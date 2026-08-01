var bot = BotManager.getCurrentBot();

// =====================================================================
// eval — "]" 프리픽스로 JS 코드 실행 (권한 등급별)
//
//   슈퍼관리자(2) : 제한 없는 eval. 봇 스코프 그대로 — java/Packages/bot 접근 가능.
//   일반관리자(1) : 샌드박스 eval. Rhino 안전 스코프라 Java 에 닿지 못한다.
//                   계산 / 문자열·정규식 / JSON 정도만 가능.
//   그 외(0)      : 거부.
//
//   권한은 hash(카카오톡 user_id) 로만 판정한다. 닉네임은 누구나 바꿀 수 있어
//   신원이 아니다 — lib/admin.js 참고.
//
//   관리 명령(슈퍼관리자 전용): !관리자 / !관리자추가 / !관리자삭제
//   누구나: !내권한 (본인 레벨과 이 방에서의 hash 확인)
//
// 메시지 수신: ChatManager 의 broadcast 큐 구독. ChatManager 가 켜져 있어야 동작.
//
// RhinoJS-safe: var / function 만.
// =====================================================================

var BOT_NAME = "eval";
var WORKER_NAME = "EVAL_BOT_WORKER";

function libPath(name) {
  var p = "/sdcard/msgbot/lib/" + name;
  try {
    if (typeof bot.getRootPath === "function") p = bot.getRootPath() + "/../../lib/" + name;
  } catch (_) {}
  return p;
}

var admin   = require(libPath("admin.js"));
var sandbox = require(libPath("sandbox.js"));

function trim(s) { return String(s == null ? "" : s).replace(/^\s+|\s+$/g, ""); }

function levelName(lv) {
  if (lv >= admin.LEVEL_SUPER) return "슈퍼관리자";
  if (lv >= admin.LEVEL_ADMIN) return "일반관리자";
  return "일반 사용자";
}

// =====================================================================
// ] — 코드 실행
// =====================================================================

function handleEval(msg) {
  var code = String(msg.content).substring(1);
  var lv = admin.levelOf(msg.hash);

  if (lv >= admin.LEVEL_SUPER) {
    try { msg.reply(String(eval(code))); }
    catch (e) { msg.reply(String(e)); }
    return;
  }

  if (lv >= admin.LEVEL_ADMIN) {
    var r = sandbox.run(code);
    msg.reply(r.error ? ("[제한 실행] ⚠ " + r.error) : ("[제한 실행] " + r.value));
    return;
  }

  msg.reply("권한이 없습니다. 관리자만 쓸 수 있습니다. (!내권한 으로 확인)");
}

// =====================================================================
// !내권한
// =====================================================================

function handleMyLevel(msg) {
  var lv = admin.levelOf(msg.hash);
  var person = admin.personOf(msg.hash);
  var lines = [
    "[내 권한]",
    "등급: " + lv + " (" + levelName(lv) + ")"
  ];
  if (person) lines.push("사람: " + person);
  lines.push("hash: " + String(msg.hash || "?"));
  lines.push("방: " + String(msg.room || "?"));
  if (lv === admin.LEVEL_NONE) {
    lines.push("");
    lines.push("권한이 필요하면 슈퍼관리자에게 위 hash 를 알려주세요.");
  } else if (lv === admin.LEVEL_ADMIN) {
    lines.push("");
    lines.push("] 로 제한 실행 가능 (계산·문자열·정규식·JSON). Java/봇 접근은 불가.");
  }
  msg.reply(lines.join("\n"));
}

// =====================================================================
// !관리자 — 목록
// =====================================================================

function handleList(msg) {
  if (!admin.isAdmin(msg.hash)) { msg.reply("관리자만 쓸 수 있습니다."); return; }

  var list = admin.listAdmins();
  if (!list.length) { msg.reply("등록된 관리자가 없습니다."); return; }

  var lines = ["[관리자 목록]"];
  for (var i = 0; i < list.length; i++) {
    var a = list[i];
    lines.push("");
    lines.push("• " + a.person + " — " + levelName(a.level) + " (" + a.level + "), hash " + a.hashes.length + "개");
    for (var j = 0; j < a.hashes.length; j++) {
      lines.push("   " + String(a.hashes[j].room || "?"));
    }
  }
  lines.push("");
  lines.push("샌드박스 사용 가능: " + (sandbox.available() ? "예" : "아니오 (" + sandbox.probeResult() + ")"));
  msg.reply(lines.join("\n"));
}

// =====================================================================
// !관리자추가 [닉네임] [확인]
// =====================================================================

function handleAdd(msg, arg) {
  if (!admin.isSuper(msg.hash)) { msg.reply("슈퍼관리자만 관리자를 등록할 수 있습니다."); return; }

  var confirm = false;
  var name = trim(arg);
  if (/\s확인$/.test(name)) { confirm = true; name = trim(name.replace(/\s확인$/, "")); }

  if (!name) {
    msg.reply("사용법: !관리자추가 [닉네임]\n예) !관리자추가 마히로");
    return;
  }

  var rows = admin.findHashesByName(name);
  if (!rows.length) {
    msg.reply("userhash 에서 '" + name + "' 을(를) 찾지 못했습니다.\n" +
              "그 사람이 봇이 보는 방에서 한 번 이상 말한 적이 있어야 합니다.");
    return;
  }

  if (!confirm) {
    var lines = ["[관리자 등록 확인] '" + name + "' — hash " + rows.length + "개"];
    for (var i = 0; i < rows.length; i++) {
      var owner = admin.personOf(rows[i].hash);
      lines.push("• " + String(rows[i].room || "?") +
                 (owner ? "  ⚠ 이미 '" + owner + "' 에 등록됨" : ""));
    }
    lines.push("");
    lines.push("닉네임은 누구나 바꿀 수 있으니 위 방 목록이 맞는지 확인하세요.");
    lines.push("등록하려면: !관리자추가 " + name + " 확인");
    msg.reply(lines.join("\n"));
    return;
  }

  var res = admin.grant(name, admin.LEVEL_ADMIN, rows, msg.hash);
  if (res && res.error) { msg.reply("[관리자 등록 실패] " + res.error); return; }
  msg.reply("[관리자 등록] " + res.person + " — 일반관리자(1)\n" +
            "hash " + res.total + "개 연결 (신규 " + res.added + ", 이전 소유 " + res.moved + ")");
}

// =====================================================================
// !관리자삭제 [사람] [확인]
// =====================================================================

function handleRemove(msg, arg) {
  if (!admin.isSuper(msg.hash)) { msg.reply("슈퍼관리자만 관리자를 회수할 수 있습니다."); return; }

  var confirm = false;
  var name = trim(arg);
  if (/\s확인$/.test(name)) { confirm = true; name = trim(name.replace(/\s확인$/, "")); }

  if (!name) { msg.reply("사용법: !관리자삭제 [사람]"); return; }

  var list = admin.listAdmins(), target = null;
  for (var i = 0; i < list.length; i++) if (list[i].person === name) target = list[i];
  if (!target) { msg.reply("'" + name + "' 은(는) 등록된 관리자가 아닙니다."); return; }

  if (!confirm) {
    msg.reply("[관리자 회수 확인] " + target.person + " — " + levelName(target.level) +
              ", hash " + target.hashes.length + "개\n\n회수하려면: !관리자삭제 " + name + " 확인");
    return;
  }

  var res = admin.revoke(name, msg.hash);
  if (res && res.error) { msg.reply("[관리자 회수 실패] " + res.error); return; }
  msg.reply("[관리자 회수] " + res.person + " — hash " + res.removedHashes + "개 삭제");
}

// =====================================================================
// 디스패치
// =====================================================================

function handleMessage(msg) {
  var text = trim(msg.content);

  if (text.indexOf("]") === 0) { handleEval(msg); return; }
  if (text === "!내권한")      { handleMyLevel(msg); return; }
  if (text === "!관리자")      { handleList(msg); return; }
  if (text.indexOf("!관리자추가") === 0) { handleAdd(msg, text.substring("!관리자추가".length)); return; }
  if (text.indexOf("!관리자삭제") === 0) { handleRemove(msg, text.substring("!관리자삭제".length)); return; }
}

function isMyCommand(text) {
  var t = trim(text);
  return !!t && (t.indexOf("]") === 0 || t.indexOf("!관리자") === 0 || t === "!내권한");
}

// ─── 메시지 큐 + 워커 스레드 (ChatManager 구독, 공용 subscriber 모듈) ───
var subscribe = require(libPath("subscriber.js"));

subscribe(BOT_NAME, WORKER_NAME, function (msg) {
  if (!isMyCommand(msg.content)) return;
  try { handleMessage(msg); }
  catch (e) {
    try { msg.reply("[eval] ⚠ 오류: " + ((e && e.message) ? e.message : e)); } catch (_) {}
  }
});

// ─── 보일러플레이트 ─────────────────────────────────────────────────────────
function onMessage(rawMsg) {}   // 메시지는 ChatManager 큐로 들어옴
bot.addListener(Event.MESSAGE, onMessage);

function onCommand(msg) {}
bot.setCommandPrefix("@");
bot.addListener(Event.COMMAND, onCommand);

function onCreate(savedInstanceState, activity) {
  var textView = new Packages.android.widget.TextView(activity);
  textView.setText("eval (권한 등급별)");
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
