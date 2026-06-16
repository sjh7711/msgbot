const bot = BotManager.getCurrentBot();

// =====================================================================
// 상식퀴즈봇 — Gemini API 기반 한국어 상식 퀴즈
//
// 명령어:
//   !상식 / !ㅅㅅ       : 랜덤 토픽으로 새 퀴즈 출제
//   !상식 [토픽] / !ㅅㅅ [토픽] : 지정 토픽으로 새 퀴즈 출제 (개인당 1일 30회, API 키 제공자 45회, 한국시간 자정 리셋)
//                       - 퀴즈 진행 중이면 답안 제출로 해석됨
//   !ㅈㄷ [답]      : 답안 제출 (30초 이내, 1회만)
//                       - 객관식: 1~5 숫자
//                       - 주관식: 단어
//   !상식순위       : 순위 조회
//   !상식종료       : 진행 중인 퀴즈 강제 종료
//   !이의신청       : 직전 채점된 회차 정답 재검증 (오답자 한정, 일반 20회/일·API제공자 무제한)
//   !이의신청 [N]   : N회차 재검증 (1회차당 1회 / 그 회차 모든 제출 답안 검토 →
//                       incorrect 판정 시 회차 전체 무효화, 그 외엔 답안 인정된 참여자별 통계 보정)
//   !api [KEY]      : Gemini API 키 등록 (개인채팅 권장). ① 키를 실제 호출해 유효성 검증 →
//                       ② 방 이름→닉네임을 단계적으로 물어 userhash.db 에서 hash 해석 →
//                       ③ quiz.db 영구 저장. 제공자는 해당 방 토픽 출제 한도가 45회로 상향.
//
// 메시지 수신:
//   ChatManager 봇이 KakaoTalk DB를 폴링/복호화해서 큐로 broadcast.
//   이 봇은 자기 LinkedBlockingQueue 만 구독.
//   → ChatManager 가 켜져 있어야 메시지를 받음.
// =====================================================================

const BOT_NAME = "상식퀴즈봇";

// ── 설정 ─────────────────────────────────────────────────────────────
// 각 provider: { key, model } — 429(쿼터 초과) 발생 시 다음 항목으로 라운드로빈.
// 아래는 기본(코드 내장) 키. 사용자가 !api 로 등록한 키는 quiz_apikey 에 저장되고,
// 시작 시 loadApiKeys() 가 이 배열 뒤에 append 한다. (const 지만 배열 mutate 는 허용됨)
const DEFAULT_MODEL = "gemini-3.1-flash-lite";
const API_KEYS = [];
var currentProviderIndex = 0;

// !api 키 등록 대화 세션 상태 (개인채팅 단계별 진행). 워커 스레드보다 먼저 초기화돼야 해서 상단 선언.
var apiSessions = {};                     // sessionKey -> { step, key, requesterName, room, nameCands, ts }
var API_SESSION_TTL_MS = 5 * 60 * 1000;   // 5분 무응답 시 만료

const ANSWER_WINDOW_MS = 30 * 1000;
const REVEAL_DELAY_MS  = 30 * 1000;       // 제출 마감과 동시에 정답 공개 (= ANSWER_WINDOW_MS)
const POST_REVEAL_IGNORE_MS = 2500;       // 정답 공개 직후 이 시간 동안 !상식/!ㅅㅅ+단어 입력 무시

// reveal 타이머 누수 방지 (메이플봇 maple-poll 과 동일 패턴):
//  - 이름 프리픽스로 재컴파일 시 killOldThreads 가 옛 컨텍스트의 타이머를 interrupt.
//  - CTX_TOKEN 으로 옛 컨텍스트가 발화시킨 stale reveal 태스크를 processTask 에서 무시.
//    (재컴파일하면 옛 타이머가 1회 발화해 같은 방의 새 퀴즈를 조기 공개시킬 수 있던 문제)
var REVEAL_THREAD_PREFIX = "QUIZ_REVEAL_TIMER";
var CTX_TOKEN = "" + java.lang.System.nanoTime() + "_" + java.lang.System.identityHashCode(new java.lang.Object());
const MAX_TOTAL_CHARS  = 400;

// 카카오톡 "더보기(접기)" 트리거용 긴 공백(제로폭 공백) 스페이서. 메시지 일부를 접기 위해 끝에 덧붙임.
var LONG_MSG_SPACER = "​".repeat(500);

// 토픽 출제 일일 한도 (한국시간 자정 리셋). API 키 제공자는 우대 한도 적용.
const TOPIC_LIMIT_DEFAULT  = 25;
const TOPIC_LIMIT_PROVIDER = 45;

// 이의신청 일일 한도 (한국시간 자정 리셋). 일반 참여자만 적용, API 키 제공자는 무제한.
const APPEAL_LIMIT_DEFAULT = 20;

const DB_PATH = Packages.android.os.Environment
    .getExternalStorageDirectory().getAbsolutePath() + "/msgbot/quiz.db";
const USERHASH_DB_PATH = Packages.android.os.Environment
    .getExternalStorageDirectory().getAbsolutePath() + "/msgbot/userhash.db";

const TOPICS = [
  "한국사","경제","회계","법","통계",
  "물리학","화학","생물학","지구과학","천문우주","수학",
  "유명영화","스포츠","음식",
  "동물", "IT/컴퓨터","기술","의학/건강",
  "환경/기후"
];

// ── DB ───────────────────────────────────────────────────────────────
function openDB() {
  return Packages.android.database.sqlite.SQLiteDatabase.openOrCreateDatabase(DB_PATH, null);
}

// ─── 공용 DB 헬퍼 (lib/db-helper.js): withDB / queryAll / transaction ───
var DBH = (function() {
  var libPath = "/sdcard/msgbot/lib/db-helper.js";
  try {
    if (typeof bot.getRootPath === "function") {
      libPath = bot.getRootPath() + "/../../lib/db-helper.js";
    }
  } catch(_) {}
  return require(libPath);
})();

function initDB() {
  DBH.withDB(DB_PATH, function(db){
  try {
    // ── quiz_user: hash 기반 스키마로 마이그레이션 ─────────────────────
    // 신 스키마: PK (hash, room), name 은 표시용 컬럼
    var col = db.rawQuery("PRAGMA table_info(quiz_user)", []);
    var hasHash = false, hasName = false, hasRoom = false, hasWins = false, tableExists = false;
    while (col.moveToNext()) {
      tableExists = true;
      var c = col.getString(1);
      if (c === "hash") hasHash = true;
      if (c === "name") hasName = true;
      if (c === "room") hasRoom = true;
      if (c === "wins") hasWins = true;
    }
    col.close();

    // 손상된/너무 옛 스키마면 드롭, 정상 옛 스키마(name PK)는 마이그레이션, 신 스키마면 패스
    var needMigrate = tableExists && !hasHash && hasName && hasRoom && hasWins;
    var needDrop    = tableExists && (!hasName || !hasWins || !hasRoom);

    if (needDrop) {
      db.execSQL("DROP TABLE quiz_user");
      tableExists = false;
      needMigrate = false;
    }

    if (needMigrate) {
      try { db.execSQL("DROP TABLE IF EXISTS quiz_user_old"); } catch(_) {}
      db.execSQL("ALTER TABLE quiz_user RENAME TO quiz_user_old");
      tableExists = false;
    }

    db.execSQL(
      "CREATE TABLE IF NOT EXISTS quiz_user (" +
      " hash TEXT NOT NULL," +
      " room TEXT NOT NULL DEFAULT ''," +
      " name TEXT NOT NULL DEFAULT ''," +
      " participated INTEGER NOT NULL DEFAULT 0," +
      " wins INTEGER NOT NULL DEFAULT 0," +
      " wrong INTEGER NOT NULL DEFAULT 0," +
      " updated INTEGER," +
      " PRIMARY KEY (hash, room)" +
      ")"
    );

    // 백필: userhash.db 에서 name → hash 매핑 (없으면 'name:<old name>' 합성 해시)
    if (needMigrate) {
      var uhDb = null;
      try {
        uhDb = Packages.android.database.sqlite.SQLiteDatabase.openDatabase(
          USERHASH_DB_PATH, null,
          Packages.android.database.sqlite.SQLiteDatabase.OPEN_READONLY
        );
      } catch(_) { /* userhash.db 없음 — 합성 해시만 사용 */ }

      // UPSERT 가 옛 SQLite (< 3.24) 에서 미지원이므로 호환 가능한 2-step 방식 사용
      var insIgnore = db.compileStatement(
        "INSERT OR IGNORE INTO quiz_user (hash, room, name, participated, wins, wrong, updated) " +
        "VALUES (?, ?, ?, 0, 0, 0, 0)"
      );
      var updStmt = db.compileStatement(
        "UPDATE quiz_user SET " +
        " participated = participated + ?," +
        " wins = wins + ?," +
        " wrong = wrong + ?," +
        " name = ?," +
        " updated = MAX(COALESCE(updated,0), ?) " +
        "WHERE hash=? AND room=?"
      );

      var oldCur = db.rawQuery(
        "SELECT name, room, participated, wins, wrong, updated FROM quiz_user_old", []
      );
      try {
        while (oldCur.moveToNext()) {
          var oldName = oldCur.getString(0) || "";
          var oldRoom = oldCur.getString(1) || "";
          var part = oldCur.getInt(2);
          var winsVal = oldCur.getInt(3);
          var wrongVal = oldCur.getInt(4);
          var updTs = oldCur.isNull(5) ? 0 : oldCur.getLong(5);

          var hashFound = null;
          if (uhDb) {
            // 1차: (name, room) 정확 매치
            var uc = null;
            try {
              uc = uhDb.rawQuery(
                "SELECT hash FROM userhash WHERE name=? AND room=? ORDER BY last_seen DESC LIMIT 1",
                [oldName, oldRoom]
              );
              if (uc.moveToFirst()) hashFound = uc.getString(0);
            } finally { if (uc) uc.close(); }

            // 2차: name 만 매치
            if (!hashFound) {
              try {
                uc = uhDb.rawQuery(
                  "SELECT hash FROM userhash WHERE name=? ORDER BY last_seen DESC LIMIT 1",
                  [oldName]
                );
                if (uc.moveToFirst()) hashFound = uc.getString(0);
              } finally { if (uc) uc.close(); }
            }
          }

          // 매칭 실패 시 합성 해시 — 다른 사용자와 충돌 안 함
          var finalHash = hashFound || ("name:" + oldName);

          // 1) 행이 없으면 0으로 INSERT, 있으면 무시
          insIgnore.bindString(1, finalHash);
          insIgnore.bindString(2, oldRoom);
          insIgnore.bindString(3, oldName);
          insIgnore.execute();
          insIgnore.clearBindings();

          // 2) 통계 합산 — INSERT/기존 행 모두에 대해 동일하게 동작
          updStmt.bindLong(1, part);
          updStmt.bindLong(2, winsVal);
          updStmt.bindLong(3, wrongVal);
          updStmt.bindString(4, oldName);
          updStmt.bindLong(5, updTs);
          updStmt.bindString(6, finalHash);
          updStmt.bindString(7, oldRoom);
          updStmt.execute();
          updStmt.clearBindings();
        }
      } finally {
        oldCur.close();
        insIgnore.close();
        updStmt.close();
        if (uhDb) try { uhDb.close(); } catch(_) {}
      }

      try { db.execSQL("DROP TABLE quiz_user_old"); } catch(_) {}
    }
    db.execSQL("CREATE INDEX IF NOT EXISTS idx_qu_room ON quiz_user(room)");

    // quiz_topic_request: 구 스키마(name 컬럼)면 드롭하고 hash 기반으로 재생성
    var col2 = db.rawQuery("PRAGMA table_info(quiz_topic_request)", []);
    var qtrHasHash = false, qtrExists = false;
    while (col2.moveToNext()) {
      qtrExists = true;
      if (col2.getString(1) === "hash") qtrHasHash = true;
    }
    col2.close();
    if (qtrExists && !qtrHasHash) db.execSQL("DROP TABLE quiz_topic_request");

    db.execSQL(
      "CREATE TABLE IF NOT EXISTS quiz_topic_request (" +
      " hash TEXT NOT NULL," +
      " created INTEGER NOT NULL" +
      ")"
    );
    db.execSQL("CREATE INDEX IF NOT EXISTS idx_qtr_hash_created ON quiz_topic_request(hash, created DESC)");

    // quiz_appeal_request: 이의신청 일일 한도 집계용 (hash 기준, 한국시간 자정 리셋)
    db.execSQL(
      "CREATE TABLE IF NOT EXISTS quiz_appeal_request (" +
      " hash TEXT NOT NULL," +
      " created INTEGER NOT NULL" +
      ")"
    );
    db.execSQL("CREATE INDEX IF NOT EXISTS idx_qar_hash_created ON quiz_appeal_request(hash, created DESC)");

    // 이의신청·최근정답 회피용 라운드 저장 (방별 순번 num 으로 식별)
    //  - room='legacy' 는 옛 quiz_history 에서 마이그레이션된 dedup-only 행들
    db.execSQL(
      "CREATE TABLE IF NOT EXISTS quiz_round (" +
      " room TEXT NOT NULL," +
      " num INTEGER NOT NULL," +
      " type TEXT NOT NULL," +
      " topic TEXT," +
      " question TEXT NOT NULL," +
      " choices TEXT," +
      " answer TEXT NOT NULL," +
      " correct_index INTEGER," +
      " explanation TEXT," +
      " created INTEGER NOT NULL," +
      " appeal_state INTEGER NOT NULL DEFAULT 0," +
      " appeal_verdict TEXT," +
      " appeal_reasoning TEXT," +
      " PRIMARY KEY (room, num)" +
      ")"
    );
    // 기존 quiz_round 에 topic 컬럼이 없으면 추가
    var qrCols = db.rawQuery("PRAGMA table_info(quiz_round)", []);
    var qrHasTopic = false;
    while (qrCols.moveToNext()) {
      if (qrCols.getString(1) === "topic") qrHasTopic = true;
    }
    qrCols.close();
    if (!qrHasTopic) { try { db.execSQL("ALTER TABLE quiz_round ADD COLUMN topic TEXT"); } catch(_) {} }
    db.execSQL("CREATE INDEX IF NOT EXISTS idx_qr_created ON quiz_round(created DESC)");

    // quiz_history → quiz_round 마이그레이션 (room='legacy', num=순번)
    var qhExists = false;
    try {
      var qhCheck = db.rawQuery(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='quiz_history'", []
      );
      qhExists = qhCheck.moveToFirst();
      qhCheck.close();
    } catch(_) {}

    if (qhExists) {
      var startCur = db.rawQuery(
        "SELECT COALESCE(MAX(num), 0) + 1 FROM quiz_round WHERE room='legacy'", []
      );
      var legacyNum = startCur.moveToFirst() ? startCur.getInt(0) : 1;
      startCur.close();

      var legIns = db.compileStatement(
        "INSERT OR IGNORE INTO quiz_round " +
        "(room, num, type, topic, question, choices, answer, correct_index, explanation, created) " +
        "VALUES ('legacy', ?, 'legacy', ?, ?, '[]', ?, 0, '', ?)"
      );
      // 옛 객관식 정답이 '1'~'5' 한 글자로 저장된 행은 쓰레기 데이터라 제외
      var legCur = db.rawQuery(
        "SELECT question, answer, topic, created FROM quiz_history " +
        "WHERE NOT (answer GLOB '[1-5]' AND length(answer) = 1)", []
      );
      try {
        while (legCur.moveToNext()) {
          legIns.bindLong(1, legacyNum);
          legIns.bindString(2, legCur.getString(2) || "");
          legIns.bindString(3, legCur.getString(0) || "");
          legIns.bindString(4, legCur.getString(1) || "");
          legIns.bindLong(5, legCur.isNull(3) ? 0 : legCur.getLong(3));
          legIns.execute();
          legIns.clearBindings();
          legacyNum++;
        }
      } finally {
        legCur.close();
        legIns.close();
      }
      try { db.execSQL("DROP TABLE quiz_history"); } catch(_) {}
    }
    db.execSQL(
      "CREATE TABLE IF NOT EXISTS quiz_round_participant (" +
      " room TEXT NOT NULL," +
      " num INTEGER NOT NULL," +
      " name TEXT NOT NULL," +
      " hash TEXT NOT NULL," +
      " was_winner INTEGER NOT NULL," +
      " wrong_count INTEGER NOT NULL," +
      " raw_answer TEXT" +
      ")"
    );
    // 기존 테이블에 raw_answer 컬럼이 없으면 추가 (마이그레이션)
    var qrpCols = db.rawQuery("PRAGMA table_info(quiz_round_participant)", []);
    var qrpHasRaw = false;
    while (qrpCols.moveToNext()) {
      if (qrpCols.getString(1) === "raw_answer") qrpHasRaw = true;
    }
    qrpCols.close();
    if (!qrpHasRaw) {
      try { db.execSQL("ALTER TABLE quiz_round_participant ADD COLUMN raw_answer TEXT"); } catch(_) {}
    }
    db.execSQL("CREATE INDEX IF NOT EXISTS idx_qrp_round ON quiz_round_participant(room, num)");

    // quiz_answer_log: LLM 이 생성한 정답을 중복 포함 전부 적재 (빈도/최근 집계용).
    //  - 한 번 생성될 때마다 1행 INSERT (DISTINCT 아님) → COUNT(*) 로 빈도 산출 가능.
    //  - answer: 표시용 정답 텍스트, norm: 빈도 그룹핑용 정규화 키
    //  - question: 출제 문제 본문, topic: 장르(분야). 둘 다 nullable (옛 행/백필 전에는 NULL).
    db.execSQL(
      "CREATE TABLE IF NOT EXISTS quiz_answer_log (" +
      " answer TEXT NOT NULL," +
      " norm TEXT NOT NULL," +
      " question TEXT," +
      " topic TEXT," +
      " created INTEGER NOT NULL" +
      ")"
    );
    db.execSQL("CREATE INDEX IF NOT EXISTS idx_qal_created ON quiz_answer_log(created DESC)");
    db.execSQL("CREATE INDEX IF NOT EXISTS idx_qal_norm ON quiz_answer_log(norm)");
    // 구버전(컬럼 없던 시절) 테이블 대비 — question/topic 없으면 추가 (기존 행은 NULL 로 남고 이후 백필).
    var qalCols = db.rawQuery("PRAGMA table_info(quiz_answer_log)", []);
    var qalHasQuestion = false, qalHasTopic = false;
    while (qalCols.moveToNext()) {
      var qalc = qalCols.getString(1);
      if (qalc === "question") qalHasQuestion = true;
      if (qalc === "topic") qalHasTopic = true;
    }
    qalCols.close();
    if (!qalHasQuestion) { try { db.execSQL("ALTER TABLE quiz_answer_log ADD COLUMN question TEXT"); } catch(_) {} }
    if (!qalHasTopic) { try { db.execSQL("ALTER TABLE quiz_answer_log ADD COLUMN topic TEXT"); } catch(_) {} }

    // quiz_apikey: 사용자가 !api 로 등록한 Gemini API 키 (재시작 후에도 유지).
    //  - key 를 PK 로 두어 중복 등록 방지.
    //  - added_by_name/hash/room: 누가(어느 방 닉네임/해시로) 제공했는지 기록. hash 는 토픽한도 우대 키.
    db.execSQL(
      "CREATE TABLE IF NOT EXISTS quiz_apikey (" +
      " key TEXT NOT NULL," +
      " model TEXT NOT NULL," +
      " added_by_name TEXT," +
      " added_by_hash TEXT," +
      " added_by_room TEXT," +
      " created INTEGER NOT NULL," +
      " PRIMARY KEY (key)" +
      ")"
    );
    // 구버전(컬럼 없던 시절) 테이블 대비 — added_by_room 없으면 추가
    var akCols = db.rawQuery("PRAGMA table_info(quiz_apikey)", []);
    var akHasRoom = false;
    while (akCols.moveToNext()) { if (akCols.getString(1) === "added_by_room") akHasRoom = true; }
    akCols.close();
    if (!akHasRoom) { try { db.execSQL("ALTER TABLE quiz_apikey ADD COLUMN added_by_room TEXT"); } catch(_) {} }

    // 최초 1회: 기존 quiz_round 정답을 quiz_answer_log 로 백필 (테이블이 비어있을 때만 실행 → 멱등).
    //  - answer 가 '1'~'5' 단일 숫자(옛 객관식 인덱스)인 행은 의미 없으므로 제외.
    //  - 중복 포함 그대로 적재 (과거 빈도까지 반영).
    try {
      var qalCnt = db.rawQuery("SELECT COUNT(*) FROM quiz_answer_log", []);
      var qalEmpty = qalCnt.moveToFirst() ? (qalCnt.getInt(0) === 0) : true;
      qalCnt.close();
      if (qalEmpty) {
        var bfCur = db.rawQuery(
          "SELECT answer, created FROM quiz_round " +
          "WHERE answer != '' AND NOT (answer GLOB '[1-5]' AND length(answer) = 1)", []
        );
        var bfIns = db.compileStatement(
          "INSERT INTO quiz_answer_log (answer, norm, created) VALUES (?, ?, ?)"
        );
        try {
          while (bfCur.moveToNext()) {
            var bfAns = String(bfCur.getString(0) || "").trim();
            if (!bfAns || /^[1-5]$/.test(bfAns)) continue;   // 숫자 1~5 정답 제외
            var bfNorm = normalize(bfAns);
            if (!bfNorm) continue;
            bfIns.bindString(1, bfAns);
            bfIns.bindString(2, bfNorm);
            bfIns.bindLong(3, bfCur.isNull(1) ? nowMs() : bfCur.getLong(1));
            bfIns.execute();
            bfIns.clearBindings();
          }
        } finally {
          bfCur.close();
          bfIns.close();
        }
      }
    } catch(_) {}

    // 봇 재시작 시 처리 중(state=1) 으로 박힌 이의신청 회차를 재신청 가능 상태(0)로 복구
    try { db.execSQL("UPDATE quiz_round SET appeal_state=0 WHERE appeal_state=1"); } catch(_) {}
  } finally { }
  });
}
initDB();

// ── API 키 영구 저장/로드 (quiz_apikey) ───────────────────────────────
// 키 문자열 마스킹 (채팅 로그 노출 최소화): 앞 6 + … + 뒤 4
function maskKey(k) {
  k = String(k || "");
  if (k.length <= 12) return k.slice(0, 2) + "…";
  return k.slice(0, 6) + "…" + k.slice(-4);
}

function apiKeyExists(k) {
  for (var i = 0; i < API_KEYS.length; i++) if (API_KEYS[i].key === k) return true;
  return false;
}

// 이 해시의 사용자가 (해당 방에) !api 로 키를 1개 이상 제공했는지 (토픽/이의신청 한도 우대용).
// 키 사용처가 등록한 방으로 제한되므로 우대도 같은 방에서만 적용. room 미지정 시 방 무관(하위호환).
function isApiProvider(hash, room) {
  if (!hash) return false;
  return DBH.withDB(DB_PATH, function(db){
    var cur = null;
    try {
      if (room == null) {
        cur = db.rawQuery("SELECT 1 FROM quiz_apikey WHERE added_by_hash = ? LIMIT 1", [hash]);
      } else {
        cur = db.rawQuery(
          "SELECT 1 FROM quiz_apikey WHERE added_by_hash = ? AND " +
          "(added_by_room = ? OR added_by_room IS NULL OR added_by_room = '') LIMIT 1",
          [hash, String(room)]);
      }
      return cur.moveToFirst();
    } catch(e) { return false; } finally { if (cur) cur.close(); }
  });
}

// 시작 시 quiz_apikey 의 키들을 API_KEYS 뒤에 append (코드 내장 키와 중복 제외)
function loadApiKeys() {
  return DBH.withDB(DB_PATH, function(db){
    var cur = null; var n = 0;
    try {
      cur = db.rawQuery("SELECT key, model, added_by_room FROM quiz_apikey ORDER BY created ASC", []);
      while (cur.moveToNext()) {
        var k = cur.getString(0);
        var m = cur.getString(1) || DEFAULT_MODEL;
        var rm = cur.getString(2) || "";   // 등록한 방 — 이 방에서만 사용 가능 (빈값이면 전역)
        if (k && !apiKeyExists(k)) { API_KEYS.push({ key: k, model: m, room: rm }); n++; }
      }
    } catch(e) {} finally { if (cur) cur.close(); }
    return n;
  });
}

// !api 로 등록: DB 에 영구 저장(누가/어느 방 닉네임으로 줬는지 포함) + 런타임 API_KEYS 에 즉시 추가.
// 반환: "added" | "exists" | "error"
function registerApiKey(key, name, hash, room) {
  if (apiKeyExists(key)) return "exists";
  var ok = DBH.withDB(DB_PATH, function(db){
    try {
      // PK(key) 충돌 시 무시 → 이미 DB 에만 있고 런타임엔 없던 경우도 안전
      var stmt = db.compileStatement(
        "INSERT OR IGNORE INTO quiz_apikey (key, model, added_by_name, added_by_hash, added_by_room, created) VALUES (?, ?, ?, ?, ?, ?)"
      );
      stmt.bindString(1, key);
      stmt.bindString(2, DEFAULT_MODEL);
      stmt.bindString(3, name || "");
      stmt.bindString(4, hash || "");
      stmt.bindString(5, room || "");
      stmt.bindLong(6, nowMs());
      stmt.execute(); stmt.close();
    } catch(e) { return false; }
    return true;
  });
  if (!ok) return "error";
  API_KEYS.push({ key: key, model: DEFAULT_MODEL, room: room || "" });   // 등록한 방에서만 사용
  currentProviderIndex = API_KEYS.length - 1;  // 방금 등록한 새 키부터 사용 (기존 키는 쿼터 소진 상태일 수 있음)
  return "added";
}

// 키를 실제로 한 번 호출해 유효성 검증. 네트워크 호출이므로 워커 스레드가 아닌 별도 스레드에서 호출할 것.
// 반환: "ok"(정상응답) | "quota"(키는 유효하나 429) | "invalid"(잘못된 키) | "neterr"(통신 오류)
function testApiKey(key) {
  var conn = null;
  try {
    var url = new java.net.URL(
      "https://generativelanguage.googleapis.com/v1beta/models/" + DEFAULT_MODEL + ":generateContent?key=" + key);
    conn = url.openConnection();
    conn.setRequestMethod("POST");
    conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
    conn.setDoOutput(true);
    conn.setConnectTimeout(15000);
    conn.setReadTimeout(20000);
    var body = JSON.stringify({
      contents: [{ parts: [{ text: "ping" }] }],
      generationConfig: { maxOutputTokens: 1 }
    });
    var w = new java.io.OutputStreamWriter(conn.getOutputStream(), "UTF-8");
    w.write(body); w.flush(); w.close();

    var code = conn.getResponseCode();
    if (code >= 200 && code < 300) return "ok";

    var es = conn.getErrorStream();
    var raw = "";
    if (es) {
      var rd = new java.io.BufferedReader(new java.io.InputStreamReader(es, "UTF-8"));
      var sb = new java.lang.StringBuilder(); var ln;
      while ((ln = rd.readLine()) !== null) sb.append(ln);
      rd.close(); raw = String(sb.toString());
    }
    if (code === 429 || raw.indexOf("RESOURCE_EXHAUSTED") !== -1) return "quota";
    if (code === 400 || code === 403 ||
        raw.indexOf("API_KEY_INVALID") !== -1 || raw.indexOf("API key not valid") !== -1) return "invalid";
    return "neterr";
  } catch(e) {
    return "neterr";
  } finally { try { if (conn) conn.disconnect(); } catch(_) {} }
}

// 닉네임 직접복호화 공유 모듈 (msg.author.name 신뢰 안 함, user_id→이름)
var kt = (function() {
  var libPath = "/sdcard/msgbot/lib/kakao-decrypt.js";
  try {
    if (typeof bot.getRootPath === "function") {
      libPath = bot.getRootPath() + "/../../lib/kakao-decrypt.js";
    }
  } catch(_) {}
  return require(libPath);
})();

// ── userhash.db 조회 (방/닉네임 → hash 해석) ───────────────────────────
function _openUserHashDB() {
  try {
    return Packages.android.database.sqlite.SQLiteDatabase.openDatabase(
      USERHASH_DB_PATH, null,
      Packages.android.database.sqlite.SQLiteDatabase.OPEN_READONLY);
  } catch(_) { return null; }
}
// LIKE 와일드카드/이스케이프 문자 무력화 (부분일치는 코드에서 %...% 로 감쌈)
function _likeEscape(s) {
  return String(s == null ? "" : s).replace(/[\\%_]/g, function(c) { return "\\" + c; });
}

// 부분 일치하는 방 이름 목록 (중복 제거)
function findRoomsByPartial(partial) {
  var out = [];
  try {
    DBH.withReadOnlyDB(USERHASH_DB_PATH, function(db){
      var cur = null;
      try {
        cur = db.rawQuery(
          "SELECT DISTINCT room FROM userhash WHERE room LIKE ? ESCAPE '\\' AND room != '' ORDER BY room",
          ["%" + _likeEscape(partial) + "%"]);
        while (cur.moveToNext()) { var r = cur.getString(0); if (r) out.push(r); }
      } finally { if (cur) cur.close(); }
    });
  } catch(e) {}
  return out;
}

// 특정 방에서 부분 일치하는 닉네임 후보 [{name, hash}] (hash 기준 distinct, 최근 접속 우선)
function findNamesByPartial(room, partial) {
  var out = [];
  // 1) 공유 캐시(직접복호화 신뢰값) 우선 — 해당 방 + 부분일치
  try {
    var hits = kt.findUserIdsByName(String(partial), true, String(room));
    for (var i = 0; i < hits.length; i++) out.push({ name: hits[i].name || "", hash: hits[i].uid });
  } catch(_) {}
  if (out.length) return out;
  // 2) 폴백: userhash.db
  try {
    DBH.withReadOnlyDB(USERHASH_DB_PATH, function(db){
      var cur = null;
      try {
        cur = db.rawQuery(
          "SELECT name, hash, MAX(last_seen) ls FROM userhash " +
          "WHERE room = ? AND name LIKE ? ESCAPE '\\' GROUP BY hash ORDER BY ls DESC",
          [String(room), "%" + _likeEscape(partial) + "%"]);
        while (cur.moveToNext()) {
          var nm = cur.getString(0); var h = cur.getString(1);
          if (h) out.push({ name: nm || "", hash: h });
        }
      } finally { if (cur) cur.close(); }
    });
  } catch(e) {}
  return out;
}

loadApiKeys();

// ── 유틸 ─────────────────────────────────────────────────────────────
function normalize(s) {
  return (s == null ? "" : String(s))
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")                          // 모든 공백
    .replace(/[·．。．.,，'"`\-–—!?()（）「」<>《》]/g, ""); // 흔한 구두점
}

function nowMs() { return Date.now(); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// 오늘 00:00 KST(UTC+9) 에 해당하는 epoch(ms). 토픽 출제 한도를 캘린더 일자(0시~24시) 기준으로 리셋.
function kstDayStartMs() {
  var KST = 9 * 60 * 60 * 1000;
  var DAY = 24 * 60 * 60 * 1000;
  var k = nowMs() + KST;        // KST 벽시계로 환산
  return (k - (k % DAY)) - KST; // KST 자정으로 내림 후 다시 UTC epoch 으로
}

// ── Gemini 호출 ──────────────────────────────────────────────────────
// _callGeminiOnce: 현재 provider 로 1회 호출. 429(쿼터 초과)면 { quota429: true } 반환.
// callGemini: 429 면 다음 provider 로 자동 전환하며 모든 provider 를 순회.
//   - 한 provider 라도 정상 응답하면 그 응답을 그대로 사용.
//   - 모든 provider 가 429 면 { quotaExhausted: true } 반환.
// 이 방에서 사용 가능한 provider 인덱스 목록.
//  - quiz_apikey 의 첫번째(가장 먼저 등록된) 키 = API_KEYS[0] 은 전역 키로 모든 방에서 사용.
//    (loadApiKeys 가 created ASC 로 append 하고 API_KEYS 는 빈 배열에서 시작하므로 [0]=최초 등록분)
//  - room 이 비어있는 키(있다면)도 전역 공용.
//  - 그 외 !api 등록 키는 등록한 방(room)에서만 사용.
function eligibleProviderIndexes(room) {
  var out = [];
  for (var i = 0; i < API_KEYS.length; i++) {
    var p = API_KEYS[i];
    if (i === 0 || !p.room || p.room === room) out.push(i);
  }
  return out;
}

function callGemini(prompt, room) {
  var elig = eligibleProviderIndexes(room);
  if (!elig.length) return { quotaExhausted: true, error: "이 방에서 사용 가능한 API 키 없음" };
  // 직전 currentProviderIndex 이상인 첫 eligible 부터 시작 (소진된 키 재시도 최소화, 방이 바뀌면 자동 보정)
  var start = 0;
  for (var s = 0; s < elig.length; s++) { if (elig[s] >= currentProviderIndex) { start = s; break; } }
  for (var tried = 0; tried < elig.length; tried++) {
    var idx = elig[(start + tried) % elig.length];
    currentProviderIndex = idx;
    var res = _callGeminiOnce(prompt, API_KEYS[idx]);
    if (res.quota429) continue;   // 이 provider 는 쿼터 소진 — 다음 eligible provider 로
    return res;                   // 정상 응답 또는 429 외 오류 → 즉시 반환
  }
  // 이 방의 모든 eligible provider 가 429
  return { quotaExhausted: true, error: "모든 API 사용량 한도 초과" };
}

function _callGeminiOnce(prompt, provider) {
  var conn = null;
  try {
    var url = new java.net.URL(
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      provider.model + ":generateContent?key=" + provider.key
    );
    conn = url.openConnection();
    conn.setRequestMethod("POST");
    conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
    conn.setDoOutput(true);
    conn.setConnectTimeout(15000);
    conn.setReadTimeout(30000);

    var body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 1.1,
        topP: 0.95,
        responseMimeType: "application/json"
      }
    });

    var writer = new java.io.OutputStreamWriter(conn.getOutputStream(), "UTF-8");
    writer.write(body);
    writer.flush(); writer.close();

    var code = conn.getResponseCode();
    var stream = (code >= 200 && code < 300) ? conn.getInputStream() : conn.getErrorStream();
    var raw = "";
    if (stream) {
      var reader = new java.io.BufferedReader(new java.io.InputStreamReader(stream, "UTF-8"));
      var sb = new java.lang.StringBuilder();
      var line;
      while ((line = reader.readLine()) !== null) sb.append(line);
      reader.close();
      raw = String(sb.toString());
    }

    if (code < 200 || code >= 300) {
      if (code === 429) {
        // 사용량 한도 초과 — callGemini 가 다음 provider 로 전환하도록 플래그 반환
        return { quota429: true, error: "HTTP 429" };
      }
      return { error: "HTTP " + code + ": " + raw.slice(0, 300) };
    }

    var resp;
    try { resp = JSON.parse(raw); }
    catch(pe) { return { error: "응답 JSON 파싱 실패: " + raw.slice(0, 200) }; }

    if (resp.promptFeedback && resp.promptFeedback.blockReason) {
      return { error: "차단됨: " + resp.promptFeedback.blockReason };
    }
    if (!resp.candidates || !resp.candidates[0]) {
      return { error: "candidates 없음: " + raw.slice(0, 200) };
    }
    var cand = resp.candidates[0];
    if (cand.finishReason && cand.finishReason !== "STOP" && cand.finishReason !== "MAX_TOKENS") {
      return { error: "finishReason: " + cand.finishReason };
    }
    if (!cand.content || !cand.content.parts || !cand.content.parts[0]) {
      return { error: "content 없음 (finish=" + (cand.finishReason || "?") + ")" };
    }
    return { text: String(cand.content.parts[0].text || "") };
  } catch(e) {
    return { error: (e && e.message) ? e.message : String(e) };
  } finally {
    try { if (conn) conn.disconnect(); } catch(_) {}
  }
}

// ── LLM 생성 정답 로그 (quiz_answer_log) ──────────────────────────────
// LLM 이 생성한 정답을 reject/실패 포함 모두 적재. 목적: LLM 이 자주 생성하는 답을 빈도 집계해 회피.
// 문제 본문(question)·장르(topic)도 함께 적재. 또한 같은 정답(norm)인데 토픽이 비어있던
// 과거 행(기존 데이터)에는 이번 토픽을 백필한다 (기존 데이터는 삭제하지 않음).
function logGeneratedAnswer(answerText, question, topic) {
  var a = String(answerText == null ? "" : answerText).trim();
  if (!a || /^[1-5]$/.test(a)) return;   // 빈값·객관식 인덱스('1'~'5')는 무의미
  var n = normalize(a);
  if (!n) return;
  var q = String(question == null ? "" : question).trim();
  var t = String(topic == null ? "" : topic).trim();
  DBH.withDB(DB_PATH, function(db){
  try {
    // 기존 데이터 백필: 같은 norm 인데 topic 이 NULL/빈값이던 과거 행을 이번 토픽으로 채움
    if (t) {
      try { db.execSQL(
        "UPDATE quiz_answer_log SET topic = ? WHERE norm = ? AND (topic IS NULL OR topic = '')",
        [t, n]); } catch(_) {}
    }
    var stmt = db.compileStatement(
      "INSERT INTO quiz_answer_log (answer, norm, question, topic, created) VALUES (?, ?, ?, ?, ?)");
    stmt.bindString(1, a);
    stmt.bindString(2, n);
    stmt.bindString(3, q);
    stmt.bindString(4, t);
    stmt.bindLong(5, nowMs());
    stmt.execute(); stmt.close();
  } catch(_) {} finally { }
  });
}

// 빈도 상위 N개 정답 (norm 기준 그룹, 표시는 가장 최근 표기)
function getFrequentAnswers(limit) {
  return DBH.withDB(DB_PATH, function(db){
    var cur = null; var out = [];
    try {
      cur = db.rawQuery(
        "SELECT answer, COUNT(*) c, MAX(created) mc FROM quiz_answer_log " +
        "GROUP BY norm ORDER BY c DESC, mc DESC LIMIT " + (limit || 50), []
      );
      while (cur.moveToNext()) {
        var a = cur.getString(0);
        if (a && !/^[1-5]$/.test(a)) out.push(a);
      }
    } catch(e) {} finally { if (cur) cur.close(); }
    return out;
  });
}

// 빈출 정답(quiz_answer_log)을 생성 횟수와 함께 상위 N개. !금지목록 표시용.
function getFrequentAnswersWithCount(limit) {
  return DBH.withDB(DB_PATH, function(db){
    var cur = null; var out = [];
    try {
      cur = db.rawQuery(
        "SELECT answer, COUNT(*) c, MAX(created) mc FROM quiz_answer_log " +
        "GROUP BY norm ORDER BY c DESC, mc DESC LIMIT " + (limit || 50), []
      );
      while (cur.moveToNext()) {
        var a = cur.getString(0);
        var c = cur.getInt(1);
        if (a && !/^[1-5]$/.test(a)) out.push({ answer: a, count: c });
      }
    } catch(e) {} finally { if (cur) cur.close(); }
    return out;
  });
}

// 실제 출제된(=reveal 까지 간) 정답 중 최근 N개. quiz_round 기준 → dedupSet·프롬프트 "최근" 소스.
function getRecentRoundAnswers(limit) {
  return DBH.withDB(DB_PATH, function(db){
    var cur = null; var out = [];
    try {
      cur = db.rawQuery(
        "SELECT DISTINCT answer FROM quiz_round WHERE answer != '' " +
        "ORDER BY created DESC LIMIT " + (limit || 1000), []
      );
      while (cur.moveToNext()) {
        var a = cur.getString(0);
        if (a && !/^[1-5]$/.test(a)) out.push(a);  // 옛 객관식 인덱스('1'~'5') 제외
      }
    } catch(e) {} finally { if (cur) cur.close(); }
    return out;
  });
}

// 정답/보기 텍스트가 실제 명칭이 아니라 템플릿 자리표시자(예: "본 정답 명칭", "보기1", "정답")인지 판별.
// LLM 이 예시 JSON 의 placeholder 를 그대로 베껴 출제하는 사고를 차단한다.
function looksLikePlaceholder(s) {
  var n = normalize(s);
  if (!n) return true;
  // "정답"/"보기"/"본 정답 명칭" 류 메타 단어가 답/보기에 들어갈 일은 정상적으로 없음
  if (n.indexOf("정답") !== -1) return true;        // 본정답명칭, 정답명칭, 정답텍스트, 정답단어 ...
  if (/^보기[1-5]?$/.test(n)) return true;           // 보기, 보기1~5
  if (n.indexOf("자리표시") !== -1) return true;
  var exact = ["선택지", "예시", "문제본문", "세부분야한글", "동의어영문표기", "띄어쓰기제거형", "해설", "보기"];
  for (var i = 0; i < exact.length; i++) if (n === exact[i]) return true;
  return false;
}

// 오늘(UTC+9 기준 0시~24시) 해당 유저(해시 기준)가 토픽 출제를 요청한 횟수
function countRecentTopicRequests(hash) {
  var since = kstDayStartMs();   // 오늘 00:00 KST 의 epoch(ms)
  return DBH.withDB(DB_PATH, function(db){
    var cur = null;
    try {
      cur = db.rawQuery(
        "SELECT COUNT(*) FROM quiz_topic_request WHERE hash=? AND created >= " + since, [hash]
      );
      if (cur.moveToFirst()) return cur.getInt(0);
      return 0;
    } catch(e) { return 0; }
    finally { if (cur) cur.close(); }
  });
}

function recordTopicRequest(hash) {
  DBH.withDB(DB_PATH, function(db){
  try {
    var stmt = db.compileStatement("INSERT INTO quiz_topic_request (hash, created) VALUES (?, ?)");
    stmt.bindString(1, hash);
    stmt.bindLong(2, nowMs());
    stmt.execute(); stmt.close();
  } finally { }
  });
}

// 오늘(UTC+9 기준 0시~24시) 해당 유저(해시 기준)가 이의신청한 횟수
function countRecentAppeals(hash) {
  var since = kstDayStartMs();
  return DBH.withDB(DB_PATH, function(db){
    var cur = null;
    try {
      cur = db.rawQuery(
        "SELECT COUNT(*) FROM quiz_appeal_request WHERE hash=? AND created >= " + since, [hash]
      );
      if (cur.moveToFirst()) return cur.getInt(0);
      return 0;
    } catch(e) { return 0; }
    finally { if (cur) cur.close(); }
  });
}

function recordAppeal(hash) {
  DBH.withDB(DB_PATH, function(db){
  try {
    var stmt = db.compileStatement("INSERT INTO quiz_appeal_request (hash, created) VALUES (?, ?)");
    stmt.bindString(1, hash);
    stmt.bindLong(2, nowMs());
    stmt.execute(); stmt.close();
  } finally { }
  });
}

// ── 라운드 저장 / 이의신청용 ──────────────────────────────────────────
function nextRoundNum(room) {
  return DBH.withDB(DB_PATH, function(db){
    var cur = null;
    try {
      cur = db.rawQuery("SELECT COALESCE(MAX(num), 0) + 1 FROM quiz_round WHERE room=?", [room]);
      if (cur.moveToFirst()) return cur.getInt(0);
      return 1;
    } finally { if (cur) cur.close(); }
  });
}

function saveRound(room, num, q) {
  DBH.withDB(DB_PATH, function(db){
  try {
    var stmt = db.compileStatement(
      "INSERT INTO quiz_round (room, num, type, topic, question, choices, answer, correct_index, explanation, created) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    stmt.bindString(1, room);
    stmt.bindLong(2, num);
    stmt.bindString(3, q.type);
    stmt.bindString(4, q.topic || "");
    stmt.bindString(5, q.question || "");
    stmt.bindString(6, JSON.stringify(q.choices || []));
    stmt.bindString(7, q.answer || "");
    stmt.bindLong(8, q.correctIndex || 0);
    stmt.bindString(9, q.explanation || "");
    stmt.bindLong(10, nowMs());
    stmt.execute(); stmt.close();
  } finally { }
  });
}

function saveRoundParticipant(room, num, name, hash, wasWinner, wrongCount, rawAnswer) {
  DBH.withDB(DB_PATH, function(db){
  try {
    var stmt = db.compileStatement(
      "INSERT INTO quiz_round_participant (room, num, name, hash, was_winner, wrong_count, raw_answer) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    stmt.bindString(1, room);
    stmt.bindLong(2, num);
    stmt.bindString(3, name || "");
    stmt.bindString(4, hash || "");
    stmt.bindLong(5, wasWinner ? 1 : 0);
    stmt.bindLong(6, wrongCount || 0);
    stmt.bindString(7, String(rawAnswer || ""));
    stmt.execute(); stmt.close();
  } finally { }
  });
}

function getLatestRound(room) {
  return DBH.withDB(DB_PATH, function(db){
    var cur = null;
    try {
      cur = db.rawQuery(
        "SELECT num, type, question, choices, answer, correct_index, explanation, appeal_state, appeal_verdict " +
        "FROM quiz_round WHERE room=? ORDER BY num DESC LIMIT 1", [room]
      );
      if (!cur.moveToFirst()) return null;
      return readRoundCursor(cur);
    } finally { if (cur) cur.close(); }
  });
}

function getRoundByNum(room, num) {
  return DBH.withDB(DB_PATH, function(db){
    var cur = null;
    try {
      cur = db.rawQuery(
        "SELECT num, type, question, choices, answer, correct_index, explanation, appeal_state, appeal_verdict " +
        "FROM quiz_round WHERE room=? AND num=?", [room, String(num)]
      );
      if (!cur.moveToFirst()) return null;
      return readRoundCursor(cur);
    } finally { if (cur) cur.close(); }
  });
}

function readRoundCursor(cur) {
  return {
    num: cur.getInt(0),
    type: cur.getString(1),
    question: cur.getString(2),
    choices: (function(){ try { return JSON.parse(cur.getString(3) || "[]"); } catch(_) { return []; } })(),
    answer: cur.getString(4),
    correctIndex: cur.getInt(5),
    explanation: cur.getString(6),
    appealState: cur.getInt(7),
    appealVerdict: cur.getString(8)
  };
}

function getRoundParticipants(room, num) {
  return DBH.withDB(DB_PATH, function(db){
    var cur = null; var out = [];
    try {
      cur = db.rawQuery(
        "SELECT name, hash, was_winner, wrong_count, raw_answer FROM quiz_round_participant WHERE room=? AND num=?",
        [room, String(num)]
      );
      while (cur.moveToNext()) {
        out.push({
          name: cur.getString(0),
          hash: cur.getString(1),
          wasWinner: cur.getInt(2) === 1,
          wrongCount: cur.getInt(3),
          rawAnswer: cur.getString(4) || ""
        });
      }
    } finally { if (cur) cur.close(); }
    return out;
  });
}

function setAppealState(room, num, state) {
  DBH.withDB(DB_PATH, function(db){
  try {
    var stmt = db.compileStatement("UPDATE quiz_round SET appeal_state=? WHERE room=? AND num=?");
    stmt.bindLong(1, state);
    stmt.bindString(2, room);
    stmt.bindLong(3, num);
    stmt.execute(); stmt.close();
  } finally { }
  });
}

function saveAppealResult(room, num, verdict, reasoning) {
  DBH.withDB(DB_PATH, function(db){
  try {
    var stmt = db.compileStatement(
      "UPDATE quiz_round SET appeal_state=2, appeal_verdict=?, appeal_reasoning=? WHERE room=? AND num=?"
    );
    stmt.bindString(1, verdict || "");
    stmt.bindString(2, reasoning || "");
    stmt.bindString(3, room);
    stmt.bindLong(4, num);
    stmt.execute(); stmt.close();
  } finally { }
  });
}

// 한 라운드의 참여자들 통계를 quiz_user에서 차감
function revertRoundStats(room, num) {
  var parts = getRoundParticipants(room, num);
  DBH.withDB(DB_PATH, function(db){
  try {
    var stmt = db.compileStatement(
      "UPDATE quiz_user SET " +
      " participated = MAX(participated - 1, 0)," +
      " wins = MAX(wins - ?, 0)," +
      " wrong = MAX(wrong - ?, 0)," +
      " updated = ? " +
      "WHERE hash=? AND room=?"
    );
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p.hash) continue;
      stmt.bindLong(1, p.wasWinner ? 1 : 0);
      stmt.bindLong(2, p.wrongCount);
      stmt.bindLong(3, nowMs());
      stmt.bindString(4, p.hash);
      stmt.bindString(5, room);
      stmt.execute();
      stmt.clearBindings();
    }
    stmt.close();
  } finally { }
  });
}

// 참여자 한 명 통계 보정 (오답 -wrongCount, 정답 +1) — 답안이 인정된 비정답자마다 호출
function correctAppellantStats(room, hash, wrongCount) {
  if (!hash) return;
  DBH.withDB(DB_PATH, function(db){
  try {
    var stmt = db.compileStatement(
      "UPDATE quiz_user SET " +
      " wins = wins + 1," +
      " wrong = MAX(wrong - ?, 0)," +
      " updated = ? " +
      "WHERE hash=? AND room=?"
    );
    stmt.bindLong(1, wrongCount || 0);
    stmt.bindLong(2, nowMs());
    stmt.bindString(3, hash);
    stmt.bindString(4, room);
    stmt.execute(); stmt.close();
  } finally { }
  });
}

function recordParticipation(hash, name, isWinner, wrongCount, room) {
  if (!hash) return;
  var r = room || "";
  var nm = name || "";
  DBH.withDB(DB_PATH, function(db){
  try {
    var cur = db.rawQuery("SELECT 1 FROM quiz_user WHERE hash=? AND room=?", [hash, r]);
    var exists = cur.moveToFirst(); cur.close();

    if (!exists) {
      var ins = db.compileStatement(
        "INSERT INTO quiz_user (hash, room, name, participated, wins, wrong, updated) VALUES (?, ?, ?, 0, 0, 0, ?)"
      );
      ins.bindString(1, hash);
      ins.bindString(2, r);
      ins.bindString(3, nm);
      ins.bindLong(4, nowMs());
      ins.execute(); ins.close();
    }

    // name 도 같이 업데이트 (최신 닉 유지)
    var upd = db.compileStatement(
      "UPDATE quiz_user SET participated=participated+1, " +
      "wins=wins+?, wrong=wrong+?, name=?, updated=? WHERE hash=? AND room=?"
    );
    upd.bindLong(1, isWinner ? 1 : 0);
    upd.bindLong(2, wrongCount || 0);
    upd.bindString(3, nm);
    upd.bindLong(4, nowMs());
    upd.bindString(5, hash);
    upd.bindString(6, r);
    upd.execute(); upd.close();
  } finally { }
  });
}

function getRanking(topN, room) {
  return DBH.withDB(DB_PATH, function(db){
    var cur = null; var out = [];
    try {
      cur = db.rawQuery(
        "SELECT name, participated, wins, wrong, (wins*10 - wrong) AS score FROM quiz_user " +
        "WHERE participated >= 1 AND room = ? " +
        "ORDER BY score DESC, wins DESC, participated DESC " +
        "LIMIT " + topN, [room || ""]
      );
      while (cur.moveToNext()) {
        out.push({
          name: cur.getString(0),
          participated: cur.getInt(1),
          wins: cur.getInt(2),
          wrong: cur.getInt(3),
          score: cur.getInt(4)
        });
      }
    } finally { if (cur) cur.close(); }
    return out;
  });
}

// ── 게임 상태 ────────────────────────────────────────────────────────
// 방(channelId)별 독립 진행. 같은 시각 서로 다른 방에서 동시에 퀴즈가 돌 수 있다.
//  - 인메모리 진행 상태 + 정답공개 타이머 라우팅 = channelId 기준.
//  - DB(quiz_round/appeals/stats) + 봇 답장 = 기존대로 방 이름 문자열(quiz.room) 기준 유지.
var quizzes = {};               // channelId -> quiz state (newQuizState())
var lastRevealMsByChan = {};    // channelId -> 마지막 정답 공개 시각 (공개 직후 입력 무시 판정용)

function newQuizState() {
  return {
    active: false,
    generating: false,
    room: "",
    type: "",          // "multi" | "short"
    topic: "",
    question: "",
    choices: [],
    answer: "",
    explanation: "",
    correctIndex: 0,   // 객관식
    acceptable: [],    // 정규화된 허용 답 리스트
    startTime: 0,
    participants: {},  // pid (hash 또는 "noname:name") -> { hash, name, wrongCount, raw, notified }
    winnerPid: "",
    winnerName: "",
    winnerRaw: "",
    winnerTimeMs: 0,
    revealThread: null
  };
}

function resetQuiz(quiz, chanId) {
  if (quiz && quiz.revealThread) {
    try { quiz.revealThread.interrupt(); } catch(_) {}
  }
  quizzes[chanId] = newQuizState();
}

// 난이도 1~5 기준(생성·감사 프롬프트 공용)
var DIFFICULTY_SCALE = "1=고등학생도 아는 쉬운 상식, 2=성인 대부분 아는 상식, 3=성인이 잠깐 생각하면 맞히는 수준, 4=관심 있는 사람이 아는 수준, 5=전공자/대학원 석사 수준";

// 목표 난이도 가중 추첨: 1=10%, 2=25%, 3=25%, 4=25%, 5=15%
function pickDifficulty() {
  var r = Math.random();
  if (r < 0.10) return 1;
  if (r < 0.35) return 2;
  if (r < 0.60) return 3;
  if (r < 0.85) return 4;
  return 5;
}

// ── 퀴즈 생성 ────────────────────────────────────────────────────────
function generateQuiz(customTopic, room) {
  var topic = customTopic || pick(TOPICS);
  var wantMulti = Math.random() < 0.7; // 객관식 70%, 주관식 30%
  var seed = Math.floor(Math.random() * 1000000);
  var targetDifficulty = pickDifficulty();   // 분포를 우리가 정한 뒤 LLM에게 그 난이도로 출제시킴(=표시 별점)
  // LLM 에게 전달하는 '금지단어' 목록 (forbidden):
  //  - 시작값 = 빈출 50 (quiz_answer_log, LLM 이 자주 생성하는 답) + 최근 20 (quiz_round, 실제 출제분).
  //  - 재시도 중 LLM 이 생성한 답을 여기에 누적 → 다음 시도 프롬프트의 금지단어로 직접 추가.
  //    (봇 내부에서 조용히 reject 만 하지 않고, LLM 에게 "이 답 쓰지 마"라고 명시해 재생성을 줄임)
  var freqAnswers = getFrequentAnswers(50);
  var recentUsed = getRecentRoundAnswers(20);
  // 빈출 상위 50 정답은 avoid block(프롬프트 금지단어)으로 안내할 뿐 아니라,
  // LLM 이 그대로 어기면 코드단에서 하드 reject → 사유가 다음 시도 피드백으로 전달된다.
  var freqSet = {};          // norm -> true (빈출 상위 정답 하드 차단용)
  for (var fsi = 0; fsi < freqAnswers.length; fsi++) {
    var fsn = normalize(freqAnswers[fsi]);
    if (fsn) freqSet[fsn] = true;
  }
  var forbidden = [];        // 표시용 (프롬프트 콤마 나열, 순서 유지)
  var forbiddenSeen = {};    // norm -> true (중복 추가 방지)
  function addForbidden(word) {
    var n = normalize(word);
    if (!n || forbiddenSeen[n]) return;
    forbiddenSeen[n] = true;
    forbidden.push(word);
  }
  for (var fi = 0; fi < freqAnswers.length; fi++) addForbidden(freqAnswers[fi]);
  for (var ri = 0; ri < recentUsed.length; ri++) addForbidden(recentUsed[ri]);
  function buildAvoidBlock() {
    return forbidden.length
      ? ("★중요★ 최근/자주 출제된 정답이라 새 문제의 정답(객관식: 정답 보기 텍스트, 주관식: 정답 단어)으로 재사용 금지: " +
         forbidden.join(", ") + "\n" +
         "위 금지 정답들은 **글자가 똑같은 경우만이 아니라, 조금씩 변형하거나 사실상 같은 대상을 가리키는 표현 전부**를 금지합니다. 다음을 모두 포함해 회피하세요:\n" +
         "  - 동의어·유의어·다른 명칭 (예: '소금' ↔ '염화나트륨', '훈민정음' ↔ '한글')\n" +
         "  - 글자를 끼워넣거나 빼서 늘리거나 줄인 형태, 접두/접미사를 붙인 확장형·축약형 (예: '유동자산' ↔ '유동성자산' ↔ '당좌자산')\n" +
         "  - 한자/영문/외래어 표기 변형, 띄어쓰기·구두점만 다른 형태\n" +
         "  - 핵심 어근(앞부분 글자)이 겹쳐 사실상 같은 분야·대상을 가리키는 표현\n" +
         "위 금지 정답과 위 기준으로 조금이라도 겹치면, 정답을 **완전히 다른 분야의 전혀 다른 대상**으로 새로 정하세요.\n\n")
      : "";
  }

  // 코드단 하드 중복 차단 안전망 (quiz_round 최근 1000). LLM 이 금지단어를 어기면 reject·재시도.
  var dedupSet = {};
  (function buildDedup(arr) {
    for (var i = 0; i < arr.length; i++) {
      var n = normalize(arr[i]);
      if (n) dedupSet[n] = true;
    }
  })(getRecentRoundAnswers(1000));

  var typeDesc = wantMulti
    ? "객관식 5지선다 (choices에 5개 보기, answer는 \"1\"~\"5\" 중 하나)"
    : "주관식 단답형 (choices는 빈 배열 [], answer는 짧은 단어/구 1개)";

  // 금지단어 블록은 매 시도마다 바뀌므로 head/tail 을 분리해 두고, 루프에서 그 사이에 끼워 넣는다.
  var promptHead =
    "당신은 한국인을 대상으로 한국어 상식 퀴즈를 출제합니다. 응시자는 모두 23세~32세의 한국인이며, 한국에서 자란 성인을 기준으로 하되 분야에 따라 대학원 석사 수준의 전문 지식까지 출제할 수 있습니다.\n" +
    "특히 한국사·한국 문화 분야는 한국에서 실제로 통용되는 표현·관습·문헌만 다뤄야 합니다. 한국에 존재하지 않는 외국 속담을 직역해 출제하거나, 한국에서 잘 쓰지 않는 한자성어를 출제하지 마세요.\n" +
    "분야: " + topic + " (이 분야 하나에만 집중)\n" +
    "난이도: 고등학생 일반 상식 ~ 대학원 석사 수준의 전문 지식\n" +
    "형식: " + typeDesc + "\n" +
    "변동 시드(다양성 확보용): " + seed + "\n\n";

  var promptTail =
    "요구사항:\n" +
    "1. 정답이 명확하게 하나로 결정되어야 합니다.\n" +
    "2. 문제 본문 + 보기 전체 합쳐 350자 이내.\n" +
    "3. 주관식 정답은 2~6글자의 단어·고유명사·용어·사건명 (한 단어 위주). 예) 광합성·상대성이론·프랑스혁명 가능. '~하는 것' 같은 문장형·서술형 정답은 금지.\n" +
    "4. 주관식 acceptable에는 정답 본형 + 띄어쓰기 제거형 + 한자/영문 표기 + 동의어 등 2~10개를 배열로 (정답자 매칭은 공백·구두점 무시되니 변형 표기 충분히 넣을 것).\n" +
    "5. 객관식 보기 5개는 헷갈리되 정답은 명확해야 함. 정답 위치는 랜덤하게.\n" +
    "6. 난이도 하한: 대한민국 성인 80% 이상이 보자마자 즉답할 초등학생 수준의 상식은 금지. 예) '훈민정음을 만든 왕은?', '물의 화학식은?' 처럼 누구나 아는 문제 금지.\n" +
    "6-1. 난이도 상한: 대학원 석사 수준의 전문 지식까지 출제 가능합니다(전공자라면 알 만한 개념·이론·용어 환영). 다만 그 분야를 깊이 공부하지 않으면 평생 접할 일 없는 초전문 트리비아나, 단순 암기용 수치·고유명사 나열은 피하고 풀이에 '생각'이 필요한 문제를 노리세요.\n" +
    "7. 한국인이 모를만한 외국인 이름이나 지역명 등 금지 (너무 어려워서 재미없음).\n" +
    "8. 정답이 문제 본문에 어떤 형태로든 노출되면 실격입니다. 다음을 모두 포함:\n" +
    "    - 정답 단어 그 자체, acceptable에 적은 변형, 한자/영문 표기.\n" +
    "    - 정답이 관용구·문장형이라면 표현 전체뿐 아니라 핵심 부분(앞 2어절 이상), 부정⇄긍정 반전형, 시제·어미 변형형까지 전부 금지. 예) 정답이 '첫 단추를 잘못 끼우다'면 '첫 단추를 잘 끼워야 한다', '단추를 끼우다', '첫 단추부터' 도 본문 금지.\n" +
    "    - 정답이 사물의 명사라면 그 사물의 형태·성질을 직접 묘사하는 표현도 금지. 예) 정답이 '원'이면 본문에 '둥근', '원형', '동그란' 등장 금지.\n" +
    "9. 하나의 문제는 반드시 단일 분야('" + topic + "') 안에서만 다뤄야 합니다. 서로 다른 분야를 비교·비유·연결해서 문제로 만들지 마세요. 예: '민주주의 국가의 권력 견제 기관과 비슷하게 컴퓨터 시스템에서는...' 같이 정치와 IT를 엮는 문제는 절대 금지.\n" +
    "9-1. 분야명('" + topic + "') 자체가 정답이 되어선 안 됩니다. 정답은 그 분야 안의 구체적 개념·인물·사건·작품·용어여야 합니다. 예) 분야가 '인테리어'면 정답이 '인테리어'·'실내장식'처럼 분야명 자체나 동의어가 되면 실격.\n" +
    "10. '이', '그', '저', '이것', '그것', '저것', '이러한', '그러한', '이와', '그와', '이를', '그를', '이러한 것', '해당' 같은 지시어·대명사는 **오직 정답을 가리킬 때만** 사용하세요. 정답이 아닌 다른 대상에는 지시어를 쓰지 말고 그 대상의 명사를 그대로 반복해 명확히 서술하세요 (정답이 아닌 것을 '이것/그것' 등으로 가리키면 응시자가 매우 헷갈립니다). 또한 정답 단어의 일부 글자를 가리기 위해 '그것'/'이것' 등 대명사를 따옴표·인용부호로 둘러싸 본문에 노출시키는 행위 절대 금지. 예) '제품명에 \"그것\"이 포함되어 있어' 같이 인용된 대명사로 정답의 일부 글자를 대체하면 실격. 정답을 본문에 직접 적을 수 없다면 대명사로 가리지 말고, 단서(용도·기원·특징 등)만으로 추론하게 하세요.\n" +
    "11. 문제만 읽고도 정답을 합리적으로 추론할 수 있을 만큼 충분하고 **사실에 부합하는** 단서를 본문에 포함하세요. 다음을 반드시 지키세요:\n" +
    "    - 문제에 적은 모든 사실은 정답에 실제로 해당해야 합니다. 정답과 어긋나는 사실을 단서로 쓰면 안 됩니다.\n" +
    "    - 분위기나 인상만 그럴듯한 모호한 묘사로 채우지 말고, 정답을 다른 보기와 구별 짓는 결정적 특징(고유 인물·연도·발견 경위·정의·기능 등)을 최소 1~2개 명시하세요.\n" +
    "    - 단, 요구사항 8(정답 단어 본문 노출 금지)은 유지: 단서는 풍부하되 정답 단어 자체는 본문에 등장 금지.\n" +
    "11-1. 확실히 검증된 사실만 출제하세요. 잘 모르거나 자신 없는 분야·소재라면 억지로 지어내지 말고, 그 문제를 통째로 버리고 당신이 확실히 아는 주제·정답으로 바꾸세요. 그럴듯하게 들리는 추측을 사실인 양 쓰면 실격입니다.\n" +
    "11-2. 정확한 연도·수치·통계, '누가 최초로/유일하게/세계 최대' 같은 단정적 표현은 확실할 때만 단서로 쓰세요. 조금이라도 불확실하면 그런 단정은 빼고, 확실한 일반적 특징만으로 출제하세요.\n" +
    "12. 한 줄 해설은 **문제에 제시된 단서를 그대로 확장·정당화**하는 내용이어야 합니다. 해설이 문제의 단서와 모순되거나 전혀 다른 사실을 들고 와서 정답을 정당화하면 안 됩니다\n" +
    "13. 문제 본문에 정답의 이유·원리·정의를 풀어 적지 마세요. 그건 explanation 필드 전용입니다. '왜 X일까요? Y이기 때문입니다.' 형식처럼 본문 안에서 자문자답·해설을 끝내버리면 실격. 예) '맨홀 뚜껑은 왜 둥글까? 사각형이면 구멍에 빠지기 때문이다.' → 본문이 곧 해설이라 실격. 본문은 단서만, 해설은 explanation 에만.\n" +
    "14. 본문의 모든 문장은 정답을 직접 가리키는 단서여야 합니다. 다음 종류의 군더더기 절대 금지:\n" +
    "    (a) 정답과 무관한 일반 상식·통계·이론·여담을 끼워넣지 마세요. 예) 캐릭터 생일을 묻는 문제에 '생일 역설' 통계 한 문단을 넣는 것 → 정답 단서 0개라 실격.\n" +
    "    (b) '흔히 ~로 알고 있지만 실제로는 ~' 형식의 대조 도입은 그 '흔한 오해'가 **실제로 한국인 사이에서 통용되는 진짜 오해**일 때만 허용. 그럴듯한 가짜 오해를 지어내지 마세요. 예) '플래시 메모리는 흔히 고정·조이는 용도로 알려져 있지만' → 현실에 존재하지 않는 가짜 오해라 실격.\n" +
    "    (c) 본문 길이가 짧아도 좋습니다. 단서만 있으면 2~3문장으로 충분. 분량 채우려고 헛소리 늘리지 마세요.\n" +
    "15. choices 의 각 보기와 answer/acceptable 에는 반드시 **실제 명칭·내용**을 적으세요. '보기1', '보기2', '정답', '본 정답 명칭', '정답 명칭', '<정답>', '세부 분야 한글' 같은 자리표시자·설명문·꺾쇠표기를 그대로 출력하면 즉시 실격입니다. 아래 JSON 예시의 \"보기1\"·\"<정답>\" 등은 형식 안내용 placeholder 일 뿐이므로 전부 실제 값으로 치환하세요.\n" +
    "16. 이 문제의 목표 난이도는 정확히 **" + targetDifficulty + "/5** 입니다. 반드시 이 난이도에 맞춰 출제하세요 (난이도 기준: " + DIFFICULTY_SCALE + "). 너무 쉽거나 어렵게 벗어나지 마세요.\n\n" +
    "★중요★ 최종 자가검증 (JSON을 출력하기 전에 머릿속으로 반드시 거쳐야 하는 단계):\n" +
    "  (a) 내가 정답으로 정한 단어/번호가 문제 본문의 모든 단서를 사실관계상 충족하는가?\n" +
    "  (b) 해설이 정답을 반박하거나 부정하고 있지 않은가? (예: 정답을 '땡기'로 적어놓고 해설에 '땡기는 비표준어'라고 쓰는 자기모순)\n" +
    "  (c) 객관식이라면 답 번호와 보기 배열의 위치가 일치하는가? (answer가 '3'이면 choices[2]가 진짜 정답이어야 함)\n" +
    "  (d) 문제 단서 중 정답이 아닌 다른 보기에 더 잘 맞는 단서가 섞여 있지 않은가?\n" +
    "  (e) 정답 표현의 부분·변형·반전형이 본문에 등장하지 않는가? (관용구는 특별 주의: 정답이 '첫 단추를 잘못 끼우다'면 '첫 단추를 잘 끼워야' 같은 변형도 절대 금지)\n" +
    "  (f) 본문이 정답의 이유·원리를 이미 설명하고 있지 않은가? 본문만 읽고도 '아 그래서 답이 X구나' 라고 풀이가 끝나면 실격.\n" +
    "  (g) 본문의 모든 문장이 정답을 가리키는 단서인가? 정답과 무관한 일반 통계·여담·가짜 오해 도입부가 있다면 그 문장을 통째로 삭제하거나 진짜 단서로 교체.\n" +
    "  (h) choices·answer 에 '보기1'·'정답'·'본 정답 명칭'·'<...>' 같은 자리표시자가 남아있지 않고 전부 실제 명칭으로 채워졌는가?\n" +
    "  하나라도 어긋나면 문제·정답·해설 중 어디든 다시 작성해 일관성을 맞춘 뒤 JSON을 출력하세요. 위 항목을 모두 통과한 상태로만 응답을 내십시오.\n\n" +
    "응답은 아래 JSON 형식만 (다른 텍스트 금지):\n" +
    "{\n" +
    "  \"type\": \"" + (wantMulti ? "multi" : "short") + "\",\n" +
    "  \"topic\": \"<세부 분야 한글>\",\n" +
    "  \"question\": \"<문제 본문>\",\n" +
    "  \"choices\": " + (wantMulti ? "[\"보기1\",\"보기2\",\"보기3\",\"보기4\",\"보기5\"]" : "[]") + ",\n" +
    "  \"answer\": \"" + (wantMulti ? "<1|2|3|4|5>" : "<정답>") + "\",\n" +
    "  \"acceptable\": [\"정답\",\"띄어쓰기제거형\",\"동의어/영문표기\"],\n" +
    "  \"explanation\": \"<1~2문장 해설>\"\n" +
    "}";

  var lastError = "원인 미상";
  var attemptErrors = [];   // 시도별 실패 사유 누적 (성공 시 return 으로 빠져나가므로 실패분만 쌓임)
  var MAX_GEN_ATTEMPTS = 4;
  for (var attempt = 0; attempt < MAX_GEN_ATTEMPTS; attempt++) {
    if (attempt > 0) attemptErrors.push(lastError);   // 직전 시도가 실패했음(성공이면 이미 return) → 사유 기록
    // 직전 시도의 실패 사유(로컬검증·감사 반려 포함)를 다음 프롬프트에 피드백으로 주입해 같은 실수를 교정시킨다.
    var feedback = (attempt > 0)
      ? ("⚠ 직전에 만든 문제는 다음 이유로 반려되었습니다. 그 부분을 반드시 고쳐서 새로 출제하세요:\n  - " + lastError + "\n\n")
      : "";
    // 매 시도마다 금지단어 블록을 새로 만들어 (직전 시도들에서 생성된 답까지 포함) 프롬프트 조립
    var prompt = promptHead + feedback + buildAvoidBlock() + promptTail;
    var res = callGemini(prompt, room);
    if (res.quotaExhausted) { return { _quotaExhausted: true }; }
    if (res.error) { lastError = "API 오류: " + res.error; continue; }

    var data = null;
    try {
      var raw = res.text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
      data = JSON.parse(raw);
    } catch(e) {
      lastError = "JSON 파싱 실패: " + (res.text || "").slice(0, 150);
      continue;
    }

    if (!data || !data.question || data.answer == null) {
      lastError = "필드 누락: " + JSON.stringify(data).slice(0, 150);
      continue;
    }

    // 길이 검증
    var totalLen = String(data.question).length;
    if (data.choices && data.choices.length) {
      for (var i = 0; i < data.choices.length; i++) {
        totalLen += String(data.choices[i] || "").length + 4;
      }
    }
    if (totalLen > MAX_TOTAL_CHARS) { lastError = "길이 초과: " + totalLen + "자"; continue; }

    // 형식 검증
    if (wantMulti) {
      if (!data.choices || data.choices.length !== 5) { lastError = "객관식 보기 수 오류"; continue; }
      var ansNum = String(data.answer).trim();
      if (!/^[1-5]$/.test(ansNum)) { lastError = "객관식 정답 형식 오류: " + ansNum; continue; }
    } else {
      if (!String(data.answer).trim()) { lastError = "주관식 정답 비어있음"; continue; }

      // 정답(및 acceptable 변형)이 문제 본문에 포함되면 실격
      var qNorm = normalize(data.question);
      var leakCandidates = [String(data.answer)];
      if (data.acceptable && data.acceptable.length) {
        for (var ai = 0; ai < data.acceptable.length; ai++) leakCandidates.push(String(data.acceptable[ai]));
      }
      var leaked = null;
      for (var li = 0; li < leakCandidates.length; li++) {
        var cand = normalize(leakCandidates[li]);
        if (cand && cand.length >= 2 && qNorm.indexOf(cand) !== -1) { leaked = leakCandidates[li]; break; }
      }
      if (leaked) { lastError = "정답이 본문에 노출됨: " + leaked; continue; }
    }

    // 실제 정답 텍스트 산출 (객관식이면 보기 텍스트, 주관식이면 정답 단어)
    var answerText = wantMulti
      ? String((data.choices && data.choices[parseInt(String(data.answer), 10) - 1]) || data.answer)
      : String(data.answer);

    var ansNorm = normalize(answerText);

    // 객관식 정답 노출 검사 — 정답 보기 텍스트가 본문에 그대로(공백·구두점 무시) 등장하면 reject.
    // (주관식은 위 else 블록에서 acceptable 변형까지 이미 검사함)
    if (wantMulti && ansNorm && ansNorm.length >= 2 && normalize(data.question).indexOf(ansNorm) !== -1) {
      lastError = "정답이 본문에 노출됨: " + answerText; continue;
    }

    // 자리표시자/메타 텍스트 누출 차단 — 예시 JSON 의 "본 정답 명칭", "보기1", "정답" 등을
    // 실제 명칭 대신 그대로 출제하는 사고 방지. 객관식은 모든 보기, 주관식은 정답을 검사.
    var phTargets = wantMulti ? data.choices.slice() : [answerText];
    var phBad = null;
    for (var pi = 0; pi < phTargets.length; pi++) {
      if (looksLikePlaceholder(phTargets[pi])) { phBad = phTargets[pi]; break; }
    }
    if (phBad) { lastError = "자리표시자/메타 텍스트 누출: " + phBad; continue; }

    // LLM 이 생성한(=형식상 멀쩡한) 정답은 이후 토픽겹침·중복 reject 여부와 무관하게:
    //  (1) quiz_answer_log 에 적재 → "LLM 이 자주 뽑는 답" 빈도 집계 (생성 실패로 끝나도 누락 없음)
    //  (2) 이번 호출의 forbidden 에 추가 → 다음 시도 프롬프트에서 LLM 에게 직접 금지단어로 전달
    logGeneratedAnswer(answerText, data.question, data.topic || topic);
    addForbidden(answerText);

    // 토픽-정답 겹침 차단 (방향에 따라 기준이 다름)
    //  A. 토픽이 정답을 포함 (topic ⊃ answer): 토픽 이름이 정답을 흘림 → 차단.
    //     예) 토픽 "롤 카서스" + 정답 "카서스".
    //  B. 정답이 토픽을 포함 (answer ⊃ topic): 정답이 토픽 확장형. 단, 토픽이 짧은 흔한 단어면
    //     멀쩡한 구체 정답('화학'→'화학결합')도 걸리므로, 토픽이 정답 길이의 80% 이상을 차지해
    //     "사실상 토픽 자체"인 경우만 차단. 예) '화학'→'화학결합'(0.5) 통과, '천문학'→'천문학자'(0.75) 통과,
    //     '화학'→'화학'(1.0) 차단.
    var topicNorm = normalize(topic);
    if (ansNorm && topicNorm && ansNorm.length >= 2 && topicNorm.length >= 2) {
      var overlap = false;
      if (topicNorm.indexOf(ansNorm) !== -1) overlap = true;                                   // A
      else if (ansNorm.indexOf(topicNorm) !== -1 && (topicNorm.length / ansNorm.length) >= 0.8) overlap = true; // B
      if (overlap) {
        lastError = "토픽-정답 겹침: topic='" + topic + "', ans='" + answerText + "'";
        continue;
      }
    }

    // 코드단 하드 중복 검사 — quiz_round 최근 출제 정답과 겹치면 reject (프롬프트 표시 여부와 무관)
    if (ansNorm && dedupSet[ansNorm]) { lastError = "최근 출제 정답 중복: " + answerText; continue; }

    // 빈출 상위 정답 하드 차단 — quiz_answer_log 빈출 50 과 겹치면 reject.
    // (avoid block 으로 이미 금지 안내했으나 LLM 이 어긴 경우. 사유가 다음 시도 피드백으로 전달됨)
    if (ansNorm && freqSet[ansNorm]) { lastError = "출제빈도 상위 정답 재사용: " + answerText; continue; }

    // 2차: 생성과 분리된 감사(audit). 코드로 못 잡는 의미적 위반(정답 노출/정의 복붙, 문제·해설 사실모순,
    // 분야 혼합, 진부함, 단서 부족 등)을 별도 LLM 호출로 체크리스트 판정. ok=false 만 reject(→ 사유가 다음 시도 피드백으로 전달).
    // quota/인프라 오류는 이미 생성·로컬검증을 통과한 문제이므로 감사를 생략하고 통과(fail-open).
    var isLastAttempt = (attempt === MAX_GEN_ATTEMPTS - 1);
    var audit = auditQuiz(data, topic, wantMulti, answerText, isLastAttempt, room);
    if (audit.ok === false) { lastError = "감사 반려(답: " + answerText + "): " + audit.reason; continue; }

    data._topic = data.topic || topic;
    data._type = wantMulti ? "multi" : "short";
    data._difficulty = targetDifficulty;   // 표시 별점 = 추첨한 목표 난이도(분포 보장).
    return data;
  }
  attemptErrors.push(lastError);   // 마지막 시도 실패 사유
  return { _error: lastError, _attempts: attemptErrors };
}

// 2차 감사(audit): 생성과 분리된 별도 LLM 호출로, 코드로 잡기 힘든 의미적 위반을 "체크리스트" 방식으로 판정.
//  - 단일 ok/false 대신 항목별 true/false 를 받아 판정 일관성을 높인다.
//  - hard(노출·사실모순·번호오류·분야혼합·자리표시자)는 무조건 reject.
//  - soft(단서 부족)는 reject 하되, 마지막 시도(isLastAttempt)에서는 통과시켜
//    과도한 reject 로 "생성 실패"가 나는 것을 방지.
//  - quota/인프라/파싱 오류는 이미 생성·로컬검증을 통과한 문제이므로 감사 생략하고 통과(fail-open).
// 반환: { ok:true } | { ok:false, reason }
var AUDIT_FLAGS = {
  // key -> { label, hard }
  answer_leak:       { label: "정답 노출",          hard: true  },
  fact_conflict:     { label: "문제·해설 사실모순",  hard: true  },
  wrong_choice:      { label: "객관식 번호 오류",    hard: true  },
  field_mismatch:    { label: "분야 혼합/분야명 정답", hard: true  },
  placeholder_text:  { label: "자리표시자 누출",      hard: true  },
  insufficient_clue: { label: "단서 부족",          hard: false }
};
function auditQuiz(data, topic, wantMulti, answerText, isLastAttempt, room) {
  var choicesText = "";
  if (wantMulti && data.choices && data.choices.length) {
    var cl = [];
    for (var i = 0; i < data.choices.length; i++) cl.push((i + 1) + ". " + data.choices[i]);
    choicesText = "\n보기:\n" + cl.join("\n");
  }
  var prompt =
    "당신은 한국인 상식 퀴즈 감수자입니다. 아래 퀴즈를 항목별로 위반 여부만 판정하세요. 새 문제를 만들지 말고 판정만 하세요.\n\n" +
    "분야: " + topic + "\n" +
    "형식: " + (wantMulti ? "객관식(answer는 정답 보기 번호)" : "주관식") + "\n" +
    "문제: " + String(data.question) + choicesText + "\n" +
    "정답: " + String(data.answer) + (wantMulti ? (" (=" + answerText + ")") : "") + "\n" +
    "해설: " + String(data.explanation || "") + "\n\n" +
    "각 항목을 true(위반)/false(정상)로 판정:\n" +
    "- answer_leak: 정답 단어·그 변형·한자/영문표기·핵심 일부·대명사 위장이 본문에 노출됨 (정답의 정의·뜻을 풀어쓴 것은 노출이 아니므로 false). 또는 정답이 분야명('" + topic + "') 자체인 경우.\n" +
    "- fact_conflict: 문제의 단서·정답·해설 셋 사이에 사실관계 충돌이 있음. 예) 문제는 '중력으로 빛이 휘는 현상'(→일반상대성이론)을 가리키는데 해설은 '특수상대성이론이 설명한다'고 적음.\n" +
    "- wrong_choice: (객관식) answer 번호가 가리키는 보기가 실제 정답과 다름. (주관식이면 항상 false)\n" +
    "- field_mismatch: 서로 무관한 분야를 억지로 비교·비유·연결해야만 풀리는 문제임(예: 정치와 IT를 엮음). 단, 가까운 하위 분야끼리의 연결(예: 과학 안에서 물리·화학)이나 다른 분야를 배경·예시로 잠깐 언급한 정도는 위반이 아님(false). \n" +
    "- placeholder_text: 보기/정답/해설에 '보기1','정답','본 정답 명칭','<정답>' 같은 자리표시자·메타텍스트가 실제 명칭 대신 남아 있음.\n" +
    "- insufficient_clue: 본문 단서만으로 정답을 합리적으로 추론할 수 없음(단서 부족·모호).\n\n" +
    "응답은 아래 JSON 형식만 출력(다른 텍스트 금지):\n" +
    "{\"answer_leak\":false,\"fact_conflict\":false,\"wrong_choice\":false,\"field_mismatch\":false,\"placeholder_text\":false,\"insufficient_clue\":false}";

  var res = callGemini(prompt, room);
  if (res.quotaExhausted || res.error) return { ok: true };   // 감사를 못 돌리면 통과(fail-open)
  var v;
  try {
    var raw = res.text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    v = JSON.parse(raw);
  } catch(e) { return { ok: true }; }                          // 감사 응답 파싱 실패 → 통과
  if (!v || typeof v !== "object") return { ok: true };

  // 플래그 → hard/soft 위반 사유 수집 (코드에서 최종 판정)
  var hardReasons = [], softReasons = [];
  for (var key in AUDIT_FLAGS) {
    if (v[key] === true) {
      (AUDIT_FLAGS[key].hard ? hardReasons : softReasons).push(AUDIT_FLAGS[key].label);
    }
  }
  if (hardReasons.length) return { ok: false, reason: hardReasons.join(", ") };
  if (softReasons.length && !isLastAttempt) return { ok: false, reason: softReasons.join(", ") };
  return { ok: true };
}

// generateQuiz 의 시도별 lastError 문자열을 사용자용 짧은 요약으로 변환.
function summarizeGenError(err) {
  err = String(err || "");
  function ansAfter(sep) { var i = err.indexOf(sep); return i === -1 ? "" : err.slice(i + sep.length).trim(); }
  if (/^API 오류: HTTP/.test(err)) { var c = err.match(/HTTP\s+(\d+)/); return "HTTP 에러" + (c ? " (" + c[1] + ")" : ""); }
  if (err.indexOf("API 오류:") === 0) return "API 오류";
  if (err.indexOf("JSON 파싱 실패") === 0) return "JSON 파싱 실패";
  if (err.indexOf("필드 누락") === 0) return "필드 누락";
  if (err.indexOf("길이 초과") === 0) return err;   // "길이 초과: N자" 자체가 충분히 짧음
  if (err.indexOf("객관식 보기 수 오류") === 0) return "객관식 보기 수 오류";
  if (err.indexOf("객관식 정답 형식 오류") === 0) return "객관식 정답 형식 오류";
  if (err.indexOf("주관식 정답 비어있음") === 0) return "주관식 정답 비어있음";
  if (err.indexOf("정답이 본문에 노출됨:") === 0) return "정답 본문 노출 (답: " + ansAfter("정답이 본문에 노출됨:") + ")";
  if (err.indexOf("자리표시자") === 0) return "자리표시자 누출";
  if (err.indexOf("토픽-정답 겹침:") === 0) { var m = err.match(/ans='([^']*)'/); return "토픽-정답 겹침" + (m ? " (답: " + m[1] + ")" : ""); }
  if (err.indexOf("최근 출제 정답 중복:") === 0) return "중복문제 (답: " + ansAfter("최근 출제 정답 중복:") + ")";
  if (err.indexOf("감사 반려") === 0) {
    var am = err.match(/^감사 반려\(답: ([\s\S]*?)\):\s*([\s\S]*)$/);
    if (!am) return "내부 검증 통과 X";
    var labels = (am[2] || "").trim();
    return (labels ? labels : "내부 검증 통과 X") + " (답: " + am[1] + ")";
  }
  return err || "원인 미상";
}

// ── 퀴즈 진행 ────────────────────────────────────────────────────────
// startQuiz 는 워커 스레드에서 호출됨.
// Gemini 호출은 시간이 길어(5~30s) 워커를 막으면 안 되니 별도 스레드에서 돌리되,
// 결과(data 또는 error)는 큐로 다시 보내서 워커 스레드 위에서 quiz 상태를 변경.
function startQuiz(msg, customTopic, requesterHash, quiz, chanId) {
  if (quiz.active || quiz.generating) {
    msg.reply("이미 퀴즈가 진행 중입니다.");
    return;
  }
  quiz.generating = true;
  msg.reply(customTopic
    ? "🧠 \"" + customTopic + "\" 토픽 퀴즈 생성 중..."
    : "🧠 상식 퀴즈를 생성 중입니다...");

  var room = msg.room;
  new java.lang.Thread(function() {
    var data = null, error = null;
    try { data = generateQuiz(customTopic, room); }
    catch(e) { error = (e && e.message) ? e.message : String(e); }

    try {
      if (!data || data._error || data._quotaExhausted) {
        msgQueue.put({ type: "quiz_fail", room: room, chanId: chanId,
          quotaExhausted: !!(data && data._quotaExhausted),
          attempts: (data && data._attempts) ? data._attempts : null,
          error: (data && data._error) ? data._error : (error || "알 수 없음") });
      } else {
        // 생성 성공 시에만 토픽 출제 횟수 차감 (해시 기준)
        if (customTopic && requesterHash) {
          try { recordTopicRequest(requesterHash); } catch(_) {}
        }
        msgQueue.put({ type: "quiz_ready", room: room, chanId: chanId, data: data });
      }
    } catch(_) {}
  }).start();
}

// 난이도(1~5) → 별점 문자열. 예) 3 → "★★★☆☆"
function difficultyStars(n) {
  n = parseInt(n, 10);
  if (isNaN(n) || n < 1) n = 1; else if (n > 5) n = 5;
  return new Array(n + 1).join("★") + new Array(6 - n).join("☆");
}

function startActiveQuiz(room, data, quiz, chanId) {
  quiz.generating = false;
  quiz.active = true;
  quiz.room = room;
  quiz.type = data._type;
  quiz.topic = data._topic || "";
  quiz.question = String(data.question);
  quiz.choices = data.choices || [];
  quiz.answer = String(data.answer);
  quiz.explanation = data.explanation || "";
  quiz.difficulty = data._difficulty || 3;
  quiz.startTime = nowMs();

  if (quiz.type === "multi") {
    quiz.correctIndex = parseInt(quiz.answer, 10);
    quiz.acceptable = [String(quiz.correctIndex)];
  } else {
    var acc = [normalize(quiz.answer)];
    if (data.acceptable && data.acceptable.length) {
      for (var i = 0; i < data.acceptable.length; i++) {
        // 예시 JSON 의 "정답" 등 자리표시자가 acceptable 에 섞이면 오답이 정답 처리될 수 있어 제외
        if (looksLikePlaceholder(data.acceptable[i])) continue;
        var n = normalize(data.acceptable[i]);
        if (n && acc.indexOf(n) === -1) acc.push(n);
      }
    }
    quiz.acceptable = acc;
  }

  var lines = [];
  lines.push("🧠 주제: " + (data._topic || "상식") + " " + difficultyStars(quiz.difficulty));
  lines.push("━━━━━━━━━━━━━");
  lines.push(quiz.question);
  if (quiz.type === "multi") {
    for (var j = 0; j < quiz.choices.length; j++) {
      lines.push("  " + (j + 1) + ". " + quiz.choices[j]);
    }
  }
  lines.push("━━━━━━━━━━━━━");
  lines.push(quiz.type === "multi"
    ? "💬 !ㅈㄷ [번호]"
    : "💬 !ㅈㄷ [답]");
  lines.push("⏰ 30초 내 1회 제출 (재도전 불가)");

  bot.send(room, lines.join("\n"));

  // 정답 공개 타이머도 워커 큐를 거치게 해서 직렬화.
  // chanId 를 클로저에 캡처해 reveal 태스크에 실어 보낸다 → 다른 방 타이머가 이 방 퀴즈를 공개하지 못하게 함.
  var th = new java.lang.Thread(function() {
    try {
      java.lang.Thread.sleep(REVEAL_DELAY_MS);
      // CTX_TOKEN 을 실어 보낸다 → 재컴파일된 새 컨텍스트는 옛 토큰의 reveal 을 무시.
      try { msgQueue.put({ type: "reveal", chanId: chanId, token: CTX_TOKEN }); } catch(_) {}
    } catch(_) { /* interrupted = 종료 */ }
  });
  // 이름을 붙여 재컴파일 시 killOldThreads(프리픽스 매칭)가 옛 타이머를 정리할 수 있게 한다.
  th.setName(REVEAL_THREAD_PREFIX + ":" + chanId);
  quiz.revealThread = th;
  // 스레드 레지스트리 등록(!스레드 노출/킬 가능). 방별 고유 이름이라 replace=true 가 같은 방 옛 타이머만 교체. 실패 무시.
  try {
    var _tregR = require(Packages.android.os.Environment.getExternalStorageDirectory().getAbsolutePath() + "/msgbot/lib/thread-registry.js");
    _tregR.registerThread(REVEAL_THREAD_PREFIX + ":" + chanId, BOT_NAME, th);
  } catch(_) {}
  th.start();
}

function submitAnswer(msg, raw, quiz, chanId) {
  if (!quiz.active) return;
  if (msg.room !== quiz.room) return;
  if (quiz.winnerPid) return; // 이미 우승자 결정됨

  var elapsed = nowMs() - quiz.startTime;
  if (elapsed > ANSWER_WINDOW_MS) {
    // 마감(=정답 공개)과 동시 처리되므로 별도 "제출 종료" 안내 없이 조용히 무시
    return;
  }

  var hash = msg.author.hash || "";
  var who = (function(){ try { return kt.resolveSender(msg); } catch(_) { return null; } })();
  var name = (who && who.name) ? who.name : (msg.author.name || "익명");
  // pid: hash가 있으면 hash, 없으면 "noname:" + name 합성 키 (anon 들이 같은 이름이면 그대로 충돌)
  var pid = hash || ("noname:" + name);

  // 1회 제한
  if (quiz.participants[pid]) {
    var p = quiz.participants[pid];
    if (!p.notified) {
      p.notified = true;
      msg.reply(name + "님은 이미 제출하셨습니다.");
    }
    return;
  }

  var norm = normalize(raw);
  if (!norm) return;

  if (quiz.type === "multi" && !/^[1-5]$/.test(norm)) {
    msg.reply("객관식: 1~5 숫자로 제출해주세요.");
    return;
  }

  // 주관식 정답은 항상 짧음 — 길이 초과 시 무시 (오타·실수 메시지 차단)
  if (quiz.type === "short" && String(raw).trim().length > 30) {
    return;
  }

  var isCorrect = (quiz.acceptable.indexOf(norm) !== -1);
  quiz.participants[pid] = {
    hash: pid,           // 통계 INSERT 시 사용할 식별자 (합성 해시 포함)
    name: name,
    wrongCount: isCorrect ? 0 : 1,
    raw: String(raw),
    notified: false
  };

  if (isCorrect) {
    quiz.winnerPid = pid;
    quiz.winnerName = name;
    quiz.winnerRaw = String(raw);
    quiz.winnerTimeMs = elapsed;
    revealAnswer(quiz, chanId);
  } else {
    msg.reply("❌ " + name + "님 오답: " + raw);
  }
}

function revealAnswer(quiz, chanId) {
  if (!quiz || !quiz.active) return;
  var room = quiz.room;

  // 참여자 통계 기록 (hash 기반)
  var pids = Object.keys(quiz.participants);
  for (var i = 0; i < pids.length; i++) {
    var pid = pids[i];
    var p = quiz.participants[pid];
    recordParticipation(p.hash, p.name, pid === quiz.winnerPid, p.wrongCount, room);
  }

  // 라운드 저장 (이의신청용)
  //  - 객관식의 quiz.answer 는 "3" 같은 인덱스 문자열이라 DB 에는 실제 정답 텍스트를 저장 (이의신청 표시·가독성)
  //  - 정답 중복 회피 풀은 quiz_answer_log (생성 시점 적재) 가 담당
  var savedAnswer = quiz.type === "multi"
    ? String(quiz.choices[quiz.correctIndex - 1] || quiz.answer)
    : quiz.answer;
  var roundNum = nextRoundNum(room);
  try {
    saveRound(room, roundNum, {
      type: quiz.type,
      topic: quiz.topic,
      question: quiz.question,
      choices: quiz.choices,
      answer: savedAnswer,
      correctIndex: quiz.correctIndex,
      explanation: quiz.explanation
    });
    for (var i = 0; i < pids.length; i++) {
      var pid = pids[i];
      var p = quiz.participants[pid];
      saveRoundParticipant(room, roundNum, p.name, p.hash, pid === quiz.winnerPid, p.wrongCount, p.raw);
    }
  } catch(_) {}

  var lines = [];
  if (quiz.winnerPid) {
    var secs = Math.round(quiz.winnerTimeMs / 100) / 10;
    lines.push("🏆 " + quiz.winnerName + " 정답! (" + secs + "초, +10점)");
  } else {
    lines.push("⏰ 시간 종료! 정답자 없음");
  }
  lines.push("━━━━━━━━━━━━━");
  if (quiz.type === "multi") {
    var idx = quiz.correctIndex - 1;
    var ansText = (idx >= 0 && idx < quiz.choices.length) ? quiz.choices[idx] : "";
    lines.push("정답: " + quiz.correctIndex + "번. " + ansText);
  } else {
    lines.push("정답: " + quiz.answer);
  }
  if (quiz.explanation) lines.push("📖 " + quiz.explanation);

  // 오답자 목록
  var wrongList = [];
  for (var k = 0; k < pids.length; k++) {
    var pid2 = pids[k];
    if (pid2 === quiz.winnerPid) continue;
    var p2 = quiz.participants[pid2];
    wrongList.push(p2.name + "(" + p2.raw + ")");
  }
  if (wrongList.length) {
    lines.push("━━━━━━━━━━━━━");
    lines.push("❌ 오답자\n" + wrongList.join("\n"));
  }
  lines.push("");
  lines.push("새 퀴즈는  !상식");
  // 참여자가 한 명도 없으면 이의신청 안내 생략 (어차피 신청자 자격 없음)
  if (pids.length > 0) {
    lines.push("이의신청: !이의신청 " + roundNum);
  }

  bot.send(room, lines.join("\n"));
  lastRevealMsByChan[chanId] = nowMs();   // 공개 직후 늦은 !상식/!ㅅㅅ+단어 입력을 무시하기 위한 기준 시각 (방별)
  resetQuiz(quiz, chanId);
}

// ── 이의신청 ────────────────────────────────────────────────────────
function handleAppeal(msg, numArg) {
  var room = msg.room;
  var round;
  if (numArg) {
    var n = parseInt(numArg, 10);
    if (!n || isNaN(n)) { msg.reply("회차 번호는 숫자만 입력하세요. 예: !이의신청 42"); return; }
    round = getRoundByNum(room, n);
    if (!round) { msg.reply("#" + n + " 회차를 찾을 수 없습니다."); return; }
  } else {
    round = getLatestRound(room);
    if (!round) { msg.reply("최근 채점된 퀴즈가 없습니다."); return; }
  }

  if (round.appealState === 1) { msg.reply("#" + round.num + " 회차 이의신청이 처리 중입니다."); return; }
  if (round.appealState === 2) {
    msg.reply("#" + round.num + " 회차는 이미 이의신청이 처리되었습니다. (판정: " + (round.appealVerdict || "?") + ")");
    return;
  }

  // 오답자만 신청 가능
  var hash = msg.author.hash || "";
  var parts = getRoundParticipants(room, round.num);
  var found = null;
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].hash === hash) { found = parts[i]; break; }
  }
  if (!found) { msg.reply("이의신청은 해당 회차에 답안을 제출한 사람만 가능합니다."); return; }
  if (found.wasWinner) { msg.reply("정답자는 이의신청할 수 없습니다."); return; }

  // 일일 이의신청 한도 — 일반 참여자만 적용, (이 방의) API 키 제공자는 무제한
  if (!isApiProvider(hash, room)) {
    var appealCnt = countRecentAppeals(hash);
    if (appealCnt >= APPEAL_LIMIT_DEFAULT) {
      msg.reply("⏰ " + (msg.author.name || "익명") + "님은 오늘 이의신청 한도(" + APPEAL_LIMIT_DEFAULT + "회)에 도달했습니다." +
        "\n(API 키 제공 시 무제한)" +
        "\nhttps://aistudio.google.com/api-keys 에서 API 키를 만들고 \n" +
        "봇과 1:1 채팅에서 !api 발급받은키 를 입력하면 등록됩니다.");
      return;
    }
  }

  setAppealState(room, round.num, 1);
  try { recordAppeal(hash); } catch(_) {}
  msg.reply("🔍 #" + round.num + " 회차 이의신청 검토 중...");

  // 검토 대상: 이 회차의 모든 비정답 참여자(답안 제출자). 통계 보정도 이들을 대상으로 한다.
  var reviewees = [];
  for (var j = 0; j < parts.length; j++) {
    var pp = parts[j];
    if (pp.wasWinner) continue;
    if (!String(pp.rawAnswer || "").trim()) continue;
    reviewees.push({
      name: pp.name,
      hash: pp.hash,
      wrongCount: pp.wrongCount,
      rawAnswer: pp.rawAnswer || ""
    });
  }

  // LLM 에 넘길 제출 답안 목록 (정규화 기준 중복 제거)
  var submittedAnswers = [];
  var seen = {};
  for (var k = 0; k < reviewees.length; k++) {
    var a = String(reviewees[k].rawAnswer || "").trim();
    if (!a) continue;
    var nk = normalize(a);
    if (seen[nk]) continue;
    seen[nk] = true;
    submittedAnswers.push(a);
  }

  new java.lang.Thread(function() {
    var result = null, error = null;
    try { result = verifyQuizAnswer(round, submittedAnswers, room); }
    catch(e) { error = (e && e.message) ? e.message : String(e); }
    try {
      msgQueue.put({ type: "appeal_result", room: room, num: round.num, result: result, error: error, reviewees: reviewees });
    } catch(_) {}
  }).start();
}

function verifyQuizAnswer(round, submittedAnswers, room) {
  var choicesText = "";
  if (round.type === "multi" && round.choices && round.choices.length) {
    for (var i = 0; i < round.choices.length; i++) {
      choicesText += (i + 1) + ". " + round.choices[i] + "\n";
    }
  }
  var officialAnswer = round.type === "multi"
    ? (round.correctIndex + "번 (" + (round.choices[round.correctIndex - 1] || "?") + ")")
    : round.answer;

  var answers = submittedAnswers || [];
  var submittedBlock = "";
  if (answers.length) {
    submittedBlock = "참여자들이 제출한 답안 목록:\n";
    for (var s = 0; s < answers.length; s++) {
      submittedBlock += (s + 1) + ". \"" + answers[s] + "\"\n";
    }
  }

  var prompt =
    "다음 상식 퀴즈의 공식 정답이 사실관계상 정확한지, 그리고 참여자들이 제출한 각 답안이 정답으로 인정될 수 있는지 엄정히 검토하세요.\n\n" +
    "문제: " + round.question + "\n" +
    (choicesText ? "보기:\n" + choicesText : "") +
    "공식 정답: " + officialAnswer + "\n" +
    submittedBlock +
    "출제자 해설: " + (round.explanation || "(없음)") + "\n\n" +
    "검토 항목:\n" +
    "1. 공식 정답이 사실에 부합하는가?\n" +
    "2. 문제 본문의 단서가 공식 정답과 모순되지 않는가?\n" +
    "3. (객관식) 보기 중 공식 정답보다 명백히 더 적절한 답이 있는가?\n" +
    "4. 제출된 각 답안이 문제의 단서·사실관계에 비추어 정답으로 인정될 수 있는가? (공식 정답과 동등하거나, 공식 정답보다 더 맞거나, 동의어·이표기 등으로 같은 답인지 등)\n\n" +
    "판정 기준 (verdict):\n" +
    "- correct: 공식 정답이 분명히 맞다. 사실관계·단서 모두 부합.\n" +
    "- incorrect: 공식 정답이 분명히 틀렸다. 다른 답이 명백히 맞다.\n" +
    "- ambiguous: 본문 단서가 부족하거나, 여러 답이 가능하거나, 사실관계가 모호.\n\n" +
    "응답은 아래 JSON 형식만 (submissions 배열에는 위 '제출한 답안 목록'의 각 답안을 빠짐없이, 제출된 텍스트 그대로 넣으세요):\n" +
    "{\n" +
    "  \"verdict\": \"correct\" 또는 \"incorrect\" 또는 \"ambiguous\",\n" +
    "  \"reasoning\": \"1~3문장 한국어 검토 의견 (공식 정답에 대한)\",\n" +
    "  \"better_answer\": \"<공식 정답보다 더 적절한 답이 있으면 적고, 없으면 빈 문자열>\",\n" +
    "  \"submissions\": [\n" +
    "    { \"answer\": \"<제출된 답안 그대로>\", \"acceptable\": true 또는 false, \"reasoning\": \"1~2문장 한국어 - 인정/불인정 이유\" }\n" +
    "  ]\n" +
    "}";

  var res = callGemini(prompt, room);
  if (res.quotaExhausted) return { _quotaExhausted: true };
  if (res.error) return { _error: res.error };
  try {
    var raw = res.text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    var data = JSON.parse(raw);
    if (!data.verdict) return { _error: "verdict 누락" };
    if (["correct","incorrect","ambiguous"].indexOf(data.verdict) === -1) {
      return { _error: "잘못된 verdict: " + data.verdict };
    }
    if (!data.submissions || !(data.submissions instanceof Array)) data.submissions = [];
    return data;
  } catch(e) {
    return { _error: "JSON 파싱 실패: " + (res.text || "").slice(0, 150) };
  }
}

function showRanking(msg) {
  var top = getRanking(20, msg.room);
  if (!top.length) {
    msg.reply("순위 데이터가 없습니다.");
    return;
  }
  var lines = ["상식 퀴즈 랭킹", "점수 = 정답×10 − 오답×1", "━━━━━━━━━━━━━"];
  for (var i = 0; i < top.length; i++) {
    var u = top[i];
    lines.push(
      (i + 1) + "위 " + u.name.split("").join("​") +
      "\n " + u.score + "점 정:" + u.wins +
      "/오:" + u.wrong +
      "(" + (u.wins / (u.wins + u.wrong) * 100).toFixed(1) + "%)"
    );
    if (i === 2 && top.length > 3) lines[lines.length - 1] = lines[lines.length - 1] + LONG_MSG_SPACER;   // 3위와 4위 사이 접기(더보기) 처리
  }
  msg.reply(lines.join("\n"));
}

// 빈출 정답(=새 문제에서 회피하는 금지목록) 상위 50개. 5위까지 미리보기, 이후는 더보기로 접음.
function showForbiddenList(msg) {
  var rows = getFrequentAnswersWithCount(50);
  if (!rows.length) {
    msg.reply("금지목록 데이터가 없습니다.");
    return;
  }
  var lines = ["🚫 금지목록 (빈출 정답 TOP " + rows.length + ")", "자주 생성된 정답일수록 새 문제에서 회피", "━━━━━━━━━━━━━"];
  for (var i = 0; i < rows.length; i++) {
    lines.push((i + 1) + ". " + rows[i].answer + " (" + rows[i].count + "회)");
    if (i === 4 && rows.length > 5) lines[lines.length - 1] = lines[lines.length - 1] + LONG_MSG_SPACER;   // 5위와 6위 사이 접기(더보기) 처리
  }
  msg.reply(lines.join("\n"));
}

// ── 프리필터: 이 봇이 처리할 명령인지 빠르게 판별 ─────────────────
function isGameCommand(text) {
  if (!text) return false;
  if (text === "!상식" || text === "!ㅅㅅ") return true;
  if (text === "!상식종료") return true;
  if (text === "!상식순위") return true;
  if (text === "!금지목록") return true;
  if (text === "!이의신청") return true;
  if (text.indexOf("!이의신청 ") === 0) return true;
  if (text.indexOf("!ㅈㄷ") === 0 && text.length > 4) return true;
  if (text.indexOf("!상식 ") === 0 && text.length > 4) return true;
  if (text.indexOf("!ㅅㅅ ") === 0 && text.length > 4) return true;
  if (text.indexOf("!api ") === 0 && text.length > 5) return true;
  return false;
}

// ── 메시지 직렬화 큐 + 워커 스레드 ─────────────────────────────────
// 큐에는 두 종류가 섞여 들어옴:
//   1) ChatManager broadcast 메시지 (java.util.HashMap)
//   2) 내부 이벤트 (JS 객체): { type: "quiz_ready" | "quiz_fail" | "reveal" }
// 워커가 instanceof 로 분기해 처리.
var msgQueue = new java.util.concurrent.LinkedBlockingQueue();
var WORKER_NAME = "QUIZ_BOT_WORKER";

(function killOldThreads() {
  try {
    var root = java.lang.Thread.currentThread().getThreadGroup();
    while (root.getParent() != null) root = root.getParent();
    var n = root.activeCount() + 32;
    var arr = java.lang.reflect.Array.newInstance(java.lang.Thread, n);
    var got = root.enumerate(arr, true);
    for (var i = 0; i < got; i++) {
      var t = arr[i];
      if (!t) continue;
      // 워커 + 옛 컨텍스트의 reveal 타이머(프리픽스 매칭)를 함께 정리한다.
      var tn = String(t.getName() || "");
      if (tn === WORKER_NAME || tn.indexOf(REVEAL_THREAD_PREFIX) === 0) {
        try { t.interrupt(); } catch(_) {}
      }
    }
  } catch(_) {}
})();

// ── ChatManager 레지스트리에 자신을 등록 ───────────────────────────
// 재컴파일 시 같은 이름으로 put → 옛 큐가 새 큐로 교체됨 (멱등).
// ChatManager 가 아직 안 떠 있으면 레지스트리만 미리 만들어두고 큐를 등록.
// ChatManager 가 나중에 뜨면 같은 ConcurrentHashMap 을 보게 됨.
(function registerWithChatManager() {
  try {
    var sysProps = java.lang.System.getProperties();
    var REG_KEY = "__CHATMANAGER_REGISTRY__";
    var registry = sysProps.get(REG_KEY);
    if (registry == null) {
      registry = new java.util.concurrent.ConcurrentHashMap();
      sysProps.put(REG_KEY, registry);
    }
    registry.put(BOT_NAME, msgQueue);
  } catch(_) {}
})();

var _worker = new java.lang.Thread(function() {
  while (!java.lang.Thread.currentThread().isInterrupted()) {
    var task = null;
    try { task = msgQueue.take(); } catch(_) { return; } // interrupt → exit
    try {
      if (task instanceof java.util.HashMap) {
        // ChatManager 에서 온 외부 메시지
        var text = String(task.get("text") || "").trim();
        var room = String(task.get("room") || "");
        var name = String(task.get("name") || "익명");
        var hash = String(task.get("hash") || "");
        var channelId = String(task.get("channelId") || "");   // 방별 진행 상태/타이머 라우팅 키
        // !api 등록 세션 진행 중인 사용자는 일반 명령이 아니어도(방/닉네임 입력 등) 받아줘야 함
        var inSession = !!apiSessions[apiSessionKey(room, hash || name)];
        if (!inSession && !isGameCommand(text)) continue;
        var msg = {
          content: text,
          room: room,
          channelId: channelId,
          author: { name: name, hash: hash },
          reply: (function(r) { return function(s) { try { bot.send(r, s); } catch(_) {} }; })(room)
        };
        if (inSession && handleApiSession(msg)) continue;  // 세션이 소비하면 일반 처리 건너뜀
        handleMessage(msg);
      } else {
        // 내부 이벤트 (quiz_ready / quiz_fail / reveal)
        processTask(task);
      }
    } catch(_) {}
  }
}, WORKER_NAME);
try {
  var _treg = require(Packages.android.os.Environment.getExternalStorageDirectory().getAbsolutePath() + "/msgbot/lib/thread-registry.js");
  _treg.registerThread(WORKER_NAME, BOT_NAME, _worker);
} catch(_) {}
_worker.start();

function processTask(task) {
  if (!task) return;
  if (task.type === "reveal") {
    // 옛 JS 컨텍스트(재컴파일 전)의 타이머가 발화한 stale reveal 은 무시 — 같은 방 새 퀴즈 조기공개 방지.
    if (task.token && task.token !== CTX_TOKEN) return;
    // 이 방(chanId)의 상태만 공개. 다른 방 타이머가 끼어들어 엉뚱한 방을 공개하지 못하게 가드.
    var rq = quizzes[task.chanId];
    if (rq && rq.active) revealAnswer(rq, task.chanId);
    return;
  }
  if (task.type === "quiz_ready") {
    var aq = quizzes[task.chanId] || (quizzes[task.chanId] = newQuizState());
    startActiveQuiz(task.room, task.data, aq, task.chanId);
    return;
  }
  if (task.type === "quiz_fail") {
    var fq = quizzes[task.chanId] || (quizzes[task.chanId] = newQuizState());
    fq.generating = false;
    if (task.quotaExhausted) {
      bot.send(task.room,
        "사용가능 API [0/" + API_KEYS.length + "]\n상식퀴즈 일시적으로 사용 불가\n\n" +
        "👉 https://aistudio.google.com/api-keys 에서 API 키를 만들고 \n" +
        "봇과 1:1 채팅에서 !api 발급받은키 를 입력하면 등록됩니다.\n" + 
        "api 제공자는 토픽 제출 횟수가 45회로 상향됩니다");
    } else {
      // 시도별 실패 사유를 요약해 안내
      var lines = ["❗ 퀴즈 생성 실패"];
      if (task.attempts && task.attempts.length) {
        for (var ai = 0; ai < task.attempts.length; ai++) {
          lines.push((ai + 1) + ". " + summarizeGenError(task.attempts[ai]));
        }
      } else {
        lines.push(summarizeGenError(task.error));   // 예외 등으로 시도 내역이 없을 때
      }
      bot.send(task.room, lines.join("\n"));
    }
    return;
  }
  if (task.type === "appeal_result") {
    processAppealResult(task.room, task.num, task.result, task.error, task.reviewees);
    return;
  }
  if (task.type === "api_test_result") {
    // 키 검증 결과(별도 스레드) → 워커 스레드에서 세션 시작/거절 (apiSessions 는 워커 전용 상태)
    var m = {
      content: "", room: task.room,
      author: { name: task.name || "익명", hash: task.hash || "" },
      reply: (function(r) { return function(s) { try { bot.send(r, s); } catch(_) {} }; })(task.room)
    };
    // ok(정상응답) 또는 quota(429) 모두 "유효한 키"로 간주하고 등록 진행.
    //  - 429 는 키가 유효하나 현재 한도 소진 상태일 뿐 → 등록해두면 한도 회복 후 사용됨.
    if (task.status === "ok" || task.status === "quota") {
      startApiSession(m, task.key);
    } else if (task.status === "invalid") {
      m.reply("❌ 유효하지 않은 API 키입니다.\nhttps://aistudio.google.com/api-keys 에서 키를 다시 확인해주세요.");
    } else {
      m.reply("키 검증 중 통신 오류가 발생했습니다. 잠시 후 다시 시도해주세요.");
    }
    return;
  }
}

function processAppealResult(room, num, result, error, reviewees) {
  // 모든 API 사용량 한도 초과 → 상태 복원 후 안내
  if (result && result._quotaExhausted) {
    setAppealState(room, num, 0);  // 재신청 가능하도록 되돌림
    bot.send(room,
      "사용가능 API [0/" + API_KEYS.length + "]\n#" + num + " 회차 이의신청 일시적으로 사용 불가\n\n" +
      "👉 https://aistudio.google.com/api-keys 에서 API 키를 만들고 \n" +
      "봇과 1:1 채팅에서 !api 발급받은키 를 입력하면 등록됩니다.\n" +
      "api 제공자는 토픽 제출 횟수가 45회로 상향됩니다");
    return;
  }
  // API 실패 → 상태 복원 후 안내
  if (!result || result._error) {
    setAppealState(room, num, 0);  // 재신청 가능하도록 되돌림
    bot.send(room, "❗ #" + num + " 회차 이의신청 검토 실패\n사유: " + (error || (result && result._error) || "알 수 없음") + "\n다시 시도해보세요.");
    return;
  }

  var verdict = result.verdict;
  var reasoning = result.reasoning || "";
  var better = result.better_answer || "";
  var submissions = result.submissions || [];
  reviewees = reviewees || [];

  saveAppealResult(room, num, verdict, reasoning);

  var lines = ["🔍 #" + num + " 회차 이의신청 검토 결과"];
  if (verdict === "correct") {
    lines.push("판정: ✅ 정답 유지");
  } else if (verdict === "incorrect") {
    lines.push("판정: ❌ 공식 정답 오류 (이 회차 점수/오답 통계 무효화)");
  } else {
    lines.push("판정: ⚠️ 모호함 (점수는 유지)");
  }
  if (reasoning) lines.push("사유: " + reasoning);
  if (better) lines.push("더 적절한 답: " + better);

  // 인정된 제출 답안(정규화 기준) 집합 구성
  var acceptedNorms = {};
  if (submissions.length) {
    lines.push("━━━━━━━━━━━━━");
    lines.push("제출 답안 검토");
    for (var i = 0; i < submissions.length; i++) {
      var sub = submissions[i] || {};
      var ans = String(sub.answer || "").trim();
      if (!ans) continue;
      var ok = sub.acceptable === true;
      if (ok) acceptedNorms[normalize(ans)] = true;
      var ln = "- \"" + ans + "\" → " + (ok ? "⭕ 인정" : "❌ 불인정");
      if (sub.reasoning) ln += " (" + sub.reasoning + ")";
      lines.push(ln);
    }
  }

  // 통계 처리:
  //  - verdict=incorrect → 회차 전체 무효화
  //  - else → 답안이 인정된 비정답 참여자별로 보정 (wrong -wrongCount, wins +1)
  if (verdict === "incorrect") {
    try { revertRoundStats(room, num); } catch(e) {
      lines.push("(통계 복원 중 오류: " + (e && e.message ? e.message : e) + ")");
    }
  } else {
    var correctedNames = [];
    for (var j = 0; j < reviewees.length; j++) {
      var rv = reviewees[j];
      if (!rv.hash) continue;
      if (!acceptedNorms[normalize(rv.rawAnswer || "")]) continue;
      try {
        correctAppellantStats(room, rv.hash, rv.wrongCount);
        correctedNames.push(rv.name || "익명");
      } catch(e) {
        lines.push("(" + (rv.name || "익명") + " 통계 보정 중 오류: " + (e && e.message ? e.message : e) + ")");
      }
    }
    if (correctedNames.length) {
      lines.push("→ " + correctedNames.join(", ") + " 통계 보정: 오답 -1 / 정답 +1");
    }
  }

  bot.send(room, lines.join("\n"));
}

// ── !api 키 등록 대화 세션 (개인채팅) ─────────────────────────────────
// 개인채팅에선 그 사람이 어느 방의 누구인지(=토픽한도 우대에 쓸 hash) 알 수 없으므로,
// 방 이름 → 닉네임을 단계적으로 물어 userhash.db 에서 실제 hash 를 해석한 뒤 등록한다.
// 워커 스레드 단일 처리라 별도 락 없이 안전. (apiSessions/API_SESSION_TTL_MS 선언은 상단에 hoist)

function apiSessionKey(room, hash) { return String(room) + "\x00" + String(hash); }

function startApiSession(msg, key) {
  var sk = apiSessionKey(msg.room, msg.author.hash || msg.author.name || "");
  apiSessions[sk] = {
    step: "room", key: key, requesterName: msg.author.name || "익명",
    room: "", nameCands: [], ts: nowMs()
  };
  msg.reply("🔑 키를 받았습니다. (" + maskKey(key) + ")\n등록을 위해 확인이 필요합니다.\n\n" +
            "퀴즈를 이용하는 채팅방 이름의 일부를 입력해주세요.\n(취소하려면 '취소' 입력)");
}

// 세션 메시지 처리. 이 메시지를 세션이 소비했으면 true (→ 일반 명령 처리 건너뜀).
function handleApiSession(msg) {
  var sk = apiSessionKey(msg.room, msg.author.hash || msg.author.name || "");
  var s = apiSessions[sk];
  if (!s) return false;
  if ((nowMs() - s.ts) > API_SESSION_TTL_MS) { delete apiSessions[sk]; return false; }  // 만료 → 일반 처리

  var text = String(msg.content || "").trim();
  if (text.indexOf("!api ") === 0) { delete apiSessions[sk]; return false; }  // 새 등록 → 일반 핸들러가 재시작
  if (text === "취소" || text === "!취소") { delete apiSessions[sk]; msg.reply("API 키 등록을 취소했습니다."); return true; }
  if (!text) return true;
  s.ts = nowMs();

  if (s.step === "room") {
    var rooms = findRoomsByPartial(text);
    if (!rooms.length) {
      msg.reply("'" + text + "' 에 해당하는 방을 찾지 못했습니다.\n방 이름의 일부를 다시 입력해주세요.");
    } else if (rooms.length === 1) {
      s.room = rooms[0]; s.step = "name";
      msg.reply("방 확인: " + s.room + "\n\n본인의 닉네임 일부를 입력해주세요.");
    } else {
      var shown = rooms.slice(0, 10);
      msg.reply("여러 방이 검색되었습니다:\n- " + shown.join("\n- ") +
        (rooms.length > 10 ? "\n…(총 " + rooms.length + "개)" : "") +
        "\n\n더 구체적으로 방 이름을 다시 입력해주세요.");
    }
    return true;
  }

  if (s.step === "name") {
    var cands = findNamesByPartial(s.room, text);
    if (!cands.length) {
      msg.reply("방 '" + s.room + "' 에서 '" + text + "' 에 해당하는 닉네임을 찾지 못했습니다.\n닉네임 일부를 다시 입력해주세요.");
    } else if (cands.length === 1) {
      finalizeApiSession(msg, sk, s, cands[0]);
    } else {
      s.nameCands = cands.slice(0, 9); s.step = "name_choice";
      var lines = ["여러 명이 검색되었습니다. 번호를 입력해주세요:"];
      for (var i = 0; i < s.nameCands.length; i++) lines.push((i + 1) + ". " + s.nameCands[i].name);
      lines.push("(다시 검색하려면 닉네임 입력, 취소는 '취소')");
      msg.reply(lines.join("\n"));
    }
    return true;
  }

  if (s.step === "name_choice") {
    var n = parseInt(text, 10);
    if (/^\d+$/.test(text) && n >= 1 && n <= s.nameCands.length) {
      finalizeApiSession(msg, sk, s, s.nameCands[n - 1]);
    } else {
      // 숫자가 아니면 닉네임 재검색으로 간주
      var re = findNamesByPartial(s.room, text);
      if (!re.length) {
        msg.reply("1~" + s.nameCands.length + " 사이 번호를 입력하거나, 닉네임을 다시 입력해주세요.");
      } else if (re.length === 1) {
        finalizeApiSession(msg, sk, s, re[0]);
      } else {
        s.nameCands = re.slice(0, 9);
        var lines2 = ["여러 명이 검색되었습니다. 번호를 입력해주세요:"];
        for (var j = 0; j < s.nameCands.length; j++) lines2.push((j + 1) + ". " + s.nameCands[j].name);
        msg.reply(lines2.join("\n"));
      }
    }
    return true;
  }
  return true;
}

function finalizeApiSession(msg, sk, s, chosen) {
  delete apiSessions[sk];
  var r = registerApiKey(s.key, chosen.name, chosen.hash, s.room);
  if (r === "added") {
    msg.reply("✅ API 키 등록이 완료되었습니다!\n" +
              "키: " + maskKey(s.key) + "\n방: " + s.room + "\n닉네임: " + chosen.name +
              "\n현재 사용가능 API: " + API_KEYS.length + "개\n" +
              "이제 '" + s.room + "' 방에서 토픽 출제 한도가 " + TOPIC_LIMIT_PROVIDER + "회로 상향됩니다.");
  } else if (r === "exists") {
    msg.reply("이미 등록된 키입니다. (" + maskKey(s.key) + ")");
  } else {
    msg.reply("키 등록 중 오류가 발생했습니다.");
  }
}

// ── 실제 메시지 처리 (워커 스레드 위에서만 실행됨) ─────────────────
function handleMessage(msg) {
  try {
    var text = msg.content;
    // 방별 진행 상태 — channelId 로 라우팅. DB/답장은 여전히 방 이름(quiz.room) 기준.
    var chanId = msg.channelId || "";
    var quiz = quizzes[chanId] || (quizzes[chanId] = newQuizState());

    if (text === "!상식" || text === "!ㅅㅅ") {
      startQuiz(msg, null, null, quiz, chanId);
      return;
    }

    if (text === "!상식종료") {
      if (quiz.active && msg.room === quiz.room) {
        var ans = quiz.answer;
        resetQuiz(quiz, chanId);
        msg.reply("퀴즈를 종료합니다. 정답은 \"" + ans + "\" 였습니다.");
      } else {
        msg.reply("진행 중인 퀴즈가 없습니다.");
      }
      return;
    }

    if (text === "!상식순위") {
      showRanking(msg);
      return;
    }

    if (text === "!금지목록") {
      showForbiddenList(msg);
      return;
    }

    if (text.indexOf("!api ") === 0) {
      var key = text.slice("!api ".length).trim();
      // 키 형식 최소 검증: 공백 없는 토큰 1개, 적당한 길이
      if (!key || /\s/.test(key) || key.length < 20 || key.length > 200) {
        msg.reply("키 형식이 올바르지 않습니다.\nhttps://aistudio.google.com/api-keys 에서 발급한 키를\n!api 발급키  형식으로 1개만 입력해주세요.");
        return;
      }
      if (apiKeyExists(key)) { msg.reply("이미 등록된 키입니다. (" + maskKey(key) + ")"); return; }
      // 먼저 키를 실제 호출해 유효성 검증 (네트워크 → 별도 스레드). 결과는 큐로 돌려받아 세션 시작.
      msg.reply("🔍 API 키 유효성을 확인하는 중입니다...");
      var rm = msg.room, nm = msg.author.name || "익명", hs = msg.author.hash || "";
      new java.lang.Thread(function() {
        var status = testApiKey(key);
        try { msgQueue.put({ type: "api_test_result", room: rm, name: nm, hash: hs, key: key, status: status }); } catch(_) {}
      }).start();
      return;
    }

    if (text === "!이의신청" || text.indexOf("!이의신청 ") === 0) {
      var numArg = text === "!이의신청" ? "" : text.slice("!이의신청 ".length).trim();
      handleAppeal(msg, numArg);
      return;
    }

    if (text.indexOf("!ㅈㄷ ") === 0 || text.indexOf("!상식 ") === 0 || text.indexOf("!ㅅㅅ ") === 0) {
      // 세 접두사(!ㅈㄷ/!상식/!ㅅㅅ) 모두 3글자라 동일하게 slice(3) 로 인자 추출
      var arg = text.slice(3).trim();
      if (!arg) return;

      // !상식/!ㅅㅅ 접두사 + 퀴즈 비활성 → 토픽 출제 요청 (진행 중이면 아래 답안 제출로 해석)
      var isTopicPrefix = text.indexOf("!상식 ") === 0 || text.indexOf("!ㅅㅅ ") === 0;

      // 정답 공개 직후 2.5초 동안은 !상식/!ㅅㅅ + 단어 입력을 무시.
      // (마감 직전 늦게 친 답안이 공개 직후 새 퀴즈 토픽으로 잘못 출제되는 것 방지)
      if (isTopicPrefix && (nowMs() - (lastRevealMsByChan[chanId] || 0)) < POST_REVEAL_IGNORE_MS) {
        return;
      }

      // "!ㅅㅅ 5" 처럼 숫자만 있는 인자는 분야명이 아니라 직전 퀴즈에 늦게 친 답안일 가능성이 큼.
      // 진행 중인 퀴즈가 없을 때 이런 입력으로 엉뚱한 "토픽 5" 퀴즈를 출제하거나 출제 횟수를
      // 차감하지 않도록 무시한다. (진행 중이면 아래 submitAnswer 로 답안 처리됨)
      if (isTopicPrefix && !quiz.active && /^\d+$/.test(arg)) return;

      if (isTopicPrefix && !quiz.active && !quiz.generating) {
        var customTopic = arg.replace(/[\r\n\t]/g, " ").slice(0, 30);
        if (!customTopic) return;
        var requesterHash = msg.author.hash || msg.author.name || "익명";
        var topicLimit = isApiProvider(msg.author.hash, msg.room) ? TOPIC_LIMIT_PROVIDER : TOPIC_LIMIT_DEFAULT;
        var cnt = countRecentTopicRequests(requesterHash);
        if (cnt >= topicLimit) {
          msg.reply("⏰ " + (msg.author.name || "익명") + "님은 오늘 토픽 출제 한도(" + topicLimit + "회)에 도달했습니다." +
            (topicLimit === TOPIC_LIMIT_DEFAULT ? "\n(API 키 제공 시 " + TOPIC_LIMIT_PROVIDER + "회로 상향)" : "") +
            "\nhttps://aistudio.google.com/api-keys 에서 API 키를 만들고 \n" +
            "봇과 1:1 채팅에서 !api 발급받은키 를 입력하면 등록됩니다.")
          return;
        }
        startQuiz(msg, customTopic, requesterHash, quiz, chanId);
        return;
      }

      // 마감(=정답 공개, 30초) 직전~공개 사이의 짧은 레이스 구간에 !상식/!ㅅㅅ 로 들어온
      // 입력을 조용히 무시 (새 퀴즈 출제도, 종료 안내도 하지 않음).
      if (isTopicPrefix && quiz.active && msg.room === quiz.room &&
          (nowMs() - quiz.startTime) > ANSWER_WINDOW_MS) {
        return;
      }

      submitAnswer(msg, arg, quiz, chanId);
      return;
    }
  } catch(e) {
    try { msg.reply("오류: " + (e && e.message ? e.message : e)); } catch(_) {}
  }
}

// ── 보일러플레이트 ───────────────────────────────────────────────────
// 메시지는 ChatManager 큐로 들어오므로 onMessage 는 no-op.
function onMessage(rawMsg) {}
bot.addListener(Event.MESSAGE, onMessage);

function onCommand(msg) {}
bot.setCommandPrefix("@");
bot.addListener(Event.COMMAND, onCommand);

function onCreate(savedInstanceState, activity) {
  var tv = new Packages.android.widget.TextView(activity);
  tv.setText("상식퀴즈봇");
  tv.setTextColor(Packages.android.graphics.Color.DKGRAY);
  activity.setContentView(tv);
}
function onStart(activity) {}
function onResume(activity) {}
function onPause(activity) {}
function onStop(activity) {}
function onRestart(activity) {}
function onDestroy(activity) {}
function onBackPressed(activity) {}

bot.addListener(Event.Activity.CREATE, onCreate);
bot.addListener(Event.Activity.START, onStart);
bot.addListener(Event.Activity.RESUME, onResume);
bot.addListener(Event.Activity.PAUSE, onPause);
bot.addListener(Event.Activity.STOP, onStop);
bot.addListener(Event.Activity.RESTART, onRestart);
bot.addListener(Event.Activity.DESTROY, onDestroy);
bot.addListener(Event.Activity.BACK_PRESSED, onBackPressed);
