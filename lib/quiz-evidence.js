// =====================================================================
// quiz-evidence.js — 퀴즈 소재 전용 Gemini 검색 API 클라이언트
//
// 일반 /v1/ask 검색 요약과 계약이 다르다. query에는 사용자가 요청한 토픽만
// 보내고, 퀴즈 유형·기준일·제외 정답은 별도 JSON 필드로 전달한다.
// Gemini가 URL을 만들지 않으며 서버가 실제 수집 URL만 sources에 결합한다.
//
// RhinoJS-safe: var / function 만.
// =====================================================================

var BASE_URL = "http://192.168.0.55:18083/v1/quiz-evidence";
var KEY_PATH = Packages.android.os.Environment
    .getExternalStorageDirectory().getAbsolutePath() + "/msgbot/qwen_key";

var CONNECT_TIMEOUT = 5000;
var READ_TIMEOUT = 20000;
var MAX_QUERY = 300;

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

function cleanOneLine(value, maxLength) {
  return String(value == null ? "" : value)
    .replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "").slice(0, maxLength);
}

function arrayLike(value) {
  return !!value && typeof value !== "string" && typeof value.length === "number";
}

function boundedInt(value, fallback) {
  var n = Math.floor(Number(value));
  if (!isFinite(n)) n = fallback;
  if (n < 1) n = 1;
  if (n > 5) n = 5;
  return n;
}

function normalizeKey(value) {
  return cleanOneLine(value, 160).toLowerCase().replace(/\s+/g, "");
}

function cleanExcludeAnswers(values) {
  var out = [], seen = {};
  for (var i = 0; arrayLike(values) && i < values.length && out.length < 100; i++) {
    var value = cleanOneLine(values[i], 120);
    var key = "$" + normalizeKey(value);
    if (!value || key === "$" || Object.prototype.hasOwnProperty.call(seen, key)) continue;
    seen[key] = true;
    out.push(value);
  }
  return out;
}

function errorResult(code, message, retryable, httpStatus) {
  return {
    error: cleanOneLine(message || code || "퀴즈 근거 API 오류", 200),
    errorCode: cleanOneLine(code || "QUIZ_EVIDENCE_ERROR", 48),
    retryable: retryable === true,
    httpStatus: Number(httpStatus) || 0
  };
}

function parseServerError(resp, raw, status) {
  var payload = resp && resp.error;
  if (payload && typeof payload === "object") {
    return errorResult(payload.code, payload.message, payload.retryable, status);
  }
  if (resp && resp.detail != null) {
    var detail = resp.detail;
    if (typeof detail !== "string") {
      try { detail = JSON.stringify(detail); } catch (_) { detail = String(detail); }
    }
    return errorResult("INVALID_REQUEST", detail, false, status);
  }
  return errorResult("HTTP_ERROR", cleanOneLine(raw, 160) || ("HTTP " + status), false, status);
}

function hasGeneratedMarkup(value) {
  var text = String(value == null ? "" : value);
  return /https?:\/\/|www\.|\[[^\]]+\]\s*\(|<\/?[A-Za-z][^>]*>/i.test(text);
}

function cleanSourceIds(values, knownSources) {
  if (!arrayLike(values) || !values.length) return null;
  var out = [], seen = {};
  for (var i = 0; i < values.length && out.length < 5; i++) {
    var id = cleanOneLine(values[i], 24);
    var key = "$" + id;
    if (!/^[A-Za-z0-9_-]{1,24}$/.test(id) ||
        !Object.prototype.hasOwnProperty.call(knownSources, key)) return null;
    if (!Object.prototype.hasOwnProperty.call(seen, key)) {
      seen[key] = true;
      out.push(id);
    }
  }
  return out.length ? out : null;
}

function validateSuccess(resp, requiredDistractorCount) {
  if (!resp || typeof resp !== "object") {
    return errorResult("MODEL_OUTPUT_FORMAT", "퀴즈 근거 응답이 비어 있습니다", true, 0);
  }
  if (!arrayLike(resp.sources) || !resp.sources.length) {
    return errorResult("NO_SOURCES", "검색 출처를 확보하지 못했습니다", true, 0);
  }

  var sources = [], knownSources = {};
  for (var si = 0; si < resp.sources.length && sources.length < 5; si++) {
    var source = resp.sources[si] || {};
    var id = cleanOneLine(source.id || source.source_id, 24);
    var title = cleanOneLine(source.title || ("출처 " + id), 180);
    var url = String(source.url || source.final_url || "").replace(/[\r\n\s]+/g, "").slice(0, 600);
    var idKey = "$" + id;
    if (!/^[A-Za-z0-9_-]{1,24}$/.test(id) || !title || !/^https?:\/\//i.test(url) ||
        Object.prototype.hasOwnProperty.call(knownSources, idKey)) {
      return errorResult("MODEL_OUTPUT_FORMAT", "출처 형식 검증에 실패했습니다", true, 0);
    }
    knownSources[idKey] = true;
    sources.push({ id: id, title: title, url: url });
  }

  if (!arrayLike(resp.materials) || !resp.materials.length) {
    return errorResult("TOPIC_NOT_FOUND", "검증 가능한 퀴즈 소재를 찾지 못했습니다", false, 0);
  }

  var materials = [], materialAnswers = {};
  for (var mi = 0; mi < resp.materials.length && materials.length < 5; mi++) {
    var material = resp.materials[mi] || {};
    var materialId = cleanOneLine(material.id, 12);
    var facet = cleanOneLine(material.facet, 40);
    var answer = cleanOneLine(material.answer, 120);
    var fact = cleanOneLine(material.fact, 700);
    var ids = cleanSourceIds(material.source_ids, knownSources);
    var answerKey = "$" + normalizeKey(answer);
    if (!/^M[1-9][0-9]*$/.test(materialId) || !facet || !answer || !fact || !ids ||
        fact.indexOf(answer) === -1 || hasGeneratedMarkup(facet) || hasGeneratedMarkup(answer) ||
        hasGeneratedMarkup(fact) || answerKey === "$" ||
        Object.prototype.hasOwnProperty.call(materialAnswers, answerKey)) {
      return errorResult("MODEL_OUTPUT_FORMAT", "퀴즈 소재 형식 검증에 실패했습니다", true, 0);
    }
    materialAnswers[answerKey] = true;
    materials.push({ id: materialId, facet: facet, answer: answer, fact: fact, source_ids: ids });
  }

  var distractors = [], distractorNames = {};
  if (arrayLike(resp.distractors)) {
    for (var di = 0; di < resp.distractors.length && distractors.length < 20; di++) {
      var distractor = resp.distractors[di] || {};
      var name = cleanOneLine(distractor.name, 120);
      var distractorIds = cleanSourceIds(distractor.source_ids, knownSources);
      var nameKey = "$" + normalizeKey(name);
      if (!name || !distractorIds || hasGeneratedMarkup(name) || nameKey === "$" ||
          Object.prototype.hasOwnProperty.call(materialAnswers, nameKey) ||
          Object.prototype.hasOwnProperty.call(distractorNames, nameKey)) {
        return errorResult("MODEL_OUTPUT_FORMAT", "객관식 오답 소재 형식 검증에 실패했습니다", true, 0);
      }
      distractorNames[nameKey] = true;
      distractors.push({ name: name, source_ids: distractorIds });
    }
  }
  if (requiredDistractorCount > 0 && distractors.length < requiredDistractorCount) {
    return errorResult("MODEL_OUTPUT_FORMAT",
      "객관식 오답 후보가 " + requiredDistractorCount + "개보다 적습니다", true, 0);
  }

  var warnings = [];
  if (arrayLike(resp.warnings)) {
    for (var wi = 0; wi < resp.warnings.length && warnings.length < 10; wi++) {
      var warning = cleanOneLine(resp.warnings[wi], 200);
      if (warning && !hasGeneratedMarkup(warning)) warnings.push(warning);
    }
  }
  return {
    materials: materials,
    distractors: distractors,
    sources: sources,
    partial: resp.partial === true,
    warnings: warnings,
    elapsedMs: Number(resp.elapsed_ms) || 0
  };
}

// 성공: {materials,distractors,sources,partial,warnings,elapsedMs}
// 실패: {error,errorCode,retryable,httpStatus}
function fetchEvidence(query, options) {
  var topic = cleanOneLine(query, MAX_QUERY + 1);
  if (topic.length > MAX_QUERY) {
    return errorResult("INVALID_REQUEST", "토픽이 너무 깁니다(최대 " + MAX_QUERY + "자).", false, 0);
  }
  if (topic.length < 2) return errorResult("INVALID_REQUEST", "토픽이 너무 짧습니다.", false, 0);

  var opts = options || {};
  var referenceDate = cleanOneLine(opts.referenceDate || opts.reference_date, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(referenceDate)) {
    return errorResult("INVALID_REQUEST", "기준일은 YYYY-MM-DD 형식이어야 합니다.", false, 0);
  }
  var quizType = String(opts.quizType || opts.quiz_type || "multi").toLowerCase();
  if (quizType !== "multi" && quizType !== "short") {
    return errorResult("INVALID_REQUEST", "quiz_type은 multi 또는 short여야 합니다.", false, 0);
  }

  var key = readApiKey();
  if (!key) return errorResult("UNAUTHORIZED", "퀴즈 근거 API 키 파일 없음(" + KEY_PATH + ")", false, 0);

  var requiredDistractorCount = quizType === "multi"
    ? boundedInt(opts.distractorCount || opts.distractor_count, 4) : 0;
  var requestPayload = {
    query: topic,
    mode: "search",
    profile: "quiz_evidence",
    language: "ko",
    max_results: boundedInt(opts.maxResults || opts.max_results, 5),
    reference_date: referenceDate,
    quiz_type: quizType,
    material_count: boundedInt(opts.materialCount || opts.material_count, 5),
    exclude_answers: cleanExcludeAnswers(opts.excludeAnswers || opts.exclude_answers)
  };
  if (quizType === "multi") requestPayload.distractor_count = requiredDistractorCount;
  var body = JSON.stringify(requestPayload);

  var conn = null;
  try {
    conn = new java.net.URL(BASE_URL).openConnection();
    conn.setRequestMethod("POST");
    conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
    conn.setRequestProperty("Authorization", "Bearer " + key);
    conn.setDoOutput(true);
    conn.setConnectTimeout(CONNECT_TIMEOUT);
    conn.setReadTimeout(READ_TIMEOUT);

    var writer = new java.io.OutputStreamWriter(conn.getOutputStream(), "UTF-8");
    writer.write(body); writer.flush(); writer.close();

    var status = conn.getResponseCode();
    var stream = (status >= 200 && status < 300) ? conn.getInputStream() : conn.getErrorStream();
    var raw = "";
    if (stream) {
      var reader = new java.io.BufferedReader(new java.io.InputStreamReader(stream, "UTF-8"));
      var sb = new java.lang.StringBuilder(), line;
      while ((line = reader.readLine()) !== null) sb.append(line);
      reader.close();
      raw = String(sb.toString());
    }
    var resp = null;
    try { resp = JSON.parse(raw); } catch (_) {}
    if (status < 200 || status >= 300) return parseServerError(resp, raw, status);
    if (resp && resp.error) return parseServerError(resp, raw, status);
    return validateSuccess(resp, requiredDistractorCount);
  } catch (e) {
    var detail = cleanOneLine((e && e.message) ? e.message : String(e), 160);
    var timedOut = /timeout|timed out|시간.*초과/i.test(detail);
    return errorResult(timedOut ? "SEARCH_TIMEOUT" : "GATEWAY_UNAVAILABLE",
      timedOut ? "퀴즈 근거 검색 시간이 초과되었습니다" : ("퀴즈 근거 API 연결 실패: " + detail),
      false, 0);
  } finally {
    try { if (conn) conn.disconnect(); } catch (_) {}
  }
}

module.exports = {
  fetchEvidence: fetchEvidence,
  BASE_URL: BASE_URL,
  CONNECT_TIMEOUT: CONNECT_TIMEOUT,
  READ_TIMEOUT: READ_TIMEOUT,
  MAX_QUERY: MAX_QUERY
};
