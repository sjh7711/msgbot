// =====================================================================
// kakao-decrypt.js — KakaoTalk DB 복호화 + user_id↔닉네임 공유 캐시 모듈
//
// 복호화 핵심 비용은 DB 가 아니라 su 프로세스 스폰이라, ChatManager 방식
// (영구 su 셸 재사용 + ReentrantLock)을 채택. sqlite3 는 -readonly.
//
// ── 이름 캐시 설계 ──
//   * msg.author.name 은 닉네임이 꼬여 들어오는 경우가 있어 신뢰하지 않는다.
//     user_id 를 open_chat_member 에서 "직접 복호화"한 값만 캐시한다.
//   * 캐시는 System.getProperties() 의 ConcurrentHashMap 1개를 모든 봇이 공유
//     (__CHATMANAGER_REGISTRY__ 와 동일 패턴). 값은 JSON {"n","r","t"} 문자열.
//   * TTL 20초 = "정방향 재복호화 주기"일 뿐, 항목을 삭제하지 않는다.
//     (만료돼도 맵에 남아 역방향 스캔에 쓰임 → 침묵 20초에도 캐시 안 사라짐)
//   * 영속화: userhash.db 의 kt_name_cache 테이블에 30분 주기 flush, 봇/프로세스
//     기동 후 첫 접근 시 1회 복구 → 재시작에도 보존.
//   * 정방향(getUserName/Names): 신선분은 캐시, 만료/미스는 재복호화+갱신.
//   * 역방향(findUserIdsByName): 공유 캐시 스캔(room 필터 가능).
//   * 빈 결과 폴백(resolveSender): chat_id + 메시지 내용 매칭으로 실제 작성자
//     user_id 를 역추적 → 복호화 → 캐시(room 포함).
//
// RhinoJS-safe: var / function 만. ?. , ?? , 템플릿리터럴, arrow 미사용.
// =====================================================================

var SQLiteDatabase = Packages.android.database.sqlite.SQLiteDatabase;

var DB1_PATH = "/data/data/com.kakao.talk/databases/KakaoTalk.db";
var DB2_PATH = "/data/data/com.kakao.talk/databases/KakaoTalk2.db";
var CACHE_DB_PATH = Packages.android.os.Environment.getExternalStorageDirectory()
    .getAbsolutePath() + "/msgbot/userhash.db";

var USER_NAME_TTL_MS = 20 * 1000;          // 정방향 재복호화 주기 20초
var FLUSH_INTERVAL_MS = 30 * 60 * 1000;    // 캐시 DB flush 주기 30분
var CONTENT_MATCH_LIMIT = 40;              // 폴백 시 역추적할 최근 chat_logs 행 수

// ─── byte 헬퍼 ──────────────────────────────────────────────────────
function _toJavaByteArr(arr) {
  var B = java.lang.reflect.Array.newInstance(java.lang.Byte.TYPE, arr.length);
  for (var i = 0; i < arr.length; i++) { var v = arr[i] & 0xFF; if (v > 127) v -= 256; B[i] = v; }
  return B;
}
function _initArray(size, fill) { var a = new Array(size); for (var i = 0; i < size; i++) a[i] = fill; return a; }
function _arraycopy(src, sp, dst, dp, len) { for (var i = 0; i < len; i++) dst[dp + i] = src[sp + i]; }

// ─── PBKDF(PKCS12, SHA-1) 키 유도 + AES/CBC 복호화 ─────────────────
function _genSalt(userId, encType) {
  if (userId <= 0) return '\0'.repeat(16);
  var prefixes = ['','','12','24','18','30','36','12','48','7','35','40','17','23','29',
    'isabel','kale','sulli','van','merry','kyle','james','maddux','tony','hayden',
    'paul','elijah','dorothy','sally','bran','extr.ursra','veil'];
  var salt = (prefixes[encType] + userId).slice(0, 16);
  salt = salt + '\0'.repeat(16 - salt.length);
  return new java.lang.String(salt).getBytes("UTF-8").slice();
}
function _adjust(a, aOff, b) {
  var x = (b[b.length-1] & 0xff) + (a[aOff + b.length-1] & 0xff) + 1;
  a[aOff + b.length-1] = x % 256; x = x >> 8;
  for (var i = b.length-2; i >= 0; i--) { x = x + (b[i] & 0xff) + (a[aOff + i] & 0xff); a[aOff + i] = x % 256; x = x >> 8; }
}
function deriveKey(userId, encType) {
  var salt = _genSalt(userId, encType);
  var password = [0,22,0,8,0,9,0,111,0,2,0,23,0,43,0,8,0,33,0,33,0,10,0,16,0,3,0,3,0,7,0,6,0,0];
  var iterations = 2, dkeySize = 32, v = 64, u = 20;
  var D = _initArray(v, 1);
  var S = _initArray(v * Math.floor((salt.length + v - 1) / v), 0);
  for (var i in S) S[i] = salt[i % salt.length];
  var P = _initArray(v * Math.floor((password.length + v - 1) / v), 0);
  for (var i in P) P[i] = password[i % password.length];
  var I = S.concat(P);
  var B = _initArray(v, 0);
  var c = Math.floor((dkeySize + u - 1) / u);
  var dKey = _initArray(dkeySize, 0);
  for (var i = 1; i <= c; i++) {
    var h = java.security.MessageDigest.getInstance("SHA-1");
    h.update(_toJavaByteArr(D)); h.update(_toJavaByteArr(I));
    var A = h.digest();
    for (var j = 1; j < iterations; j++) { h = java.security.MessageDigest.getInstance("SHA-1"); h.update(A); A = h.digest(); }
    for (var j = 0; j != B.length; j++) B[j] = A[j % A.length];
    for (var j = 0; j != I.length / v; j++) _adjust(I, j * v, B);
    if (i == c) _arraycopy(A, 0, dKey, (i-1)*u, dKey.length - ((i-1)*u));
    else        _arraycopy(A, 0, dKey, (i-1)*u, A.length);
  }
  return dKey;
}
function _b64AESDecrypt(key, iv, encrypted) {
  encrypted = Packages.android.util.Base64.decode(encrypted, 0);
  iv = new Packages.javax.crypto.spec.IvParameterSpec(iv);
  key = new Packages.javax.crypto.spec.SecretKeySpec(key, "AES");
  var cipher = Packages.javax.crypto.Cipher.getInstance("AES/CBC/PKCS5PADDING");
  cipher.init(2, key, iv);
  return cipher.doFinal(encrypted);
}
// 실패 시 입력(b64)을 그대로 돌려준다 (복호화 불가 행 판별용).
function decrypt(key, b64) {
  try {
    var iv = [15,8,1,0,25,71,37,220,21,245,23,224,225,21,12,53];
    var dec = _b64AESDecrypt(_toJavaByteArr(key), _toJavaByteArr(iv), b64);
    return String(new java.lang.String(dec, "utf-8"));
  } catch(_) { return b64; }
}

// (userId, encType) → 키 캐시 (봇별 — 결정적이라 공유 불필요)
var _keyCache = {};
function keyFor(userId, encType) {
  var k = userId + "_" + encType; var v = _keyCache[k];
  if (!v) { v = deriveKey(userId, encType); _keyCache[k] = v; }
  return v;
}

// ─── su 실행 (공유 su 셸 모듈로 위임: JVM 1개 재사용 + 레지스트리 등록) ──
var _suMod = null;
try { _suMod = require(Packages.android.os.Environment.getExternalStorageDirectory().getAbsolutePath() + "/msgbot/lib/su-shell.js"); } catch(_) {}
function _suOneShot(command) {
  var proc = null;
  try {
    var l = new java.util.ArrayList(); l.add("su"); l.add("-c"); l.add(command);
    var pb = new java.lang.ProcessBuilder(l); pb.redirectErrorStream(true);
    proc = pb.start();
    var rd = new java.io.BufferedReader(new java.io.InputStreamReader(proc.getInputStream(), "UTF-8"));
    var sb = new java.lang.StringBuilder(); var ln;
    while ((ln = rd.readLine()) !== null) sb.append(ln).append("\n");
    rd.close(); proc.waitFor();
    return String(sb.toString());
  } catch(e) { return "ERR: " + (e && e.message ? e.message : e); }
  finally { try { if (proc) proc.destroy(); } catch(_) {} }
}
function suExec(command) { return _suMod ? _suMod.exec(command) : _suOneShot(command); }

// ─── sqlite3 (-readonly, -line 객체 파서) ──────────────────────────
function runSqlite(dbPath, sql) {
  var sqlOneLine = String(sql).replace(/\r?\n/g, ' ').replace(/'/g, "'\\''");
  var cmd = "sqlite3 -readonly -batch -line '" + dbPath + "' '" + sqlOneLine + "'";
  var out = String(suExec(cmd) || "");
  if (out.indexOf("Error:") !== -1 || out.indexOf("rror near") !== -1 ||
      out.indexOf("extra argument") !== -1) return null;
  var rowsObj = [], cur = null, lastKey = null;
  var lines = out.split("\n");
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    if (!l || !l.replace(/\s+/g, "").length) { if (cur) { rowsObj.push(cur); cur = null; lastKey = null; } continue; }
    var eq = l.indexOf(" = ");
    if (eq < 0) { if (cur && lastKey != null) cur[lastKey] += "\n" + l; continue; }  // 멀티라인 값
    var k = l.slice(0, eq).replace(/^\s+/, ""); var val = l.slice(eq + 3);
    if (!cur) cur = {}; cur[k] = val; lastKey = k;
  }
  if (cur) rowsObj.push(cur);
  return rowsObj;
}

// ─── 공유 이름 캐시 (System.getProperties JVM 전역, 값=JSON {n,r,t}) ──
var _CACHE_KEY    = "__KT_NAME_CACHE__";
var _LOADED_KEY   = "__KT_CACHE_LOADED__";
var _LASTFLUSH_KEY = "__KT_CACHE_LASTFLUSH__";
function _cacheMap() {
  var props = java.lang.System.getProperties();
  var m = props.get(_CACHE_KEY);
  if (m == null) { m = new java.util.concurrent.ConcurrentHashMap(); props.put(_CACHE_KEY, m); }
  return m;
}
function _enc(name, room, ts) {
  return JSON.stringify({ n: String(name == null ? "" : name), r: String(room == null ? "" : room), t: ts || 0 });
}
function _dec(v) {
  if (v == null) return null;
  try { var o = JSON.parse(String(v)); return { name: String(o.n || ""), room: String(o.r || ""), ts: o.t || 0 }; }
  catch(_) { return null; }
}
function _cacheGet(uid) { return _dec(_cacheMap().get(String(uid))); }
// room 이 비면 기존 room 을 보존(정방향 조회가 방 태그를 지우지 않게).
function _cachePut(uid, name, room, ts) {
  try {
    if (!room) { var old = _cacheGet(uid); if (old && old.room) room = old.room; }
    _cacheMap().put(String(uid), _enc(name, room, ts));
    _maybeFlush(false);
  } catch(_) {}
}

// ─── 영속화: userhash.db 의 kt_name_cache ──────────────────────────
function _ensureCacheTable(db) {
  db.execSQL("CREATE TABLE IF NOT EXISTS kt_name_cache (" +
    "user_id TEXT PRIMARY KEY, name TEXT, room TEXT, ts INTEGER)");
}
// 프로세스(JVM)당 1회: DB → 공유 맵 복구.
function _loadFromDB() {
  var props = java.lang.System.getProperties();
  if (props.get(_LOADED_KEY) != null) return;
  props.put(_LOADED_KEY, "1");
  var db = null, cur = null;
  try {
    db = SQLiteDatabase.openOrCreateDatabase(CACHE_DB_PATH, null);
    _ensureCacheTable(db);
    cur = db.rawQuery("SELECT user_id, name, room, ts FROM kt_name_cache", null);
    var m = _cacheMap();
    while (cur.moveToNext()) {
      var uid = cur.getString(0);
      if (uid == null) continue;
      m.put(String(uid), _enc(cur.getString(1), cur.getString(2), parseInt(cur.getString(3), 10) || 0));
    }
  } catch(_) {} finally {
    try { if (cur) cur.close(); } catch(_) {}
    try { if (db) db.close(); } catch(_) {}
  }
}
// 30분 경과 시(또는 force) 공유 맵 → DB. lastFlush 를 먼저 선점해 동시 flush 방지.
function _maybeFlush(force) {
  var props = java.lang.System.getProperties();
  var last = props.get(_LASTFLUSH_KEY); last = last ? (parseInt(String(last), 10) || 0) : 0;
  var now = Date.now();
  if (!force && last && (now - last) < FLUSH_INTERVAL_MS) return;
  props.put(_LASTFLUSH_KEY, String(now));
  var db = null;
  try {
    db = SQLiteDatabase.openOrCreateDatabase(CACHE_DB_PATH, null);
    _ensureCacheTable(db);
    db.beginTransaction();
    try {
      var stmt = db.compileStatement("INSERT OR REPLACE INTO kt_name_cache(user_id, name, room, ts) VALUES(?,?,?,?)");
      var it = _cacheMap().entrySet().iterator();
      while (it.hasNext()) {
        var e = it.next(); var d = _dec(e.getValue()); if (!d) continue;
        stmt.clearBindings();
        stmt.bindString(1, String(e.getKey()));
        stmt.bindString(2, d.name || "");
        stmt.bindString(3, d.room || "");
        stmt.bindString(4, String(d.ts || 0));
        stmt.execute();
      }
      db.setTransactionSuccessful();
    } finally { try { db.endTransaction(); } catch(_) {} }
  } catch(_) {} finally { try { if (db) db.close(); } catch(_) {} }
}
function flush() { _maybeFlush(true); }   // 수동 flush (종료 직전 등)

// ─── 이름 해석 상태 (봇별) ─────────────────────────────────────────
var _ready = null;
var _myKeys = {};
var _friendsTable = null, _friendsId = "id", _friendsName = "name";

function _initNames() {
  try {
    var rows = runSqlite(DB2_PATH, "SELECT user_id FROM open_profile LIMIT 1;");
    if (rows && rows.length) {
      var myid = rows[0].user_id;
      for (var i = 1; i <= 31; i++) _myKeys[String(i)] = deriveKey(myid, i);
    }
    var cands = [["open_chat_member","user_id","nickname"],["friends_v2","id","name"],["friends","id","name"]];
    for (var ci = 0; ci < cands.length; ci++) {
      var c = cands[ci];
      var p = runSqlite(DB2_PATH, "SELECT COUNT(*) AS n FROM " + c[0] + " LIMIT 1;");
      if (p && p.length) { _friendsTable = c[0]; _friendsId = c[1]; _friendsName = c[2]; break; }
    }
  } catch(_) {}
}

// 최초 1회: DB 캐시 복구 + root 확인 + 이름 테이블/키 준비.
function isReady() {
  if (_ready !== null) return _ready;
  try {
    _loadFromDB();                                   // 캐시 복구는 root 없이도 수행
    var who = String(suExec("whoami") || "").trim();
    if (who.indexOf("root") === -1) { _ready = false; return false; }
    _initNames();
    _ready = true;
  } catch(_) { _ready = false; }
  return _ready;
}

// 정방향: user_id 배열 → { user_id: name }. 신선 캐시는 그대로, 만료/미스만 배치 복호화+갱신.
function getUserNames(uids) {
  var res = {}, now = Date.now(), need = [];
  if (!uids || !uids.length) return res;
  for (var i = 0; i < uids.length; i++) {
    var u = String(uids[i]);
    var c = _cacheGet(u);
    if (c && (now - c.ts) < USER_NAME_TTL_MS) { res[u] = c.name; continue; }
    if (/^\d+$/.test(u)) need.push(u);
    else res[u] = "user_" + u;
  }
  if (!need.length) return res;
  if (!isReady() || !_friendsTable) {
    for (var i = 0; i < need.length; i++) {
      var c2 = _cacheGet(need[i]);                  // 신선친 아니어도 캐시값 있으면 활용
      res[need[i]] = (c2 && c2.name) ? c2.name : ("user_" + need[i]);
    }
    return res;
  }
  var found = {};
  try {
    var sql = "SELECT " + _friendsId + " AS uid, " + _friendsName + " AS nm, enc FROM " +
              _friendsTable + " WHERE " + _friendsId + " IN (" + need.join(",") + ");";
    var rows = runSqlite(DB2_PATH, sql);
    if (rows) {
      for (var i = 0; i < rows.length; i++) {
        var uid = rows[i].uid, encName = rows[i].nm, key = _myKeys[String(rows[i].enc)];
        var nm = key ? decrypt(key, encName) : null;
        if (nm && nm !== encName) found[uid] = nm;
      }
    }
  } catch(_) {}
  for (var i = 0; i < need.length; i++) {
    var u = need[i];
    if (found[u]) { _cachePut(u, found[u], "", now); res[u] = found[u]; }   // 정방향 → 캐시 갱신
    else { var c3 = _cacheGet(u); res[u] = (c3 && c3.name) ? c3.name : ("user_" + u); }
  }
  return res;
}
function getUserName(uid) {
  var r = getUserNames([uid]);
  return r[String(uid)] || ("user_" + uid);
}

// 역방향: 공유 캐시에서 name 일치 user_id 목록 [{uid,name,room}].
//   partial=true → 부분일치. room 지정 시 그 방의 항목만.
function findUserIdsByName(name, partial, room) {
  var out = [], target = String(name);
  if (!target) return out;
  if (_ready === null) { try { _loadFromDB(); } catch(_) {} }   // 캐시 비었으면 복구 시도
  var roomF = room ? String(room) : null;
  try {
    var it = _cacheMap().entrySet().iterator();
    while (it.hasNext()) {
      var e = it.next(); var d = _dec(e.getValue()); if (!d) continue;
      if (roomF && d.room !== roomF) continue;
      var hit = partial ? (d.name.indexOf(target) !== -1) : (d.name === target);
      if (hit) out.push({ uid: String(e.getKey()), name: d.name, room: d.room });
    }
  } catch(_) {}
  return out;
}

// 빈 결과 폴백: chat_id + 메시지 내용 매칭으로 실제 작성자 user_id 역추적.
function _findUidByContent(cid, content) {
  if (!cid || content == null) return null;
  var rows = runSqlite(DB1_PATH,
    "SELECT user_id, message, v FROM chat_logs WHERE chat_id = " + cid +
    " ORDER BY created_at DESC LIMIT " + CONTENT_MATCH_LIMIT + ";");
  if (!rows) return null;
  var target = String(content);
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!r.user_id || r.message == null) continue;
    var enc = null; try { enc = (JSON.parse(r.v || "{}")).enc; } catch(_) {}
    if (enc == null) continue;
    var dec = decrypt(keyFor(r.user_id, enc), r.message);
    if (String(dec) === target) return String(r.user_id);
  }
  return null;
}

// 메시지의 "신뢰 가능한" 작성자 해석 → { uid, name, room }.
//   1) msg.author.hash(숫자 user_id) 를 정방향 해석(캐시/복호화). 성공 시 room 태그.
//   2) 실패 시 chat_id + 내용 매칭으로 user_id 역추적 → 복호화 → 캐시.
//   3) 그래도 안 되면 최후수단으로 msg.author.name.
function resolveSender(msg) {
  var room = (msg && msg.room) ? String(msg.room) : "";
  var now = Date.now();
  var hash = (msg && msg.author && msg.author.hash != null) ? String(msg.author.hash).replace(/[^0-9]/g, "") : "";
  if (hash) {
    var nm = getUserName(hash);
    if (nm && nm !== ("user_" + hash)) { _cachePut(hash, nm, room, now); return { uid: hash, name: nm, room: room }; }
  }
  var cid = (msg && msg.channelId != null) ? String(msg.channelId).replace(/[^0-9]/g, "") : "";
  var content = (msg && msg.content != null) ? msg.content : (msg ? msg.text : null);
  if (isReady() && cid && content != null) {
    var uid = _findUidByContent(cid, content);
    if (uid) {
      var nm2 = getUserName(uid);
      _cachePut(uid, nm2, room, now);
      return { uid: uid, name: nm2, room: room };
    }
  }
  var fallbackName = (msg && msg.author && msg.author.name) ? String(msg.author.name) : "익명";
  return { uid: hash || null, name: fallbackName, room: room };
}

module.exports = {
  DB1_PATH: DB1_PATH,
  DB2_PATH: DB2_PATH,
  CACHE_DB_PATH: CACHE_DB_PATH,
  // 저수준
  deriveKey: deriveKey,
  decrypt: decrypt,
  keyFor: keyFor,
  suExec: suExec,
  runSqlite: runSqlite,
  // 정방향 (캐시 갱신)
  isReady: isReady,
  getUserName: getUserName,
  getUserNames: getUserNames,
  // 역방향 (공유 캐시 스캔, room 필터)
  findUserIdsByName: findUserIdsByName,
  // 신뢰 가능한 작성자 해석(폴백 포함)
  resolveSender: resolveSender,
  // 영속화
  flush: flush
};
