const bot = BotManager.getCurrentBot();

// =====================================================================
// 제미니봇 — LLM 질의응답 (Gemini 주 API + 내부망 Qwen 서브 API)
//
// 명령어:
//   !제미니 [질문] / !ㅈㅁㄴ [질문]
//       : 질문을 Gemini 에 보내고 답변을 받아옴. 질문 길이 제한 없음.
//       : 사용 한도 — API 키 제공자(이 방)는 무제한, 그 외는 1일 10회 (한국시간 자정 리셋).
//   !qwen [질문]   (구 qwen봇 통합)
//       : 내부망 Qwen 서버에 직접 질문. 무료라 사용 한도를 세지 않는다.
//   !대화요약 …    (summary.js)
//
// 제미니 → Qwen 폴백:
//   ① 개인 1일 한도 소진  ② 이 방의 모든 제미니 키가 429
//   두 경우에만 Qwen 으로 넘긴다. 차단·파싱오류 등 다른 실패는 그대로 오류로 알린다
//   (진짜 문제가 Qwen 답변 뒤에 숨지 않도록).
//   Qwen 은 ≈2.4 tok/s 로 느려서 폴백 시 먼저 안내 메시지를 보낸다.
//   대화요약은 출력이 길어 Qwen 으로는 수 분이 걸리므로 폴백 대상에서 제외한다.
//
// API 키:
//   상식퀴즈봇과 동일한 키 저장소(quiz.db 의 quiz_apikey)를 "읽기"만 한다.
//   사용자가 상식퀴즈봇의 !api 로 등록한 키가 그대로 적용된다.
//   - 코드 내장 키(room 없음/빈값)는 모든 방 공용.
//   - 사용자가 등록한 키는 등록한 방(added_by_room)에서만 사용 (= 상식퀴즈봇과 동일 규칙).
//   ※ 키 등록은 상식퀴즈봇이 담당하므로 이 봇은 !api 를 처리하지 않는다(중복 응답 방지).
//
// 메시지 수신:
//   ChatManager 봇이 KakaoTalk DB를 폴링/복호화해서 큐로 broadcast.
//   이 봇은 자기 LinkedBlockingQueue 만 구독. → ChatManager 가 켜져 있어야 메시지를 받음.
// =====================================================================

const BOT_NAME = "제미니봇";

// ── 설정 ─────────────────────────────────────────────────────────────
const DEFAULT_MODEL = "gemini-3.1-flash-lite";

// 긴 답변 미리보기 채움용 제로폭 공백(U+200B) 스페이서.
var LONG_MSG_SPACER = "​".repeat(500);

// 코드 내장(전역) 키 — 모든 방 공용 폴백. 전용 키로 바꾸거나 비워도 됨([] 로 두면 등록된 방에서만 작동).
// (상식퀴즈봇과 같은 물리 키를 쓰면 동일 Google 쿼터를 공유하니 주의)
var BUILTIN_KEYS = [];

// 상식퀴즈봇과 공유하는 키 저장소(quiz.db). 읽기 전용으로만 연다.
const QUIZ_DB_PATH = Packages.android.os.Environment
    .getExternalStorageDirectory().getAbsolutePath() + "/msgbot/quiz.db";

function nowMs() { return Date.now(); }

// ── 사용 한도 (API 키 제공자 무제한 / 비제공자 1일 10회) ───────────────
const GEMINI_DAILY_LIMIT = 10;   // 키 미제공자의 1일 사용 횟수 (한국시간 자정 리셋)

// 사용량 기록 전용 DB. quiz.db 는 읽기 전용으로만 쓰므로 카운트는 별도 파일에 기록한다.
const GEMINI_DB_PATH = Packages.android.os.Environment
    .getExternalStorageDirectory().getAbsolutePath() + "/msgbot/gemini.db";

function openUsageDB() {
  return Packages.android.database.sqlite.SQLiteDatabase.openOrCreateDatabase(GEMINI_DB_PATH, null);
}

// ─── 공용 DB 헬퍼 (lib/db-helper.js): withDB / withReadOnlyDB / queryAll / transaction ───
var DBH = (function() {
  var libPath = "/sdcard/msgbot/lib/db-helper.js";
  try {
    if (typeof bot.getRootPath === "function") {
      libPath = bot.getRootPath() + "/../../lib/db-helper.js";
    }
  } catch(_) {}
  return require(libPath);
})();

(function initUsageDB() {
  DBH.withDB(GEMINI_DB_PATH, function(db){
    try {
      db.execSQL(
        "CREATE TABLE IF NOT EXISTS gemini_usage (" +
        " hash TEXT NOT NULL," +
        " created INTEGER NOT NULL" +
        ")");
      try { db.execSQL("CREATE INDEX IF NOT EXISTS idx_gemini_usage ON gemini_usage(hash, created)"); } catch(_) {}
    } catch(_) {}
  });
})();

// 오늘 00:00 KST(UTC+9) 에 해당하는 epoch(ms). 한도를 한국시간 자정 기준으로 리셋.
function kstDayStartMs() {
  var KST = 9 * 60 * 60 * 1000;
  var DAY = 24 * 60 * 60 * 1000;
  var k = nowMs() + KST;
  return (k - (k % DAY)) - KST;
}

// 이 hash 가 오늘(KST) 사용한 횟수
function countTodayUses(hash) {
  if (!hash) return 0;
  return DBH.withDB(GEMINI_DB_PATH, function(db){
    var cur = null; var n = 0;
    try {
      cur = db.rawQuery("SELECT COUNT(*) FROM gemini_usage WHERE hash = ? AND created >= ?",
        [String(hash), String(kstDayStartMs())]);
      if (cur.moveToFirst()) n = cur.getInt(0);
    } catch(e) {} finally { if (cur) cur.close(); }
    return n;
  });
}

// 사용 1회 기록 (답변 성공 시 호출)
function recordUse(hash) {
  if (!hash) return;
  DBH.withDB(GEMINI_DB_PATH, function(db){
    try {
      var stmt = db.compileStatement("INSERT INTO gemini_usage (hash, created) VALUES (?, ?)");
      stmt.bindString(1, String(hash));
      stmt.bindLong(2, nowMs());
      stmt.execute(); stmt.close();
    } catch(e) {}
  });
}

// 이 hash 의 사용자가 (이 방에) !api 로 키를 제공했는지 — quiz.db 의 quiz_apikey 조회(읽기 전용).
// 키 사용처가 등록한 방으로 제한되므로 제공자 우대도 같은 방에서만 적용 (= 상식퀴즈봇과 동일 규칙).
function isApiProvider(hash, room) {
  if (!hash) return false;
  try {
    return DBH.withReadOnlyDB(QUIZ_DB_PATH, function(db){
      var cur = null;
      try {
        cur = db.rawQuery(
          "SELECT 1 FROM quiz_apikey WHERE added_by_hash = ? AND " +
          "(added_by_room = ? OR added_by_room IS NULL OR added_by_room = '') LIMIT 1",
          [String(hash), String(room)]);
        return cur.moveToFirst();
      } finally {
        try { if (cur) cur.close(); } catch(_) {}
      }
    });
  } catch(e) { return false; }
}

// ── 이 방에서 쓸 수 있는 키 목록 ──────────────────────────────────────
// 키 선택 정책 공용 모듈. 못 불러오면 null → 아래 옛 경로(eligibleKeysForRoom)로 내려간다.
var APIKEYS = (function() {
  var p = "/sdcard/msgbot/lib/apikeys.js";
  try { if (typeof bot.getRootPath === "function") p = bot.getRootPath() + "/../../lib/apikeys.js"; } catch(_) {}
  try { var m = require(p); return (m && typeof m.forRoom === "function") ? m : null; } catch(_) { return null; }
})();

// [폴백] 공용 모듈을 못 쓸 때의 옛 선택 로직.
// 내장 전역 키 + quiz_apikey 중 (이 방 등록분 OR 전역 등록분). 매 호출마다 DB 를 새로 읽어
// 상식퀴즈봇에서 방금 등록한 키도 재시작 없이 반영된다. quiz.db 가 없거나 잠기면 내장 키만 사용.
function eligibleKeysForRoom(room) {
  var keys = [];
  var seen = {};
  for (var i = 0; i < BUILTIN_KEYS.length; i++) {
    var bk = BUILTIN_KEYS[i];
    if (bk.key && !seen[bk.key]) { seen[bk.key] = true; keys.push({ key: bk.key, model: bk.model || DEFAULT_MODEL }); }
  }
  try {
    DBH.withReadOnlyDB(QUIZ_DB_PATH, function(db){
      var cur = null;
      try {
        // quiz_apikey 의 첫번째(가장 먼저 등록된, MIN(created)) 키는 전역으로 모든 방에서 사용.
        // 그 외엔 이 방 등록분 또는 room 빈값(전역)만. 상식퀴즈봇 eligibleProviderIndexes(i===0) 와 동일 정책.
        cur = db.rawQuery(
          "SELECT key, model FROM quiz_apikey " +
          "WHERE added_by_room = ? OR added_by_room IS NULL OR added_by_room = '' " +
          "OR created = (SELECT MIN(created) FROM quiz_apikey) " +
          "ORDER BY created ASC",
          [String(room)]);
        while (cur.moveToNext()) {
          var k = cur.getString(0);
          var m = cur.getString(1) || DEFAULT_MODEL;
          if (k && !seen[k]) { seen[k] = true; keys.push({ key: k, model: m }); }
        }
      } finally {
        try { if (cur) cur.close(); } catch(_) {}
      }
    });
  } catch(e) {
    // quiz.db 미존재/잠김/테이블 없음 → 내장 키만으로 진행
  }
  return keys;
}

// ── Gemini 호출 ──────────────────────────────────────────────────────
// callGemini: 이 방의 eligible 키들을 라운드로빈. 429(쿼터 초과)면 다음 키로 전환.
//   - 한 키라도 정상 응답하면 그 응답 사용.
//   - 모든 키가 429 면 { quotaExhausted: true }.
//   - eligible 키가 0개면 { error }.
var _keyCursor = 0;   // 호출 간 시작 키를 돌려가며 부하 분산
function callGemini(prompt, room) {
  // 키 순서는 lib/apikeys.js 가 정한다 (primary → secondary → 방 전용, 쿨다운은 뒤로).
  // 예전엔 매 호출마다 커서를 돌려 라운드로빈했는데, 그러면 primary 를 주력으로
  // 쓴다는 말이 무의미해진다(부하가 반반 갈림). 상식퀴즈봇과 정책이 갈라지기도 했다.
  var keys = APIKEYS ? APIKEYS.forRoom(room) : eligibleKeysForRoom(room);
  if (!keys.length) return { error: "이 방에서 사용 가능한 API 키가 없습니다." };
  for (var tried = 0; tried < keys.length; tried++) {
    var k = keys[tried];
    var res = _callGeminiOnce(prompt, k);
    if (res.quota429) {
      // 소진을 DB 에 남겨 상식퀴즈봇도 이 키를 피하게 한다. 실패해도 호출은 계속.
      if (APIKEYS) { try { APIKEYS.markExhausted(k.key); } catch(_) {} }
      continue;
    }
    // 쉬는 중이던 키가 살아 돌아왔으면 쿨다운을 푼다
    if (APIKEYS && k.cooling && !res.error) { try { APIKEYS.markAlive(k.key); } catch(_) {} }
    return res;                   // 정상 응답 또는 429 외 오류 → 즉시 반환
  }
  return { quotaExhausted: true, error: "모든 API 사용량 한도 초과" };
}

function _callGeminiOnce(prompt, provider) {
  var conn = null;
  try {
    var url = new java.net.URL(
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      provider.model + ":generateContent?key=" + provider.key);
    conn = url.openConnection();
    conn.setRequestMethod("POST");
    conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
    conn.setDoOutput(true);
    conn.setConnectTimeout(15000);
    conn.setReadTimeout(40000);

    var body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, topP: 0.95 }
    });
    var writer = new java.io.OutputStreamWriter(conn.getOutputStream(), "UTF-8");
    writer.write(body); writer.flush(); writer.close();

    var code = conn.getResponseCode();
    var stream = (code >= 200 && code < 300) ? conn.getInputStream() : conn.getErrorStream();
    var raw = "";
    if (stream) {
      var reader = new java.io.BufferedReader(new java.io.InputStreamReader(stream, "UTF-8"));
      var sb = new java.lang.StringBuilder(); var line;
      while ((line = reader.readLine()) !== null) sb.append(line);
      reader.close();
      raw = String(sb.toString());
    }

    if (code < 200 || code >= 300) {
      if (code === 429) return { quota429: true, error: "HTTP 429" };
      return { error: "HTTP " + code + ": " + raw.slice(0, 200) };
    }

    var resp;
    try { resp = JSON.parse(raw); }
    catch(pe) { return { error: "응답 JSON 파싱 실패: " + raw.slice(0, 120) }; }

    if (resp.promptFeedback && resp.promptFeedback.blockReason) {
      return { error: "차단됨: " + resp.promptFeedback.blockReason };
    }
    if (!resp.candidates || !resp.candidates[0]) {
      return { error: "candidates 없음" };
    }
    var cand = resp.candidates[0];
    if (cand.finishReason && cand.finishReason !== "STOP" && cand.finishReason !== "MAX_TOKENS") {
      return { error: "finishReason: " + cand.finishReason };
    }
    if (!cand.content || !cand.content.parts || !cand.content.parts.length) {
      return { error: "content 없음 (finish=" + (cand.finishReason || "?") + ")" };
    }
    var out = "";
    for (var i = 0; i < cand.content.parts.length; i++) out += String(cand.content.parts[i].text || "");
    return { text: out };
  } catch(e) {
    return { error: (e && e.message) ? e.message : String(e) };
  } finally {
    try { if (conn) conn.disconnect(); } catch(_) {}
  }
}

function buildPrompt(question) {
  return "당신은 한국어로 답하는 어시스턴트입니다. 다음 질문에 정확하고 간결하게 한국어로 답하세요.\n\n" +
         "질문: " + question;
}

// ── 메시지 처리 ──────────────────────────────────────────────────────
function isGeminiCommand(text) {
  return text.indexOf("!제미니") === 0 || text.indexOf("!ㅈㅁㄴ") === 0;
}

// 닉네임 직접복호화 공유 모듈 (msg.author.name 신뢰 안 함)
var kt = (function() {
  var libPath = "/sdcard/msgbot/lib/kakao-decrypt.js";
  try {
    if (typeof bot.getRootPath === "function") {
      libPath = bot.getRootPath() + "/../../lib/kakao-decrypt.js";
    }
  } catch(_) {}
  return require(libPath);
})();

// "!대화요약 N" 모듈 (같은 봇 디렉터리). chat_logs → 주제별 요약(Gemini 재사용).
var summaryMod = (function() {
  var p = "/sdcard/msgbot/Bots/제미니봇/summary.js";
  try { if (typeof bot.getRootPath === "function") p = bot.getRootPath() + "/summary.js"; } catch(_) {}
  return require(p);
})();

// 내부망 Qwen 클라이언트 (구 qwen봇 통합). "!qwen" 직접 호출 + 제미니 한도 소진 시 폴백.
var qwen = (function() {
  var p = "/sdcard/msgbot/Bots/제미니봇/qwen.js";
  try { if (typeof bot.getRootPath === "function") p = bot.getRootPath() + "/qwen.js"; } catch(_) {}
  return require(p);
})();

function isSummaryCommand(text) { return text.indexOf(summaryMod.CMD) === 0; }

// 통합 질의 모듈 (/v1/ask). 일반 답변·URL 요약·웹 검색 중 무엇을 할지는 서버가
// 고르므로 클라이언트에서 갈래를 나누지 않는다.
// 못 불러오면 null → 아래에서 qwen.js(18080) 일반 답변으로만 동작한다
// (이 파일 하나 때문에 봇 전체가 컴파일 실패하지 않도록).
var askMod = (function() {
  try {
    var p = "/sdcard/msgbot/Bots/제미니봇/ask.js";
    try { if (typeof bot.getRootPath === "function") p = bot.getRootPath() + "/ask.js"; } catch(_) {}
    var m = require(p);
    return (m && typeof m.ask === "function") ? m : null;
  } catch(_) { return null; }
})();

function isQwenCommand(text) { return text.indexOf("!qwen") === 0; }

// /v1/ask 결과를 카톡 메시지로 꾸민다.
// 첫 줄 + 제로폭 스페이서로 카카오톡 미리보기를 채우는 건 제미니와 같은 형식.
function formatAskResult(res, tag) {
  var kind = "";
  if (res.route === "url_summary") kind = " · 링크 요약";
  else if (res.route === "web_search") kind = " · 웹 검색";

  var lines = [];
  if (res.route === "url_summary") {
    if (res.title) lines.push("📄 " + res.title);
    if (res.url) lines.push(res.url);
    if (lines.length) lines.push("");
  }
  lines.push(res.answer);

  // 검색 답변의 [S1] 인용과 짝이 되는 실제 출처. 없으면 붙이지 않는다.
  if (res.route === "web_search" && res.sources.length) {
    lines.push("");
    lines.push("출처");
    for (var i = 0; i < res.sources.length; i++) {
      var s = res.sources[i];
      lines.push("[" + s.id + "] " + (s.title || s.url));
      if (s.title && s.url) lines.push("    " + s.url);
    }
  }
  if (res.truncated) lines.push("\n※ 문서가 길어 일부만 반영됐습니다.");
  if (res.partial) lines.push("\n※ 일부 문서만 수집돼 근거가 불완전합니다.");

  return "답변입니다. (" + tag + kind + ")" + LONG_MSG_SPACER + "\n" + lines.join("\n");
}

// ── Qwen 답변 전송 (공통) ────────────────────────────────────────────
// 기본 경로는 /v1/ask. 서버에 닿지 못할 때만 18080 일반 답변으로 내려간다
// (같은 호스트라 대개 같이 죽지만, 요약 서비스만 내려간 경우를 건진다).
function sendQwenAnswer(room, question, tag) {
  if (askMod) {
    var r = askMod.ask(question);
    if (r && !r.error) {
      try { bot.send(room, formatAskResult(r, tag)); } catch(_) {}
      return true;
    }
    if (r && !r.connectFailed) {
      try { bot.send(room, "⚠ Qwen 답변 실패: " + r.error); } catch(_) {}
      return false;
    }
  }
  var res = qwen.ask(question);
  if (res && typeof res.text === "string" && res.text) {
    try { bot.send(room, "답변입니다. (" + tag + ")" + LONG_MSG_SPACER + "\n" + res.text); } catch(_) {}
    return true;
  }
  try { bot.send(room, "⚠ Qwen 답변 실패: " + ((res && res.error) ? res.error : "알 수 없음")); } catch(_) {}
  return false;
}

// "!qwen [무엇이든]" — 내부망 서버라 우리 쪽에서 사용 횟수를 세지 않는다.
//   URL 이 섞여 있으면 요약, 최신 정보가 필요하면 웹 검색, 나머지는 일반 답변.
//   무엇을 할지는 서버(/v1/ask, mode=auto)가 고르므로 사용자는 형식을 몰라도 된다.
//   "!qwen <URL> 요약해줘" / "!qwen 요약좀 <URL>" / "!qwen 오늘 환율" 전부 동작.
function handleQwen(msg) {
  try {
    var text = String(msg.content || "").trim();
    var question = text.slice("!qwen".length).trim();
    if (!question) {
      msg.reply("사용법: !qwen [질문]\n" +
                "· 링크를 넣으면 그 문서를 요약하고, 최신 정보가 필요하면 웹을 검색합니다.\n" +
                "· 검색이 필요한 질문은 외부 검색엔진으로 전달됩니다. 개인정보·비밀번호·키는 넣지 마세요.\n" +
                "예) !qwen 광합성이 뭐야?  /  !qwen https://... 요약해줘");
      return;
    }
    var room = msg.room;

    // 30초~1분 걸리므로 기다리는 줄 알 수 있게 먼저 알린다.
    // 무엇을 할지(요약·검색·일반 답변)는 서버가 고르므로 안내도 한 가지로 둔다.
    try { msg.reply("답변을 생성중입니다."); } catch(_) {}

    // 생성에 시간이 걸리므로 워커 큐를 막지 않도록 별도 스레드에서 처리.
    new java.lang.Thread(function() {
      sendQwenAnswer(room, question, "Qwen");
    }).start();
  } catch(e) {
    try { msg.reply("오류: " + (e && e.message ? e.message : e)); } catch(_) {}
  }
}

// 대화요약 처리: 사용 한도는 제미니와 동일(제공자 무제한 / 그 외 1일 N회). 성공 시 1회 차감.
function handleSummary(msg) {
  try {
    var room = msg.room;
    var who = (function(){ try { return kt.resolveSender(msg); } catch(_) { return null; } })();
    var displayName = (who && who.name) ? who.name : (msg.author.name || "익명");
    var hash = msg.author.hash || ("noname:" + (msg.author.name || "익명"));
    var isProvider = isApiProvider(msg.author.hash, room);
    if (!isProvider && countTodayUses(hash) >= GEMINI_DAILY_LIMIT) {
      msg.reply("⚠ " + displayName + "님은 오늘 제미니 사용 한도(" + GEMINI_DAILY_LIMIT + "회)에 도달했습니다.\n" +
        "상식퀴즈봇과 1:1 채팅에서 !api 로 이 방에 키를 등록하면 무제한으로 사용할 수 있습니다.");
      return;
    }
    summaryMod.handle(msg, kt, callGemini, bot, function onSuccess(){
      if (!isProvider) { try { recordUse(hash); } catch(_){} }
    });
  } catch(e) {
    try { msg.reply("오류: " + (e && e.message ? e.message : e)); } catch(_){}
  }
}

function handleMessage(msg) {
  try {
    var text = String(msg.content || "").trim();
    var prefix = null;
    if (text.indexOf("!제미니") === 0) prefix = "!제미니";
    else if (text.indexOf("!ㅈㅁㄴ") === 0) prefix = "!ㅈㅁㄴ";
    if (!prefix) return;

    var question = text.slice(prefix.length).trim();
    if (!question) {
      msg.reply("사용법: " + prefix + " [질문]\n예) " + prefix + " 광합성이 뭐야?");
      return;
    }

    var room = msg.room;
    var who = (function(){ try { return kt.resolveSender(msg); } catch(_) { return null; } })();
    var displayName = (who && who.name) ? who.name : (msg.author.name || "익명");
    var hash = msg.author.hash || ("noname:" + (msg.author.name || "익명"));
    var isProvider = isApiProvider(msg.author.hash, room);   // 이 방에 키 제공 → 무제한

    // 사용 한도: 제공자는 무제한, 그 외는 1일 GEMINI_DAILY_LIMIT 회 (한국시간 자정 리셋).
    // 한도에 걸리면 거절하지 않고 내부망 Qwen 으로 넘긴다(무료·무제한이라 횟수를 세지 않음).
    if (!isProvider && countTodayUses(hash) >= GEMINI_DAILY_LIMIT) {
      var overRoom = room;
      msg.reply("⚠ " + displayName + "님은 오늘 제미니 한도(" + GEMINI_DAILY_LIMIT + "회)를 다 쓰셨습니다.\n" +
        "내부망 Qwen 으로 답변을 만드는 중입니다. 조금 오래 걸릴 수 있습니다.\n" +
        "(상식퀴즈봇과 1:1 채팅에서 !api 로 키를 등록하면 제미니를 무제한 사용할 수 있습니다.)");
      new java.lang.Thread(function() {
        sendQwenAnswer(overRoom, question, "제미니 한도 초과 → Qwen");
      }).start();
      return;
    }

    // 네트워크 호출은 워커 큐를 막지 않도록 별도 스레드에서 처리하고, 끝나면 직접 send.
    new java.lang.Thread(function() {
      var res = callGemini(buildPrompt(question), room);
      if (res && typeof res.text === "string" && res.text.trim()) {
        if (!isProvider) { try { recordUse(hash); } catch(_) {} }   // 성공 응답만 한도에 반영
        // 요청 형식: "답변입니다." 500회 반복(미리보기 채움) 뒤 줄바꿈 후 실제 답변.
        try { bot.send(room, "답변입니다."+ LONG_MSG_SPACER + "\n" + res.text.trim()); } catch(_) {}
      } else if (res && res.quotaExhausted) {
        // 모든 제미니 키가 429 → Qwen 으로 폴백.
        // 폴백은 "토큰 소진"일 때만 한다. 차단·파싱오류 같은 건 그대로 오류로 알려야
        // 진짜 문제가 Qwen 답변 뒤에 숨지 않는다.
        try { bot.send(room, "⚠ 제미니 API 사용량이 모두 소진되어 내부망 Qwen 으로 답변합니다. 조금 오래 걸릴 수 있습니다."); } catch(_) {}
        sendQwenAnswer(room, question, "제미니 소진 → Qwen");
      } else {
        try { bot.send(room, "⚠ 답변 생성 실패: " + ((res && res.error) ? res.error : "알 수 없음")); } catch(_) {}
      }
    }).start();
  } catch(e) {
    try { msg.reply("오류: " + (e && e.message ? e.message : e)); } catch(_) {}
  }
}

// ── 메시지 큐 + 워커 스레드 (공유 subscriber 모듈로 위임) ──────────────
// 큐에는 ChatManager broadcast 메시지(java.util.HashMap)만 들어온다.
// subscriber.js 가 큐 생성/옛 워커 정리/레지스트리 등록/instanceof 가드/필드 추출/워커 루프를 담당한다.
var WORKER_NAME = "GEMINI_BOT_WORKER";

var subscribe = (function() {
  var libPath = "/sdcard/msgbot/lib/subscriber.js";
  try {
    if (typeof bot.getRootPath === "function") {
      libPath = bot.getRootPath() + "/../../lib/subscriber.js";
    }
  } catch(_) {}
  return require(libPath);
})();

subscribe(BOT_NAME, WORKER_NAME, function(msg) {
  try {
    var text = String(msg.content || "").trim();
    if (isSummaryCommand(text)) { handleSummary(msg); return; }   // !대화요약
    if (isQwenCommand(text)) { handleQwen(msg); return; }         // !qwen (구 qwen봇)
    if (!isGeminiCommand(text)) return;   // 우리 명령이 아니면 무시 (모든 메시지가 broadcast 됨)
    handleMessage(msg);
  } catch(_) {}
});

// ── 보일러플레이트 ───────────────────────────────────────────────────
// 메시지는 ChatManager 큐로 들어오므로 onMessage 는 no-op.
function onMessage(rawMsg) {}
bot.addListener(Event.MESSAGE, onMessage);

function onCommand(msg) {}
bot.setCommandPrefix("@");
bot.addListener(Event.COMMAND, onCommand);

function onCreate(savedInstanceState, activity) {
  var tv = new Packages.android.widget.TextView(activity);
  tv.setText("제미니봇");
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
