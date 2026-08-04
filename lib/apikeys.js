// =====================================================================
// apikeys.js — Gemini API 키 선택 정책 (상식퀴즈봇 · 제미니봇 공용)
//
//   두 봇이 같은 저장소(quiz.db 의 quiz_apikey)를 쓰면서 선택 정책은 따로
//   갖고 있었다. 그래서 같은 방에서 상식퀴즈봇은 A 키를, 제미니봇은 B 키를
//   쓰는 일이 생겼다. 정책을 여기 한 곳으로 모은다.
//
//   등급(priority)
//     0 = primary    모든 방에서, 가장 먼저 쓴다
//     1 = secondary  모든 방에서, primary 가 쉬는 동안 쓴다
//     9 = 방 전용    등록한 방에서만 (기본값)
//
//   쿨다운
//     429(한도 초과)를 받은 키는 cooldown_until 까지 건너뛴다. 두 봇이 같은
//     컬럼을 보므로, 한쪽이 소진을 발견하면 다른 쪽도 즉시 그 키를 피한다.
//     단 후보가 전부 쿨다운이면 쿨다운을 무시하고 순서대로 시도한다 — 전부
//     쉬는 중이라고 아무것도 안 하면 그냥 죽는 것보다 낫다.
//
//   ⚠ 쿨다운은 429 를 "일일 한도 소진" 으로 보고 건다. 분당 한도(RPM)로 인한
//     일시적 429 도 같은 길이만큼 쉬게 되므로, 짧은 폭주 한 번이 그 키를
//     오래 벤치에 앉힐 수 있다. COOLDOWN_MS 는 그 점을 감안해 정할 것.
//
//   RhinoJS-safe: var / function 만.
// =====================================================================

var QUIZ_DB_PATH = Packages.android.os.Environment
    .getExternalStorageDirectory().getAbsolutePath() + "/msgbot/quiz.db";

var PRIORITY_PRIMARY = 0;
var PRIORITY_SECONDARY = 1;
var PRIORITY_ROOM = 9;

var COOLDOWN_MS = 24 * 60 * 60 * 1000;   // 마지막 429 로부터 24시간

// ── 모델 사슬 ────────────────────────────────────────────────────────
// 앞에서부터 시도하고, "그 모델이 없다" 는 응답이 오면 다음으로 내려간다.
// 새 모델은 계정·티어·API 버전에 따라 아직 안 열려 있을 수 있어서, 기본값을
// 갈아끼우는 것만으로는 위험하다. 사슬로 두면 최악이라도 옛 모델로 굴러간다.
var MODEL_CHAIN = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];

// 못 쓰는 모델은 잠시 기억해 매번 헛수고하지 않는다. 사유에 따라 길이가 다르다.
//   missing  아예 없는 모델 — 오래 기억한다
//   busy     과부하("model_high_demand" 류) — 몇 분이면 풀린다
// 메모리 상태라 재컴파일하면 초기화된다 — 그 사이 열렸으면 다시 잡힌다.
var MODEL_DOWN_MS = 60 * 60 * 1000;   // missing: 1시간
var MODEL_BUSY_MS = 5 * 60 * 1000;    // busy: 5분
var _modelDown = {};                  // "key|model" 또는 "*|model" -> 만료 시각

function nowMs() { return java.lang.System.currentTimeMillis(); }

// 이 응답이 "키 문제" 가 아니라 "모델 문제" 인가. 맞으면 사유를 돌려준다.
//   이걸 먼저 가려내지 않으면 두 가지가 망가진다.
//   ① 없는 모델을 부른 400/404 가 "잘못된 키" 로 분류돼 멀쩡한 키를 차례로 버린다.
//   ② 모델 과부하(503/overloaded)가 429 로 오면 키를 24시간 쿨다운에 넣는다.
//      키는 멀쩡한데 하루를 버리는 셈이다.
function modelErrorKind(code, raw) {
  var s = String(raw || "");
  // 진짜 쿼터 소진은 키 문제다. 다른 무엇보다 먼저 걸러낸다.
  if (/RESOURCE_EXHAUSTED/i.test(s)) return null;
  if (code === 400 && /api[\s_-]*key/i.test(s)) return null;
  // 과부하·일시 불가 — 모델을 잠깐 피하면 된다
  if (code === 503) return "busy";
  if (/overloaded|UNAVAILABLE|high[\s_-]*demand/i.test(s)) return "busy";
  // 아예 없는 모델
  if (code === 404) return "missing";
  if (/is not found for API version|NOT_FOUND|not supported for|models\/[^\s"]+ is not found/i.test(s)) {
    return "missing";
  }
  return null;
}

function isModelError(code, raw) { return !!modelErrorKind(code, raw); }

// 과부하는 모델 자체의 상태라 키와 무관하다 — "*" 로 전역 기록해서 키마다
// 같은 벽에 부딪히지 않게 한다. 없는 모델은 계정·티어를 타므로 키별로 남긴다.
function markModelDown(key, model, kind, at) {
  var busy = (kind === "busy");
  var k = (busy ? "*" : String(key)) + "|" + String(model);
  _modelDown[k] = (at || nowMs()) + (busy ? MODEL_BUSY_MS : MODEL_DOWN_MS);
}

function isModelDown(key, model, at) {
  var t = at || nowMs();
  var a = _modelDown[String(key) + "|" + String(model)];
  var b = _modelDown["*|" + String(model)];
  return (!!a && a > t) || (!!b && b > t);
}

// 이 키로 시도할 모델을 순서대로. 못 쓴다고 표시된 것은 뒤로 미룬다.
//   stored: 그 키에 저장된 모델(옛 행은 3.1 이 들어 있다). 사슬에 없는 값이면
//           누군가 일부러 지정한 것이므로 맨 앞에 둔다.
function modelsFor(key, stored, at) {
  var out = [];
  if (stored && MODEL_CHAIN.indexOf(String(stored)) === -1) out.push(String(stored));
  for (var i = 0; i < MODEL_CHAIN.length; i++) out.push(MODEL_CHAIN[i]);
  var live = [], down = [];
  for (var j = 0; j < out.length; j++) {
    if (isModelDown(key, out[j], at)) down.push(out[j]); else live.push(out[j]);
  }
  // 전부 막혔으면 그래도 순서대로 시도한다 (쿨다운과 같은 이유)
  return live.concat(down);
}

function dbh() {
  var p = Packages.android.os.Environment.getExternalStorageDirectory()
      .getAbsolutePath() + "/msgbot/lib/db-helper.js";
  return require(p);
}

// ── 스키마 ──────────────────────────────────────────────────────────
// priority / cooldown_until 은 나중에 붙은 컬럼이라 구버전 테이블에는 없다.
// 없으면 추가하고, 기존 행에는 그때까지의 실질 정책을 그대로 옮겨 적는다:
//   가장 오래된 행 = 그동안의 사실상 primary, room 이 빈 행 = 그동안의 전역.
function ensureColumns(db) {
  var cur = null, hasPriority = false, hasCooldown = false;
  try {
    cur = db.rawQuery("PRAGMA table_info(quiz_apikey)", []);
    while (cur.moveToNext()) {
      var n = String(cur.getString(1));
      if (n === "priority") hasPriority = true;
      if (n === "cooldown_until") hasCooldown = true;
    }
  } catch (e) { return false; } finally { if (cur) try { cur.close(); } catch (_) {} }

  if (!hasCooldown) {
    try { db.execSQL("ALTER TABLE quiz_apikey ADD COLUMN cooldown_until INTEGER DEFAULT 0"); } catch (e) {}
  }
  if (!hasPriority) {
    try {
      db.execSQL("ALTER TABLE quiz_apikey ADD COLUMN priority INTEGER DEFAULT " + PRIORITY_ROOM);
      // 옛 정책 이관: room 이 빈 행은 전역이었다 → secondary
      db.execSQL("UPDATE quiz_apikey SET priority = " + PRIORITY_SECONDARY +
                 " WHERE added_by_room IS NULL OR added_by_room = ''");
      // 옛 정책 이관: 가장 오래된 행이 사실상 primary 였다
      db.execSQL("UPDATE quiz_apikey SET priority = " + PRIORITY_PRIMARY +
                 " WHERE created = (SELECT MIN(created) FROM quiz_apikey)");
    } catch (e) {}
  }
  return true;
}

function rowsFrom(db) {
  var cur = null, out = [];
  try {
    cur = db.rawQuery(
      "SELECT key, model, added_by_name, added_by_room, created, priority, cooldown_until " +
      "FROM quiz_apikey ORDER BY priority ASC, created ASC", []);
    while (cur.moveToNext()) {
      out.push({
        key: String(cur.getString(0) || ""),
        model: String(cur.getString(1) || ""),
        who: String(cur.getString(2) || "?"),
        room: String(cur.getString(3) || ""),
        created: Number(cur.getLong(4)),
        priority: Number(cur.getInt(5)),
        cooldownUntil: Number(cur.getLong(6))
      });
    }
  } catch (e) {} finally { if (cur) try { cur.close(); } catch (_) {} }
  return out;
}

// 전체 목록 (등급순 → 등록순). 읽기 전용.
function list() {
  try {
    return dbh().withDB(QUIZ_DB_PATH, function (db) {
      if (!ensureColumns(db)) return [];
      return rowsFrom(db);
    });
  } catch (e) { return []; }
}

function isCooling(row, at) { return row.cooldownUntil > (at || nowMs()); }

// 이 방에서 쓸 수 있는 키를 쓸 순서대로. 쿨다운 중인 것은 뒤로 미룬다.
//   반환 [{ key, model, priority, cooling }] — cooling=true 는 "다 막혔을 때만 써라"
function forRoom(room, at) {
  var t = at || nowMs();
  var all = list();
  var live = [], cooling = [];
  for (var i = 0; i < all.length; i++) {
    var r = all[i];
    if (!r.key) continue;
    // primary/secondary 는 모든 방에서, 그 외는 등록한 방에서만
    if (r.priority > PRIORITY_SECONDARY && r.room !== String(room)) continue;
    var item = { key: r.key, model: r.model, priority: r.priority, cooling: isCooling(r, t) };
    if (item.cooling) cooling.push(item); else live.push(item);
  }
  // 전부 쿨다운이면 그래도 시도한다. 아무것도 안 하는 것보다 낫다.
  return live.concat(cooling);
}

// 429 를 받은 키를 쉬게 한다. 두 봇이 같은 컬럼을 보므로 한쪽의 발견이 곧 공유다.
function markExhausted(key, at) {
  var until = (at || nowMs()) + COOLDOWN_MS;
  try {
    return dbh().withDB(QUIZ_DB_PATH, function (db) {
      ensureColumns(db);
      db.execSQL("UPDATE quiz_apikey SET cooldown_until = ? WHERE key = ?",
                 [String(until), String(key)]);
      return true;
    });
  } catch (e) { return false; }   // DB 잠김 등 — 기록 못 해도 호출 자체는 계속돼야 한다
}

// 정상 응답한 키는 쿨다운을 푼다 (한도가 회복됐다는 증거)
function markAlive(key) {
  try {
    return dbh().withDB(QUIZ_DB_PATH, function (db) {
      ensureColumns(db);
      db.execSQL("UPDATE quiz_apikey SET cooldown_until = 0 WHERE key = ? AND cooldown_until <> 0",
                 [String(key)]);
      return true;
    });
  } catch (e) { return false; }
}

// 등급 변경. primary 로 올리면 기존 primary 는 secondary 로 내린다 (primary 는 하나).
function setPriority(key, priority) {
  var p = Number(priority);
  try {
    return dbh().withDB(QUIZ_DB_PATH, function (db) {
      ensureColumns(db);
      if (p === PRIORITY_PRIMARY) {
        db.execSQL("UPDATE quiz_apikey SET priority = " + PRIORITY_SECONDARY +
                   " WHERE priority = " + PRIORITY_PRIMARY + " AND key <> ?", [String(key)]);
      }
      db.execSQL("UPDATE quiz_apikey SET priority = ? WHERE key = ?", [String(p), String(key)]);
      return true;
    });
  } catch (e) { return false; }
}

function priorityLabel(p) {
  if (p === PRIORITY_PRIMARY) return "primary";
  if (p === PRIORITY_SECONDARY) return "secondary";
  return "방 전용";
}

// 남은 쿨다운을 사람이 읽을 문구로. 안 쉬는 중이면 빈 문자열.
function cooldownLabel(row, at) {
  var t = at || nowMs();
  if (!(row.cooldownUntil > t)) return "";
  var left = row.cooldownUntil - t;
  var h = Math.floor(left / 3600000), m = Math.floor((left % 3600000) / 60000);
  return h > 0 ? ("⏸ " + h + "시간 " + m + "분 남음") : ("⏸ " + Math.max(1, m) + "분 남음");
}

module.exports = {
  QUIZ_DB_PATH: QUIZ_DB_PATH,
  PRIORITY_PRIMARY: PRIORITY_PRIMARY,
  PRIORITY_SECONDARY: PRIORITY_SECONDARY,
  PRIORITY_ROOM: PRIORITY_ROOM,
  COOLDOWN_MS: COOLDOWN_MS,
  MODEL_CHAIN: MODEL_CHAIN,
  MODEL_DOWN_MS: MODEL_DOWN_MS,
  MODEL_BUSY_MS: MODEL_BUSY_MS,
  isModelError: isModelError,
  modelErrorKind: modelErrorKind,
  markModelDown: markModelDown,
  isModelDown: isModelDown,
  modelsFor: modelsFor,
  list: list,
  forRoom: forRoom,
  markExhausted: markExhausted,
  markAlive: markAlive,
  setPriority: setPriority,
  priorityLabel: priorityLabel,
  cooldownLabel: cooldownLabel,
  isCooling: isCooling
};
