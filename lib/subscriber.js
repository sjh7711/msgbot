// =====================================================================
// subscriber.js — ChatManager broadcast 큐 구독 공용 모듈
//
// 목적: 모든 구독형 봇이 중복으로 들고 있던 ~120줄 보일러플레이트
//   (killOldThreads + System.getProperties() 레지스트리 등록 + 워커
//    take()-루프) 을 한 곳으로 추출한다.
//
// 사용:
//   var subscribe = require(<경로>/subscriber.js);
//   subscribe("eval", "EVAL_BOT_WORKER", function(msg) { ... });
//
// onMessage(msg) 로 전달되는 msg 객체:
//   { content, text, room, name, author:{name,hash}, hash, channelId, reply(s) }
//   (eval.js 의 기존 task 필드 추출을 그대로 미러링: text/room/name/hash.
//    channelId 는 cm.js broadcast 가 함께 넣어주므로 방어적으로 노출.)
//
// RhinoJS-safe: var / function 만 사용. ?. , ?? , 템플릿리터럴, arrow 미사용.
// =====================================================================

// 워커 핸들러에서 삼킨 예외를 파일로 남긴다 — "동작(예: DB 쓰기)은 되는데 reply 가 안 나오는"
// 스코프/런타임 버그 진단용. /sdcard/msgbot/subscriber_error.log 에 한 줄씩, 256KB 하드 캡.
// (예외 자체는 계속 삼켜서 워커 루프를 죽이지 않되, 흔적만 남긴다.) RhinoJS-safe: var/function 만.
function _logErr(botName, workerName, where, e) {
  try {
    var logPath = Packages.android.os.Environment.getExternalStorageDirectory()
        .getAbsolutePath() + "/msgbot/subscriber_error.log";
    var lf = new java.io.File(logPath);
    if (lf.exists() && lf.length() > 262144) {
      try { new java.io.FileWriter(logPath, false).close(); } catch(_) {}
    }
    var detail = String(e);
    try { if (e && e.stack) detail += " | stack: " + String(e.stack).replace(/\n/g, " / "); } catch(_) {}
    try {
      if (e && (e.fileName != null || e.lineNumber != null))
        detail += " @" + String(e.fileName) + ":" + String(e.lineNumber);
    } catch(_) {}
    var fw = new java.io.FileWriter(logPath, true);
    fw.write(new java.util.Date().toString() + " [" + String(botName) + "/" + String(workerName)
        + "] " + where + ": " + detail + "\n");
    fw.close();
  } catch(_) {}
}

module.exports = function subscribe(botName, workerName, onMessage) {
  var bot = BotManager.getCurrentBot();

  // ─── 메시지 큐 ─────────────────────────────────────────────────────
  var msgQueue = new java.util.concurrent.LinkedBlockingQueue();

  // ─── 같은 이름의 옛 워커 스레드 정리 ───────────────────────────────
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
        if (String(t.getName() || "") === workerName) {
          try { t.interrupt(); } catch(_) {}
        }
      }
    } catch(_) {}
  })();

  // ─── ChatManager 레지스트리에 큐 등록 ──────────────────────────────
  //   (eval.js 의 키/등록 로직을 그대로 복제: System.getProperties() 에
  //    "__CHATMANAGER_REGISTRY__" 키로 ConcurrentHashMap 을 두고 봇이름→큐)
  (function registerWithChatManager() {
    try {
      var sysProps = java.lang.System.getProperties();
      var REG_KEY = "__CHATMANAGER_REGISTRY__";
      var registry = sysProps.get(REG_KEY);
      if (registry == null) {
        registry = new java.util.concurrent.ConcurrentHashMap();
        sysProps.put(REG_KEY, registry);
      }
      registry.put(botName, msgQueue);
    } catch(_) {}
  })();

  // ─── 워커 스레드: take() 루프 ──────────────────────────────────────
  var _worker = new java.lang.Thread(function() {
    while (!java.lang.Thread.currentThread().isInterrupted()) {
      var task = null;
      try { task = msgQueue.take(); } catch(_) { return; }
      try {
        if (!(task instanceof java.util.HashMap)) continue;
        // eval.js 와 동일한 task 필드 추출
        var text = String(task.get("text") || "");
        var room = String(task.get("room") || "");
        var name = String(task.get("name") || "익명");
        var hash = String(task.get("hash") || "");
        // cm.js broadcast 가 함께 넣는 channelId (방어적으로 노출)
        var channelId = String(task.get("channelId") || "");
        var msg = {
          content: text,
          text: text,
          room: room,
          name: name,
          author: { name: name, hash: hash },
          hash: hash,
          channelId: channelId,
          reply: (function(r){ return function(s){ try { bot.send(r, s); } catch(_) {} }; })(room)
        };
        try { onMessage(msg); } catch(e) { _logErr(botName, workerName, "onMessage", e); }
      } catch(e) { _logErr(botName, workerName, "task", e); }
    }
  }, workerName);

  _worker.start();

  // 스레드 레지스트리 등록 (생성일/추적용; 실패해도 무시). start 후 등록해야 ref 가 alive 상태로 기록됨.
  try {
    var _treg = require(Packages.android.os.Environment.getExternalStorageDirectory()
        .getAbsolutePath() + "/msgbot/lib/thread-registry.js");
    _treg.registerThread(workerName, botName, _worker);
  } catch(_) {}

  return msgQueue;
};
