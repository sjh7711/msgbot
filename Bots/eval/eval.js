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
    msg.reply(r.error ? ("⚠ " + r.error) : String(r.value));
    return;
  }

  // 권한 없으면 아무 응답도 하지 않는다. 거절 문구는 그 방 전체가 보는 공개
  // 메시지라, 명령이 있다는 사실과 누가 시도했는지를 드러낸다.
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
// !관리자추가 — 방 선택 → 사람 다중 선택 (관리 전용 방에서만)
//
//   닉네임을 직접 타이핑하던 방식은 정확히 일치해야 해서
//   "숨밥(숨어서 鴨肉飯먹기)" 같은 이름을 못 쓴다. 번호 선택으로 바꿨다.
//   ChatManager 의 !onoff / !compile 과 같은 조작감.
// =====================================================================

var PENDING_TTL_MS = 180000;   // 3분
var pending = null;            // { stage:"room"|"user", hash, room, rooms|users, targetRoom, ts }

function nowMs() { return java.lang.System.currentTimeMillis(); }

function pendingAlive() {
  if (!pending) return false;
  if (nowMs() - pending.ts > PENDING_TTL_MS) { pending = null; return false; }
  return true;
}

// 대기 중인 선택이 이 메시지 주인의 것인가 (같은 사람 + 같은 방일 때만 숫자를 가로챈다)
function pendingMatches(msg) {
  return pendingAlive() &&
         pending.hash === String(msg && msg.hash) &&
         pending.room === String(msg && msg.room);
}

function isSelectionInput(text) { return /^[0-9]+([\s,]+[0-9]+)*$/.test(text); }

// "1 3 5" / "1,3,5" → [0,2,4] (1-기반 → 0-기반, 중복 제거, 입력 순서 유지)
function parseSelection(text, max) {
  var parts = trim(text).split(/[\s,]+/);
  var out = [], seen = {}, bad = [];
  for (var i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    var n = parseInt(parts[i], 10);
    if (isNaN(n) || n < 1 || n > max) { bad.push(parts[i]); continue; }
    if (seen[n]) continue;
    seen[n] = true;
    out.push(n - 1);
  }
  return { indices: out, bad: bad };
}

function startRoomSelection(msg) {
  var rooms = admin.listRooms();
  if (!rooms.length) { msg.reply("userhash 에 방 기록이 없습니다."); return; }

  pending = { stage: "room", hash: String(msg.hash), room: String(msg.room), rooms: rooms, ts: nowMs() };

  var lines = ["[관리자 등록] 어느 방에서 고를까요?"];
  for (var i = 0; i < rooms.length; i++) {
    lines.push((i + 1) + ". " + rooms[i].room + " (" + rooms[i].count + "명)");
  }
  lines.push("");
  lines.push("번호 하나를 입력하세요. (취소: !관리자취소)");
  msg.reply(lines.join("\n"));
}

function showUserSelection(msg, targetRoom) {
  var users = admin.listUsersInRoom(targetRoom);
  if (!users.length) {
    pending = null;
    msg.reply("'" + targetRoom + "' 에 기록된 사람이 없습니다.");
    return;
  }
  var owned = admin.listAdminHashes();   // hash → person (한 번에 조회)

  pending = { stage: "user", hash: String(msg.hash), room: String(msg.room),
              targetRoom: targetRoom, users: users, ts: nowMs() };

  var lines = ["[관리자 등록] " + targetRoom + " — 누구를 등록할까요?"];
  for (var i = 0; i < users.length; i++) {
    var who = owned[String(users[i].hash)];
    lines.push((i + 1) + ". " + String(users[i].name) + (who ? "  (이미 " + who + ")" : ""));
  }
  lines.push("");
  lines.push("번호를 입력하세요. 여러 명은 공백/쉼표로 구분 (예: 1 3 5). (취소: !관리자취소)");
  msg.reply(lines.join("\n"));
}

function applyUserSelection(msg, text) {
  var users = pending.users, targetRoom = pending.targetRoom;
  var sel = parseSelection(text, users.length);

  if (!sel.indices.length) {
    msg.reply("번호를 알아볼 수 없습니다" + (sel.bad.length ? " (" + sel.bad.join(", ") + ")" : "") +
              ".\n1~" + users.length + " 사이 번호를 입력하세요. (취소: !관리자취소)");
    return;                                  // 대기 상태는 유지 — 다시 입력할 수 있게
  }
  pending = null;

  var ok = [], failed = [];
  for (var i = 0; i < sel.indices.length; i++) {
    var u = users[sel.indices[i]];
    var person = String(u.name);
    var res = admin.grant(person, admin.LEVEL_ADMIN,
                          [{ hash: u.hash, name: u.name, room: u.room }], msg.hash);
    if (res && res.error) failed.push(person + " — " + res.error);
    else ok.push(person);
  }

  var lines = ["[관리자 등록] " + targetRoom];
  if (ok.length) lines.push("일반관리자로 등록: " + ok.join(", "));
  if (failed.length) {
    lines.push("");
    lines.push("실패:");
    for (var f = 0; f < failed.length; f++) lines.push("  " + failed[f]);
  }
  if (sel.bad.length) lines.push("무시된 입력: " + sel.bad.join(", "));
  msg.reply(lines.join("\n"));
}

function handleSelection(msg, text) {
  if (pending.stage === "room") {
    var sel = parseSelection(text, pending.rooms.length);
    if (sel.indices.length !== 1) {
      msg.reply("방은 하나만 고를 수 있습니다. 번호 하나를 입력하세요. (취소: !관리자취소)");
      return;
    }
    showUserSelection(msg, pending.rooms[sel.indices[0]].room);
    return;
  }
  applyUserSelection(msg, text);
}

function handleCancel(msg) {
  if (pendingMatches(msg)) { pending = null; msg.reply("[관리자 등록] 취소했습니다."); }
  else msg.reply("취소할 작업이 없습니다.");
}

// 관리 명령 공통 가드: 관리 전용 방 + 슈퍼관리자
function guardManage(msg, what) {
  if (!admin.isAdminRoom(msg.room)) {
    msg.reply(what + "은(는) '" + admin.adminRoomsLabel() + "' 방에서만 할 수 있습니다.");
    return false;
  }
  if (!admin.isSuper(msg.hash)) {
    msg.reply("슈퍼관리자만 " + what + "을(를) 할 수 있습니다.");
    return false;
  }
  return true;
}

function handleAdd(msg, arg) {
  if (!guardManage(msg, "관리자 등록")) return;
  if (trim(arg)) {
    msg.reply("사용법: !관리자추가\n인자 없이 입력하면 방 목록이 나옵니다.");
    return;
  }
  startRoomSelection(msg);
}

// =====================================================================
// !관리자삭제 [사람] [확인]
// =====================================================================

function handleRemove(msg, arg) {
  if (!guardManage(msg, "관리자 회수")) return;

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
  if (text === "!관리자취소")  { handleCancel(msg); return; }
  if (text === "!관리자")      { handleList(msg); return; }
  if (text.indexOf("!관리자추가") === 0) { handleAdd(msg, text.substring("!관리자추가".length)); return; }
  if (text.indexOf("!관리자삭제") === 0) { handleRemove(msg, text.substring("!관리자삭제".length)); return; }
  if (isSelectionInput(text) && pendingMatches(msg)) { handleSelection(msg, text); return; }
}

function isMyCommand(text, msg) {
  var t = trim(text);
  if (!t) return false;
  if (t.indexOf("]") === 0 || t.indexOf("!관리자") === 0) return true;
  // 번호 선택 대기 중일 때만 숫자 입력을 가로챈다 (같은 사람·같은 방)
  return isSelectionInput(t) && pendingMatches(msg);
}

// ─── 메시지 큐 + 워커 스레드 (ChatManager 구독, 공용 subscriber 모듈) ───
var subscribe = require(libPath("subscriber.js"));

subscribe(BOT_NAME, WORKER_NAME, function (msg) {
  if (!isMyCommand(msg.content, msg)) return;
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
