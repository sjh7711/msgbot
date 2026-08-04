// =====================================================================
// deletedchat.js — "지운채팅" 뷰어 (로그봇 명령 "!지운채팅")
//
//   KakaoTalk.db(chat_logs)에서 삭제 피드(origin=SYNCDLMSG, feedType:14)를
//   찾아 logId 로 원본을 역참조 → 복호화 → 사람이 읽는 줄로 렌더해 보여준다.
//     * 저장 안 함(온디맨드). 명령을 친 방(chat_id)으로 자동 스코프.
//     * 쿼리/복호화/이름해석은 lib/kakao-decrypt.js(kt) 재사용.
//     * 메시지 렌더링은 lib/kakao-msg-render.js 재사용(타입 확장 지점).
//
//   삭제 표현 검증(2026-06-24, 실DB): 삭제는 전부 type=0 SYNCDLMSG 피드로만
//   표현되고 원본은 deleted_at=0 으로 내용이 살아있음 → 피드 스캔이 전부 포착.
//
// 사용: var dc = require(".../deletedchat.js"); dc.handle(msg, kt);
//   msg = subscriber.js 가 만든 객체 { content, channelId, room, reply }.
//
// RhinoJS-safe: var / function 만.
// =====================================================================

var CMD = "!지운채팅";
var LONG_MSG_SPACER = "​".repeat(500);

var DEFAULT_COUNT = 10;    // 인자 없을 때 (예전 30 — 한 통에 안 담겨 여러 통으로 쪼개졌다)
var MAX_COUNT = 300;       // 사용자가 직접 지정할 수 있는 상한

// 한 줄이 길면 그 한 건 때문에 메시지가 통째로 쪼개진다. 지운 채팅을 "훑어보는"
// 용도라 앞부분만 있어도 충분하므로 줄 단위로 자른다.
var LINE_MAX = 200;
// 한 통에 담는 길이. 여기를 넘으면 다음 통으로 넘어간다.
var CHUNK_MAX = 3500;
// 그래도 넘치면 몇 통까지 보낼지. 도배를 막는 마지막 방어선.
var MAX_CHUNKS = 3;

function cut(s, n) {
  var t = String(s == null ? "" : s).replace(/[\r\n]+/g, " ");
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

var _render = (function(){
  var p = Packages.android.os.Environment.getExternalStorageDirectory()
      .getAbsolutePath() + "/msgbot/lib/kakao-msg-render.js";
  return require(p);
})();

function formatTs(sec){
  var sdf = new java.text.SimpleDateFormat("MM-dd HH:mm", java.util.Locale.KOREA);
  sdf.setTimeZone(java.util.TimeZone.getTimeZone("Asia/Seoul"));
  return sdf.format(new java.util.Date(sec * 1000));   // chat_logs.created_at 은 초 단위
}
function encOf(v){ try { return JSON.parse(String(v)).enc; } catch (_) { return null; } }
function isPosInt(s){ try { return java.lang.Integer.parseInt(String(s).trim()) > 0; } catch (_) { return false; } }

// 복호화 후 '원문 그대로 반환(=실패)' 또는 빈값이면 null
function decClean(kt, uid, enc, b64){
  if (b64 == null || b64 === "" || enc == null) return null;
  var d = null;
  try { d = kt.decrypt(kt.keyFor(uid, enc), b64); } catch (_) { return null; }
  if (d == null || String(d) === String(b64)) return null;
  return String(d);
}

// 현재 방의 삭제건 [{name, ts, content, delAt, lost}] (삭제 최신순, 최대 limit)
function findDeleted(kt, chatId, limit){
  var fSql = "SELECT id, user_id, message, v, created_at FROM chat_logs "
           + "WHERE chat_id=" + chatId + " AND type=0 AND v LIKE '%SYNCDLMSG%' "
           + "ORDER BY created_at DESC LIMIT " + Math.min(limit * 3, 300);
  var feeds = kt.runSqlite(kt.DB1_PATH, fSql) || [];
  var logIds = [], meta = {};
  for (var i = 0; i < feeds.length && logIds.length < limit; i++){
    var f = feeds[i];
    var dec = decClean(kt, f.user_id, encOf(f.v), f.message);
    if (!dec) continue;
    // ⚠️ logId 는 2^53 초과 64비트 정수다. JSON.parse(=double)/Number 를 거치면
    //    정밀도 손실(…089→…088) + Rhino 의 String(double) 지수표기로 id IN(...) 가
    //    전부 빗나간다. 복호화 JSON 문자열에서 숫자를 '문자열 그대로' 정규식 추출한다.
    var ftM = dec.match(/"feedType"\s*:\s*(\d+)/);
    if (!ftM || ftM[1] !== "14") continue;
    var liM = dec.match(/"logId"\s*:\s*(\d+)/);
    if (!liM) continue;
    var li = liM[1];
    if (meta[li]) continue;
    logIds.push(li); meta[li] = { delAt: parseInt(f.created_at, 10) || 0 };
  }
  if (!logIds.length) return [];

  var oSql = "SELECT id, user_id, type, message, attachment, v, created_at FROM chat_logs "
           + "WHERE chat_id=" + chatId + " AND id IN (" + logIds.join(",") + ")";
  var origs = kt.runSqlite(kt.DB1_PATH, oSql) || [];
  var byId = {};
  for (var j = 0; j < origs.length; j++) byId[String(origs[j].id)] = origs[j];

  var out = [];
  for (var k = 0; k < logIds.length; k++){
    var id = logIds[k], r = byId[id], delAt = meta[id].delAt;
    if (!r){ out.push({ lost: true, delAt: delAt }); continue; }    // 원본 purge 됨
    var enc = encOf(r.v);
    var msg = decClean(kt, r.user_id, enc, r.message);
    var attRaw = decClean(kt, r.user_id, enc, r.attachment);
    var att = null; if (attRaw){ try { att = JSON.parse(attRaw); } catch (_) {} }
    var content = _render.render({ type: parseInt(r.type, 10) || 0, message: msg, att: att });
    var name = "익명";
    try { name = kt.getUserName(r.user_id) || ("user_" + r.user_id); } catch (_) {}
    out.push({ name: name, ts: parseInt(r.created_at, 10) || 0, content: content, delAt: delAt, lost: false });
  }
  // 시간 오름차순(보낸 시각 기준, 유실 행은 삭제 시각) — 오래된 게 위로.
  out.sort(function(a, b){
    var ta = a.lost ? a.delAt : a.ts;
    var tb = b.lost ? b.delAt : b.ts;
    return ta - tb;
  });
  return out;
}

// "!지운채팅 [닉패턴] [개수]" 핸들러. 처리하면 true.
function handle(msg, kt){
  var content = String((msg && msg.content) || "");
  if (content.indexOf(CMD) !== 0) return false;

  try { if (!kt.isReady()){ msg.reply("KakaoTalk DB 접근 불가 (root 미준비)"); return true; } }
  catch (_) { msg.reply("복호화 모듈 오류"); return true; }

  var chatId = String((msg && msg.channelId) || "").replace(/[^0-9]/g, "");
  if (!chatId){ msg.reply("이 방의 chat_id 를 알 수 없습니다."); return true; }

  var rest = content.substring(CMD.length).trim();
  var count = DEFAULT_COUNT, namePat = null;
  if (rest.length){
    var parts = rest.split(/\s+/);
    if (isPosInt(parts[parts.length - 1])) count = Math.min(java.lang.Integer.parseInt(parts.pop()), MAX_COUNT);
    var np = parts.join(" ").trim();
    if (np.length) namePat = np;
  }

  var rows = findDeleted(kt, chatId, count);

  if (namePat){
    var core = namePat.replace(/\*/g, "");
    rows = rows.filter(function(r){ return !r.lost && r.name && r.name.indexOf(core) !== -1; });
  }

  if (!rows.length){ msg.reply("지워진 채팅이 없습니다."); return true; }

  // 스페이서(제로폭 500자)는 카톡 미리보기를 접기 위한 것이라 첫 통에만 붙인다.
  // 예전엔 조각마다 헤더를 다시 넣어서, 쪼개질 때마다 500자를 더 쓰고 그만큼
  // 더 쪼개지는 악순환이었다.
  var lines = [];
  for (var i = 0; i < rows.length; i++){
    var r = rows[i];
    lines.push(r.lost
      ? "[" + formatTs(r.delAt) + " 삭제] (원본 유실)"
      : "[" + formatTs(r.ts) + "] " + r.name + ": " + cut(r.content, LINE_MAX));
  }

  var chunks = [], cur = "";
  for (var j = 0; j < lines.length; j++){
    if (cur && (cur.length + lines[j].length + 1) > CHUNK_MAX){ chunks.push(cur); cur = ""; }
    cur += (cur ? "\n" : "") + lines[j];
  }
  if (cur) chunks.push(cur);

  var dropped = 0;
  if (chunks.length > MAX_CHUNKS){
    // 몇 통까지만 보내고 나머지는 잘라낸다. 방을 도배하느니 개수를 줄여 다시 묻는 게 낫다.
    for (var d = MAX_CHUNKS; d < chunks.length; d++) dropped += chunks[d].split("\n").length;
    chunks = chunks.slice(0, MAX_CHUNKS);
  }

  var head = CMD + " (" + rows.length + "건)" + LONG_MSG_SPACER + "\n—\n";
  for (var c = 0; c < chunks.length; c++){
    var prefix = (c === 0) ? head
               : (CMD + " (" + (c + 1) + "/" + chunks.length + ")\n—\n");
    var tail = (c === chunks.length - 1 && dropped)
             ? "\n\n※ " + dropped + "건은 길어서 생략했습니다. " + CMD + " " + Math.max(1, count - dropped) + " 처럼 개수를 줄여 보세요."
             : "";
    msg.reply(prefix + chunks[c] + tail);
  }
  return true;
}

module.exports = { handle: handle, findDeleted: findDeleted, CMD: CMD };
