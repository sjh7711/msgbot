const bot = BotManager.getCurrentBot();

// =====================================================================
// 로그봇 — userhash(hash → name/room) 기록  (구 'userhash table' 통합)
//
// 메시지 수신: ChatManager 의 broadcast 큐 구독 (모든 메시지 처리).
//   ChatManager 가 켜져 있어야 동작.
//
// "!지운채팅" 명령: KakaoTalk.db 에서 삭제된 채팅을 모아 보여줌(온디맨드).
//   → Bots/로그봇/deletedchat.js + lib/kakao-decrypt.js + lib/kakao-msg-render.js
//
// ⚠️ 최근채팅 기능(chat.db 저장 / "!최근채팅" 조회)은 분리되어
//   /sdcard/msgbot/recentchat.js.bak 에 보관됨 (비활성).
//
// ⚠️ hash 형식: KakaoTalk DB 의 user_id (ChatManager 가 넘겨줌).
//   기존 userhash.db 데이터는 옛 해시 기반이라 새 데이터와 조인 안 됨
//   (고립됨, 손상은 아님).
// =====================================================================

const BOT_NAME = "로그봇";

const HASH_DB_PATH = Packages.android.os.Environment.getExternalStorageDirectory().getAbsolutePath() + "/msgbot/userhash.db";

// ChatManager broadcast 큐 구독 공용 모듈
var subscribe = (function() {
  var libPath = "/sdcard/msgbot/lib/subscriber.js";
  try {
    if (typeof bot.getRootPath === "function") {
      libPath = bot.getRootPath() + "/../../lib/subscriber.js";
    }
  } catch(_) {}
  return require(libPath);
})();

// 복호화 모듈(kt) + 지운채팅 뷰어 모듈
var kt = (function() {
  var p = "/sdcard/msgbot/lib/kakao-decrypt.js";
  try { if (typeof bot.getRootPath === "function") p = bot.getRootPath() + "/../../lib/kakao-decrypt.js"; } catch(_) {}
  return require(p);
})();
var deletedChat = (function() {
  var p = "/sdcard/msgbot/Bots/로그봇/deletedchat.js";
  try { if (typeof bot.getRootPath === "function") p = bot.getRootPath() + "/deletedchat.js"; } catch(_) {}
  return require(p);
})();

// 공용 DB 커넥션 재사용 (메시지마다 open/close 하지 않음).
// SQLiteDatabase 는 내부 락이 있어 워커 단일 스레드에서 안전하게 공유 가능.
var _hashDb = null;
function openHashDb() {
  if (_hashDb == null || !_hashDb.isOpen())
    _hashDb = Packages.android.database.sqlite.SQLiteDatabase.openOrCreateDatabase(HASH_DB_PATH, null);
  return _hashDb;
}

// ----- 초기화 -----
(function init() {
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

// ─── 메시지 큐 + 워커 스레드 (ChatManager 구독, 공유 모듈) ───────────────────
var WORKER_NAME = "LOG_BOT_WORKER";

subscribe(BOT_NAME, WORKER_NAME, function(msg) {
  // "!지운채팅" 명령 우선 처리 (처리하면 userhash 기록은 건너뜀)
  try {
    if (msg.content && String(msg.content).indexOf(deletedChat.CMD) === 0) {
      if (deletedChat.handle(msg, kt)) return;
    }
  } catch (e) {}

  // 로그봇은 모든 메시지에 대해 userhash 를 기록한다 (프리필터 없음).
  if (!msg.hash) return;
  upsertUserHash(msg.hash, msg.author.name, msg.room);
});

// ─── 보일러플레이트 ─────────────────────────────────────────────────────────
function onMessage(rawMsg) {}  // 메시지는 ChatManager 큐로 들어옴
bot.addListener(Event.MESSAGE, onMessage);

function onCommand(msg) {}
bot.setCommandPrefix("@");
bot.addListener(Event.COMMAND, onCommand);

function onCreate(savedInstanceState, activity) {
  var textView = new Packages.android.widget.TextView(activity);
  textView.setText("로그봇 (userhash)");
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
