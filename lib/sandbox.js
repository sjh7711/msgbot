// =====================================================================
// sandbox.js — 제한된 JS 실행 (일반관리자용 eval)
//
//  Rhino 의 initSafeStandardObjects() 로 "LiveConnect 가 빠진" 새 스코프를
//  만들어 그 안에서만 코드를 돌린다. 그 스코프에는 java / Packages /
//  importClass / JavaAdapter 가 아예 존재하지 않는다.
//
//  ※ 왜 "위험한 전역을 파라미터로 가리는" 방식이 아닌가
//    ({}).constructor.constructor("return java")() 한 줄이면 호스트 스코프의
//    Function 생성자를 되찾아 가려둔 전역이 그대로 살아난다(실측 확인). 토큰
//    필터링도 ["ja","va"].join("") 로 우회된다. 안전 스코프는 이 우회로 얻는
//    Function 조차 안전 스코프 소속이라 Java 에 닿지 못한다 — 이게 결정적 차이.
//
//  ⚠ 절대 호스트 객체를 스코프에 주입하지 말 것.
//    bot 이나 msg 를 넣어주면 obj.getClass().forName("java.io.File") 로
//    바로 탈출된다. 코드가 만든 "값"만 돌려받아 호출부가 출력한다.
//
//  막지 못하는 것: 무한 루프와 메모리 고갈. Rhino 의 observeInstructionCount
//    는 전역 ContextFactory 를 갈아끼워야 하는데 앱이 이미 등록했고,
//    Android 에는 Thread.stop() 이 없다. 타임아웃은 "호출부에 응답을 돌려주는"
//    용도이고 스레드 자체는 계속 돌 수 있다(봇 재컴파일로 정리).
//
//  사용: var sandbox = require("/sdcard/msgbot/lib/sandbox.js");
//        var r = sandbox.run("1+1");   // { value: "2" } 또는 { error: ... }
//
//  RhinoJS-safe: var / function 만.
// =====================================================================

var _SD = Packages.android.os.Environment.getExternalStorageDirectory().getAbsolutePath();

var DEFAULT_TIMEOUT_MS = 5000;
var THREAD_NAME = "SANDBOX_EVAL";
var MAX_CODE_LEN = 4000;
var MAX_OUTPUT_LEN = 1500;

var _treg = null;
try { _treg = require(_SD + "/msgbot/lib/thread-registry.js"); } catch (_) {}

// 결과 문자열화도 샌드박스 안에서 한다 (호스트가 결과 객체를 만지지 않도록).
var FORMAT_SRC =
  "(function(v){" +
  "if (v === undefined) return 'undefined';" +
  "if (v === null) return 'null';" +
  "if (typeof v === 'function') return '[function]';" +
  "if (typeof v === 'object') { try { return JSON.stringify(v); } catch(e) { return String(v); } }" +
  "return String(v);" +
  "})(__result__)";

// 자가검증: 안전 스코프에서 java 가 진짜로 안 보이는지 확인한다.
// 마지막 항목이 constructor 체인 우회 시도.
var PROBE_SRC =
  "typeof java + '/' + typeof Packages + '/' + " +
  "(function(){ try { return ({}).constructor.constructor('return typeof java')(); } " +
  "catch(e) { return 'blocked'; } })()";

var _capable = null;    // null = 미확인
var _probeOut = "";

function _ctxClass() {
  return Packages.org.mozilla.javascript.Context;
}

// 안전 스코프를 새로 만들어 code 를 평가하고, 결과를 문자열로 돌려준다.
// 스코프는 매 호출 새로 만들므로 이전 실행의 변수/프로토타입 변경이 남지 않는다.
function _evalSafe(code) {
  var C = _ctxClass();
  var cx = C.enter();
  try {
    // sealed=false: 사용자가 var 선언을 할 수 있어야 한다(스코프에 프로퍼티 추가).
    // 스코프가 일회용이라 내장객체를 건드려도 다음 실행에 영향이 없다.
    var scope = cx.initSafeStandardObjects(null, false);
    var result = cx.evaluateString(scope, String(code), "restricted", 1, null);
    scope.put("__result__", scope, result);
    return String(cx.evaluateString(scope, FORMAT_SRC, "format", 1, null));
  } finally {
    try { C.exit(); } catch (_) {}
  }
}

// 이 기기에서 샌드박스가 실제로 동작하는지 (1회 확인 후 캐시)
function available() {
  if (_capable !== null) return _capable;
  try {
    var out = _evalSafe(PROBE_SRC);
    _probeOut = String(out);
    var parts = _probeOut.split("/");
    _capable = (parts.length === 3 &&
                parts[0] === "undefined" &&      // java 없음
                parts[1] === "undefined" &&      // Packages 없음
                (parts[2] === "undefined" || parts[2] === "blocked"));   // 우회로도 못 닿음
  } catch (e) {
    _probeOut = "예외: " + ((e && e.message) ? String(e.message) : String(e));
    _capable = false;
  }
  return _capable;
}

function probeResult() { return _probeOut; }

// 반환: { value: String } 또는 { error: String }
function run(code, timeoutMs) {
  var src = String(code == null ? "" : code).replace(/^\s+|\s+$/g, "");
  if (!src) return { error: "실행할 코드가 없습니다." };
  if (src.length > MAX_CODE_LEN) {
    return { error: "코드가 너무 깁니다 (" + src.length + "자 > " + MAX_CODE_LEN + "자)." };
  }
  if (!available()) {
    return { error: "이 기기에서는 제한 실행을 쓸 수 없습니다. (자가검증: " + _probeOut + ")" };
  }

  var limit = timeoutMs || DEFAULT_TIMEOUT_MS;
  var holder = { done: false, value: null, error: null };

  var t = new java.lang.Thread(new java.lang.Runnable({
    run: function () {
      try { holder.value = _evalSafe(src); }
      catch (e) { holder.error = (e && e.message) ? String(e.message) : String(e); }
      holder.done = true;
    }
  }));
  t.setDaemon(true);
  t.setName(THREAD_NAME);
  t.start();

  try { t.join(limit); } catch (ie) {}

  if (!holder.done) {
    // 죽일 방법이 없다. 최소한 !스레드 목록에 보이게 등록해 둔다.
    try { if (_treg) _treg.registerThread(THREAD_NAME, "eval", t); } catch (_) {}
    return { error: "시간 초과(" + Math.round(limit / 1000) + "초). 무한 루프로 보입니다. " +
                    "해당 스레드는 계속 돌 수 있으니 !스레드 로 확인하고, 남아 있으면 eval 봇을 재컴파일하세요." };
  }
  if (holder.error !== null) return { error: holder.error };

  var v = String(holder.value);
  if (v.length > MAX_OUTPUT_LEN) v = v.substring(0, MAX_OUTPUT_LEN) + "… (잘림)";
  return { value: v };
}

module.exports = {
  run: run,
  available: available,
  probeResult: probeResult,
  DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS
};
