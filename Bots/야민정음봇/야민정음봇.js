var bot = BotManager.getCurrentBot();

// =====================================================================
// 야민정음봇 — "!야민정음 [텍스트]" 를 야민정음으로 바꿔준다
//
//  야민정음 = 한글 자모를 생김새가 비슷한 것으로 바꿔 적는 인터넷 밈.
//  (디시 야구갤러리 '야갤' + 훈민정음)
//
//  이 봇은 **모양 유사 치환만** 적용한다. 회전(폭풍눈물→롬곡옾눞),
//  압축(돌돔→뚊), 한자 활용은 다루지 않는다.
//
//  변환 방식
//    한 음절을 초성·중성·종성으로 분해하고, 규칙표의 (초성,중성,종성) 패턴과
//    맞으면 짝이 되는 글자로 바꾼다. 규칙마다 "어느 부분을 보고 바꿀지"를
//    플래그로 정해서, 예를 들어 대→머 규칙은 종성을 무시하므로
//    대→머 뿐 아니라 댁→먹 까지 한 규칙으로 처리된다.
//
//    규칙은 **단방향(일반 한국어 → 야민정음)** 이다.
//    처음엔 양방향으로 뒀는데(대↔머), 그러면 ㅁ+ㅓ 가 전부 ㄷ+ㅐ 로 바뀌어
//    "먹고싶다"가 "댁고싶다"가 되는 부작용이 있었다. 멍→댕 처럼 반대 방향이
//    필요한 것만 따로 규칙으로 적는다.
//
//    한 글자당 한 번만 바꾼다(먼저 맞는 규칙이 이김).
//
//  명령: !야민정음 [텍스트] / !야민 [텍스트] / !야민정음(도움말)
//
//  메시지 수신: ChatManager 의 broadcast 큐 구독. ChatManager 가 켜져 있어야 동작.
//
//  RhinoJS-safe: var / function 만.
// =====================================================================

var BOT_NAME = "야민정음봇";
var WORKER_NAME = "YAMIN_BOT_WORKER";

var MAX_INPUT = 500;    // 입력 길이 상한 (카톡 도배 방지)

// 카카오톡 "더보기" 접기용 제로폭 공백
var LONG_MSG_SPACER = new Array(501).join("​");

// ── 한글 분해/조립 ───────────────────────────────────────────────────
var SYL_BASE = 0xAC00, SYL_LAST = 0xD7A3;
var JAMO_FIRST = 0x3131, JAMO_LAST = 0x3163;   // ㄱ~ㅣ 호환 자모

var CHO = ["ㄱ","ㄲ","ㄴ","ㄷ","ㄸ","ㄹ","ㅁ","ㅂ","ㅃ","ㅅ","ㅆ","ㅇ","ㅈ","ㅉ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ"];
var JUNG = ["ㅏ","ㅐ","ㅑ","ㅒ","ㅓ","ㅔ","ㅕ","ㅖ","ㅗ","ㅘ","ㅙ","ㅚ","ㅛ","ㅜ","ㅝ","ㅞ","ㅟ","ㅠ","ㅡ","ㅢ","ㅣ"];
var JONG = ["","ㄱ","ㄲ","ㄳ","ㄴ","ㄵ","ㄶ","ㄷ","ㄹ","ㄺ","ㄻ","ㄼ","ㄽ","ㄾ","ㄿ","ㅀ","ㅁ","ㅂ","ㅄ","ㅅ","ㅆ","ㅇ","ㅈ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ"];

function indexOfIn(arr, v) {
  for (var i = 0; i < arr.length; i++) if (arr[i] === v) return i;
  return -1;
}

// 한 글자 → { cho, jung, jong }. 완성형이 아니면 자모 하나로 취급.
function sep(ch) {
  var c = ch.charCodeAt(0);
  if (c >= SYL_BASE && c <= SYL_LAST) {
    var idx = c - SYL_BASE;
    return {
      cho:  CHO[Math.floor(idx / (21 * 28))],
      jung: JUNG[Math.floor(idx / 28) % 21],
      jong: JONG[idx % 28]
    };
  }
  if (c >= JAMO_FIRST && c <= JAMO_LAST) {
    // 단독 자모: 자음이면 초성 자리, 모음이면 중성 자리로 본다
    if (indexOfIn(JUNG, ch) !== -1) return { cho: "", jung: ch, jong: "" };
    return { cho: ch, jung: "", jong: "" };
  }
  return null;   // 한글 아님
}

// { cho, jung, jong } → 글자. 조합이 불가능하면 붙여서 반환.
function build(cho, jung, jong) {
  if (jung === "" && jong === "") return cho;
  if (cho === "" && jong === "") return jung;
  if (cho === "" && jung === "") return jong;
  var ci = indexOfIn(CHO, cho), ji = indexOfIn(JUNG, jung), ki = indexOfIn(JONG, jong);
  if (ci === -1 || ji === -1 || ki === -1) return cho + jung + jong;
  return String.fromCharCode(SYL_BASE + (ci * 21 + ji) * 28 + ki);
}

// ── 치환 규칙 ────────────────────────────────────────────────────────
//  [초성볼것, 중성볼것, 종성볼것, 글자A, 글자B]
//  플래그가 1인 자리만 비교·교체하고, 0인 자리는 원래 글자 것을 유지한다.
//  예) [1,1,0,"대","머"] → 초성·중성만 보므로 댕→멍, 댁→먹 도 함께 처리.
//  순서가 곧 우선순위다(먼저 맞는 규칙이 이김).
//
//  ⚠ 초성을 보지 않는 [0,1,1] 규칙은 반드시 맨 뒤에 둔다.
//    앞에 두면 초성이 다른 글자까지 삼켜버린다. 예를 들어 [0,1,1,"위","읶"] 이
//    먼저 오면 귀(ㄱ+ㅟ)가 중성·종성만 맞아 긲 이 되어, 정작 널리 쓰이는
//    귀→커 규칙에 닿지 못한다.
//
//  ※ 여기 있는 건 "널리 통용되는" 규칙만이다.
//    모양이 닮았다는 이유로 가능한 치환은 훨씬 많지만(구→ㅋ, 고→끄, 지→거,
//    저→겨, 찌→꺼, 디→ㅁ, 너→ㅂ, 든→ㅌ, 유→윾, 의→익 …), 전부 적용하면
//    문장이 못 읽을 정도로 뭉개진다. 실측 예:
//      "오늘 대구 날씨"      → "오늘 머ㅋ 날씨"   (대구는 머구가 통용형)
//      "이거 완전 명작이다"  → "이지 완견 띵작이다"
//      "비빔면 먹고싶다"     → "네넴띤 댁끄싶다"
//    그래서 읽히는 선에서 잘 알려진 것만 남겼다. 더 필요하면 여기에 추가하면 된다.
var RULES = [
  // 글자 전체가 정확히 맞을 때만 (좁은 규칙이 먼저)
  [1,1,1,"멍","댕"],   // 멍멍이→댕댕이  ※ ㅁㅓ 전체를 ㄷㅐ 로 바꾸면 먹→댁 이 되므로 이 글자만
  [1,1,1,"김","숲"],   // 김치→숲치
  [1,1,1,"장","튽"],   // 사장→사튽
  [1,1,1,"통","듷"],   // 대통령→머듷령

  // 초성+중성을 보고 바꾸는 규칙 (종성은 그대로) — 야민정음의 뼈대
  [1,1,0,"대","머"],   // 대구→머구, 대장→머튽
  [1,1,0,"귀","커"],   // 귀엽다→커엽다, 펭귄→펭컨
  [1,1,0,"비","네"],   // 비빔면→네넴띤 (비→네, 빔→넴)
  [1,1,0,"며","띠"],   // 명작→띵작, 면→띤
  [1,1,0,"파","과"],   // 팔도→괄도

  // 초성 무시 규칙 — 위 규칙들이 다 안 맞았을 때만 적용
  [0,1,1,"왕","앟"]    // 왕→앟
];

// from 패턴에 맞으면 to 로 바꾼 글자를 돌려준다. 안 맞으면 null.
function applyOne(part, useCho, useJung, useJong, from, to) {
  var f = sep(from), t = sep(to);
  if (!f || !t) return null;
  if (useCho  && part.cho  !== f.cho)  return null;
  if (useJung && part.jung !== f.jung) return null;
  if (useJong && part.jong !== f.jong) return null;
  return build(
    useCho  ? t.cho  : part.cho,
    useJung ? t.jung : part.jung,
    useJong ? t.jong : part.jong
  );
}

// 한 글자 변환. 단방향으로만 시도하고, 바뀌면 즉시 확정(재적용 없음).
function convertChar(ch) {
  var part = sep(ch);
  if (!part) return ch;
  for (var i = 0; i < RULES.length; i++) {
    var r = RULES[i];
    var out = applyOne(part, r[0] === 1, r[1] === 1, r[2] === 1, r[3], r[4]);
    if (out !== null && out !== ch) return out;
  }
  return ch;
}

function convert(text) {
  var out = "";
  for (var i = 0; i < text.length; i++) out += convertChar(text.charAt(i));
  return out;
}

// ── 명령 처리 ────────────────────────────────────────────────────────
function trim(s) { return String(s == null ? "" : s).replace(/^\s+|\s+$/g, ""); }

var HELP =
  "[야민정음봇]\n" +
  "글자 모양이 비슷한 한글로 바꿔 드립니다.\n\n" +
  "!야민정음 [텍스트]\n" +
  "!야민 [텍스트]\n\n" +
  "예) !야민정음 멍멍이 귀엽다\n" +
  "→ 댕댕이 커엽다";

function handleMessage(msg) {
  var text = trim(msg.content);
  var arg = null;
  if (text.indexOf("!야민정음") === 0) arg = trim(text.slice("!야민정음".length));
  else if (text.indexOf("!야민") === 0) arg = trim(text.slice("!야민".length));
  else return;

  if (!arg) { msg.reply(HELP); return; }
  if (arg.length > MAX_INPUT) {
    msg.reply("텍스트가 너무 깁니다 (" + arg.length + "자 > " + MAX_INPUT + "자).");
    return;
  }

  var out = convert(arg);
  if (out === arg) {
    msg.reply("바꿀 만한 글자가 없습니다.\n(모양이 닮은 글자가 있어야 바뀝니다)");
    return;
  }
  msg.reply(out.length > 300 ? (out.slice(0, 1) + LONG_MSG_SPACER + "\n" + out.slice(1)) : out);
}

// ─── 프리필터 ───────────────────────────────────────────────────────
function isMyCommand(text) {
  var t = trim(text);
  return !!t && t.indexOf("!야민") === 0;
}

// ─── 메시지 큐 + 워커 스레드 (ChatManager 구독, 공용 subscriber 모듈) ───
var subscribe = (function () {
  var libPath = "/sdcard/msgbot/lib/subscriber.js";
  try {
    if (typeof bot.getRootPath === "function") {
      libPath = bot.getRootPath() + "/../../lib/subscriber.js";
    }
  } catch (_) {}
  return require(libPath);
})();

subscribe(BOT_NAME, WORKER_NAME, function (msg) {
  if (!isMyCommand(msg.content)) return;
  try { handleMessage(msg); }
  catch (e) {
    try { msg.reply("오류: " + ((e && e.message) ? e.message : e)); } catch (_) {}
  }
});

// ─── 보일러플레이트 ─────────────────────────────────────────────────────────
function onMessage(rawMsg) {}   // 메시지는 ChatManager 큐로 들어옴
bot.addListener(Event.MESSAGE, onMessage);

function onCommand(msg) {}
bot.setCommandPrefix("@");
bot.addListener(Event.COMMAND, onCommand);

function onCreate(savedInstanceState, activity) {
  var tv = new Packages.android.widget.TextView(activity);
  tv.setText("야민정음봇");
  tv.setTextColor(Packages.android.graphics.Color.DKGRAY);
  activity.setContentView(tv);
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
