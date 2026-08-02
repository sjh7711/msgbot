// =====================================================================
// ask.js — 내부망 통합 질의 API(/v1/ask) 클라이언트
//
//   "!qwen [무엇이든]" 의 기본 경로. 어떤 처리를 할지는 서버가 고른다:
//     · 질문에 URL 이 있으면          → URL 요약   (route=url_summary)
//     · 최신 정보/명시적 검색 요청이면 → 웹 검색    (route=web_search)
//     · 그 외                         → 일반 답변  (route=chat)
//   일반 답변 도중 모델이 근거가 필요하다고 하면 서버가 검색을 한 번 더 돈다.
//   덕분에 클라이언트에서 URL 정규식으로 갈래를 나눌 필요가 없다.
//
//   ⚠ mode=auto 이므로 질문이 외부 검색엔진(SearXNG 경유)으로 나갈 수 있다.
//     API 키·개인정보는 !qwen 에 넣지 않는다. (문서: "안전 경계" 절)
//
//   API (POST http://192.168.0.55:18082/v1/ask)
//     요청 : { query, mode, summary_style, language, max_results }
//     응답 : { request_id, requested_mode, route, route_reason, answer,
//              sources, searched, fallback_used, partial, summary_style,
//              language, model, usage, elapsed_ms,
//              chunks/truncated(url), search(web_search) }
//     오류 : HTTP 4xx/5xx + { detail } (문자열 또는 FastAPI 검증 배열)
//
//   한도(같은 IP·키 기준, 15분): 일반·URL 합쳐 10회, 검색 5회.
//   일반 답변이 자동 검색으로 넘어가면 양쪽을 각각 1회씩 쓴다.
//   그래서 같은 질문은 아래 캐시로 재요청하지 않는다.
//
//   실측(2026-08-02): chat 51초 / url_summary 7초 / web_search 42초.
//
//   RhinoJS-safe: var / function 만.
// =====================================================================

var BASE_URL = "http://192.168.0.55:18082/v1/ask";
var KEY_PATH = Packages.android.os.Environment
    .getExternalStorageDirectory().getAbsolutePath() + "/msgbot/qwen_key";

var CONNECT_TIMEOUT = 15000;
// 최악: 일반 답변(180초) 뒤 자동 검색(수집 75초 + LLM 180초). 넉넉히 잡는다.
var READ_TIMEOUT = 300000;

var MODE = "auto";          // 서버가 chat/url/search 를 고르게 한다
// summary_style 은 "brief" 아니면 "detailed" 둘뿐이다(서버 검증 응답으로 확인).
// 같은 문서 실측(llama.cpp README, 1 chunk): brief 17.6초/710자,
// detailed 44.4초/2,100자. 카톡은 마크다운을 렌더링하지 않아 detailed 의
// 굵은 제목·중첩 목록이 날것으로 보이고 미리보기도 넘긴다 → brief.
var SUMMARY_STYLE = "brief";
var MAX_RESULTS = 3;        // 검색 시 수집 문서 수 (서버 최대 5)
var LANGUAGE = "ko";

// 카톡 메시지에 섞여 들어오는 URL 을 집는다.
//  라우팅은 서버가 하므로, 이건 "요약하는 중" 안내 문구를 고르는 용도로만 쓴다.
var URL_RE     = /https?:\/\/[^\s<>"']+/i;
var URL_WWW_RE = /(^|\s)(www\.[^\s<>"']+)/i;

// 끝에 붙기 쉬운 문장부호 제거 ("...html." / "...html)" 등)
function trimUrlTail(u) {
  return String(u).replace(/[)\]}>.,;:!?'"]+$/, "");
}

// 텍스트에서 첫 URL 을 뽑는다. 없으면 null.
function extractUrl(text) {
  var s = String(text == null ? "" : text);
  var m = URL_RE.exec(s);
  if (m) return trimUrlTail(m[0]);
  var w = URL_WWW_RE.exec(s);
  if (w) return "https://" + trimUrlTail(w[2]);
  return null;
}

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
  } catch (e) {
    return null;
  } finally {
    if (reader) try { reader.close(); } catch (_) {}
  }
}

// detail 은 문자열이거나 FastAPI 검증 오류 배열이다. 사람이 읽을 한 줄로.
function detailToText(detail) {
  if (detail == null) return "";
  if (typeof detail === "string") return detail;
  try {
    if (detail.length) {
      var parts = [];
      for (var i = 0; i < detail.length && i < 3; i++) {
        var d = detail[i];
        var where = (d.loc && d.loc.length) ? d.loc[d.loc.length - 1] : "";
        parts.push((where ? where + ": " : "") + (d.msg || ""));
      }
      return parts.join(", ");
    }
  } catch (_) {}
  return String(detail);
}

// 출처 배열을 [{ id, title, url }] 로 정규화. id 는 답변의 [S1] 인용과 짝이 된다.
// 서버 실제 필드(2026-08-02 확인): source_id, title, requested_url, final_url,
// fetched_at, content_type, bytes, sha256, redirects, page_count, truncated.
function normSources(arr) {
  var out = [];
  if (!arr) return out;
  try {
    for (var i = 0; i < arr.length && i < 5; i++) {
      var s = arr[i] || {};
      var u = String(s.final_url || s.requested_url || s.url || "");
      var t = String(s.title || "");
      if (!u && !t) continue;
      out.push({ id: String(s.source_id || s.id || ("S" + (i + 1))), title: t, url: u });
    }
  } catch (_) {}
  return out;
}

// ── 결과 캐시 ────────────────────────────────────────────────────────
//  15분 한도가 빡빡해서(일반·URL 10회 / 검색 5회) 단톡방에서 같은 질문이
//  반복되면 금방 막힌다. 질문 원문이 같으면 재요청하지 않는다.
var CACHE_TTL_MS = 3600000;   // 1시간
var CACHE_MAX = 30;
var _cache = {};
var _cacheKeys = [];

function cacheGet(k) {
  var e = _cache[k];
  if (!e) return null;
  if (java.lang.System.currentTimeMillis() - e.ts > CACHE_TTL_MS) {
    delete _cache[k];
    return null;
  }
  return e.value;
}

function cachePut(k, v) {
  if (!_cache[k]) {
    _cacheKeys.push(k);
    while (_cacheKeys.length > CACHE_MAX) {
      var old = _cacheKeys.shift();
      delete _cache[old];
    }
  }
  _cache[k] = { ts: java.lang.System.currentTimeMillis(), value: v };
}

function shallowCopy(o) {
  var c = {};
  for (var k in o) if (o.hasOwnProperty(k)) c[k] = o[k];
  return c;
}

// 질문 하나를 서버에 넘기고 결과를 받는다.
//   반환 : { route, routeReason, answer, sources, searched, fallbackUsed,
//            partial, truncated, title, url, elapsedMs, cached? }
//   실패 : { error, connectFailed? }
//          connectFailed 는 서버에 닿지도 못한 경우 — 호출 측에서 18080
//          일반 답변으로 내려갈지 판단하는 데 쓴다.
function ask(query) {
  var q = String(query == null ? "" : query);
  var hit = cacheGet(q);
  if (hit) { var c = shallowCopy(hit); c.cached = true; return c; }

  var key = readApiKey();
  if (!key) return { error: "Qwen API 키 파일을 읽을 수 없습니다(" + KEY_PATH + ")." };

  var conn = null;
  var gotResponse = false;
  try {
    conn = new java.net.URL(BASE_URL).openConnection();
    conn.setRequestMethod("POST");
    conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
    conn.setRequestProperty("Authorization", "Bearer " + key);
    conn.setDoOutput(true);
    conn.setConnectTimeout(CONNECT_TIMEOUT);
    conn.setReadTimeout(READ_TIMEOUT);

    var body = JSON.stringify({
      query: q,
      mode: MODE,
      summary_style: SUMMARY_STYLE,
      language: LANGUAGE,
      max_results: MAX_RESULTS
    });
    var writer = new java.io.OutputStreamWriter(conn.getOutputStream(), "UTF-8");
    writer.write(body); writer.flush(); writer.close();

    var code = conn.getResponseCode();
    gotResponse = true;
    var stream = (code >= 200 && code < 300) ? conn.getInputStream() : conn.getErrorStream();
    var raw = "";
    if (stream) {
      var reader = new java.io.BufferedReader(new java.io.InputStreamReader(stream, "UTF-8"));
      var sb = new java.lang.StringBuilder(); var line;
      while ((line = reader.readLine()) !== null) sb.append(line);
      reader.close();
      raw = String(sb.toString());
    }

    var resp = null;
    try { resp = JSON.parse(raw); } catch (pe) {}

    if (code < 200 || code >= 300) {
      var msg = resp ? detailToText(resp.detail) : raw.slice(0, 160);
      // SearXNG 가 죽으면 검색 경로만 503 이다. 사용자에게 이유를 알려준다.
      if (code === 503 && !msg) msg = "웹 검색을 지금 쓸 수 없습니다(검색 서비스 중단).";
      return { error: msg || ("HTTP " + code) };
    }
    if (!resp || typeof resp.answer !== "string" || !resp.answer) {
      return { error: "응답이 비어 있습니다." };
    }

    var out = {
      route: String(resp.route || "chat"),
      routeReason: String(resp.route_reason || ""),
      answer: String(resp.answer).replace(/^\s+|\s+$/g, ""),
      sources: normSources(resp.sources),
      searched: !!resp.searched,
      fallbackUsed: !!resp.fallback_used,
      partial: !!resp.partial,
      truncated: !!resp.truncated,
      title: "",
      url: "",
      elapsedMs: resp.elapsed_ms || 0
    };
    // URL 요약도 출처가 sources 로 온다(전용 endpoint 의 source 객체와 다름).
    // 문서가 하나뿐이므로 첫 항목이 그 문서다.
    if (out.route === "url_summary" && out.sources.length) {
      out.title = out.sources[0].title;
      out.url = out.sources[0].url;
    }
    cachePut(q, out);
    return out;
  } catch (e) {
    var em = (e && e.message) ? e.message : String(e);
    // 응답 코드를 받기 전에 터졌으면 서버에 닿지 못한 것 → 폴백 대상.
    return { error: "질의 서버 연결 실패: " + em, connectFailed: !gotResponse };
  } finally {
    try { if (conn) conn.disconnect(); } catch (_) {}
  }
}

module.exports = {
  ask: ask,
  extractUrl: extractUrl
};
