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

function nowMs() { return java.lang.System.currentTimeMillis(); }

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
  list: list,
  forRoom: forRoom,
  markExhausted: markExhausted,
  markAlive: markAlive,
  setPriority: setPriority,
  priorityLabel: priorityLabel,
  cooldownLabel: cooldownLabel,
  isCooling: isCooling
};
