// =====================================================================
// summary.js — "!대화요약 N" : 최근 N시간 대화를 주제별로 요약 (Gemini)
//
//   KakaoTalk.db(chat_logs)에서 "이 방 + 최근 N시간" 메시지를 복호화해
//   "[HH:mm] 닉: 내용" 로그로 만든 뒤, 주제분절형 프롬프트로 Gemini 에 요약.
//     * 온디맨드(저장 안 함). 명령을 친 방(channelId=chat_id)으로 자동 스코프.
//     * 복호화/이름해석은 lib/kakao-decrypt.js(kt) 재사용.
//     * 메시지 렌더링은 lib/kakao-msg-render.js 재사용(이모티콘/미디어 등).
//     * Gemini 호출은 제미니봇의 callGemini(키 로테이션/쿼터) 를 그대로 받아 씀.
//
//   ── 분량 처리 (map-reduce) ──
//     로그가 SINGLE_CHARS 이하면 단발 요약.
//     초과하면 SEGMENT_CHARS 단위 구간으로 쪼개 각 구간을 부분요약(map)한 뒤,
//     부분요약들을 하나로 통합(reduce)한다. → 12시간도 누락 없이 커버.
//     (사용량 카운트는 명령 1회당 1회. 내부 호출이 여러 번이어도 onSuccess 는 1회)
//
// 사용: var sm = require(".../summary.js");
//       sm.handle(msg, kt, callGemini, bot, onSuccess);
//   msg = subscriber.js 객체 { content, channelId, room, author, reply }.
//   onSuccess() = 최종 요약 생성 성공 시 1회 호출(사용량 카운트 등).
//
// RhinoJS-safe: var / function 만. arrow/템플릿리터럴/?. ?? 미사용.
// =====================================================================

var CMD = "!대화요약";
var MAX_HOURS = 12;           // 허용 최대 시간
var DEFAULT_HOURS = 3;        // 인자 없을 때 기본
var MAX_MSGS = 8000;          // DB 에서 가져올 최대 메시지 수(최근 우선)
var MAX_TOTAL_CHARS = 120000; // 전체 로그 char 상한(초과 시 오래된 줄 생략)
var SINGLE_CHARS = 30000;     // 이 이하면 map-reduce 없이 단발 요약
var SEGMENT_CHARS = 16000;    // map 단계: 부분요약 1회에 넣는 로그 char
var SEND_CHUNK = 3500;        // 카톡 전송 청크 길이
var LONG_MSG_SPACER = "​".repeat(400);   // 긴 메시지 미리보기 접기용(U+200B). 헤더 뒤에 삽입.

var _render = (function(){
  var p = Packages.android.os.Environment.getExternalStorageDirectory()
      .getAbsolutePath() + "/msgbot/lib/kakao-msg-render.js";
  return require(p);
})();

function fmtHM(sec){
  var sdf = new java.text.SimpleDateFormat("HH:mm", java.util.Locale.KOREA);
  sdf.setTimeZone(java.util.TimeZone.getTimeZone("Asia/Seoul"));
  return sdf.format(new java.util.Date(sec * 1000));   // chat_logs.created_at = 초
}
function encOf(v){ try { return JSON.parse(String(v)).enc; } catch(_) { return null; } }
function looksNumeric(s){ return /^\d+(\.\d+)?$/.test(String(s).trim()); }   // 0.1, 100 등 숫자형 토큰

// 복호화 후 '원문 그대로(=실패)' 또는 빈값이면 null
function decClean(kt, uid, enc, b64){
  if (b64 == null || b64 === "" || enc == null) return null;
  var d = null;
  try { d = kt.decrypt(kt.keyFor(uid, enc), b64); } catch(_) { return null; }
  if (d == null || String(d) === String(b64)) return null;
  return String(d);
}

// 빠른 개수 파악용 COUNT(복호화 없음). 즉시 "처리 중" 안내에 쓰는 대략치.
//   (이모티콘/피드까지 포함한 원시 행 수라 실제 요약 대상보다 약간 많을 수 있음)
function countMessages(kt, chatId, hours){
  var nowSec = Math.floor(java.lang.System.currentTimeMillis() / 1000);
  var since = nowSec - hours * 3600;
  var rows = kt.runSqlite(kt.DB1_PATH,
    "SELECT COUNT(*) AS n FROM chat_logs WHERE chat_id=" + chatId + " AND created_at >= " + since) || [];
  return (rows.length && rows[0].n != null) ? (parseInt(rows[0].n, 10) || 0) : 0;
}

// 최근 hours 시간 메시지 [{ts, uid, text}] (시간 오름차순). 토큰 절약 위해 이모티콘 줄 제외.
function fetchMessages(kt, chatId, hours){
  var nowSec = Math.floor(java.lang.System.currentTimeMillis() / 1000);
  var since = nowSec - hours * 3600;
  var sql = "SELECT user_id, type, message, attachment, v, created_at FROM chat_logs "
          + "WHERE chat_id=" + chatId + " AND created_at >= " + since
          + " ORDER BY created_at DESC LIMIT " + MAX_MSGS;   // 최신 우선으로 받고 아래서 뒤집음
  var rows = kt.runSqlite(kt.DB1_PATH, sql) || [];
  var items = [];
  for (var i = 0; i < rows.length; i++){
    var r = rows[i];
    var enc = encOf(r.v);
    var msgText = decClean(kt, r.user_id, enc, r.message);
    var attRaw = decClean(kt, r.user_id, enc, r.attachment);
    var att = null; if (attRaw){ try { att = JSON.parse(attRaw); } catch(_){} }
    var content = _render.render({ type: parseInt(r.type, 10) || 0, message: msgText, att: att });
    if (!content) continue;
    content = String(content).replace(/\s+/g, " ").trim();
    if (!content || content === "이모티콘") continue;   // 빈줄/이모티콘 제외
    items.push({ ts: parseInt(r.created_at, 10) || 0, uid: String(r.user_id), text: content });
  }
  items.reverse();   // 오름차순(오래된 → 최신)
  return items;
}

// 닉네임 일괄해석 후 "[HH:mm] 닉: 내용" 줄 배열 구성(오름차순).
//   char 예산(MAX_TOTAL_CHARS) 초과 시 오래된 줄부터 버림.
function buildLines(kt, items){
  var uidSet = {}, uids = [];
  for (var i = 0; i < items.length; i++){ if (!uidSet[items[i].uid]){ uidSet[items[i].uid] = 1; uids.push(items[i].uid); } }
  var names = {};
  try { names = kt.getUserNames(uids) || {}; } catch(_){}

  var all = [];
  for (var j = 0; j < items.length; j++){
    var it = items[j];
    var nm = names[it.uid] || ("user_" + it.uid);
    all.push("[" + fmtHM(it.ts) + "] " + nm + ": " + it.text);
  }
  // 최신부터 예산 채움 → 오름차순 복원.
  var kept = [], total = 0, dropped = 0;
  for (var k = all.length - 1; k >= 0; k--){
    var L = all[k];
    if (total + L.length + 1 > MAX_TOTAL_CHARS){ dropped = k + 1; break; }
    kept.push(L); total += L.length + 1;
  }
  kept.reverse();
  return { lines: kept, dropped: dropped, used: kept.length, chars: total };
}

// 줄 배열을 char 예산 단위 구간으로 분할(시간순 유지). 각 구간 = 줄 배열.
function splitSegments(lines, budget){
  var segs = [], cur = [], total = 0;
  for (var i = 0; i < lines.length; i++){
    var L = lines[i];
    if (cur.length && (total + L.length + 1) > budget){ segs.push(cur); cur = []; total = 0; }
    cur.push(L); total += L.length + 1;
  }
  if (cur.length) segs.push(cur);
  return segs;
}

// 공통 출력형식 + 규칙 (단발/부분요약/통합이 동일 형식을 쓰도록).
function outputRules(focus){
  var s = "";
  s += "[출력 형식] — 아래 두 줄짜리 블록만 사용. 제목/참여자/결론 등 다른 항목은 쓰지 마라.\n";
  s += "- 🕒 <대략 HH:MM~HH:MM>\n";
  s += "  <그 시간대에 오간 내용 요약. 1~3문장>\n";
  s += "(주제가 바뀔 때마다 위 블록을 반복)\n\n";
  s += "[규칙]\n";
  s += "- 대화에 실제로 등장한 내용만 써라. 추측·창작 금지. 불확실하면 \"불명확\"으로 표기.\n";
  s += "- 이모티콘, 단순 맞장구, 인사는 요약에서 제외.\n";
  s += "- 링크·날짜·시간·숫자(약속 등)는 정확히 보존.\n";
  s += "- 내용에 사람을 언급할 땐 로그의 닉네임을 그대로 써라.\n";
  s += "- 서론·맺음말·안내문 없이 첫 블록부터 바로 출력하라. '요약한 내용입니다' 같은 문장 금지.\n";
  if (focus) s += "- 단, '" + focus + "'와(과) 관련된 주제는 더 상세히 다뤄라.\n";
  return s;
}

// 단발 요약 프롬프트.
function buildPrompt(hours, logText, focus){
  var maxTopics = Math.min(10, Math.max(4, hours + 2));
  var p = "";
  p += "너는 카카오톡 단체 채팅 요약 전문가다. 아래는 최근 " + hours + "시간 동안의 대화 로그다. 이를 요약하라.\n\n";
  p += "[처리 순서]\n";
  p += "1. 먼저 대화를 \"주제(화제)\" 단위로 분절하라. " + hours + "시간 동안 주제는 여러 번 바뀐다.\n";
  p += "   - 화제 전환 신호: 새 질문 등장, 말 거는 대상 변경, 한동안 침묵 후 재개, 링크/사진 공유.\n";
  p += "   - 짧게 스쳐간 잡담(인사, ㅋㅋ, 맞장구만 있는 구간)은 하나로 묶거나 생략하라.\n";
  p += "2. 각 주제 블록을 아래 형식으로 요약하라. 주제는 최대 " + maxTopics + "개로 합쳐라.\n\n";
  p += outputRules(focus);
  p += "\n[대화 로그]\n" + logText + "\n";
  return p;
}

// map 단계: 한 구간의 부분요약 프롬프트.
function buildSegmentPrompt(logText, focus){
  var p = "";
  p += "다음은 한 카카오톡 단톡방 대화의 시간순 일부 구간이다. 주제(화제) 단위로 분절해 요약하라.\n";
  p += "짧게 스쳐간 잡담(인사/ㅋㅋ/맞장구)은 묶거나 생략하라.\n\n";
  p += outputRules(focus);
  p += "\n[대화 로그 구간]\n" + logText + "\n";
  return p;
}

// reduce 단계: 부분요약들을 하나로 통합하는 프롬프트.
function buildReducePrompt(hours, partialsText, focus){
  var maxTopics = Math.min(12, Math.max(5, hours + 2));
  var p = "";
  p += "다음은 같은 카카오톡 단톡방의 최근 " + hours + "시간 대화를 시간 구간별로 미리 요약한 '부분요약'들을 시간순으로 이어붙인 것이다.\n";
  p += "이를 하나의 최종 요약으로 통합하라.\n";
  p += "- 인접 구간에서 같은 주제가 이어지면 하나의 블록으로 합치고 시간대를 이어 붙여라.\n";
  p += "- 전체 시간 순서를 유지하라. 최종 주제는 최대 " + maxTopics + "개로 합쳐라.\n";
  p += "- 부분요약에 있는 내용만 사용하고 새로 지어내지 마라.\n\n";
  p += outputRules(focus);
  p += "\n[부분요약 모음]\n" + partialsText + "\n";
  return p;
}

function sendChunks(bot, room, header, body){
  var first = true, remain = String(body);
  while (remain.length){
    var chunk = remain.slice(0, SEND_CHUNK);
    remain = remain.slice(chunk.length);
    if (first){ try { bot.send(room, header + LONG_MSG_SPACER + "\n" + chunk); } catch(_){} first = false; }
    else { try { bot.send(room, chunk); } catch(_){} }
  }
  if (first) { try { bot.send(room, header + "\n(내용 없음)"); } catch(_){} }
}

// "!대화요약 [N] [관심사]" 핸들러. 처리하면 true.
function handle(msg, kt, callGemini, bot, onSuccess){
  var content = String((msg && msg.content) || "");
  if (content.indexOf(CMD) !== 0) return false;

  try { if (!kt.isReady()){ msg.reply("KakaoTalk DB 접근 불가 (root 미준비)"); return true; } }
  catch(_) { msg.reply("복호화 모듈 오류"); return true; }

  var chatId = String((msg && msg.channelId) || "").replace(/[^0-9]/g, "");
  if (!chatId){ msg.reply("이 방의 chat_id 를 알 수 없습니다."); return true; }

  var rest = content.substring(CMD.length).trim();
  var hours = DEFAULT_HOURS, focus = null;
  if (rest.length){
    var parts = rest.split(/\s+/);
    // 첫 토큰이 숫자형(소수 포함)이면 '시간'으로 소비 → 내림 후 [1, MAX_HOURS]로 클램프.
    // (0.1·0·100 같은 값도 키워드로 새지 않고 시간으로 처리됨)
    if (looksNumeric(parts[0])) hours = Math.floor(parseFloat(parts.shift()));
    var f = parts.join(" ").trim();
    if (f.length) focus = f;
  }
  if (hours > MAX_HOURS) hours = MAX_HOURS;
  if (hours < 1) hours = 1;

  var room = msg.room, fHours = hours, fFocus = focus, fChatId = chatId;

  // DB 스캔+복호화+(여러 번의) 네트워크는 무거우므로 워커 큐를 막지 않게 별도 스레드에서.
  new java.lang.Thread(function(){
    try {
      // 1) 빠른 COUNT 로 즉시 "처리 중" 안내 (무거운 복호화 전에 먼저 응답).
      var approx = countMessages(kt, fChatId, fHours);
      if (!approx){ try { bot.send(room, "최근 " + fHours + "시간 동안 요약할 대화가 없습니다."); } catch(_){} return; }
      try { bot.send(room, "⏳ 최근 " + fHours + "시간 대화(약 " + approx + "개) 요약 중… 잠시만 기다려주세요."); } catch(_){}

      // 2) 실제 복호화·요약.
      var items = fetchMessages(kt, fChatId, fHours);
      if (!items.length){ try { bot.send(room, "최근 " + fHours + "시간 동안 요약할 대화가 없습니다."); } catch(_){} return; }
      var built = buildLines(kt, items);
      if (!built.lines.length){ try { bot.send(room, "최근 " + fHours + "시간 동안 요약할 대화가 없습니다."); } catch(_){} return; }

      var quotaMsg = "⚠ 사용 가능한 API 사용량이 모두 소진되었습니다. 잠시 후 다시 시도해주세요.";
      var finalText = null, segCount = 1;

      if (built.chars <= SINGLE_CHARS){
        // ── 단발 요약 ──
        var res = callGemini(buildPrompt(fHours, built.lines.join("\n"), fFocus), room);
        if (res && typeof res.text === "string" && res.text.trim()) finalText = res.text.trim();
        else if (res && res.quotaExhausted){ try { bot.send(room, quotaMsg); } catch(_){} return; }
        else { try { bot.send(room, "⚠ 요약 생성 실패: " + ((res && res.error) ? res.error : "알 수 없음")); } catch(_){} return; }
      } else {
        // ── map-reduce ──
        var segs = splitSegments(built.lines, SEGMENT_CHARS);
        segCount = segs.length;

        var partials = [], hitQuota = false;
        for (var s = 0; s < segs.length; s++){
          var pr = callGemini(buildSegmentPrompt(segs[s].join("\n"), fFocus), room);
          if (pr && typeof pr.text === "string" && pr.text.trim()) partials.push(pr.text.trim());
          else if (pr && pr.quotaExhausted){ hitQuota = true; break; }
          // 그 외 오류는 해당 구간만 건너뜀(부분 결과라도 살림)
        }
        if (!partials.length){ try { bot.send(room, hitQuota ? quotaMsg : "⚠ 요약 생성 실패"); } catch(_){} return; }

        // 통합(reduce). 실패하면 부분요약을 그대로 이어붙여 폴백.
        var reduced = callGemini(buildReducePrompt(fHours, partials.join("\n\n"), fFocus), room);
        finalText = (reduced && typeof reduced.text === "string" && reduced.text.trim())
          ? reduced.text.trim()
          : partials.join("\n\n");
      }

      if (!finalText){ try { bot.send(room, "⚠ 요약 생성 실패"); } catch(_){} return; }
      if (typeof onSuccess === "function"){ try { onSuccess(); } catch(_){} }

      var note = "📋 최근 " + fHours + "시간 대화요약 (" + built.used + "개 메시지"
               + (segCount > 1 ? ", " + segCount + "개 구간 통합" : "")
               + (built.dropped ? ", 오래된 " + built.dropped + "개 생략" : "")
               + (fFocus ? " · 관심사: " + fFocus : "") + ")";
      sendChunks(bot, room, note, finalText);
    } catch(e){
      try { bot.send(room, "⚠ 요약 오류: " + (e && e.message ? e.message : e)); } catch(_){}
    }
  }).start();

  return true;
}

module.exports = { handle: handle, CMD: CMD, MAX_HOURS: MAX_HOURS };
