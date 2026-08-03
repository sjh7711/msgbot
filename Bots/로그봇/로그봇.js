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
// 에러 로그 수집 + 권한. 못 불러오면 null → "!에러" 만 죽고 나머지는 그대로 동작한다
// (이 두 파일 때문에 로그봇 전체가 컴파일 실패하지 않도록).
function _libPath(name) {
  var p = "/sdcard/msgbot/lib/" + name;
  try { if (typeof bot.getRootPath === "function") p = bot.getRootPath() + "/../../lib/" + name; } catch(_) {}
  return p;
}
var errlog = (function() {
  try { var m = require(_libPath("errlog.js"));
        return (m && typeof m.collect === "function") ? m : null; } catch(_) { return null; }
})();
var admin = (function() {
  try { var m = require(_libPath("admin.js"));
        return (m && typeof m.levelOf === "function") ? m : null; } catch(_) { return null; }
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

// ─── "!에러" — 흩어진 에러 로그 모아보기 ────────────────────────────────────
//   !에러            최근 24시간 요약 (봇별 건수 + 같은 에러 묶음)
//   !에러 6          최근 6시간
//   !에러 제미니봇    그 봇 것만 (부분일치)
//   !에러 상세        최근 원문 15줄 그대로
//   !에러 전체        기간 제한 없이 (남아 있는 기록 전부)
//
//   스택·파일 경로가 그대로 나오므로 관리자만 쓸 수 있게 한다.
var ERR_CMD = "!에러";
var ERR_DEFAULT_HOURS = 24;
var ERR_GROUP_MAX = 6;      // 요약에 보여줄 에러 묶음 수
var ERR_RAW_MAX = 15;       // 상세에서 보여줄 원문 줄 수
var ERR_SAMPLE_LEN = 110;   // 한 줄이 너무 길면 자른다 (카톡 가독성)

function _errCut(s, n) {
  var t = String(s).replace(/[\r\n]+/g, " ");
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function _errUsage() {
  return [ERR_CMD + " 사용법",
    "• " + ERR_CMD + "            최근 " + ERR_DEFAULT_HOURS + "시간 요약",
    "• " + ERR_CMD + " 6          최근 6시간",
    "• " + ERR_CMD + " 제미니봇    그 봇 것만",
    "• " + ERR_CMD + " 상세        최근 원문 " + ERR_RAW_MAX + "줄",
    "• " + ERR_CMD + " 전체        남아 있는 기록 전부"].join("\n");
}

function _errSummaryText(res, label) {
  var s = errlog.summarize(res.entries);
  if (!s.total) {
    return "[에러 로그] " + label + "\n에러가 없습니다. 👍\n" +
           "(수집: " + (res.sources.length ? res.sources.length + "개 파일" : "로그 파일 없음") + ")";
  }
  var lines = ["[에러 로그] " + label + " — 총 " + s.total + "건"];

  lines.push("");
  var bots = [];
  for (var i = 0; i < s.byBot.length && i < 8; i++) bots.push(s.byBot[i].bot + " " + s.byBot[i].n);
  lines.push("봇별: " + bots.join(" / "));

  lines.push("");
  lines.push("자주 나는 순:");
  for (var g = 0; g < s.groups.length && g < ERR_GROUP_MAX; g++) {
    var it = s.groups[g];
    lines.push((g + 1) + ") [" + it.bot + "] " + it.n + "회  마지막 " + it.last.slice(5));
    lines.push("   " + _errCut(it.sample, ERR_SAMPLE_LEN));
  }
  if (s.groups.length > ERR_GROUP_MAX) lines.push("… 그 외 " + (s.groups.length - ERR_GROUP_MAX) + "종류");

  lines.push("");
  var srcs = [];
  for (var k = 0; k < res.sources.length; k++) srcs.push(res.sources[k].name + "(" + res.sources[k].kept + ")");
  lines.push("수집: " + srcs.join(", "));
  // 각 기록부가 256KB 에서 파일을 비우므로 "전 기간"이 아니라는 걸 밝혀 둔다.
  lines.push("※ 로그는 용량 한도로 앞부분이 잘렸을 수 있습니다.");
  return lines.join("\n");
}

function _errRawText(res, label) {
  if (!res.entries.length) return "[에러 로그] " + label + "\n에러가 없습니다. 👍";
  var lines = ["[에러 로그] " + label + " — 최근 " + Math.min(res.entries.length, ERR_RAW_MAX) +
               "건 (총 " + res.entries.length + ")", ""];
  var from = Math.max(0, res.entries.length - ERR_RAW_MAX);
  for (var i = from; i < res.entries.length; i++) {
    var e = res.entries[i];
    lines.push(e.ts.slice(5) + " [" + e.bot + "]");
    lines.push("  " + _errCut(e.text, 200));
  }
  return lines.join("\n");
}

function handleErrCmd(msg) {
  if (!errlog) { msg.reply("에러 로그 모듈(lib/errlog.js)을 불러오지 못했습니다."); return true; }
  // 권한 모듈을 못 읽으면 열어주지 않는다 (실패 시 닫히는 쪽으로).
  if (!admin || !admin.isAdmin(msg.hash)) { msg.reply(ERR_CMD + " 은 관리자만 사용할 수 있습니다."); return true; }

  var arg = String(msg.content).slice(ERR_CMD.length).replace(/^\s+|\s+$/g, "");
  var opts = { hours: ERR_DEFAULT_HOURS }, label = "최근 " + ERR_DEFAULT_HOURS + "시간", raw = false;

  if (/^(도움말|help|\?)$/i.test(arg)) { msg.reply(_errUsage()); return true; }
  if (/^전체$/.test(arg)) { opts = {}; label = "전체 기간"; }
  else if (/^상세$/.test(arg)) { raw = true; }
  else if (/^\d+$/.test(arg)) {
    var h = Number(arg);
    if (h < 1 || h > 720) { msg.reply("시간은 1~720 사이로 넣어주세요."); return true; }
    opts = { hours: h }; label = "최근 " + h + "시간";
  } else if (arg) {
    opts = { bot: arg }; label = "'" + arg + "' 전체 기간";
  }

  var res = errlog.collect(opts);
  // 기간 계산이 실패하면 필터가 걸리지 않는다 — 라벨을 사실대로 바꾼다.
  if (res.sinceFailed) label = "전체 기간 (⚠ 기간 계산 실패로 " + label + " 필터가 적용되지 않음)";
  msg.reply(raw ? _errRawText(res, label) : _errSummaryText(res, label));
  return true;
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

  // "!에러" — 에러 로그 모아보기 (관리자 전용)
  try {
    if (msg.content && String(msg.content).indexOf(ERR_CMD) === 0) {
      if (handleErrCmd(msg)) return;
    }
  } catch (e) {
    try { msg.reply("에러 로그 조회 실패: " + (e && e.message ? e.message : e)); } catch(_) {}
    return;
  }

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
