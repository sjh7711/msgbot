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
var msgQueue = new java.util.concurrent.LinkedBlockingQueue();
var WORKER_NAME = "EVAL_BOT_WORKER";

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
      var text = String(task.get("text") || "");
      if (!isMyCommand(text)) continue;
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
