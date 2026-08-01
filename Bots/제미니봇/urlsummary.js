// =====================================================================
// urlsummary.js — 내부망 URL 요약 API 클라이언트
//
//   "!qwen" 뒤에 URL 이 섞여 있으면 일반 질의응답 대신 이쪽으로 보낸다.
//   사용자는 형식을 신경 쓰지 않아도 된다:
//     !qwen https://... 요약해줘   /   !qwen 요약좀 https://...
//     !qwen https://...           (뒷말이 없어도 요약)
//
//   API (POST http://192.168.0.55:18082/v1/url-summaries)
//     요청 : { url, summary_style: "brief"|"detailed", language: "ko" }
//     응답 : { summary, source:{title,final_url,bytes,redirects}, usage,
//              truncated, chunks, elapsed_ms, model }
//     오류 : HTTP 422 + { detail } (문자열 또는 FastAPI 검증 배열)
//
//   실측(2026-08-02, 7KB 문서): brief 30.7초/685자, detailed 43.8초/2086자.
//   카톡 가독성과 대기시간을 고려해 기본은 brief 이고, "자세히/상세" 류
//   단어가 있을 때만 detailed 로 올린다.
//
//   RhinoJS-safe: var / function 만.
// =====================================================================

var BASE_URL = "http://192.168.0.55:18082/v1/url-summaries";
var KEY_PATH = Packages.android.os.Environment
    .getExternalStorageDirectory().getAbsolutePath() + "/msgbot/qwen_key";

var CONNECT_TIMEOUT = 15000;
var READ_TIMEOUT    = 240000;   // detailed 가 길면 1분 넘김. 넉넉히.

// 카톡 메시지에 섞여 들어오는 URL 을 집는다.
//  · http(s):// 형태를 우선 인식하고, 없으면 www. 로 시작하는 것도 받는다.
//  · 뒤에 붙는 한글·공백·닫는 괄호·문장부호는 URL 에 포함하지 않는다.
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

// URL 을 뺀 나머지 말 (사용자가 덧붙인 요청)
function stripUrl(text, url) {
  var s = String(text == null ? "" : text);
  var bare = String(url).replace(/^https:\/\//, "");
  return s.replace(url, " ").replace(bare, " ").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
}

// 덧붙인 말에서 상세 요약을 원하는지 판단. 기본은 brief.
var DETAIL_RE = /자세|상세|детал|detail|길게|풀어|전문|깊게|자세히/i;
function styleFor(rest) {
  return DETAIL_RE.test(String(rest || "")) ? "detailed" : "brief";
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

// 422 의 detail 은 문자열이거나 FastAPI 검증 오류 배열이다. 사람이 읽을 한 줄로.
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

// ── 결과 캐시 ────────────────────────────────────────────────────────
//  서버에 "15분당 URL 요약 요청 한도"가 있다(실측: 초과 시 422 + 한국어 사유).
//  단톡방에서 같은 링크가 반복되는 일이 흔하므로, 같은 URL·스타일은 재요청하지 않는다.
//  요약 1건이 700~2,000자라 30건이어도 수십 KB 수준.
var CACHE_TTL_MS = 3600000;   // 1시간
var CACHE_MAX = 30;
var _cache = {};              // key -> { ts, value }
var _cacheKeys = [];          // 삽입 순서 (오래된 것부터 버리기 위함)

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

// 반환: { summary, title, url, style, truncated, elapsedMs, cached? } 또는 { error }
function summarize(url, style) {
  var wanted = (style === "detailed") ? "detailed" : "brief";
  var ck = String(url) + "|" + wanted;
  var hit = cacheGet(ck);
  if (hit) {
    // 원본을 그대로 돌려주지 않도록 얕은 복사 + 캐시 표시
    return { summary: hit.summary, title: hit.title, url: hit.url, style: hit.style,
             truncated: hit.truncated, elapsedMs: hit.elapsedMs, cached: true };
  }

  var key = readApiKey();
  if (!key) return { error: "Qwen API 키 파일을 읽을 수 없습니다(" + KEY_PATH + ")." };

  var conn = null;
  try {
    conn = new java.net.URL(BASE_URL).openConnection();
    conn.setRequestMethod("POST");
    conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
    conn.setRequestProperty("Authorization", "Bearer " + key);
    conn.setDoOutput(true);
    conn.setConnectTimeout(CONNECT_TIMEOUT);
    conn.setReadTimeout(READ_TIMEOUT);

    var body = JSON.stringify({
      url: String(url),
      summary_style: wanted,
      language: "ko"
    });
    var writer = new java.io.OutputStreamWriter(conn.getOutputStream(), "UTF-8");
    writer.write(body); writer.flush(); writer.close();

    var code = conn.getResponseCode();
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
      return { error: msg || ("HTTP " + code) };
    }
    if (!resp || typeof resp.summary !== "string" || !resp.summary) {
      return { error: "요약 응답이 비어 있습니다." };
    }
    var src = resp.source || {};
    var out = {
      summary: String(resp.summary).replace(/^\s+|\s+$/g, ""),
      title: String(src.title || ""),
      url: String(src.final_url || url),
      style: String(resp.summary_style || wanted),
      truncated: !!resp.truncated,
      elapsedMs: resp.elapsed_ms || 0
    };
    cachePut(ck, out);
    return out;
  } catch (e) {
    return { error: "요약 서버 연결 실패: " + ((e && e.message) ? e.message : String(e)) };
  } finally {
    try { if (conn) conn.disconnect(); } catch (_) {}
  }
}

module.exports = {
  extractUrl: extractUrl,
  stripUrl: stripUrl,
  styleFor: styleFor,
  summarize: summarize
};
