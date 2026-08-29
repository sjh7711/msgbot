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
var SCHEMA_VERSION = 4;
var ANSWER_TYPES = {
  person: true, organization: true, place: true, work: true, product: true,
  method: true, term: true, event: true, year: true, date: true,
  count: true, measurement: true
};
var SCALAR_ANSWER_TYPES = { year: true, date: true, count: true, measurement: true };
var GROUNDED_ALIAS_KINDS = { official: true, abbreviation: true, synonym: true };
var SYNTHETIC_ALIAS_KINDS = { transliteration: true, numeric: true };

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

function cleanClientGeminiKey(value) {
  if (value == null || value === "") return null;
  var key = String(value);
  if (key.length < 20 || key.length > 200 || /[\s\u0000-\u001F\u007F]/.test(key)) return "";
  return key;
}

function responseHeader(conn, name, maxLength) {
  try { return cleanOneLine(conn.getHeaderField(name), maxLength); } catch (_) { return ""; }
}

function attachGeminiPoolMeta(result, conn) {
  if (!result || typeof result !== "object") return result;
  var stored = responseHeader(conn, "X-Gemini-Key-Stored", 32).toLowerCase();
  var poolSizeText = responseHeader(conn, "X-Gemini-Key-Pool-Size", 12);
  var source = responseHeader(conn, "X-Gemini-Credential-Source", 24).toLowerCase();
  if (stored === "added" || stored === "already_present" || stored === "not_supplied") {
    result.geminiKeyStored = stored;
  }
  if (/^\d+$/.test(poolSizeText)) result.geminiKeyPoolSize = Number(poolSizeText);
  if (source === "server" || source === "client") result.geminiCredentialSource = source;
  return result;
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

function cleanEvidenceEntries(values, knownSources) {
  if (values == null) return [];
  if (!arrayLike(values)) return null;
  var out = [];
  for (var i = 0; i < values.length && out.length < 5; i++) {
    var entry = values[i] || {};
    var sourceId = cleanOneLine(entry.source_id || entry.sourceId, 24);
    var quote = cleanOneLine(entry.quote, 700);
    if (!sourceId || !quote || hasGeneratedMarkup(quote) ||
        !Object.prototype.hasOwnProperty.call(knownSources, "$" + sourceId)) return null;
    out.push({ source_id: sourceId, quote: quote });
  }
  return out;
}

function cleanResolvedTopic(value, requestedTopic) {
  var raw = value || {};
  var name = cleanOneLine(raw.name, 120);
  var sense = cleanOneLine(raw.sense, 240);
  if (!name || !sense || hasGeneratedMarkup(name) || hasGeneratedMarkup(sense) ||
      !arrayLike(raw.aliases)) return null;
  var aliases = [], seen = {};
  seen["$" + normalizeKey(name)] = true;
  for (var i = 0; i < raw.aliases.length && aliases.length < 20; i++) {
    var alias = cleanOneLine(raw.aliases[i], 120);
    var aliasKey = "$" + normalizeKey(alias);
    if (!alias || aliasKey === "$" || hasGeneratedMarkup(alias)) return null;
    if (!Object.prototype.hasOwnProperty.call(seen, aliasKey)) {
      seen[aliasKey] = true;
      aliases.push(alias);
    }
  }
  var requestedKey = "$" + normalizeKey(requestedTopic);
  if (requestedKey === "$" || !Object.prototype.hasOwnProperty.call(seen, requestedKey)) return null;
  return { name: name, sense: sense, aliases: aliases };
}

function validateSuccess(resp, requiredDistractorCount, requestedTopic) {
  if (!resp || typeof resp !== "object") {
    return errorResult("MODEL_OUTPUT_FORMAT", "퀴즈 근거 응답이 비어 있습니다", true, 0);
  }
  if (Number(resp.schema_version) !== SCHEMA_VERSION) {
    return errorResult("MODEL_OUTPUT_FORMAT", "지원하지 않는 퀴즈 근거 스키마입니다", false, 0);
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

  var resolvedTopic = cleanResolvedTopic(resp.resolved_topic, requestedTopic);
  if (!resolvedTopic) {
    return errorResult("MODEL_OUTPUT_FORMAT", "해석된 토픽 형식 검증에 실패했습니다", true, 0);
  }

  if (!arrayLike(resp.materials) || !resp.materials.length) {
    return errorResult("TOPIC_NOT_FOUND", "검증 가능한 퀴즈 소재를 찾지 못했습니다", false, 0);
  }

  var materials = [], materialAnswers = {}, materialTerms = {}, materialIds = {};
  for (var mi = 0; mi < resp.materials.length && materials.length < 5; mi++) {
    var material = resp.materials[mi] || {};
    var materialId = cleanOneLine(material.id, 12);
    var facet = cleanOneLine(material.facet, 40);
    var answer = cleanOneLine(material.answer, 120);
    var answerType = cleanOneLine(material.answer_type, 24).toLowerCase();
    var choiceMode = cleanOneLine(material.choice_mode, 32).toLowerCase();
    var fact = cleanOneLine(material.fact, 700);
    var ids = cleanSourceIds(material.source_ids, knownSources);
    var materialEvidence = cleanEvidenceEntries(material.evidence, knownSources);
    var answerKey = "$" + normalizeKey(answer);
    var materialIdKey = "$" + materialId;
    if (!/^M[1-9][0-9]*$/.test(materialId) || !facet || !answer || !fact || !ids ||
        !Object.prototype.hasOwnProperty.call(ANSWER_TYPES, answerType) ||
        (choiceMode !== "grounded" && choiceMode !== "scalar") ||
        (choiceMode === "scalar" && !Object.prototype.hasOwnProperty.call(SCALAR_ANSWER_TYPES, answerType)) ||
        materialEvidence == null || !materialEvidence.length ||
        fact.indexOf(answer) === -1 || hasGeneratedMarkup(facet) || hasGeneratedMarkup(answer) ||
        hasGeneratedMarkup(fact) || answerKey === "$" ||
        Object.prototype.hasOwnProperty.call(materialTerms, answerKey) ||
        Object.prototype.hasOwnProperty.call(materialIds, materialIdKey) ||
        !arrayLike(material.answer_aliases) || material.answer_aliases.length > 6 ||
        !arrayLike(material.distractors)) {
      return errorResult("MODEL_OUTPUT_FORMAT", "퀴즈 소재 형식 검증에 실패했습니다", true, 0);
    }
    if (requiredDistractorCount > 0 && material.distractors.length !== requiredDistractorCount) {
      return errorResult("INSUFFICIENT_DISTRACTORS",
        "소재별 객관식 오답 후보가 정확히 " + requiredDistractorCount + "개가 아닙니다", true, 0);
    }

    var answerAliases = [], localNames = {};
    localNames[answerKey] = true;
    for (var ai = 0; ai < material.answer_aliases.length; ai++) {
      var alias = material.answer_aliases[ai] || {};
      var aliasName = cleanOneLine(alias.name, 80);
      var aliasKey = "$" + normalizeKey(aliasName);
      var aliasKind = cleanOneLine(alias.kind, 24).toLowerCase();
      if (!aliasName || aliasKey === "$" || hasGeneratedMarkup(aliasName) ||
          /\[[A-Za-z0-9_-]+\]/.test(aliasName) ||
          Object.prototype.hasOwnProperty.call(localNames, aliasKey) ||
          Object.prototype.hasOwnProperty.call(materialTerms, aliasKey)) {
        return errorResult("MODEL_OUTPUT_FORMAT", "정답 별칭 형식 검증에 실패했습니다", true, 0);
      }
      if (Object.prototype.hasOwnProperty.call(GROUNDED_ALIAS_KINDS, aliasKind)) {
        var aliasIds = cleanSourceIds(alias.source_ids, knownSources);
        if (!aliasIds || alias.synthetic === true) {
          return errorResult("MODEL_OUTPUT_FORMAT", "출처 기반 정답 별칭 검증에 실패했습니다", true, 0);
        }
        answerAliases.push({
          name: aliasName, kind: aliasKind, source_ids: aliasIds, synthetic: false
        });
      } else if (Object.prototype.hasOwnProperty.call(SYNTHETIC_ALIAS_KINDS, aliasKind)) {
        if (alias.synthetic !== true ||
            Object.prototype.hasOwnProperty.call(alias, "source_ids")) {
          return errorResult("MODEL_OUTPUT_FORMAT", "합성 정답 별칭 검증에 실패했습니다", true, 0);
        }
        answerAliases.push({ name: aliasName, kind: aliasKind, synthetic: true });
      } else {
        return errorResult("MODEL_OUTPUT_FORMAT", "지원하지 않는 정답 별칭 종류입니다", true, 0);
      }
      localNames[aliasKey] = true;
      materialTerms[aliasKey] = true;
    }

    var distractors = [], distractorNames = {};
    for (var di = 0; di < material.distractors.length && distractors.length < 5; di++) {
      var distractor = material.distractors[di] || {};
      var name = cleanOneLine(distractor.name, 120);
      var nameKey = "$" + normalizeKey(name);
      var distractorType = cleanOneLine(distractor.answer_type, 24).toLowerCase();
      if (!name || nameKey === "$" || nameKey === answerKey || hasGeneratedMarkup(name) ||
          Object.prototype.hasOwnProperty.call(localNames, nameKey) ||
          Object.prototype.hasOwnProperty.call(distractorNames, nameKey) ||
          (distractorType && distractorType !== answerType)) {
        return errorResult("MODEL_OUTPUT_FORMAT", "소재별 객관식 오답 형식 검증에 실패했습니다", true, 0);
      }
      if (choiceMode === "scalar") {
        if (distractor.synthetic !== true) {
          return errorResult("MODEL_OUTPUT_FORMAT", "수치형 오답은 synthetic=true여야 합니다", true, 0);
        }
        distractors.push({ name: name, synthetic: true });
      } else {
        var distractorIds = cleanSourceIds(distractor.source_ids, knownSources);
        if (!distractorIds || distractor.synthetic === true) {
          return errorResult("MODEL_OUTPUT_FORMAT", "근거형 오답 소재 검증에 실패했습니다", true, 0);
        }
        distractors.push({
          name: name,
          source_ids: distractorIds,
          synthetic: false
        });
      }
      distractorNames[nameKey] = true;
      localNames[nameKey] = true;
    }
    if (requiredDistractorCount > 0 && distractors.length !== requiredDistractorCount) {
      return errorResult("INSUFFICIENT_DISTRACTORS",
        "검증을 통과한 소재별 객관식 오답 후보가 부족합니다", true, 0);
    }
    materialAnswers[answerKey] = true;
    materialTerms[answerKey] = true;
    materialIds[materialIdKey] = true;
    materials.push({
      id: materialId,
      facet: facet,
      answer: answer,
      answer_type: answerType,
      choice_mode: choiceMode,
      fact: fact,
      source_ids: ids,
      evidence: materialEvidence,
      answer_aliases: answerAliases,
      distractors: distractors
    });
  }

  var warnings = [];
  if (arrayLike(resp.warnings)) {
    for (var wi = 0; wi < resp.warnings.length && warnings.length < 10; wi++) {
      var warning = cleanOneLine(resp.warnings[wi], 200);
      if (warning && !hasGeneratedMarkup(warning)) warnings.push(warning);
    }
  }
  return {
    schema_version: SCHEMA_VERSION,
    resolved_topic: resolvedTopic,
    materials: materials,
    sources: sources,
    partial: resp.partial === true,
    warnings: warnings,
    elapsedMs: Number(resp.elapsed_ms) || 0
  };
}

// 성공(v4): {schema_version,resolved_topic,materials[*].answer_aliases/distractors,sources,partial,warnings,elapsedMs}
// 실패: {error,errorCode,retryable,httpStatus}
function fetchEvidence(query, options) {
  var topic = cleanOneLine(query, MAX_QUERY + 1);
  if (topic.length > MAX_QUERY) {
    return errorResult("INVALID_REQUEST", "토픽이 너무 깁니다(최대 " + MAX_QUERY + "자).", false, 0);
  }
  if (topic.length < 1) return errorResult("INVALID_REQUEST", "토픽이 비어 있습니다.", false, 0);

  var opts = options || {};
  // 검증 기준은 사용자가 요청한 원래 topic으로 유지하되, 짧은 한국어 토픽의
  // 검색 실패를 복구할 때만 서버에 보낼 검색 표현을 별도로 확장할 수 있다.
  var searchTopic = cleanOneLine(opts.searchQuery || opts.search_query || topic, MAX_QUERY + 1);
  if (!searchTopic || searchTopic.length > MAX_QUERY) {
    return errorResult("INVALID_REQUEST", "검색 토픽이 비어 있거나 너무 깁니다.", false, 0);
  }
  var clientGeminiKey = cleanClientGeminiKey(opts.geminiApiKey || opts.gemini_api_key);
  if (clientGeminiKey === "") {
    return errorResult("INVALID_CLIENT_GEMINI_KEY", "전달할 Gemini API 키 형식이 올바르지 않습니다", false, 0);
  }
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

  var suppliedDistractorCount = opts.distractorCount != null
    ? opts.distractorCount : opts.distractor_count;
  if (suppliedDistractorCount != null && Number(suppliedDistractorCount) !== 4) {
    return errorResult("INVALID_REQUEST", "distractor_count는 4여야 합니다.", false, 0);
  }
  var requiredDistractorCount = 4;
  var requestPayload = {
    query: searchTopic,
    mode: "search",
    profile: "quiz_evidence",
    language: "ko",
    max_results: boundedInt(opts.maxResults || opts.max_results, 5),
    reference_date: referenceDate,
    quiz_type: quizType,
    material_count: boundedInt(opts.materialCount || opts.material_count, 5),
    distractor_count: requiredDistractorCount,
    stable_only: true,
    exclude_answers: cleanExcludeAnswers(opts.excludeAnswers || opts.exclude_answers)
  };
  var body = JSON.stringify(requestPayload);

  var conn = null;
  try {
    conn = new java.net.URL(BASE_URL).openConnection();
    conn.setRequestMethod("POST");
    conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
    conn.setRequestProperty("Authorization", "Bearer " + key);
    if (clientGeminiKey) conn.setRequestProperty("X-Gemini-API-Key", clientGeminiKey);
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
    if (status < 200 || status >= 300) {
      return attachGeminiPoolMeta(parseServerError(resp, raw, status), conn);
    }
    if (resp && resp.error) return attachGeminiPoolMeta(parseServerError(resp, raw, status), conn);
    return attachGeminiPoolMeta(validateSuccess(resp, requiredDistractorCount, topic), conn);
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
  MAX_QUERY: MAX_QUERY,
  SCHEMA_VERSION: SCHEMA_VERSION
};
