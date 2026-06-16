// =====================================================================
// su-shell.js — JVM 공유 su 셸 1개 (System.getProperties) + 레지스트리 등록
//
// 기존엔 ChatManager 와 kakao-decrypt 가 각자 영구 su 셸을 들고 있어,
// 봇 재컴파일마다 새 셸이 생기고 옛 셸 프로세스가 고아로 남았다.
// 이 모듈은 JVM 전역에 su 셸 1개만 두고 모든 봇이 공유·재사용한다.
//   - 홀더(java.util.HashMap{proc,stdin,stdout})와 ReentrantLock 을
//     System.getProperties() 에 저장 → 봇 컨텍스트가 달라도 같은 셸 사용.
//   - 열릴 때 thread-registry 에 process 로 등록(추적/kill 가능).
//
// 사용: var su = require(<.../lib/su-shell.js>); var out = su.exec("whoami");
//
// RhinoJS-safe: var / function 만.
// =====================================================================

var _SHELL_KEY = "__SU_SHELL__";        // java.util.HashMap { proc, stdin, stdout }
var _LOCK_KEY  = "__SU_SHELL_LOCK__";   // ReentrantLock

var _treg = null;
try { _treg = require(Packages.android.os.Environment.getExternalStorageDirectory().getAbsolutePath() + "/msgbot/lib/thread-registry.js"); } catch(_) {}

function _lock() {
  var props = java.lang.System.getProperties();
  var l = props.get(_LOCK_KEY);
  if (l == null) { l = new java.util.concurrent.locks.ReentrantLock(); props.put(_LOCK_KEY, l); }
  return l;
}
function _holder() { return java.lang.System.getProperties().get(_SHELL_KEY); }
function _setHolder(h) {
  var props = java.lang.System.getProperties();
  if (h == null) props.remove(_SHELL_KEY); else props.put(_SHELL_KEY, h);
}
function _alive(h) {
  try { return h != null && h.get("proc").isAlive(); } catch(_) { return false; }
}

function _open() {
  var list = new java.util.ArrayList(); list.add("su");
  var pb = new java.lang.ProcessBuilder(list); pb.redirectErrorStream(true);
  var proc = pb.start();
  var h = new java.util.HashMap();
  h.put("proc", proc);
  var stdin = new java.io.BufferedWriter(new java.io.OutputStreamWriter(proc.getOutputStream(), "UTF-8"));
  var stdout = new java.io.BufferedReader(new java.io.InputStreamReader(proc.getInputStream(), "UTF-8"));
  h.put("stdin", stdin);
  h.put("stdout", stdout);
  var ready = "__SUREADY_" + Math.floor(Math.random() * 0x7FFFFFFF) + "__";
  stdin.write("export PS1='' PS2=''\n");
  stdin.write("echo " + ready + "\n");
  stdin.flush();
  var line;
  while ((line = stdout.readLine()) !== null) { if (String(line).indexOf(ready) !== -1) break; }
  _setHolder(h);
  try { _treg.registerProc("su-shell", "shared", proc); } catch(_) {}
  return h;
}

// 한 명령을 공유 셸에 보내고 sentinel 까지의 출력을 모아 반환.
function exec(command) {
  var lock = _lock(); lock.lock();
  try {
    var h = _holder();
    if (!_alive(h)) h = _open();
    if (!_alive(h)) return "ERR: su shell open 실패";
    var stdin = h.get("stdin"); var stdout = h.get("stdout");
    var sentinel = "__SUEND_" + Math.floor(Math.random() * 0x7FFFFFFF) + "_" + Date.now() + "__";
    try {
      stdin.write(command + "\n");
      stdin.write("echo " + sentinel + "\n");
      stdin.flush();
      var sb = new java.lang.StringBuilder(); var line;
      while ((line = stdout.readLine()) !== null) {
        var s = String(line);
        if (s.indexOf(sentinel) !== -1) break;
        sb.append(s).append("\n");
      }
      return String(sb.toString());
    } catch(e) {
      try { h.get("proc").destroy(); } catch(_) {}
      _setHolder(null);
      try { _treg.killByName("su-shell"); } catch(_) {}
      return "ERR: " + (e && e.message ? e.message : e);
    }
  } finally { lock.unlock(); }
}

function isOpen() { return _alive(_holder()); }

function close() {
  var lock = _lock(); lock.lock();
  try {
    var h = _holder();
    if (h != null) { try { h.get("proc").destroy(); } catch(_) {} }
    _setHolder(null);
    try { _treg.killByName("su-shell"); } catch(_) {}
  } finally { lock.unlock(); }
}

module.exports = { exec: exec, isOpen: isOpen, close: close };
