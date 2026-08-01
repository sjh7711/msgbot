// =====================================================================
// admin.js — 봇 관리자 권한 (admin.db)
//
//  레벨:  2 = 슈퍼관리자 (권한 부여/회수 가능, 제한 없는 eval)
//         1 = 일반관리자 (샌드박스 eval 만)
//         0 = 일반 사용자
//
//  ⚠ 신원은 hash(카카오톡 user_id) 뿐이다. 닉네임으로 판정하면 안 된다 —
//    로그봇이 메시지마다 userhash.name 을 덮어쓰므로 닉은 언제든 바뀌고,
//    누구나 자기 닉을 "신쫑"으로 바꿀 수 있다.
//
//  오픈채팅은 방마다 다른 user_id 를 발급하므로 같은 사람이라도 방 수만큼
//  hash 가 생긴다. 그래서 권한은 person(사람 라벨) 단위로 주고 판정은 hash
//  단위로 한다. 내전봇의 users(hash PK) + players(nickname PK) 와 같은 구조.
//
//  스키마:
//    admin_person(person PK, level, granted_by, granted_at)
//    admin_hash(hash PK, person, name, room, added_at)   ← name/room 은 표시용 스냅샷
//
//  사용: var admin = require("/sdcard/msgbot/lib/admin.js");
//        admin.levelOf(msg.hash) / admin.isAdmin(h) / admin.isSuper(h)
//
//  RhinoJS-safe: var / function 만.
// =====================================================================

var _SD = Packages.android.os.Environment.getExternalStorageDirectory().getAbsolutePath();
var ADMIN_DB_PATH    = _SD + "/msgbot/admin.db";
var USERHASH_DB_PATH = _SD + "/msgbot/userhash.db";

var dbh = require(_SD + "/msgbot/lib/db-helper.js");

var LEVEL_NONE = 0, LEVEL_ADMIN = 1, LEVEL_SUPER = 2;

// 관리 명령(등록/회수)을 받을 수 있는 방. 1:1 개인톡이라 응답이 밖으로 새지 않는다.
// 도움말봇의 관리자 명령 노출 예외도 이 목록을 쓴다 (단일 진실원).
var ADMIN_ROOMS = ["신쫑"];
function isAdminRoom(room) { return ADMIN_ROOMS.indexOf(String(room == null ? "" : room)) !== -1; }
function adminRoomsLabel() { return ADMIN_ROOMS.join(", "); }

// 초기 슈퍼관리자. 닉네임이 아니라 hash 로 고정한다(닉은 신원이 아님).
// 2026-08-01 userhash.db 에서 name='신쫑' 인 행 전부.
var SEED_PERSON = "신쫑";
var SEED_HASHES = [
  { hash: "7632968047460528057", name: "신쫑", room: "명동(공공장소에서열지마세요)" },
  { hash: "8381502182490769722", name: "신쫑", room: "그쫑 메이플톡방" },
  { hash: "9112414478412173597", name: "신쫑", room: "신쫑" }
];

// =====================================================================
// 스키마 / 시드
// =====================================================================

function ensureSchema(db) {
  db.execSQL(
    "CREATE TABLE IF NOT EXISTS admin_person (" +
    "person TEXT PRIMARY KEY, " +
    "level INTEGER NOT NULL, " +
    "granted_by TEXT, " +
    "granted_at INTEGER)"
  );
  db.execSQL(
    "CREATE TABLE IF NOT EXISTS admin_hash (" +
    "hash TEXT PRIMARY KEY, " +
    "person TEXT NOT NULL, " +
    "name TEXT, " +
    "room TEXT, " +
    "added_at INTEGER)"
  );
  db.execSQL("CREATE INDEX IF NOT EXISTS idx_admin_hash_person ON admin_hash(person)");

  // 테이블이 비어 있을 때만 시드 — 이후 회수/변경을 되살리지 않는다.
  var rows = dbh.queryAll(db, "SELECT COUNT(*) AS c FROM admin_person", []);
  if (rows.length && parseInt(rows[0].c, 10) === 0) {
    var now = java.lang.System.currentTimeMillis();
    db.execSQL("INSERT INTO admin_person(person, level, granted_by, granted_at) VALUES(?,?,?,?)",
               [SEED_PERSON, LEVEL_SUPER, "seed", now]);
    for (var i = 0; i < SEED_HASHES.length; i++) {
      var s = SEED_HASHES[i];
      db.execSQL("INSERT OR REPLACE INTO admin_hash(hash, person, name, room, added_at) VALUES(?,?,?,?,?)",
                 [s.hash, SEED_PERSON, s.name, s.room, now]);
    }
  }
}

function withAdminDB(fn) {
  return dbh.withDB(ADMIN_DB_PATH, function (db) {
    ensureSchema(db);
    return fn(db);
  });
}

// =====================================================================
// 판정
// =====================================================================

// 반환: 0 | 1 | 2. DB 오류 시에도 0 (열리지 않으면 아무도 관리자가 아님 = 안전한 실패).
function levelOf(hash) {
  var h = String(hash || "");
  if (!h) return LEVEL_NONE;
  try {
    return withAdminDB(function (db) {
      var rows = dbh.queryAll(db,
        "SELECT p.level AS level FROM admin_hash h JOIN admin_person p ON p.person = h.person " +
        "WHERE h.hash = ? LIMIT 1", [h]);
      if (!rows.length) return LEVEL_NONE;
      var lv = parseInt(rows[0].level, 10);
      return isNaN(lv) ? LEVEL_NONE : lv;
    });
  } catch (e) {
    return LEVEL_NONE;
  }
}

function isAdmin(hash) { return levelOf(hash) >= LEVEL_ADMIN; }
function isSuper(hash) { return levelOf(hash) >= LEVEL_SUPER; }

function personOf(hash) {
  var h = String(hash || "");
  if (!h) return null;
  try {
    return withAdminDB(function (db) {
      var rows = dbh.queryAll(db, "SELECT person FROM admin_hash WHERE hash = ? LIMIT 1", [h]);
      return rows.length ? String(rows[0].person) : null;
    });
  } catch (e) { return null; }
}

// =====================================================================
// 조회
// =====================================================================

// [{ person, level, hashes: [{hash, name, room}] }] (레벨 내림차순, 이름순)
function listAdmins() {
  return withAdminDB(function (db) {
    var persons = dbh.queryAll(db,
      "SELECT person, level FROM admin_person ORDER BY level DESC, person ASC", []);
    var out = [];
    for (var i = 0; i < persons.length; i++) {
      var p = String(persons[i].person);
      var hs = dbh.queryAll(db,
        "SELECT hash, name, room FROM admin_hash WHERE person = ? ORDER BY room ASC", [p]);
      out.push({ person: p, level: parseInt(persons[i].level, 10), hashes: hs });
    }
    return out;
  });
}

// userhash.db 의 방 목록 (인원 많은 순). [{ room, count }]
function listRooms() {
  try {
    return dbh.withReadOnlyDB(USERHASH_DB_PATH, function (db) {
      var rows = dbh.queryAll(db,
        "SELECT room, COUNT(*) AS cnt FROM userhash GROUP BY room ORDER BY cnt DESC, room ASC", []);
      var out = [];
      for (var i = 0; i < rows.length; i++) {
        out.push({ room: String(rows[i].room), count: parseInt(rows[i].cnt, 10) });
      }
      return out;
    });
  } catch (e) { return []; }
}

// 한 방의 사람 목록 (이름순). [{ hash, name, room, last_seen }]
function listUsersInRoom(room) {
  try {
    return dbh.withReadOnlyDB(USERHASH_DB_PATH, function (db) {
      return dbh.queryAll(db,
        "SELECT hash, name, room, last_seen FROM userhash WHERE room = ? ORDER BY name ASC",
        [String(room)]);
    });
  } catch (e) { return []; }
}

// { hash: person } 전체 맵 — 목록에 "이미 관리자" 표시할 때 한 번에 조회
function listAdminHashes() {
  try {
    return withAdminDB(function (db) {
      var rows = dbh.queryAll(db, "SELECT hash, person FROM admin_hash", []);
      var map = {};
      for (var i = 0; i < rows.length; i++) map[String(rows[i].hash)] = String(rows[i].person);
      return map;
    });
  } catch (e) { return {}; }
}

// userhash.db 에서 닉네임으로 hash 후보 찾기 (등록 대상 고르기용)
// userhash.db 가 없으면 [] 반환.
function findHashesByName(name) {
  var n = String(name || "");
  if (!n) return [];
  try {
    return dbh.withReadOnlyDB(USERHASH_DB_PATH, function (db) {
      return dbh.queryAll(db,
        "SELECT hash, name, room, last_seen FROM userhash WHERE name = ? ORDER BY last_seen DESC", [n]);
    });
  } catch (e) {
    return [];
  }
}

// =====================================================================
// 변경 (호출부에서 슈퍼관리자인지 먼저 확인할 것)
// =====================================================================

// person 에게 level 을 주고 hashRows([{hash,name,room}]) 를 연결한다.
// 이미 있으면 레벨을 갱신하고 hash 를 합친다(멱등).
function grant(person, level, hashRows, byHash) {
  var p = String(person || "");
  if (!p) return { error: "person 이 비어 있습니다." };
  if (!hashRows || !hashRows.length) return { error: "연결할 hash 가 없습니다." };

  var lv = parseInt(level, 10);
  if (lv !== LEVEL_ADMIN && lv !== LEVEL_SUPER) return { error: "level 은 1 또는 2 여야 합니다." };

  return withAdminDB(function (db) {
    return dbh.transaction(db, function () {
      var now = java.lang.System.currentTimeMillis();
      db.execSQL("INSERT OR REPLACE INTO admin_person(person, level, granted_by, granted_at) VALUES(?,?,?,?)",
                 [p, lv, String(byHash || ""), now]);

      var added = 0, moved = 0;
      for (var i = 0; i < hashRows.length; i++) {
        var r = hashRows[i];
        var h = String(r.hash || "");
        if (!h) continue;
        var cur = dbh.queryAll(db, "SELECT person FROM admin_hash WHERE hash = ? LIMIT 1", [h]);
        if (cur.length && String(cur[0].person) !== p) moved++;
        else if (!cur.length) added++;
        db.execSQL("INSERT OR REPLACE INTO admin_hash(hash, person, name, room, added_at) VALUES(?,?,?,?,?)",
                   [h, p, String(r.name || ""), String(r.room || ""), now]);
      }
      return { person: p, level: lv, added: added, moved: moved, total: hashRows.length };
    });
  });
}

// person 의 권한을 회수한다. 잠금 사고 방지 규칙:
//   · 마지막 슈퍼관리자는 회수 불가
//   · 자기 자신은 회수 불가
function revoke(person, byHash) {
  var p = String(person || "");
  if (!p) return { error: "person 이 비어 있습니다." };

  var mine = personOf(byHash);
  if (mine !== null && mine === p) return { error: "자기 자신의 권한은 회수할 수 없습니다." };

  return withAdminDB(function (db) {
    var rows = dbh.queryAll(db, "SELECT level FROM admin_person WHERE person = ? LIMIT 1", [p]);
    if (!rows.length) return { error: "'" + p + "' 은(는) 등록된 관리자가 아닙니다." };
    var lv = parseInt(rows[0].level, 10);

    if (lv >= LEVEL_SUPER) {
      var sup = dbh.queryAll(db, "SELECT COUNT(*) AS c FROM admin_person WHERE level >= ?", [LEVEL_SUPER]);
      if (sup.length && parseInt(sup[0].c, 10) <= 1) {
        return { error: "마지막 슈퍼관리자는 회수할 수 없습니다." };
      }
    }

    return dbh.transaction(db, function () {
      var hs = dbh.queryAll(db, "SELECT COUNT(*) AS c FROM admin_hash WHERE person = ?", [p]);
      var n = hs.length ? parseInt(hs[0].c, 10) : 0;
      db.execSQL("DELETE FROM admin_hash WHERE person = ?", [p]);
      db.execSQL("DELETE FROM admin_person WHERE person = ?", [p]);
      return { person: p, level: lv, removedHashes: n };
    });
  });
}

module.exports = {
  LEVEL_NONE: LEVEL_NONE,
  LEVEL_ADMIN: LEVEL_ADMIN,
  LEVEL_SUPER: LEVEL_SUPER,
  ADMIN_DB_PATH: ADMIN_DB_PATH,
  ADMIN_ROOMS: ADMIN_ROOMS,
  isAdminRoom: isAdminRoom,
  adminRoomsLabel: adminRoomsLabel,
  levelOf: levelOf,
  isAdmin: isAdmin,
  isSuper: isSuper,
  personOf: personOf,
  listAdmins: listAdmins,
  listRooms: listRooms,
  listUsersInRoom: listUsersInRoom,
  listAdminHashes: listAdminHashes,
  findHashesByName: findHashesByName,
  grant: grant,
  revoke: revoke
};
