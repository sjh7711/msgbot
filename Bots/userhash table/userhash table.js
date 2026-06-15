var bot = BotManager.getCurrentBot();

var subscribe = (function() {
  var libPath = "/sdcard/msgbot/Bots/lib/subscriber.js";
  try {
    if (typeof bot.getRootPath === "function") {
      libPath = bot.getRootPath() + "/../lib/subscriber.js";
    }
  } catch(_) {}
  return require(libPath);
})();

// =====================================================================
// userhash table — hash → name/room 매핑 저장
//
// 메시지 수신: ChatManager 의 broadcast 큐 구독 (모든 메시지 처리).
//   ChatManager 가 켜져 있어야 동작.
//
// ⚠️ hash 형식 변경:
//   이전: msgbot 의 msg.author.hash
//   이후: KakaoTalk DB 의 user_id (ChatManager 가 넘겨줌)
//   기존 userhash.db 데이터는 옛 해시 기반이라 새 데이터와 조인 안 됨
//   (고립됨, 손상은 아님).
// =====================================================================

var BOT_NAME = "userhash table";

var DB_PATH = Packages.android.os.Environment.getExternalStorageDirectory().getAbsolutePath() + "/msgbot/userhash.db";

// 공용 DB 커넥션 (워커 단일 스레드 + 조회 함수에서 재사용)
// SQLiteDatabase 는 내부 락이 있어 스레드 공유 가능. 메시지마다 open/close 하지 않음.
var _db = null;
function getDB() {
  if (_db == null || !_db.isOpen()) {
    _db = Packages.android.database.sqlite.SQLiteDatabase.openOrCreateDatabase(DB_PATH, null);
  }
  return _db;
}

// DB 초기화 및 테이블 생성
function initDB() {
  try {
    var file = new java.io.File(DB_PATH);
    var parent = file.getParentFile();
    if (!parent.exists()) parent.mkdirs();

    getDB().execSQL(
      "CREATE TABLE IF NOT EXISTS userhash (" +
        "hash TEXT PRIMARY KEY, " +
        "name TEXT, " +
        "room TEXT, " +
        "first_seen INTEGER, " +
        "last_seen INTEGER" +
      ")"
    );

  } catch (e) {
    Log.e("initDB 오류: " + e);
  }
}

// 유저 저장 (UPSERT: 없으면 INSERT, 있으면 UPDATE)
function saveUserHash(hash, room, name) {
  if (!hash) return;
  try {
    var now = Date.now();

    // ON CONFLICT UPSERT — SELECT/커서 불필요, first_seen 보존.
    //   name/room 이 빈 값('')이면 기존 값을 유지(덮어쓰기 방지).
    //   excluded.* = 새로 들어온 값, 컬럼명 단독 = 기존 행 값.
    // ⚠️ ON CONFLICT UPSERT 는 SQLite 3.24+(Android 9 / API 28+) 필요.
    getDB().execSQL(
      "INSERT INTO userhash (hash, name, room, first_seen, last_seen) " +
      "VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(hash) DO UPDATE SET " +
        "name = CASE WHEN excluded.name != '' THEN excluded.name ELSE name END, " +
        "room = CASE WHEN excluded.room != '' THEN excluded.room ELSE room END, " +
        "last_seen = excluded.last_seen",
      [hash, name, room, now, now]
    );

  } catch (e) {
    Log.e("saveUserHash 오류: " + e);
  }
}

// 특정 유저 조회
function getUser(hash) {
  var cursor = null;
  try {
    cursor = getDB().rawQuery("SELECT * FROM userhash WHERE hash = ?", [hash]);
    if (!cursor.moveToFirst()) return null;

    return {
      hash:       cursor.getString(0),
      name:       cursor.getString(1),
      room:       cursor.getString(2),
      firstSeen:  cursor.getLong(3),
      lastSeen:   cursor.getLong(4)
    };

  } catch (e) {
    Log.e("getUser 오류: " + e);
    return null;
  } finally {
    if (cursor) cursor.close();
  }
}

// 전체 유저 수 조회
function getUserCount() {
  var cursor = null;
  try {
    cursor = getDB().rawQuery("SELECT COUNT(*) FROM userhash", null);
    cursor.moveToFirst();
    return cursor.getLong(0);

  } catch (e) {
    Log.e("getUserCount 오류: " + e);
    return 0;
  } finally {
    if (cursor) cursor.close();
  }
}

// 봇 시작 시 DB 초기화
initDB();


// ─── 메시지 큐 + 워커 스레드 (ChatManager 구독) ─────────────────────────────
var WORKER_NAME = "USERHASH_TABLE_WORKER";

subscribe(BOT_NAME, WORKER_NAME, function(msg) {
  if (!msg.hash) return;
  saveUserHash(msg.hash, msg.room, msg.name);
});


// ─── 보일러플레이트 ─────────────────────────────────────────────────────────
function onMessage(msg) {}  // 메시지는 ChatManager 큐로 들어옴
bot.addListener(Event.MESSAGE, onMessage);

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
