const bot = BotManager.getCurrentBot();

// =====================================================================
// ChatManager — KakaoTalk DB 폴링/복호화 중앙 디스패처
//
// 한 곳에서 KakaoTalk.db를 300ms 폴링/복호화하고,
// 디코딩된 메시지를 등록된 모든 챗봇 큐에 broadcast 한다.
// 각 챗봇은 DB를 건드리지 않고 자기 LinkedBlockingQueue 에서 take() 만 하면 됨.
//
// 구독 방법 (subscriber 봇 스크립트):
//   var sysProps = java.lang.System.getProperties();
//   var REG_KEY = "__CHATMANAGER_REGISTRY__";
//   var registry = sysProps.get(REG_KEY);
//   if (registry == null) {
//     registry = new java.util.concurrent.ConcurrentHashMap();
//     sysProps.put(REG_KEY, registry);
//   }
//   var myQueue = new java.util.concurrent.LinkedBlockingQueue();
//   registry.put("내봇이름", myQueue);   // 같은 이름 재등록은 큐 교체 (멱등)
//
// 큐에서 받는 객체: java.util.HashMap
//   { name: String, hash: String, room: String, text: String, ts: Long }
// =====================================================================

// ── KDecrypter (KakaoTalk 메시지 AES 복호화) ───────────────────────
function _toJavaByteArr(arr) {
  var B = java.lang.reflect.Array.newInstance(java.lang.Byte.TYPE, arr.length);
  for (var i = 0; i < arr.length; i++) {
    var v = arr[i] & 0xFF;
    if (v > 127) v -= 256;
    B[i] = v;
  }
  return B;
}
function _arraycopy(src, sp, dst, dp, len) {
  for (var i = 0; i < len; i++) dst[dp + i] = src[sp + i];
}
function _initArray(size, fill) {
  var a = new Array(size);
  for (var i = 0; i < size; i++) a[i] = fill;
  return a;
}
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
  a[aOff + b.length-1] = x % 256;
  x = x >> 8;
  for (var i = b.length-2; i >= 0; i--) {
    x = x + (b[i] & 0xff) + (a[aOff + i] & 0xff);
    a[aOff + i] = x % 256;
    x = x >> 8;
  }
}
function _deriveKey(userId, encType) {
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
    h.update(_toJavaByteArr(D));
    h.update(_toJavaByteArr(I));
    var A = h.digest();
    for (var j = 1; j < iterations; j++) {
      h = java.security.MessageDigest.getInstance("SHA-1");
      h.update(A);
      A = h.digest();
    }
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
function _decrypt(key, b64) {
  try {
    var iv = [15,8,1,0,25,71,37,220,21,245,23,224,225,21,12,53];
    var dec = _b64AESDecrypt(_toJavaByteArr(key), _toJavaByteArr(iv), b64);
    return String(new java.lang.String(dec, "utf-8"));
  } catch(_) { return b64; }
}

// ── KakaoTalk DB 폴링 상태 ─────────────────────────────────────────
var KT_DB1_PATH = "/data/data/com.kakao.talk/databases/KakaoTalk.db";
var KT_DB2_PATH = "/data/data/com.kakao.talk/databases/KakaoTalk2.db";
var KT_OK = false;
var KT_FRIENDS_TABLE = null;
var KT_FRIENDS_ID_COL = "id";
var KT_FRIENDS_NAME_COL = "name";
var _myIdCache = {};
var _keyCache = {};
var _userNameCache = {};            // user_id -> { name, ts, miss? } (ts 기준 TTL 만료)
var USER_NAME_TTL_MS = 5 * 60 * 1000; // 닉네임 캐시 수명 5분 — 만료 시 open_chat_member 재조회
// 조회 실패(placeholder "user_<id>") 는 짧게만 캐시한다. 5분씩 캐싱하면 su 셸이 잠깐 바빠
// 첫 조회가 실패한 사용자가 5분 내내 user_<id> 로 표시되던 버그가 있었다(일시 실패를 빠르게 회복).
var USER_NAME_MISS_TTL_MS = 15 * 1000;
// channelId(=chat_id) ↔ room 이름 매핑. 라이브 onMessage 에서 rawMsg.channelId + rawMsg.room 을
// "동시에·정확히" 받아 채운다 (과거의 '최신 행 추측' 학습 제거 → 레이스/오매핑 없음).
// channelId 는 불변이라 파일로 영속화하고 시작 시 로드한다 (재시작 후 즉시 사용).
var CHANNEL_MAP_PATH = Packages.android.os.Environment.getExternalStorageDirectory()
    .getAbsolutePath() + "/msgbot/channel_rooms.json";
var _channelRooms = {};      // { channelId(String): room(String) }
var _pendingByChannel = {};  // 아직 매핑 안 된 channelId → 보관 메시지 (매핑 시 flush)
var PENDING_MAX = 30;        // channelId 당 최대 보관 수
var _lastProcessedId = -1;
var _lastDecomposeId = 0;   // 마지막으로 처리한 !해체 명령 행의 _id (재처리/레이스 방지)

// ── 쉘 실행 헬퍼 ────────────────────────────────────────────────────
// useSu=true면 su 권한으로 실행. 영구 su 셸 재사용 (Magisk 프롬프트는 첫 호출만).
var _suMod = null;
try { _suMod = require(Packages.android.os.Environment.getExternalStorageDirectory().getAbsolutePath() + "/msgbot/lib/su-shell.js"); } catch(_) {}
var _treg = null;
try { _treg = require(Packages.android.os.Environment.getExternalStorageDirectory().getAbsolutePath() + "/msgbot/lib/thread-registry.js"); } catch(_) {}
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
// useSu=true 면 공유 su 셸 모듈로 위임(없으면 1회성 su 폴백).
function _suExec(command) { return _suMod ? _suMod.exec(command) : _suOneShot(command); }

function _shell(command, useSu) {
  if (useSu) return _suExec(command);
  var proc = null;
  try {
    var list = new java.util.ArrayList();
    list.add("sh"); list.add("-c"); list.add(command);
    var pb = new java.lang.ProcessBuilder(list);
    pb.redirectErrorStream(true);
    proc = pb.start();
    var reader = new java.io.BufferedReader(
      new java.io.InputStreamReader(proc.getInputStream(), "UTF-8"));
    var sb = new java.lang.StringBuilder();
    var line;
    while ((line = reader.readLine()) !== null) sb.append(line).append("\n");
    reader.close();
    proc.waitFor();
    return String(sb.toString());
  } catch(e) {
    return "ERR: " + (e && e.message ? e.message : e);
  } finally {
    try { if (proc) proc.destroy(); } catch(_) {}
  }
}

// ── sqlite3 헬퍼 (su 컨텍스트에서 실행) ────────────────────────────
function _sql(dbPath, sql, quiet) {
  var sqlOneLine = String(sql).replace(/\r?\n/g, ' ').replace(/"/g, '\\"');
  var cmd = "sqlite3 -readonly -batch -line '" + dbPath + "' \"" + sqlOneLine + "\"";
  var out = String(_shell(cmd, true) || "");

  if (out.indexOf("Error:") !== -1 || out.indexOf("rror near") !== -1 ||
      out.indexOf("extra argument") !== -1) {
    return null;
  }

  var rowsObj = [];
  var cur = null;
  var lines = out.split("\n");
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i];
    if (!ln || !ln.replace(/\s+/g, "").length) {
      if (cur) { rowsObj.push(cur); cur = null; }
      continue;
    }
    var eq = ln.indexOf(" = ");
    if (eq < 0) continue;
    var key = ln.slice(0, eq).replace(/^\s+/, "");
    var val = ln.slice(eq + 3);
    if (!cur) cur = {};
    cur[key] = val;
  }
  if (cur) rowsObj.push(cur);

  if (!rowsObj.length) return [];
  var keys = Object.keys(rowsObj[0]);
  var result = [];
  for (var j = 0; j < rowsObj.length; j++) {
    var row = [];
    for (var k = 0; k < keys.length; k++) {
      var v = rowsObj[j][keys[k]];
      row.push(v == null ? "" : v);
    }
    result.push(row);
  }
  return result;
}

// _sql 과 동일하지만 컬럼명을 보존해 행을 { col: value } 객체로 반환한다.
// (해체 명령처럼 어떤 컬럼이 어떤 값인지 알아야 할 때 사용)
function _sqlObj(dbPath, sql) {
  var sqlOneLine = String(sql).replace(/\r?\n/g, ' ').replace(/"/g, '\\"');
  var cmd = "sqlite3 -readonly -batch -line '" + dbPath + "' \"" + sqlOneLine + "\"";
  var out = String(_shell(cmd, true) || "");
  if (out.indexOf("Error:") !== -1 || out.indexOf("rror near") !== -1 ||
      out.indexOf("extra argument") !== -1) {
    return null;
  }
  var rowsObj = [], cur = null, lastKey = null;
  var lines = out.split("\n");
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i];
    if (!ln || !ln.replace(/\s+/g, "").length) {        // 빈 줄 = 행 구분자
      if (cur) { rowsObj.push(cur); cur = null; lastKey = null; }
      continue;
    }
    var eq = ln.indexOf(" = ");
    if (eq < 0) {                                        // 멀티라인 값 → 직전 키에 이어붙임
      if (cur && lastKey != null) cur[lastKey] += "\n" + ln;
      continue;
    }
    var k = ln.slice(0, eq).replace(/^\s+/, "");
    var val = ln.slice(eq + 3);
    if (!cur) cur = {};
    cur[k] = val;
    lastKey = k;
  }
  if (cur) rowsObj.push(cur);
  return rowsObj;
}

// JSON 문자열이면 들여쓰기로 보기 좋게, 아니면 원문 그대로
function _prettyJSON(s) {
  if (s == null || s === "") return "";
  try {
    // 큰 정수(카카오 19자리 ID 등)는 JS Number 안전범위(2^53)를 넘어 JSON.parse 시
    // 정밀도가 깨진다. 파싱 전에 16자리 이상 정수 값을 문자열로 감싸 원본 자릿수 보존.
    var safe = String(s).replace(/([:\[,]\s*)(-?\d{16,})(?=\s*[,\]}])/g, '$1"$2"');
    return JSON.stringify(JSON.parse(safe), null, 2);
  } catch(_) { return String(s); }
}

// ── KakaoTalk DB 초기화 ────────────────────────────────────────────
function initKakaoDB() {
  try {
    var whoOut = _shell("whoami", true).trim();
    if (whoOut.indexOf("root") === -1) {
      Log.e("[ChatManager] root 권한 없음");
      return false;
    }
    var sqliteBin = _shell("which sqlite3", true).trim();
    if (!sqliteBin || sqliteBin.indexOf("not found") !== -1 || sqliteBin.indexOf("ERR") === 0) {
      Log.e("[ChatManager] sqlite3 바이너리 없음");
      return false;
    }
    var probe = _shell("ls " + KT_DB1_PATH, true).trim();
    if (probe.indexOf("KakaoTalk.db") === -1) {
      Log.e("[ChatManager] DB 파일 없음");
      return false;
    }

    var rows = _sql(KT_DB2_PATH, "SELECT user_id FROM open_profile LIMIT 1;");
    if (!rows || !rows.length) {
      Log.e("[ChatManager] open_profile 조회 실패");
      return false;
    }
    var myid = rows[0][0];
    for (var i = 1; i <= 31; i++) _myIdCache[String(i)] = _deriveKey(myid, i);

    var friendCandidates = [
      { table: "open_chat_member", idCol: "user_id", nameCol: "nickname" },
      { table: "friends_v2",       idCol: "id",      nameCol: "name"     },
      { table: "friends",          idCol: "id",      nameCol: "name"     }
    ];
    for (var fi = 0; fi < friendCandidates.length; fi++) {
      var c = friendCandidates[fi];
      var p = _sql(KT_DB2_PATH, "SELECT COUNT(*) FROM " + c.table + " LIMIT 1;", true);
      if (p && p.length) {
        KT_FRIENDS_TABLE = c.table;
        KT_FRIENDS_ID_COL = c.idCol;
        KT_FRIENDS_NAME_COL = c.nameCol;
        break;
      }
    }

    var maxRows = _sql(KT_DB1_PATH, "SELECT IFNULL(MAX(_id), 0) FROM chat_logs;");
    _lastProcessedId = (maxRows && maxRows.length) ? parseInt(maxRows[0][0], 10) || 0 : 0;
    _lastDecomposeId = _lastProcessedId;

    KT_OK = true;
    return true;
  } catch(e) {
    Log.e("[ChatManager] init 실패: " + (e && e.message ? e.message : e));
    return false;
  }
}

// ── 사용자 이름 조회 (캐시) ──────────────────────────────────────
function getUserName(user_id) {
  // 캐시 적중: 실제 이름은 5분, 실패 placeholder 는 15초 TTL. 만료 시 재조회 → 닉변/일시실패 회복.
  var cached = _userNameCache[user_id];
  if (cached) {
    var ttl = cached.miss ? USER_NAME_MISS_TTL_MS : USER_NAME_TTL_MS;
    if ((Date.now() - cached.ts) < ttl) return cached.name;
  }

  if (!KT_FRIENDS_TABLE) {
    var fallback = "user_" + user_id;
    _userNameCache[user_id] = { name: fallback, ts: Date.now(), miss: true };
    return fallback;
  }
  try {
    var sql = "SELECT " + KT_FRIENDS_NAME_COL + ", enc FROM " + KT_FRIENDS_TABLE +
              " WHERE " + KT_FRIENDS_ID_COL + " = " + user_id + " LIMIT 1;";
    var rows = _sql(KT_DB2_PATH, sql, true);
    if (rows && rows.length) {
      var encName = rows[0][0];
      var enc = rows[0][1];
      var key = _myIdCache[enc];
      if (key) {
        var name = _decrypt(key, encName);
        if (name && name !== encName) {
          _userNameCache[user_id] = { name: name, ts: Date.now() };
          return name;
        }
      }
    }
  } catch(_) {}
  var anon = "user_" + user_id;
  _userNameCache[user_id] = { name: anon, ts: Date.now(), miss: true };
  return anon;
}

// ── 구독자 레지스트리 ──────────────────────────────────────────────
// System Properties 는 JVM 전역이라 모든 봇 컨텍스트가 같은 Map 을 본다.
var REG_KEY = "__CHATMANAGER_REGISTRY__";
var _registry = (function() {
  var sysProps = java.lang.System.getProperties();
  var r = sysProps.get(REG_KEY);
  if (r == null) {
    r = new java.util.concurrent.ConcurrentHashMap();
    sysProps.put(REG_KEY, r);
  }
  return r;
})();

// 구독봇 큐별 연속 offer 실패 횟수 (소비자 정지 감지용)
var _deadQueueFails = {};
var DEAD_QUEUE_DROP_AT = 3;   // 이만큼 연속 실패하면 레지스트리에서 제거(재구독 시 자동 재등록)

function broadcast(name, hash, channelId, room, text) {
  var base = new java.util.HashMap();
  base.put("name", String(name));
  base.put("hash", String(hash));
  base.put("channelId", String(channelId));
  base.put("room", String(room));
  base.put("text", String(text));
  base.put("ts", java.lang.Long.valueOf(Date.now()));
  // 한 번만 만들어 모든 구독자 큐가 공유(읽기 전용 계약). unmodifiableMap 으로 감싸면
  // 구독자들의 `task instanceof java.util.HashMap` 가드를 통과 못해 전 메시지가 버려지므로
  // 반드시 평범한 HashMap 그대로 공유한다.
  var m = base;
  var it = _registry.entrySet().iterator();
  while (it.hasNext()) {
    var e = it.next();
    var q = e.getValue();
    if (!q) continue;
    try {
      // put() 대신 offer(): 죽은 구독봇의 유계 큐가 가득 차면 블로킹/무한증가 대신 드롭.
      // 살아있는 소비자는 큐를 즉시 비우므로 정상 상황에선 항상 성공한다.
      // (레거시 무계 큐가 아직 등록돼 있어도 offer 는 항상 성공 → 안전)
      if (q.offer(m) === false) {
        // 큐가 가득 = 소비자 정지 추정. 누적 실패 시 레지스트리에서 제거해 메모리 회수.
        var fails = (_deadQueueFails[e.getKey()] || 0) + 1;
        _deadQueueFails[e.getKey()] = fails;
        if (fails >= DEAD_QUEUE_DROP_AT) { it.remove(); delete _deadQueueFails[e.getKey()]; }
      } else {
        if (_deadQueueFails[e.getKey()]) delete _deadQueueFails[e.getKey()];
      }
    } catch(_) {}
  }
}

// ── channelId ↔ room 매핑 영속화 ──────────────────────────────────
function _loadChannelRooms() {
  try {
    var f = new java.io.File(CHANNEL_MAP_PATH);
    if (!f.exists()) return;
    var br = new java.io.BufferedReader(new java.io.InputStreamReader(new java.io.FileInputStream(f), "UTF-8"));
    var sb = new java.lang.StringBuilder(), line;
    while ((line = br.readLine()) !== null) sb.append(line);
    br.close();
    var obj = JSON.parse(String(sb.toString()) || "{}");
    if (obj && typeof obj === "object") _channelRooms = obj;
  } catch(_) {}
}
function _persistChannelRooms() {
  try {
    var w = new java.io.FileWriter(CHANNEL_MAP_PATH, false);
    w.write(JSON.stringify(_channelRooms));
    w.close();
  } catch(_) {}
}
// channelId 에 room 매핑(변경 시에만 영속화). 새로 매핑되면 보관분(_pendingByChannel) flush.
function _mapChannel(channelId, room) {
  if (channelId == null || !room) return;
  var key = String(channelId);
  if (_channelRooms[key] !== room) {
    _channelRooms[key] = room;
    _persistChannelRooms();
  }
  var buf = _pendingByChannel[key];
  if (buf && buf.length) {
    for (var i = 0; i < buf.length; i++) broadcast(buf[i].name, buf[i].userId, key, room, buf[i].text);
    delete _pendingByChannel[key];
  }
}
_loadChannelRooms();

// ── DB 폴링: 새 메시지 → 복호화 → broadcast ──────────────────────
// 반환: 이번 폴링에서 가져온 chat_logs 행 수 (0 = 새 메시지 없음). 폴러가 적응형 간격 산정에 사용.
function pollKakaoDB() {
  if (!KT_OK) return 0;
  try {
    var sql = "SELECT _id, chat_id, user_id, message, v FROM chat_logs " +
              "WHERE _id > " + _lastProcessedId + " " +
              "ORDER BY _id ASC LIMIT 50;";
    var rows = _sql(KT_DB1_PATH, sql);
    if (!rows || !rows.length) return 0;

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var rid = parseInt(r[0], 10);
      try {
        _processRow(r);
      } catch(rowErr) {
        // 이 행 처리 실패(복호화/broadcast 등): _lastProcessedId 를 전진시키지 않고 중단.
        // 다음 폴링에서 rid 부터 재시도 → 나머지 배치 메시지가 유실되지 않는다.
        // (예전엔 _id 를 루프 선두에서 커밋해, 한 행 예외 시 그 뒤 배치가 영구 유실됐다.)
        Log.e("[ChatManager] row " + rid + " 처리 실패, 다음 폴링 재시도: " +
              (rowErr && rowErr.message ? rowErr.message : rowErr));
        return i;   // 여기까지(성공한 i개)만 처리됨
      }
      _lastProcessedId = rid;   // 정상 처리(broadcast 또는 정상 skip) 후에만 전진
    }
    return rows.length;
  } catch(_) { return 0; }
}

// 한 chat_logs 행 처리: skip 이면 조용히 return, 처리 대상이면 복호화 후 broadcast.
// 예외는 던져서 pollKakaoDB 가 _lastProcessedId 전진을 막고 재시도하도록 한다.
function _processRow(r) {
  if (r.length < 5) return;   // 형식 미달 행은 스킵(정상 처리로 간주 → 전진)
  var chat_id = r[1];
  var user_id = r[2];
  var encMsg = r[3];
  var vStr = r[4] || "{}";

  var v = null;
  try { v = JSON.parse(vStr); } catch(_) { v = {}; }
  if (v.isMine === true || v.origin === "WRITE") return;
  if (v.enc == null) return;

  var cacheKey = user_id + "_" + v.enc;
  var key = _keyCache[cacheKey];
  if (!key) { key = _deriveKey(user_id, v.enc); _keyCache[cacheKey] = key; }
  var text = String(_decrypt(key, encMsg) || "").trim();
  if (!text) return;

  var name = getUserName(user_id);

  var roomName = _channelRooms[String(chat_id)];
  if (!roomName) {
    // 아직 channelId↔room 미매핑(브랜드뉴 채널): 보관 후 onMessage 매핑 시 flush
    var buf = _pendingByChannel[String(chat_id)];
    if (!buf) { buf = []; _pendingByChannel[String(chat_id)] = buf; }
    buf.push({ name: name, userId: user_id, text: text });
    while (buf.length > PENDING_MAX) buf.shift();
    return;
  }

  broadcast(name, user_id, chat_id, roomName, text);
}

// ── 폴링 스레드 ──────────────────────────────────────────────────
var POLLER_NAME = "CHATMANAGER_POLLER";

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
      if (String(t.getName() || "") === POLLER_NAME) {
        try { t.interrupt(); } catch(_) {}
      }
    }
  } catch(_) {}
})();

// 적응형 폴링 간격: 대화가 오가는 동안엔 빠르게(POLL_MIN_MS), 유휴 상태가 이어지면
// 점진적으로 느리게(POLL_MAX_MS) 폴링한다. 저사양 기기에서 아무도 채팅하지 않는 시간대에
// 매 0.15초마다 sqlite3 프로세스를 띄우는 낭비(배터리/CPU)를 크게 줄인다.
// 새 메시지가 잡히는 즉시 POLL_MIN_MS 로 복귀하므로 활성 대화 반응 속도는 그대로 유지된다.
var POLL_MIN_MS  = 150;    // 활성 시 폴링 간격
var POLL_MAX_MS  = 500;   // 유휴 시 최대 폴링 간격 (유휴 후 첫 메시지 최대 지연)
var POLL_BACKOFF = 2;    // 빈 폴링마다 간격 ×2 (MAX 까지 단계적 증가)

// 폴러는 무조건 기동한다. initKakaoDB() 가 (부팅 직후 su 미준비 등으로) 실패해도 죽지 않고
// 루프 안에서 주기적으로 재시도 → root/DB 가 준비되면 자동 복구(수동 재컴파일 불필요).
// 단일 초기화 실패가 영구 장애(전 구독봇 무응답)가 되던 단일점을 제거한다.
var _poller = new java.lang.Thread(function() {
  var interval = POLL_MIN_MS, initWait = 2000, INIT_MAX = 30000;
  while (!java.lang.Thread.currentThread().isInterrupted()) {
    // 봇 전원 감시. KakaoDB 초기화와 무관하게 돌아야 하므로 KT_OK 검사보다 앞에 둔다.
    // 자체 스로틀(WATCH_TICK_MS)이 있어 폴링 간격이 짧아도 30초에 한 번만 실제로 돈다.
    try { _watchTick(); } catch(_) {}
    if (!KT_OK) {                                                          // 아직 초기화 전 → 재시도
      var ok = false;
      try { ok = initKakaoDB(); } catch(_) { ok = false; }
      if (!ok) {
        try { java.lang.Thread.sleep(initWait); } catch(_) { return; }
        initWait = Math.min(INIT_MAX, initWait * 2);                       // 실패 → 백오프(최대 30s)
        continue;
      }
      initWait = 2000;                                                     // 성공 → 백오프 리셋
      try { Log.i("[ChatManager] KakaoDB 초기화 성공 — 폴러 가동"); } catch(_) {}
    }
    var got = 0;
    try { got = pollKakaoDB(); } catch(_) {}
    if (got > 0) interval = POLL_MIN_MS;                                   // 활동 감지 → 즉시 빠르게
    else interval = Math.min(POLL_MAX_MS, Math.floor(interval * POLL_BACKOFF)); // 유휴 → 점진 백오프
    try { java.lang.Thread.sleep(interval); } catch(_) { return; }
  }
}, POLLER_NAME);
_poller.start();
// 레지스트리 등록은 이 환경서 비신뢰(스캔으로 대체)지만, 혹시 복구될 경우 대비해 best-effort 로 남겨둠.
try { _treg.registerThread(POLLER_NAME, "ChatManager", _poller); } catch(_) {}

// ── 봇 제어 명령 (!onoff / !compile / !상태) ────────────────
// 다른 모든 봇의 on/off·컴파일을 ChatManager 에서 대화형으로 수행한다.
//   !onoff   → 봇 목록 제시 → 번호 입력 → 해당 봇 전원 토글
//   !compile → 봇 목록 제시 → 번호 입력 → 해당 봇 컴파일
//   !상태    → 모든 봇의 전원/컴파일 상태 즉시 출력
//   !취소    → 대기 중인 번호 선택 취소
var _botCtlPending = {};            // key(room|author) -> { action, names, ts }
var BOT_CTL_TTL_MS = 60 * 1000;     // 번호 선택 대기 만료 (1분)

// ChatManager 자신을 제외한 다른 봇 이름 목록.
// Bots/ 폴더를 직접 열거한다 — BotManager.getBotNames()/getBotList() 는 "로드된 봇 인스턴스"만
// 반환해서 OFF(언로드)된 봇이 빠지기 때문(그러면 끈 봇을 다시 켤 수가 없음). 폴더가 곧 봇 목록.
function _otherBotNames() {
  var out = [];
  var self = String(bot.getName());
  try {
    var botsDir = new java.io.File(bot.getRootPath()).getParentFile();   // /sdcard/msgbot/Bots
    var entries = botsDir.listFiles();
    if (entries) {
      for (var i = 0; i < entries.length; i++) {
        var f = entries[i];
        if (!f.isDirectory()) continue;
        var nm = String(f.getName());
        if (nm === self) continue;                                       // 매니저 자신 제외
        if (!(new java.io.File(f, "bot.json")).exists()) continue;       // 봇 아닌 폴더 제외
        out.push(nm);
      }
      out.sort();
    }
  } catch(_) {}
  // 폴더 열거 실패 시 폴백: getBotNames (로드된 봇만)
  if (!out.length) {
    try {
      var names = BotManager.getBotNames();
      for (var j = 0; j < names.length; j++) {
        if (names[j] == null) continue;
        var n2 = String(names[j]);
        if (!n2 || n2 === "null" || n2 === self) continue;
        out.push(n2);
      }
    } catch(_) {}
  }
  return out;
}

// 목록에 현재 상태를 함께 보여준다 — 토글은 "지금 어느 쪽인지"를 모르면 고를 수 없다.
// 카톡은 폰트가 가변폭이라 공백으로 열을 맞춰도 어긋난다. 구분자(—)로 붙인다.
function _botStateLabel(name, action) {
  if (action === "onoff") {
    var power = null;
    try { power = BotManager.getPower(name); } catch(_) {}
    var s = power ? "🟢 ON" : "🔴 OFF";
    // 꺼져 있는데 감시자가 안 되살리는 이유가 있으면 같이 알려준다.
    if (!power) {
      if (!_watchWantOf(name)) s += " (감시 제외)";
      else { var st = _watchState[name]; if (st && st.gaveUp) s += " (⛔ 복구 포기)"; }
    }
    return s;
  }
  var comp = null;
  try { comp = BotManager.isCompiled(name); } catch(_) {}
  return comp ? "컴파일됨" : "미컴파일";
}

function _botListText(action) {
  var names = _otherBotNames();
  var label = (action === "onoff") ? "on/off 토글" : "컴파일";
  var lines = ["[" + label + "] 어떤 봇에 적용할까요?"];
  for (var i = 0; i < names.length; i++) {
    lines.push((i + 1) + ". " + names[i] + " — " + _botStateLabel(names[i], action));
  }
  lines.push("");
  lines.push("번호를 입력하세요. 여러 개는 공백/쉼표로 구분 (예: 1 3 5), 전체는 '전체'. (취소: !취소)");
  return { text: lines.join("\n"), names: names };
}

function _applyOnOff(name) {
  try {
    var next = !BotManager.getPower(name);
    // 켤 때: OFF(언로드)였던 봇은 미컴파일일 수 있으므로 먼저 prepare (이미 컴파일됐으면 무동작)
    if (next) { try { BotManager.prepare(name, false); } catch(_) {} }
    BotManager.setPower(name, next);
    // 감시자가 사용자 의도와 싸우지 않도록 희망 상태를 남긴다. 수동으로 켜면
    // 크래시 루프 판정(백오프·포기)도 함께 초기화된다.
    _setWatchWant(name, next);
    return name + " : " + (next ? "🟢 ON" : "🔴 OFF");
  } catch(e) {
    return name + " : ⚠️ 전원 변경 실패 (" + (e && e.message ? e.message : e) + ")";
  }
}

function _applyCompile(name) {
  try {
    var ok = BotManager.compile(name, false);
    return name + " : " + (ok ? "✅ 컴파일 성공" : "❌ 컴파일 실패");
  } catch(e) {
    return name + " : ❌ 컴파일 오류 (" + (e && e.message ? e.message : e) + ")";
  }
}

function _statusText() {
  var names = _otherBotNames();
  if (!names.length) return "[봇 상태]\n등록된 봇이 없습니다.";
  var lines = ["[봇 상태]"];
  for (var i = 0; i < names.length; i++) {
    var nm = names[i];
    var power = null, comp = null;
    try { power = BotManager.getPower(nm); } catch(_) {}
    try { comp = BotManager.isCompiled(nm); } catch(_) {}
    var note = "";
    if (!_watchWantOf(nm)) note = " / 감시 제외";
    else {
      var st = _watchState[nm];
      if (st && st.gaveUp) note = " / ⛔ 복구 포기";
      else if (st && st.tries > 0) note = " / 복구 " + st.tries + "회";
    }
    lines.push("• " + nm + " : " +
      (power ? "🟢 ON" : "🔴 OFF") + " / " +
      (comp ? "컴파일됨" : "미컴파일") + note);
  }
  return lines.join("\n");
}

// ── 봇 자동 복구 감시자 ──────────────────────────────────────────────
// 봇이 원인 불명으로 하나씩 꺼지는 일이 있어, 주기적으로 확인해 되살린다.
//
//  · "켜져 있어야 할 봇" 은 botwatch.json 에 남긴다. !onoff 로 끈 봇은 want=false 가
//    되어 감시에서 빠진다 — 감시자가 사용자 의도와 싸우면 안 되기 때문.
//  · 파일에 없는 봇은 want=true 로 본다. 새로 만든 봇도 자동으로 지켜진다.
//  · 죽어서 꺼진 봇을 무한정 되살리면 크래시 루프가 되어 지금보다 나빠진다.
//    1분 → 5분 → 30분으로 물러서고, 그래도 안 되면 포기하고 알린다.
//    켠 뒤 STABLE_MS 를 버티면 정상으로 보고 재시도 횟수를 리셋한다.
//  · 꺼지는 원인이 아직 불명이므로 복구 기록을 파일로 남긴다(언제·어느 봇·결과).
//    며칠 쌓이면 특정 봇/시간대/직전 동작에 몰리는지가 드러난다.
//  · ChatManager 자신은 못 지킨다(꺼지면 감시자도 같이 죽음). 백업봇이 역으로 지킨다.
var WATCH_PATH = Packages.android.os.Environment.getExternalStorageDirectory()
    .getAbsolutePath() + "/msgbot/botwatch.json";
var WATCH_LOG_PATH = Packages.android.os.Environment.getExternalStorageDirectory()
    .getAbsolutePath() + "/msgbot/botwatch.log";
var WATCH_TICK_MS   = 30 * 1000;        // 확인 주기 (폴러 안에서 스로틀)
var WATCH_STABLE_MS = 10 * 60 * 1000;   // 이만큼 켜져 있으면 "안정" → 백오프 리셋
var WATCH_BACKOFF_MS = [60000, 300000, 1800000];   // 1분 → 5분 → 30분, 그 다음은 포기
var WATCH_NOTIFY_ROOM = "신쫑";         // lib/admin.js 의 ADMIN_ROOMS 와 같은 방
var WATCH_LOG_MAX = 200 * 1024;         // 로그가 무한정 커지지 않게 (넘으면 새로 시작)

var _watchWant = null;    // { name: { want, at } } — 파일 내용. null 이면 아직 안 읽음
var _watchState = {};     // name -> { tries, nextAt, okSince, gaveUp } (메모리, 재컴파일 시 초기화)
var _watchLastTick = 0;

function _watchStamp() {
  try {
    var f = new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss");
    f.setTimeZone(java.util.TimeZone.getTimeZone("Asia/Seoul"));
    return String(f.format(new java.util.Date()));
  } catch(_) { return ""; }
}

function _loadWatchWant() {
  try {
    var f = new java.io.File(WATCH_PATH);
    if (!f.exists()) return {};
    var br = new java.io.BufferedReader(new java.io.InputStreamReader(new java.io.FileInputStream(f), "UTF-8"));
    var sb = new java.lang.StringBuilder(), line;
    while ((line = br.readLine()) !== null) sb.append(line);
    br.close();
    var obj = JSON.parse(String(sb.toString()) || "{}");
    return (obj && typeof obj === "object") ? obj : {};
  } catch(_) { return {}; }
}

function _saveWatchWant() {
  try {
    var w = new java.io.FileWriter(WATCH_PATH, false);
    w.write(JSON.stringify(_watchWant));
    w.close();
  } catch(_) {}
}

// 파일에 없거나 want 가 false 가 아니면 "켜져 있어야 하는" 봇으로 본다.
function _watchWantOf(name) {
  if (_watchWant === null) _watchWant = _loadWatchWant();
  var v = _watchWant[String(name)];
  return !(v && v.want === false);
}

function _setWatchWant(name, want) {
  var nm = String(name);
  try {
    if (_watchWant === null) _watchWant = _loadWatchWant();
    _watchWant[nm] = { want: !!want, at: _watchStamp() };
    _saveWatchWant();
  } catch(_) {}
  _watchState[nm] = { tries: 0, nextAt: 0, okSince: 0, gaveUp: false };
}

function _watchLog(line) {
  try {
    var f = new java.io.File(WATCH_LOG_PATH);
    var append = true;
    try { if (f.exists() && f.length() > WATCH_LOG_MAX) append = false; } catch(_) {}
    var w = new java.io.FileWriter(WATCH_LOG_PATH, append);
    w.write(_watchStamp() + "  " + line + "\n");
    w.close();
  } catch(_) {}
}

// 알림은 "받은 방에 답장" 이 아니라 능동 전송이라, 그 방의 알림 세션이 살아 있어야
// 나간다(재부팅 후 해당 방에 아직 메시지가 없으면 실패). 실패하면 버리지 않고 쌓아
// 두었다가 다음 tick 에 다시 시도한다. 확실한 기록은 어차피 botwatch.log 쪽이다.
var _watchPending = [];
var WATCH_PENDING_MAX = 20;

function _watchFlushNotices() {
  while (_watchPending.length) {
    var ok = false;
    try { ok = (bot.send(WATCH_NOTIFY_ROOM, _watchPending[0]) !== false); } catch(_) { ok = false; }
    if (!ok) return;                     // 아직 못 보냄 — 순서 유지한 채 다음 기회에
    _watchPending.shift();
  }
}

function _watchNotify(text) {
  _watchPending.push(String(text));
  while (_watchPending.length > WATCH_PENDING_MAX) _watchPending.shift();
  _watchFlushNotices();
}

// 꺼진 봇 하나를 되살린다. 성공 여부를 실제 전원 상태로 확인한다.
function _watchRecover(name) {
  try {
    try { BotManager.prepare(name, false); } catch(_) {}
    BotManager.setPower(name, true);
    var on = false;
    try { on = !!BotManager.getPower(name); } catch(_) { on = false; }
    return { ok: on, err: on ? "" : "setPower 후에도 OFF" };
  } catch(e) {
    return { ok: false, err: (e && e.message) ? e.message : String(e) };
  }
}

function _watchTick() {
  // 폴러 스레드는 이 블록의 var 초기화보다 먼저 돌 수 있다(선언은 호이스팅되지만
  // 대입은 아래에서 일어남). 준비 전에는 조용히 넘어간다.
  if (!WATCH_BACKOFF_MS) return;
  var now = java.lang.System.currentTimeMillis();
  if (now - _watchLastTick < WATCH_TICK_MS) return;
  _watchLastTick = now;

  _watchFlushNotices();                 // 지난번에 못 보낸 알림 재시도
  var names = _otherBotNames();
  for (var i = 0; i < names.length; i++) {
    var nm = names[i];
    if (!_watchWantOf(nm)) continue;                    // 일부러 꺼둔 봇
    if (!_watchState[nm]) _watchState[nm] = { tries: 0, nextAt: 0, okSince: 0, gaveUp: false };
    var st = _watchState[nm];

    var on = null;
    try { on = BotManager.getPower(nm); } catch(_) { continue; }   // 조회 실패는 판단 보류

    if (on) {
      // 켜져 있음. 복구 이력이 있으면 충분히 버텼는지 보고 백오프를 푼다.
      if (st.tries > 0) {
        if (!st.okSince) st.okSince = now;
        else if (now - st.okSince >= WATCH_STABLE_MS) {
          _watchLog(nm + " 안정 — 복구 카운터 리셋 (" + st.tries + "회 후)");
          _watchState[nm] = { tries: 0, nextAt: 0, okSince: 0, gaveUp: false };
        }
      }
      continue;
    }

    st.okSince = 0;
    if (st.gaveUp) continue;              // 포기한 봇은 수동 개입(!onoff) 전까지 그대로 둔다
    if (now < st.nextAt) continue;        // 백오프 대기 중

    // 판정은 "시도하기 전"에 한다. 시도한 뒤에 포기를 정하면, 마지막 시도가 성공했는데도
    // "복구를 멈춥니다" 를 보내게 된다.
    if (st.tries >= WATCH_BACKOFF_MS.length) {
      // 정해진 횟수를 다 쓰고 마지막 백오프까지 기다렸는데 여전히 꺼져 있다.
      // 켜는 것 자체가 답이 아니라는 뜻 — 사람을 부른다.
      st.gaveUp = true;
      _watchLog(nm + " 복구 포기 — 수동 확인 필요");
      _watchNotify("⛔ " + nm + " 이 계속 꺼집니다. " + st.tries + "회 되살렸지만 유지되지 않아 자동 복구를 멈춥니다.\n" +
                   "로그: " + WATCH_LOG_PATH + "\n확인 후 !onoff 로 켜면 감시가 다시 시작됩니다.");
      continue;
    }

    var r = _watchRecover(nm);
    st.tries++;
    st.nextAt = now + WATCH_BACKOFF_MS[st.tries - 1];

    if (r.ok) {
      st.okSince = now;
      _watchLog(nm + " OFF 감지 → 복구 성공 (" + st.tries + "회차)");
      _watchNotify("🔄 " + nm + " 이 꺼져 있어 다시 켰습니다. (" + st.tries + "회차)");
    } else {
      _watchLog(nm + " OFF 감지 → 복구 실패 (" + st.tries + "회차): " + r.err);
      _watchNotify("⚠️ " + nm + " 이 꺼져 있어 켜려 했지만 실패했습니다. (" + st.tries + "회차)\n사유: " + r.err);
    }
  }
}

// 선택 입력 파싱: "전체"/"all"/"모두" → 전체, "1 3 5" 또는 "1,3,5" → 0-기반 인덱스 목록(중복 제거).
// 선택 형태가 아니면 null 반환(→ 일반 메시지로 흘려보냄). { indices, invalid } 반환.
function _parseSelection(text, count) {
  var t = String(text).trim();
  if (/^(전체|all|모두)$/i.test(t)) {
    var allIdx = [];
    for (var a = 0; a < count; a++) allIdx.push(a);
    return { indices: allIdx, invalid: [] };
  }
  if (!/^\d+([\s,]+\d+)*$/.test(t)) return null;   // 숫자(공백/쉼표 구분) 형태가 아님
  var toks = t.split(/[\s,]+/);
  var seen = {}, indices = [], invalid = [];
  for (var i = 0; i < toks.length; i++) {
    if (toks[i] === "") continue;
    var num = parseInt(toks[i], 10);
    if (isNaN(num) || num < 1 || num > count) { invalid.push(toks[i]); continue; }
    var idx = num - 1;
    if (!seen[idx]) { seen[idx] = true; indices.push(idx); }
  }
  return { indices: indices, invalid: invalid };
}

// ── 스레드/프로세스 관리 (thread-registry) ──────────────────────────
function _fmtAge(ms) {
  var s = Math.floor((ms || 0) / 1000);
  if (s < 60) return s + "s";
  var m = Math.floor(s / 60); if (m < 60) return m + "m";
  var h = Math.floor(m / 60); if (h < 24) return h + "h";
  return Math.floor(h / 24) + "d";
}
// 스레드 표시는 JVM 직접 스캔이 진실원(레지스트리 등록은 이 환경서 비신뢰 → 항상 0).
// 워커/폴러를 이름별로 집계해 생사 + 중복(=재컴파일 누수) 경고를 보여준다.
var _WORKER_RE = /WORKER|POLLER|maple-poll|QUIZ_REVEAL/;
function _threadListText() {
  var lines = ["[스레드/프로세스] (스캔)"];
  try {
    var en = _treg.enumerateThreads();
    var byName = {}, order = [];
    for (var j = 0; j < en.length; j++) {
      var nm = en[j].name;
      if (!_WORKER_RE.test(nm)) continue;
      if (!byName[nm]) { byName[nm] = { n: 0, alive: 0 }; order.push(nm); }
      byName[nm].n++; if (en[j].alive) byName[nm].alive++;
    }
    order.sort();
    if (!order.length) lines.push("워커/폴러: 없음 ⚠️");
    else for (var k = 0; k < order.length; k++) {
      var c = byName[order[k]];
      lines.push("• " + order[k] + " " + (c.alive ? "🟢" : "🔴") + (c.n > 1 ? (" ⚠️누수 ×" + c.n) : ""));
    }
    lines.push("— JVM 스레드 " + en.length + "개");
  } catch(e) { lines.push("스캔 오류: " + e); }
  lines.push("정리(누수): !스레드정리 · 종료: !스레드킬 <이름>");
  return lines.join("\n");
}
function _threadKill(arg) {
  if (!arg) return "사용법: !스레드킬 <#번호 또는 이름>";
  var id = String(arg).replace(/^#/, "");
  if (/^\d+$/.test(id)) {
    var r = _treg.kill(id);
    if (!r.ok && r.error) return "#" + id + " : 없음";
    return "#" + id + " " + r.name + " [" + r.kind + "] → " +
           (r.ok ? ((r.kind === "process" ? "destroy" : "interrupt") + " ✅") : "실패");
  }
  var killed = _treg.killByName(arg);
  if (killed.length) return "'" + arg + "' " + killed.length + "개 종료 ✅ (등록)";
  // 등록 맵에 없으면(미등록 스레드) JVM 스캔으로 이름 일치 스레드를 직접 interrupt 한다.
  var n = 0; try { n = _treg.killByNameScan(arg); } catch(_) {}
  return n ? ("'" + arg + "' " + n + "개 interrupt ✅ (미등록/스캔)") : ("'" + arg + "' 일치 없음");
}

// 명령을 처리했으면 true 반환 (이후 룸 학습 로직 건너뜀)
function handleBotControlCommand(rawMsg) {
  var text, room, key;
  try {
    text = String(rawMsg.content || "").trim();
    if (!text) return false;
    room = String(rawMsg.room || "");
    var who = "";
    try { who = String((rawMsg.author && (rawMsg.author.hash || rawMsg.author.name)) || ""); } catch(_) {}
    key = room + "|" + who;
  } catch(_) { return false; }

  // 상태 조회
  if (text === "!상태") {
    try { rawMsg.reply(_statusText()); } catch(_) {}
    return true;
  }

  // 스레드/프로세스 관리
  if (text === "!스레드" || text === "!스레드목록") {
    try { rawMsg.reply(_threadListText()); } catch(_) {}
    return true;
  }
  if (text.indexOf("!스레드킬 ") === 0) {
    var _tkArg = text.substring(text.indexOf(" ") + 1).trim();
    try { rawMsg.reply(_threadKill(_tkArg)); } catch(_) {}
    return true;
  }
  if (text === "!스레드정리") {
    try {
      var _rep = _treg.dedupeWorkers(_WORKER_RE);
      rawMsg.reply(_rep.length ? ("누수 정리 (최신만 유지):\n" + _rep.join("\n")) : "누수 워커 없음 ✅");
    } catch(e) { try { rawMsg.reply("정리 오류: " + e); } catch(_) {} }
    return true;
  }

  // 대기 취소
  if (text === "!취소") {
    if (_botCtlPending[key]) {
      delete _botCtlPending[key];
      try { rawMsg.reply("취소되었습니다."); } catch(_) {}
      return true;
    }
    return false;
  }

  // 명령 시작 / 인라인 선택: !onoff [선택] / !compile [선택]
  //   인자 없으면 → 봇 목록 제시(2단계). 인자 있으면(예: "전체" 또는 "1 3 5") → 즉시 적용.
  var startAction = null;
  if (text === "!onoff" || text.indexOf("!onoff ") === 0) startAction = "onoff";
  else if (text === "!compile" || text === "!complile" || text === "!컴파일" ||
           text.indexOf("!compile ") === 0 || text.indexOf("!complile ") === 0 || text.indexOf("!컴파일 ") === 0) startAction = "compile";
  if (startAction) {
    var rL = _botListText(startAction);
    if (!rL.names.length) { try { rawMsg.reply("제어할 봇이 없습니다."); } catch(_) {} return true; }
    var spc = text.indexOf(" ");
    var inlineArg = (spc !== -1) ? text.substring(spc + 1).trim() : "";
    if (inlineArg) {
      var selI = _parseSelection(inlineArg, rL.names.length);
      if (selI && selI.invalid.length) {
        try { rawMsg.reply("잘못된 번호: " + selI.invalid.join(", ") + " (1 ~ " + rL.names.length + ")"); } catch(_) {}
        return true;
      }
      if (selI && selI.indices.length) {
        var linesI = [];
        for (var si = 0; si < selI.indices.length; si++) {
          var tgtI = rL.names[selI.indices[si]];
          linesI.push((startAction === "onoff") ? _applyOnOff(tgtI) : _applyCompile(tgtI));
        }
        try { rawMsg.reply(linesI.join("\n")); } catch(_) {}
        return true;
      }
      // 인자가 선택 형태가 아니면 아래로 떨어져 목록 제시(2단계)로 폴백
    }
    _botCtlPending[key] = { action: startAction, names: rL.names, ts: Date.now() };
    try { rawMsg.reply(rL.text); } catch(_) {}
    return true;
  }

  // 선택 응답(번호/전체): 대기 중인 선택이 있을 때만 가로챔 (없으면 일반 메시지로 흘려보냄)
  var pend = _botCtlPending[key];
  if (pend) {
    var sel = _parseSelection(text, pend.names.length);
    if (sel === null) return false;   // 선택 형태가 아님 → 일반 메시지로 흘려보냄
    if (Date.now() - pend.ts > BOT_CTL_TTL_MS) {
      delete _botCtlPending[key];
      try { rawMsg.reply("선택 시간이 만료되었습니다. 명령을 다시 입력해주세요."); } catch(_) {}
      return true;
    }
    if (sel.invalid.length) {
      try { rawMsg.reply("잘못된 번호: " + sel.invalid.join(", ") + " (1 ~ " + pend.names.length + "). 다시 입력해주세요."); } catch(_) {}
      return true;   // 대기 유지 → 재입력 가능
    }
    if (!sel.indices.length) {
      try { rawMsg.reply("선택된 봇이 없습니다. 번호를 입력해주세요."); } catch(_) {}
      return true;
    }
    delete _botCtlPending[key];
    var resultLines = [];
    for (var s = 0; s < sel.indices.length; s++) {
      var target = pend.names[sel.indices[s]];
      resultLines.push((pend.action === "onoff") ? _applyOnOff(target) : _applyCompile(target));
    }
    try { rawMsg.reply(resultLines.join("\n")); } catch(_) {}
    return true;
  }

  return false;
}

// ── !해체: chat_logs 단일 행 복호화 출력 ───────────────────────────
// 사용법 두 가지:
//   ① !해체 <_id>                       — chat_logs._id 를 직접 지정
//   ② 분석할 메시지에 "답장"으로 !해체 전송  — _id 를 몰라도 답장만으로 원본 분석
//        답장 메시지(type=26)의 attachment.src_logId = 인용된 원본 메시지의 id 이므로,
//        그 id 로 원본 행을 역추적해 분석한다.
// message / attachment / supplement 컬럼은 _deriveKey(user_id, v.enc) 키로 AES 복호화.
// attachment / supplement 는 보통 JSON 이라 들여쓰기로 출력한다.

// whereCol(_id|id) = whereVal 인 단일 행을 조회해 복호화 덤프를 reply 한다.
function _decomposeAndReply(rawMsg, whereCol, whereVal) {
  try {
    var rows = _sqlObj(KT_DB1_PATH,
      "SELECT * FROM chat_logs WHERE " + whereCol + " = " + whereVal + " LIMIT 1;");
    if (rows == null) {
      try { rawMsg.reply("[해체] 쿼리 실패 (sqlite3 오류)"); } catch(_) {}
      return;
    }
    if (!rows.length) {
      try { rawMsg.reply("[해체] 해당 메시지를 찾을 수 없습니다 (" + whereCol + "=" + whereVal + ")"); } catch(_) {}
      return;
    }
    var row = rows[0];
    var headerId = (row._id != null && row._id !== "") ? row._id : whereVal;

    // v 에서 enc(암호화 타입) 추출 → message/attachment/supplement 복호화 키 유도
    var enc = null;
    try { enc = (JSON.parse(row.v || "{}")).enc; } catch(_) {}
    var uid = row.user_id;
    var key = (enc != null && uid != null && uid !== "") ? _deriveKey(uid, enc) : null;

    var decMsg = (key && row.message)    ? _decrypt(key, row.message)    : (row.message || "");
    var decAtt = (key && row.attachment) ? _decrypt(key, row.attachment) : (row.attachment || "");
    var decSup = (key && row.supplement) ? _decrypt(key, row.supplement) : (row.supplement || "");

    var name = (uid != null && uid !== "") ? getUserName(uid) : "?";

    var out = [];
    out.push("[해체 #" + headerId + "]");
    // message / attachment / supplement 를 제외한 원본 컬럼을 그대로 나열 (스키마 조사용)
    var cols = Object.keys(row);
    for (var i = 0; i < cols.length; i++) {
      var c = cols[i];
      if (c === "message" || c === "attachment" || c === "supplement") continue;
      var cv = row[c];
      if (cv == null || cv === "") continue;
      out.push(c + " = " + cv);
    }
    out.push("user = " + name + (enc != null ? "  (enc=" + enc + ")" : ""));
    out.push("──── message (복호화) ────");
    out.push(decMsg ? String(decMsg) : "(없음)");
    out.push("──── attachment (복호화) ────");
    out.push(decAtt ? _prettyJSON(decAtt) : "(없음)");
    out.push("──── supplement (복호화) ────");
    out.push(decSup ? _prettyJSON(decSup) : "(없음)");

    try { rawMsg.reply(out.join("\n")); } catch(_) {}
  } catch(e) {
    try { rawMsg.reply("[해체] 오류: " + (e && e.message ? e.message : e)); } catch(_) {}
  }
}

// "!해체" 가 "댓글(스레드)" 또는 "답장(인용)" 으로 전송됐을 때, 분석할 원본 메시지의 id 를 찾는다.
// 주의(레이스): 노티(onMessage)는 그 !해체 행이 DB 에 커밋되기 "직전"에 먼저 올 수 있다.
// 그 순간 단순히 "최신 행"을 집으면 직전 !해체(예: 이전 댓글)의 대상을 잘못 집어 항상
// 스레드 루트로 빠진다. 그래서 _lastDecomposeId 보다 _id 가 큰(아직 처리 안 한) 새 !해체
// 행이 보일 때까지 짧게(최대 8회×60ms) 재시도하며 기다린 뒤 분석 대상을 정한다:
//   ① 답장(인용): attachment.src_logId  (특정 메시지 1개를 콕 집어 인용 → 우선)
//   ② 댓글(스레드): thread_id           (댓글이 달린 스레드 루트 메시지)
// src_logId / thread_id 모두 19자리라 JSON.parse 로 숫자화하면 정밀도가 깨지므로
// (2^53 초과), 원문 문자열 / 컬럼값에서 정확한 자릿수를 문자열 그대로 뽑는다.
function _findReplyTargetId(rawMsg) {
  for (var attempt = 0; attempt < 8; attempt++) {
    try {
      var rows = _sqlObj(KT_DB1_PATH, "SELECT * FROM chat_logs ORDER BY _id DESC LIMIT 8;");
      if (rows && rows.length) {
        for (var ri = 0; ri < rows.length; ri++) {
          var row = rows[ri];
          var idNum = parseInt(row._id, 10);
          if (!(idNum > _lastDecomposeId)) break;   // DESC: 이미 처리한 지점 이하 → 새 행 없음
          var enc = null;
          try { enc = (JSON.parse(row.v || "{}")).enc; } catch(_) {}
          var key = (enc != null && row.user_id) ? _deriveKey(row.user_id, enc) : null;
          if (!key) continue;
          var msg = row.message ? String(_decrypt(key, row.message) || "").trim() : "";
          if (msg.indexOf("!해체") !== 0) continue;
          _lastDecomposeId = idNum;                 // 이 !해체 행 처리됨 기록 (재처리 방지)
          // ① 답장(인용): attachment.src_logId 우선
          var attRaw = row.attachment ? String(_decrypt(key, row.attachment) || "") : "";
          var mm = attRaw.match(/"src_logId"\s*:\s*"?(-?\d+)"?/);
          if (mm) return mm[1];
          // ② 댓글(스레드): thread_id 가 가리키는 루트 메시지
          var tid = row.thread_id;
          if (tid != null && tid !== "" && tid !== "0") return String(tid);
          return null;   // !해체 이지만 댓글/답장이 아님 (그냥 일반 메시지)
        }
      }
    } catch(_) {}
    try { java.lang.Thread.sleep(60); } catch(_) {}   // 아직 !해체 행 미가시 → 잠깐 대기 후 재시도
  }
  return null;
}

function handleDecomposeCommand(rawMsg) {
  var text;
  try { text = String(rawMsg.content || "").trim(); } catch(_) { return false; }
  if (text.indexOf("!해체") !== 0) return false;
  var m = text.match(/^!해체(?:\s+(\d+))?$/);
  if (!m) return false;                       // "!해체abc" 같은 건 흘려보냄
  if (!KT_OK) {
    try { rawMsg.reply("KakaoTalk DB 초기화 안 됨 (root/sqlite3 확인 필요)"); } catch(_) {}
    return true;
  }

  // ① !해체 <_id> : _id 직접 지정
  if (m[1]) {
    _decomposeAndReply(rawMsg, "_id", m[1]);
    return true;
  }

  // ② !해체 (댓글=thread_id / 답장=src_logId) : 분석할 원본 행을 역추적
  var srcId = _findReplyTargetId(rawMsg);
  if (srcId) {
    _decomposeAndReply(rawMsg, "id", srcId);
  } else {
    try {
      rawMsg.reply("사용법:\n• !해체 <chat_logs _id>\n• 분석할 메시지에 \"댓글\" 또는 \"답장\"으로 !해체 전송");
    } catch(_) {}
  }
  return true;
}

// ── onMessage: channelId ↔ room 매핑 (라이브 직접 + 영속화) ────────
// rawMsg.channelId(=chat_id) 와 rawMsg.room 을 동시에 받아 정확히 매핑한다 (추측 없음).
function onMessage(rawMsg) {
  // 봇 제어 명령(!onoff / !compile / !상태)을 먼저 처리. KT_OK 여부와 무관하게 동작.
  try { if (handleBotControlCommand(rawMsg)) return; } catch(_) {}
  try { if (handleDecomposeCommand(rawMsg)) return; } catch(_) {}

  // channelId(=chat_id) ↔ room 매핑: 라이브에서 둘 다 정확히 받으므로 추측·DB조회 불필요.
  // (rawMsg.channelId == KakaoTalk chat_logs.chat_id 임을 실측 확인함)
  try { _mapChannel(rawMsg.channelId, String(rawMsg.room || "")); } catch(_) {}
}
bot.addListener(Event.MESSAGE, onMessage);

function onCommand(msg) {}
bot.setCommandPrefix("@");
bot.addListener(Event.COMMAND, onCommand);

function onCreate(savedInstanceState, activity) {
  var tv = new Packages.android.widget.TextView(activity);
  tv.setText("ChatManager");
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
