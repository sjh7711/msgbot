// =====================================================================
// gateway.js — 내부망 AI 게이트웨이(/v1/ask) 최소 클라이언트
//
//   192.168.0.55:18082 이 검색(SearXNG) → 공개 문서 재수집 → Gemini 근거 종합을
//   해준다. 여기서는 "사실 확인용 근거 조회"만 쓴다(mode=search).
//
//   왜 필요한가: 퀴즈 감사도 같은 Gemini 라, 모델이 틀리게 아는 사실은 생성도
//   감사도 똑같이 통과시킨다(예: "라라는 레프 종족" — 실제로는 아니마).
//   기억이 아니라 문서를 근거로 판정하게 하려면 외부 근거가 필요하다.
//
//   실측(2026-08-26): search 4.2~6.0초(평균 5.1초), chat 1.6초.
//
//   게이트웨이는 동시 1건만 처리한다. 붙잡혀 있으면 근거 없이 진행할 수 있도록
//   타임아웃을 짧게 두고 실패를 조용히 알린다 — 근거 조회가 출제를 막으면 안 된다.
//
//   RhinoJS-safe: var / function 만.
// =====================================================================

var BASE_URL = "http://192.168.0.55:18082/v1/ask";
var KEY_PATH = Packages.android.os.Environment
    .getExternalStorageDirectory().getAbsolutePath() + "/msgbot/qwen_key";

var CONNECT_TIMEOUT = 5000;    // 게이트웨이가 없거나 꺼져 있으면 빨리 포기
var READ_TIMEOUT    = 20000;   // 평균 5초. 20초를 넘기면 근거 없이 진행한다
var MAX_QUERY = 800;           // 너무 긴 질의는 검색 품질만 떨어뜨린다

function readApiKey() {
  var reader = null;
  try {
    var f = new java.io.File(KEY_PATH);
    if (!f.exists()) return null;
    reader = new java.io.BufferedReader(
        new java.io.InputStreamReader(new java.io.FileInputStream(f), "UTF-8"));
    var sb = new java.lang.StringBuilder(), line;
    while ((line = reader.readLine()) !== null) sb.append(line);
    var key = String(sb.toString()).replace(/[\r\n\s]/g, "");
    return key.length ? key : null;
  } catch (e) { return null; }
  finally { if (reader) try { reader.close(); } catch (_) {} }
}

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

// 웹 검색으로 근거를 모아 온다.
//   반환 성공: { answer, sources: [{id,title,url}], elapsedMs }
//   반환 실패: { error }   — 호출 측은 근거 없이 진행할 수 있어야 한다
function search(query, maxResults) {
  var q = String(query == null ? "" : query).replace(/\s+/g, " ");
  q = q.replace(/^\s+|\s+$/g, "");
  if (q.length > MAX_QUERY) q = q.slice(0, MAX_QUERY);
  if (q.length < 2) return { error: "질의가 너무 짧습니다." };

  var key = readApiKey();
  if (!key) return { error: "게이트웨이 API 키 파일 없음(" + KEY_PATH + ")" };

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
      query: q,
      mode: "search",
      summary_style: "brief",
      language: "ko",
      max_results: maxResults || 3
    });
    var w = new java.io.OutputStreamWriter(conn.getOutputStream(), "UTF-8");
    w.write(body); w.flush(); w.close();

    var code = conn.getResponseCode();
    var stream = (code >= 200 && code < 300) ? conn.getInputStream() : conn.getErrorStream();
    var raw = "";
    if (stream) {
      var br = new java.io.BufferedReader(new java.io.InputStreamReader(stream, "UTF-8"));
      var sb = new java.lang.StringBuilder(), line;
      while ((line = br.readLine()) !== null) sb.append(line);
      br.close();
      raw = String(sb.toString());
    }
    var resp = null;
    try { resp = JSON.parse(raw); } catch (pe) {}

    if (code < 200 || code >= 300) {
      return { error: (resp ? detailToText(resp.detail) : raw.slice(0, 160)) || ("HTTP " + code) };
    }
    if (!resp || typeof resp.answer !== "string" || !resp.answer) {
      return { error: "근거 응답이 비어 있습니다." };
    }
    // 출처가 하나도 없으면 근거로 쓸 수 없다 — 모델 기억으로 답한 것과 다르지 않다.
    var src = [], arr = resp.sources || [];
    for (var i = 0; i < arr.length && i < 5; i++) {
      var s = arr[i] || {};
      var u = String(s.final_url || s.requested_url || s.url || "");
      if (!u) continue;
      src.push({ id: String(s.source_id || s.id || ("S" + (i + 1))), title: String(s.title || ""), url: u });
    }
    if (!src.length) return { error: "출처 없는 응답" };

    return { answer: String(resp.answer).replace(/^\s+|\s+$/g, ""), sources: src,
             elapsedMs: resp.elapsed_ms || 0 };
  } catch (e) {
    return { error: "게이트웨이 연결 실패: " + ((e && e.message) ? e.message : String(e)) };
  } finally {
    try { if (conn) conn.disconnect(); } catch (_) {}
  }
}

module.exports = { search: search, BASE_URL: BASE_URL,
                   CONNECT_TIMEOUT: CONNECT_TIMEOUT, READ_TIMEOUT: READ_TIMEOUT };
