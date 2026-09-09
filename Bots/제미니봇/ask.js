// =====================================================================
// ask.js — 내부망 통합 질의 API(/v1/ask) 클라이언트
//
//   "!제미니 [무엇이든]" 의 기본 경로. 어떤 처리를 할지는 서버가 고른다:
//     · 질문에 URL 이 있으면          → URL 요약   (route=url_summary)
//     · 최신 정보/명시적 검색 요청이면 → 웹 검색    (route=web_search)
//     · 그 외                         → 일반 답변  (route=chat)
//   일반 답변 도중 모델이 근거가 필요하다고 하면 서버가 검색을 한 번 더 돈다.
//   덕분에 클라이언트에서 URL 정규식으로 갈래를 나눌 필요가 없다. 봇의 대기
//   안내도 경로를 모른 채 "답변을 생성중입니다." 하나로 나간다.
//
//   ⚠ mode=auto 이므로 질문이 외부 검색엔진(SearXNG 경유)으로 나갈 수 있다.
//     API 키·개인정보는 !제미니 에 넣지 않는다. (문서: "안전 경계" 절)
//
//   API (POST http://192.168.0.55:18082/v1/ask)
//     요청 : { query, mode, summary_style, language, max_results }
//     응답 : { request_id, requested_mode, route, route_reason, answer,
//              sources, searched, fallback_used, partial, summary_style,
//              language, model, usage, elapsed_ms,
//              chunks/truncated(url), search(web_search) }
//     오류 : HTTP 4xx/5xx + { detail } (문자열 또는 FastAPI 검증 배열)
//
//   실측(2026-08-02, Qwen 시절): chat 51초 / url_summary 7초 / web_search 42초.
//   2026-08-04 게이트웨이가 Gemini 로 교체돼 더 빠를 것으로 보이나 미실측.
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
        var d = detail[i] || {};
        var where = (d.loc && d.loc.length) ? d.loc[d.loc.length - 1] : "";
        parts.push((where ? where + ": " : "") + (d.msg || ""));
      }
      return parts.join(", ");
    }
  } catch (_) {}
  return String(detail);
}

// 출처 배열을 [{ id, title, url }] 로 정규화. 제목만 있고 실제 URL이 없는
// 항목은 검색 근거로 인정하지 않는다. id 는 답변의 [S1] 인용과 짝이 된다.
function normSources(arr) {
  var out = [];
  if (!arr) return out;
  try {
    for (var i = 0; i < arr.length && i < 5; i++) {
      var s = arr[i] || {};
      var u = String(s.final_url || s.requested_url || s.url || "")
          .replace(/^\s+|\s+$/g, "");
      if (!/^https?:\/\/[^\s\/?#]+(?:[\/?#][^\s]*)?$/i.test(u)) continue;
      out.push({
        id: String(s.source_id || s.id || ("S" + (i + 1))),
        title: String(s.title || ""),
        url: u
      });
    }
  } catch (_) {}
  return out;
}

// HTTP 오류와 구버전 서버의 HTTP 200 검색 실패를 같은 실패 경로로 전달한다.
// connectFailed=false: 서버에는 도달했으므로 연결 장애와 구분할 수 있다.
function decodeGatewayResponse(code, resp, raw) {
  if (code < 200 || code >= 300) {
    var serverError = resp && typeof resp.error === "object" ? resp.error : null;
    var msg = resp ? detailToText(resp.detail) : String(raw || "").slice(0, 160);
    if (!msg && serverError) msg = String(serverError.message || "");
    if (code === 503 && !msg) msg = "웹 검색을 지금 쓸 수 없습니다(검색 서비스 중단).";
    // 현재 서버와 구버전 서버 일부는 검색 답변의 출처 검증 실패를 구조화 코드
    // 없이 detail 문자열로만 보낸다. 일반 5xx와 구분해야 로컬 모델로 폴백해
    // 무근거 답변을 만들지 않는다.
    var legacyNoEvidence = /(?:검색[^\r\n]{0,100}(?:출처|근거)|(?:출처|근거)[^\r\n]{0,100}(?:없|표시하지|누락))/i.test(msg);
    return {
      error: msg || ("HTTP " + code),
      errorCode: serverError && serverError.code
          ? String(serverError.code) : (legacyNoEvidence ? "SEARCH_NO_EVIDENCE" : ""),
      httpStatus: code,
      retryable: !!(serverError && serverError.retryable),
      connectFailed: false
    };
  }

  var answer = resp && typeof resp.answer === "string"
      ? resp.answer.replace(/^\s+|\s+$/g, "") : "";
  if (!answer) {
    return { error: "응답이 비어 있습니다.", httpStatus: code, connectFailed: false };
  }

  var sources = normSources(resp.sources);
  var route = String(resp.route || "chat");
  var isSearch = route === "web_search" || !!resp.searched || !!resp.search;
  var zeroResults = resp.search && resp.search.results != null &&
      String(resp.search.results).replace(/^\s+|\s+$/g, "") === "0";
  var noResultsAnswer = /^(검색 결과를 찾지 못했습니다|검색 결과가 없습니다|No search results were found)[.!]?$/i.test(answer);
  if (isSearch && (!sources.length || zeroResults || noResultsAnswer)) {
    return {
      error: "검색 근거를 확보하지 못했습니다. 질문 표현을 바꿔 다시 요청해 주세요.",
      errorCode: "SEARCH_NO_EVIDENCE",
      httpStatus: code,
      connectFailed: false
    };
  }

  var out = {
    route: route,
    routeReason: String(resp.route_reason || ""),
    answer: answer,
    sources: sources,
    searched: !!resp.searched,
    fallbackUsed: !!resp.fallback_used,
    partial: !!resp.partial,
    truncated: !!resp.truncated,
    title: "",
    url: "",
    elapsedMs: resp.elapsed_ms || 0
  };
  if (out.route === "url_summary" && out.sources.length) {
    out.title = out.sources[0].title;
    out.url = out.sources[0].url;
  }
  return out;
}

// 결과 캐시는 두지 않는다. 예전엔 15분 한도(일반·URL 10회 / 검색 5회)를 아끼려고
// 같은 질문을 1시간 재사용했는데, 게이트웨이 개편으로 그 한도가 없어졌다.
// 남겨두면 "어제 환율" 같은 질문에 옛 답을 돌려주는 손해만 남는다.

// 질문 하나를 서버에 넘기고 결과를 받는다.
//   반환 : { route, routeReason, answer, sources, searched, fallbackUsed,
//            partial, truncated, title, url, elapsedMs }
//   실패 : { error, connectFailed? }
//          connectFailed 는 서버에 닿지도 못한 경우 — 호출 측에서 로컬 Gemini 키로
//          내려갈지 판단하는 데 쓴다.
function ask(query) {
  // 게이트웨이는 query 에 제어 문자(개행 등)가 있으면 422 로 거절한다.
  // 카톡은 여러 줄 메시지를 흔히 보내므로 공백 하나로 접는다 — 이걸 안 하면
  // 줄바꿈이 든 질문은 전부 "답변을 만들지 못했습니다" 로 끝난다.
  var q = String(query == null ? "" : query).replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
  var key = readApiKey();
  if (!key) return { error: "게이트웨이 API 키 파일을 읽을 수 없습니다(" + KEY_PATH + ")." };

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

    return decodeGatewayResponse(code, resp, raw);
  } catch (e) {
    var em = (e && e.message) ? e.message : String(e);
    // 응답 코드를 받기 전에 터졌으면 서버에 닿지 못한 것 → 폴백 대상.
    return { error: "질의 서버 연결 실패: " + em, connectFailed: !gotResponse };
  } finally {
    try { if (conn) conn.disconnect(); } catch (_) {}
  }
}

module.exports = {
  ask: ask
};
