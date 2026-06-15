const bot = BotManager.getCurrentBot();

// =====================================================================
// 로그봇 — 채팅 로그/userhash 기록 + !최근채팅 조회
//
// 메시지 수신: ChatManager 의 broadcast 큐 구독 (모든 메시지 처리).
//   ChatManager 가 켜져 있어야 동작.
//
// ⚠️ hash 형식 변경:
//   이전: msgbot 의 msg.author.hash
//   이후: KakaoTalk DB 의 user_id (ChatManager 가 넘겨줌)
//   기존 userhash.db / chat_log 데이터는 옛 해시 기반이라 새 데이터와
//   조인이 안 됨 (고립됨, 손상은 아님).
// =====================================================================

const BOT_NAME = "로그봇";

const CHAT_DB_PATH = Packages.android.os.Environment.getExternalStorageDirectory().getAbsolutePath() + "/msgbot/chat.db";
const HASH_DB_PATH = Packages.android.os.Environment.getExternalStorageDirectory().getAbsolutePath() + "/msgbot/userhash.db";

// 공용 DB 커넥션 재사용 (메시지마다 open/close 하지 않음).
// SQLiteDatabase 는 내부 락이 있어 워커 단일 스레드에서 안전하게 공유 가능.
// 저사양 기기에서 매 메시지 open/close 비용을 제거한다.
var _chatDb = null;
var _hashDb = null;
function openChatDb() {
  if (_chatDb == null || !_chatDb.isOpen())
    _chatDb = Packages.android.database.sqlite.SQLiteDatabase.openOrCreateDatabase(CHAT_DB_PATH, null);
  return _chatDb;
}

function openHashDb() {
  if (_hashDb == null || !_hashDb.isOpen())
    _hashDb = Packages.android.database.sqlite.SQLiteDatabase.openOrCreateDatabase(HASH_DB_PATH, null);
  return _hashDb;
}

// ----- 초기화 -----
(function init() {
  var chatDb = openChatDb();
  try {
    chatDb.execSQL("CREATE TABLE IF NOT EXISTS chat_log (" +
                   "hash TEXT NOT NULL," +
                   "room TEXT NOT NULL," +
                   "message TEXT NOT NULL," +
                   "ts INTEGER NOT NULL)");
    chatDb.execSQL("CREATE INDEX IF NOT EXISTS idx_chat_log_hash ON chat_log(hash)");
    chatDb.execSQL("CREATE INDEX IF NOT EXISTS idx_chat_log_room_ts ON chat_log(room, ts DESC)");
    chatDb.execSQL("CREATE INDEX IF NOT EXISTS idx_chat_log_ts ON chat_log(ts DESC)");
  } catch (e) {}

  var hashDb = openHashDb();
  try {
    hashDb.execSQL("CREATE TABLE IF NOT EXISTS userhash (" +
                   "hash TEXT PRIMARY KEY," +
                   "name TEXT," +
                   "room TEXT," +
                   "first_seen INTEGER," +
                   "last_seen INTEGER)");
  } catch (e) {}
})();

function nowTs() {
  return java.lang.System.currentTimeMillis();
}

function formatTs(ts) {
  var sdf = new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm", java.util.Locale.KOREA);
  sdf.setTimeZone(java.util.TimeZone.getTimeZone("Asia/Seoul"));
  return sdf.format(new java.util.Date(ts));
}

function isPositiveInt(s) {
  try {
    if (s == null) return false;
    var n = java.lang.Integer.parseInt(String(s).trim());
    return n > 0;
  } catch (e) { return false; }
}

function makeLikePatternFromWildcard(input) {
  if (input == null) return null;
  var pat = String(input);
  pat = pat.replace(/\\/g, "\\\\");
  pat = pat.replace(/%/g, "\\%").replace(/_/g, "\\_");
  pat = pat.replace(/\*/g, "%");
  return pat;
}

function getNameByHash(hash) {
  var hashDb = openHashDb(); var cur = null;
  try {
    cur = hashDb.rawQuery("SELECT name FROM userhash WHERE hash = ?", [String(hash)]);
    if (cur.moveToFirst()) return cur.getString(0);
    return null;
  } catch (e) { return null; }
  finally { if (cur) cur.close(); }
}

function getHashesByNamePattern(likePat) {
  var hashDb = openHashDb(); var cur = null; var hashes = [];
  try {
    cur = hashDb.rawQuery("SELECT hash FROM userhash WHERE name LIKE ? ESCAPE '\\'", [likePat]);
    while (cur.moveToNext()) hashes.push(cur.getString(0));
  } catch (e) { }
  finally { if (cur) cur.close(); }
  return hashes;
}

// 직전에 기록한 (hash → name|room|ts) 캐시. 같은 유저가 같은 이름/방으로 연속 발화하면
// DB 쓰기를 건너뛴다. 저사양 기기에서 매 메시지 DB 쓰기를 대부분 제거하는 게 핵심.
var _uhCache = {};
var UH_WRITE_TTL_MS = 60 * 1000;   // 이름/방이 그대로여도 이 주기마다는 last_seen 갱신

function upsertUserHash(hash, name, room) {
  var key = String(hash);
  var nm = String(name), rm = String(room);
  var now = nowTs();
  var c = _uhCache[key];
  // 이름·방이 동일하고 최근(TTL 이내)에 기록했으면 DB 접근 자체를 생략
  if (c && c.name === nm && c.room === rm && (now - c.ts) < UH_WRITE_TTL_MS) return;

  var hashDb = openHashDb(); var cur = null;
  try {
    cur = hashDb.rawQuery("SELECT 1 FROM userhash WHERE hash = ?", [key]);
    var exists = cur.moveToFirst();
    cur.close(); cur = null;

    if (exists) {
      hashDb.execSQL(
        "UPDATE userhash SET name = ?, room = ?, last_seen = ? WHERE hash = ?",
        [nm, rm, now, key]
      );
    } else {
      hashDb.execSQL(
        "INSERT INTO userhash(hash, name, room, first_seen, last_seen) VALUES(?,?,?,?,?)",
        [key, nm, rm, now, now]
      );
    }
    _uhCache[key] = { name: nm, room: rm, ts: now };
  } catch (e) { }
  finally { if (cur) cur.close(); }
}

function insertChatLog(hash, room, message) {
  var chatDb = openChatDb();
  try {
    chatDb.execSQL(
      "INSERT INTO chat_log(hash, room, message, ts) VALUES(?, ?, ?, ?)",
      [String(hash), String(room), String(message), nowTs()]
    );
  } catch (e) {}
}


// ─── 메시지 처리 (워커 스레드에서 호출) ─────────────────────────────────────
function handleMessage(msg) {
  try {
    var hash = msg.author.hash ? String(msg.author.hash) : null;

    // 1) userhash upsert + chat_log 기록
    if (hash) {
      upsertUserHash(hash, msg.author.name, msg.room);
      if( msg.room == "명동(공공장소에서열지마세요)" ) {
        insertChatLog(hash, msg.room, msg.content);
      }
    }

    // 2) 명령 처리
    if (msg.content.startsWith("!최근채팅")) {
      var rest = msg.content.substring("!최근채팅".length).trim();
      var count = 30;
      var rows = [];
      var chatDb, cursor;

      if (rest.length === 0) {
        // case A) "!최근채팅" 단독 → 최근 30개
        chatDb = openChatDb();
        try {
          cursor = chatDb.rawQuery(
            "SELECT hash, message, ts FROM chat_log ORDER BY ts DESC LIMIT ?",
            [String(count)]
          );
          while (cursor.moveToNext()) {
            var h = cursor.getString(0);
            var m = cursor.getString(1);
            var t = cursor.getLong(2);
            var displayName = getNameByHash(h) || h;
            rows.push("[" + formatTs(t) + "] " + displayName + ": " + m);
          }
          cursor.close();
        } catch (e) {}

      } else {
        // case B) "!최근채팅 닉네임패턴 [개수]"
        var parts = rest.split(/\s+/);
        if (parts.length >= 2 && isPositiveInt(parts[parts.length - 1])) {
          count = Math.min(java.lang.Integer.parseInt(parts.pop()), 300);
        }
        var namePatternInput = parts.join(" ").trim();
        if (namePatternInput.length === 0) {
          msg.reply("닉네임 패턴이 비어있습니다. 예: !최근채팅 *홍* 100");
          return;
        }

        var likePat = makeLikePatternFromWildcard(namePatternInput);
        var hashes = getHashesByNamePattern(likePat);

        if (hashes.length === 0) {
          msg.reply("해당 닉네임 패턴의 유저가 없습니다: " + namePatternInput);
          return;
        }

        var placeholders = hashes.map(function() { return "?"; }).join(",");
        chatDb = openChatDb();
        try {
          cursor = chatDb.rawQuery(
            "SELECT hash, message, ts FROM chat_log " +
            "WHERE hash IN (" + placeholders + ") " +
            "ORDER BY ts DESC LIMIT ?",
            hashes.concat([String(count)])
          );
          while (cursor.moveToNext()) {
            var h = cursor.getString(0);
            var m = cursor.getString(1);
            var t = cursor.getLong(2);
            var displayName = getNameByHash(h) || h;
            rows.push("[" + formatTs(t) + "] " + displayName + ": " + m);
          }
          cursor.close();
        } catch (e) {}
      }

      rows.reverse();

      if (rows.length === 0) {
        msg.reply("조회 결과가 없습니다.");
      } else {
        var header = "!최근채팅 결과 (" + rows.length + "건)\n—";
        var out = header + "\n";
        for (var i = 0; i < rows.length; i++) {
          var line = rows[i];
          if ((out.length + line.length + 1) > 3500) {
            msg.reply(out);
            out = header + "\n";
          }
          out += line + "\n";
        }
        if (out.trim().length > 0) msg.reply(out.trim());
      }
    }
  } catch (e) {
    try { msg.reply("[오류] " + e); } catch(_) {}
  }
}

// ─── 메시지 큐 + 워커 스레드 (ChatManager 구독) ─────────────────────────────
var msgQueue = new java.util.concurrent.LinkedBlockingQueue();
var WORKER_NAME = "LOG_BOT_WORKER";

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
      if (String(t.getName() || "") === WORKER_NAME) {
        try { t.interrupt(); } catch(_) {}
      }
    }
  } catch(_) {}
})();

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

new java.lang.Thread(function() {
  while (!java.lang.Thread.currentThread().isInterrupted()) {
    var task = null;
    try { task = msgQueue.take(); } catch(_) { return; }
    try {
      if (!(task instanceof java.util.HashMap)) continue;
      // 로그봇은 모든 메시지를 기록하므로 프리필터 없음
      var text = String(task.get("text") || "");
      var room = String(task.get("room") || "");
      var name = String(task.get("name") || "익명");
      var hash = String(task.get("hash") || "");
      var msg = {
        content: text,
        room: room,
        author: { name: name, hash: hash },
        reply: (function(r){ return function(s){ try { bot.send(r, s); } catch(_) {} }; })(room)
      };
      handleMessage(msg);
    } catch(_) {}
  }
}, WORKER_NAME).start();


// ─── 보일러플레이트 ─────────────────────────────────────────────────────────
function onMessage(rawMsg) {}  // 메시지는 ChatManager 큐로 들어옴
bot.addListener(Event.MESSAGE, onMessage);

function onCommand(msg) {}
bot.setCommandPrefix("@");
bot.addListener(Event.COMMAND, onCommand);


function onCreate(savedInstanceState, activity) {
  var textView = new Packages.android.widget.TextView(activity);
  textView.setText("Hello, World!");
  textView.setTextColor(Packages.android.graphics.Color.DKGRAY);
  activity.setContentView(textView);
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
