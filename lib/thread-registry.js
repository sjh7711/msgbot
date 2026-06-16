// =====================================================================
// thread-registry.js — JVM 전역 스레드/프로세스 레지스트리
//
// 봇들이 띄운 워커 스레드와 su 셸 같은 자식 프로세스를 한 곳에서 추적/정리.
// 저장소는 System.getProperties() 의 ConcurrentHashMap 1개를 모든 봇이 공유
// (__CHATMANAGER_REGISTRY__ 와 동일 패턴). 항목 값은 java.util.HashMap
// (컨텍스트 안전): ref(Thread/Process), kind, name, bot, createdAt(Long).
//
// 사용:
//   var treg = require(<.../lib/thread-registry.js>);
//   treg.registerThread(name, bot, threadObj);   // 워커 등록(생성일 기록)
//   treg.registerProc(name, bot, procObj);        // su 셸 등 프로세스 등록
//   treg.list();          // [{id,name,kind,bot,createdAt,ageMs,alive}]
//   treg.kill(id);        // thread=interrupt, process=destroy
//   treg.enumerateThreads();  // 미등록 포함 JVM 전체 스레드 (passive)
//
// RhinoJS-safe: var / function 만.
// =====================================================================

var _REG_KEY = "__THREAD_REGISTRY__";
var _SEQ_KEY = "__THREAD_REGISTRY_SEQ__";

function _reg() {
  var props = java.lang.System.getProperties();
  var m = props.get(_REG_KEY);
  if (m == null) { m = new java.util.concurrent.ConcurrentHashMap(); props.put(_REG_KEY, m); }
  return m;
}
function _nextId() {
  var props = java.lang.System.getProperties();
  var c = props.get(_SEQ_KEY);
  if (c == null) { c = new java.util.concurrent.atomic.AtomicLong(0); props.put(_SEQ_KEY, c); }
  return String(c.incrementAndGet());
}
function _isAlive(ref) {
  try { return ref != null && ref.isAlive(); } catch(_) { return false; }
}

// 같은 (name,bot,kind) 의 기존 항목 제거 (replace 용)
function _removeMatching(name, bot, kind) {
  var m = _reg(); var it = m.entrySet().iterator();
  while (it.hasNext()) {
    var e = it.next(); var v = e.getValue();
    try {
      if (String(v.get("name")) === String(name) &&
          String(v.get("bot")) === String(bot) &&
          String(v.get("kind")) === String(kind)) {
        it.remove();
      }
    } catch(_) {}
  }
}

// ref 등록. replace=true 면 같은 (name,bot,kind) 기존 항목을 먼저 제거.
function register(name, kind, bot, ref, replace) {
  if (ref == null) return null;
  if (replace) { try { _removeMatching(name, bot, kind); } catch(_) {} }
  var id = _nextId();
  var entry = new java.util.HashMap();
  entry.put("ref", ref);
  entry.put("kind", String(kind || "thread"));
  entry.put("name", String(name || "?"));
  entry.put("bot", String(bot || "?"));
  entry.put("createdAt", java.lang.Long.valueOf(String(Date.now())));
  _reg().put(id, entry);
  return id;
}
function registerThread(name, bot, thread) { return register(name, "thread", bot, thread, true); }
function registerProc(name, bot, proc) { return register(name, "process", bot, proc, true); }

// 스레드 생성 + 등록 + start 편의
function spawnThread(name, bot, fn) {
  var t = new java.lang.Thread(fn, name);
  register(name, "thread", bot, t, true);
  t.start();
  return t;
}

// 죽은 항목 제거 → 제거 수 반환
function sweep() {
  var removed = 0; var m = _reg(); var it = m.entrySet().iterator();
  while (it.hasNext()) {
    var e = it.next(); var ref = null;
    try { ref = e.getValue().get("ref"); } catch(_) {}
    if (!_isAlive(ref)) { try { it.remove(); removed++; } catch(_) {} }
  }
  return removed;
}

// 목록 (기본적으로 먼저 sweep). createdAt 오름차순.
function list(noSweep) {
  if (!noSweep) { try { sweep(); } catch(_) {} }
  var out = []; var now = Date.now(); var m = _reg(); var it = m.entrySet().iterator();
  while (it.hasNext()) {
    var e = it.next(); var v = e.getValue();
    try {
      var ref = v.get("ref");
      var ca = v.get("createdAt"); ca = (ca != null) ? ca.longValue() : 0;
      out.push({
        id: String(e.getKey()),
        name: String(v.get("name")),
        kind: String(v.get("kind")),
        bot: String(v.get("bot")),
        createdAt: ca,
        ageMs: ca ? (now - ca) : 0,
        alive: _isAlive(ref)
      });
    } catch(_) {}
  }
  out.sort(function(a, b) { return a.createdAt - b.createdAt; });
  return out;
}

// id 로 종료: thread=interrupt, process=destroy. {ok,name,kind}
function kill(id) {
  var m = _reg(); var v = m.get(String(id));
  if (v == null) return { ok: false, error: "not found" };
  var kind = String(v.get("kind")); var name = String(v.get("name"));
  var ref = v.get("ref"); var ok = false;
  try {
    if (kind === "process") { ref.destroy(); ok = true; }
    else { ref.interrupt(); ok = true; }
  } catch(_) { ok = false; }
  try { m.remove(String(id)); } catch(_) {}
  return { ok: ok, name: name, kind: kind };
}
function killByName(name) {
  var killed = []; var rows = list(true);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].name === String(name)) { var r = kill(rows[i].id); if (r.ok) killed.push(rows[i].id); }
  }
  return killed;
}

// passive: JVM 전체 스레드 열거 → [{name, alive, registered}]
function enumerateThreads() {
  var out = []; var regNames = {};
  try {
    var rows = list(true);
    for (var i = 0; i < rows.length; i++) if (rows[i].kind === "thread") regNames[rows[i].name] = true;
  } catch(_) {}
  try {
    var root = java.lang.Thread.currentThread().getThreadGroup();
    while (root.getParent() != null) root = root.getParent();
    var n = root.activeCount() + 64;
    var arr = java.lang.reflect.Array.newInstance(java.lang.Thread, n);
    var got = root.enumerate(arr, true);
    for (var i = 0; i < got; i++) {
      var t = arr[i]; if (!t) continue;
      var nm = String(t.getName() || "?");
      out.push({ name: nm, alive: t.isAlive(), registered: !!regNames[nm] });
    }
  } catch(_) {}
  return out;
}

module.exports = {
  register: register,
  registerThread: registerThread,
  registerProc: registerProc,
  spawnThread: spawnThread,
  sweep: sweep,
  list: list,
  kill: kill,
  killByName: killByName,
  enumerateThreads: enumerateThreads
};
