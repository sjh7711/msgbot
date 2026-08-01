const bot = BotManager.getCurrentBot();

// =====================================================================
// qwen봇 — 내부망 Qwen(llama.cpp) 기반 간단 질의응답
//
// 명령어:
//   !qwen [질문]
//       : 질문을 내부망 Qwen 서버에 보내고 답변을 받아 그대로 반환.
//       : 질문 길이 제한 없음. 사용 한도 없음.
//
// API:
//   base URL : http://192.168.0.55:18080/v1  (내부망 HTTP, TLS 없음)
//   model    : qwen3.5-9b-q4_k_m
//   API key  : /sdcard/msgbot/qwen_key 파일에서 읽어 Bearer 로 사용.
//              (Git/채팅/로그에 노출하지 않음. 파일 내용만 읽는다.)
//
// 메시지 수신:
//   ChatManager 봇이 KakaoTalk DB를 폴링/복호화해서 큐로 broadcast.
//   이 봇은 자기 LinkedBlockingQueue 만 구독. → ChatManager 가 켜져 있어야 메시지를 받음.
//
// RhinoJS-safe: var / function 만 사용.
// =====================================================================

const BOT_NAME = "qwen봇";   // ChatManager broadcast 레지스트리 등록 키 — 폴더명과 같아야 한다

// ── 설정 ─────────────────────────────────────────────────────────────
const QWEN_BASE_URL = "http://192.168.0.55:18080/v1";
const QWEN_MODEL    = "qwen3.5-9b-q4_k_m";
const QWEN_KEY_PATH = Packages.android.os.Environment
    .getExternalStorageDirectory().getAbsolutePath() + "/msgbot/qwen_key";

const SYSTEM_PROMPT = "한국어로 정확하고 간결하게 답하세요. /no_think";

// ── API 키 읽기 (파일 내용, 앞뒤 공백/개행 제거) ──────────────────────
function readApiKey() {
  try {
    var f = new java.io.File(QWEN_KEY_PATH);
    if (!f.exists()) return null;
    var reader = new java.io.BufferedReader(
        new java.io.InputStreamReader(new java.io.FileInputStream(f), "UTF-8"));
    var sb = new java.lang.StringBuilder(); var line;
    while ((line = reader.readLine()) !== null) sb.append(line);
    reader.close();
    var key = String(sb.toString()).replace(/[\r\n\s]/g, "");
    return key.length ? key : null;
  } catch(e) { return null; }
}

// ── Qwen 호출 (OpenAI 호환 /chat/completions) ─────────────────────────
// 반환: { text } 또는 { error }
function callQwen(question) {
  var key = readApiKey();
  if (!key) return { error: "API 키 파일을 읽을 수 없습니다(" + QWEN_KEY_PATH + ")." };

  var conn = null;
  try {
    var url = new java.net.URL(QWEN_BASE_URL + "/chat/completions");
    conn = url.openConnection();
    conn.setRequestMethod("POST");
    conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
    conn.setRequestProperty("Authorization", "Bearer " + key);
    conn.setDoOutput(true);
    conn.setConnectTimeout(15000);
    conn.setReadTimeout(180000);   // 내부망 생성 속도가 느려(≈2.4 tok/s) 넉넉히.

    var body = JSON.stringify({
      model: QWEN_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: question }
      ],
      max_tokens: 512,
      stream: false,
      chat_template_kwargs: { enable_thinking: false }
    });
    // 반드시 UTF-8 로 바디를 써야 한글이 깨지지 않는다(서버가 ill-formed UTF-8 로 500 반환).
    var writer = new java.io.OutputStreamWriter(conn.getOutputStream(), "UTF-8");
    writer.write(body); writer.flush(); writer.close();

    var code = conn.getResponseCode();
    var stream = (code >= 200 && code < 300) ? conn.getInputStream() : conn.getErrorStream();
    var raw = "";
    if (stream) {
      var reader = new java.io.BufferedReader(new java.io.InputStreamReader(stream, "UTF-8"));
      var rb = new java.lang.StringBuilder(); var rl;
      while ((rl = reader.readLine()) !== null) rb.append(rl);
      reader.close();
      raw = String(rb.toString());
    }

    if (code < 200 || code >= 300) {
      if (code === 401) return { error: "인증 실패(401): API 키가 틀립니다." };
      return { error: "HTTP " + code + ": " + raw.slice(0, 200) };
    }

    var resp;
    try { resp = JSON.parse(raw); }
    catch(pe) { return { error: "응답 JSON 파싱 실패: " + raw.slice(0, 120) }; }

    if (!resp.choices || !resp.choices[0] || !resp.choices[0].message) {
      return { error: "응답에 choices 가 없습니다." };
    }
    var out = String(resp.choices[0].message.content || "").trim();
    if (!out) return { error: "빈 응답입니다." };
    return { text: out };
  } catch(e) {
    return { error: (e && e.message) ? e.message : String(e) };
  } finally {
    try { if (conn) conn.disconnect(); } catch(_) {}
  }
}

// ── 메시지 처리 ──────────────────────────────────────────────────────
function handleMessage(msg) {
  try {
    var text = String(msg.content || "").trim();
    if (text.indexOf("!qwen") !== 0) return;

    var question = text.slice("!qwen".length).trim();
    if (!question) {
      msg.reply("사용법: !qwen [질문]\n예) !qwen 광합성이 뭐야?");
      return;
    }

    var room = msg.room;
    // 네트워크 호출은 워커 큐를 막지 않도록 별도 스레드에서 처리하고, 끝나면 직접 send.
    new java.lang.Thread(function() {
      var res = callQwen(question);
      if (res && typeof res.text === "string" && res.text) {
        try { bot.send(room, res.text); } catch(_) {}
      } else {
        try { bot.send(room, "⚠ 답변 생성 실패: " + ((res && res.error) ? res.error : "알 수 없음")); } catch(_) {}
      }
    }).start();
  } catch(e) {
    try { msg.reply("오류: " + (e && e.message ? e.message : e)); } catch(_) {}
  }
}

// ── 메시지 큐 + 워커 스레드 (공유 subscriber 모듈로 위임) ──────────────
// 큐에는 ChatManager broadcast 메시지(java.util.HashMap)만 들어온다.
var WORKER_NAME = "QWEN_BOT_WORKER";

var subscribe = (function() {
  var libPath = "/sdcard/msgbot/lib/subscriber.js";
  try {
    if (typeof bot.getRootPath === "function") {
      libPath = bot.getRootPath() + "/../../lib/subscriber.js";
    }
  } catch(_) {}
  return require(libPath);
})();

subscribe(BOT_NAME, WORKER_NAME, function(msg) {
  try {
    var text = String(msg.content || "").trim();
    if (text.indexOf("!qwen") !== 0) return;   // 우리 명령이 아니면 무시 (모든 메시지가 broadcast 됨)
    handleMessage(msg);
  } catch(_) {}
});

// ── 보일러플레이트 ───────────────────────────────────────────────────
// 메시지는 ChatManager 큐로 들어오므로 onMessage 는 no-op.
function onMessage(rawMsg) {}
bot.addListener(Event.MESSAGE, onMessage);

function onCommand(msg) {}
bot.setCommandPrefix("@");
bot.addListener(Event.COMMAND, onCommand);

function onCreate(savedInstanceState, activity) {
  var tv = new Packages.android.widget.TextView(activity);
  tv.setText("qwen봇");
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
