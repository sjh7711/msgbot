const bot = BotManager.getCurrentBot();

// =====================================================================
// eval — "]" 프리픽스로 JS 코드 실행
//
// 메시지 수신: ChatManager 의 broadcast 큐 구독.
//   ChatManager 가 켜져 있어야 동작.
// =====================================================================

const BOT_NAME = "eval";

function isMyCommand(text) {
  return !!text && text.indexOf("]") === 0;
}

function handleMessage(msg) {
  if (msg.content.startsWith("]")) {
    try {
      const result = eval(msg.content.substring(1));
      msg.reply(String(result));
    } catch (e) {
      msg.reply(String(e));
    }
  }
}

// ─── 메시지 큐 + 워커 스레드 (ChatManager 구독) ─────────────────────────────
//   공용 subscriber.js 모듈로 추출. 옛 인라인 보일러플레이트(killOldThreads +
//   레지스트리 등록 + take()-루프)는 subscriber.subscribe() 안으로 이동.
//
// ⚠ require() 경로 미확인: 디바이스측 require() 해석 규칙과 lib 폴더 실제
//   위치는 태블릿에서 검증 필요. bot.getRootPath() 가 있으면 그 기준 상대
//   경로를, 없으면 절대경로로 폴백. 이 봇(eval)은 프로토타입이며, 로딩이
//   확인되기 전까지 나머지 봇은 인라인 보일러플레이트를 유지한다.
var WORKER_NAME = "EVAL_BOT_WORKER";

var subscribe = (function() {
  var libPath = "/sdcard/msgbot/Bots/lib/subscriber.js";
  try {
    if (typeof bot.getRootPath === "function") {
      libPath = bot.getRootPath() + "/../lib/subscriber.js";
    }
  } catch(_) {}
  return require(libPath);
})();

subscribe(BOT_NAME, WORKER_NAME, function(msg) {
  // eval 의 실제 핸들러: text 가 내 커맨드(']'프리픽스)일 때만 처리.
  if (!isMyCommand(msg.content)) return;
  handleMessage(msg);
});


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
