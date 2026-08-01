// =====================================================================
// qwen.js — 내부망 Qwen(llama.cpp, OpenAI 호환) 클라이언트
//
//   구 qwen봇(test봇)에서 옮겨온 모듈. 제미니봇이 두 가지로 쓴다.
//     ① "!qwen [질문]" 직접 호출
//     ② 제미니 한도 소진 시 서브 API 로 폴백
//
//   ⚠ 느리다. 내부망 생성 속도가 ≈2.4 tok/s 라 512 토큰이면 수 분이 걸린다.
//     그래서 readTimeout 을 크게 잡고, 호출부는 반드시 별도 스레드에서 부른다.
//     대화요약처럼 긴 출력이 필요한 기능에는 폴백을 걸지 않는다.
//
//   API 키는 /sdcard/msgbot/qwen_key 파일에서 읽는다(레포·채팅·로그에 노출 안 함).
//
//   사용: var qwen = require(".../Bots/제미니봇/qwen.js");
//         var r = qwen.ask("광합성이 뭐야?");   // { text } 또는 { error }
//
//   RhinoJS-safe: var / function 만.
// =====================================================================

var BASE_URL = "http://192.168.0.55:18080/v1";
var MODEL    = "qwen3.5-9b-q4_k_m";
var KEY_PATH = Packages.android.os.Environment
    .getExternalStorageDirectory().getAbsolutePath() + "/msgbot/qwen_key";

var SYSTEM_PROMPT = "한국어로 정확하고 간결하게 답하세요. /no_think";
var MAX_TOKENS    = 512;
var CONNECT_TIMEOUT = 15000;
var READ_TIMEOUT    = 180000;   // 생성이 느려 넉넉히

// ── API 키 읽기 (파일 내용, 앞뒤 공백/개행 제거) ──────────────────────
function readApiKey() {
  var reader = null;
  try {
    var f = new java.io.File(KEY_PATH);
    if (!f.exists()) return null;
    reader = new java.io.BufferedReader(
        new java.io.InputStreamReader(new java.io.FileInputStream(f), "UTF-8"));
    var sb = new java.lang.StringBuilder(); var line;
    while ((line = reader.readLine()) !== null) sb.append(line);
    var key = String(sb.toString()).replace(/[\r\n\s]/g, "");
    return key.length ? key : null;
  } catch(e) {
    return null;
  } finally {
    if (reader) try { reader.close(); } catch(_) {}
  }
}

function isConfigured() { return readApiKey() !== null; }

// ── Qwen 호출 (OpenAI 호환 /chat/completions) ─────────────────────────
// 반환: { text } 또는 { error }
function ask(question) {
  var q = String(question == null ? "" : question).replace(/^\s+|\s+$/g, "");
  if (!q) return { error: "질문이 비어 있습니다." };

  var key = readApiKey();
  if (!key) return { error: "Qwen API 키 파일을 읽을 수 없습니다(" + KEY_PATH + ")." };

  var conn = null;
  try {
    var url = new java.net.URL(BASE_URL + "/chat/completions");
    conn = url.openConnection();
    conn.setRequestMethod("POST");
    conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
    conn.setRequestProperty("Authorization", "Bearer " + key);
    conn.setDoOutput(true);
    conn.setConnectTimeout(CONNECT_TIMEOUT);
    conn.setReadTimeout(READ_TIMEOUT);

    var body = JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: q }
      ],
      max_tokens: MAX_TOKENS,
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
      if (code === 401) return { error: "Qwen 인증 실패(401): API 키가 틀립니다." };
      return { error: "Qwen HTTP " + code + ": " + raw.slice(0, 200) };
    }

    var resp;
    try { resp = JSON.parse(raw); }
    catch(pe) { return { error: "Qwen 응답 JSON 파싱 실패: " + raw.slice(0, 120) }; }

    if (!resp.choices || !resp.choices[0] || !resp.choices[0].message) {
      return { error: "Qwen 응답에 choices 가 없습니다." };
    }
    var out = String(resp.choices[0].message.content || "").replace(/^\s+|\s+$/g, "");
    if (!out) return { error: "Qwen 이 빈 응답을 돌려줬습니다." };
    return { text: out };
  } catch(e) {
    return { error: "Qwen 연결 실패: " + ((e && e.message) ? e.message : String(e)) };
  } finally {
    try { if (conn) conn.disconnect(); } catch(_) {}
  }
}

module.exports = {
  ask: ask,
  isConfigured: isConfigured,
  MODEL: MODEL,
  BASE_URL: BASE_URL
};
