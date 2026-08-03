// =====================================================================
// errlog.js — 봇 에러 로그 수집·정리
//
//   에러가 봇마다 다른 파일에 다른 형식으로 흩어져 있어서, 무슨 일이 있었는지
//   보려면 파일을 하나씩 열어야 했다. 이 모듈이 전부 읽어 한 줄 형식으로
//   맞추고, 시간순으로 합치고, 같은 에러끼리 묶어 센다.
//
//   수집 대상 (없으면 조용히 건너뜀):
//     subscriber_error.log  구독봇 워커가 삼킨 예외 — 가장 넓은 그물.
//                           lib/subscriber.js 가 모든 봇의 핸들러를 감싸므로
//                           대부분의 진짜 에러가 여기로 떨어진다.
//     maple_error.log       메이플봇 알림 전송 실패
//     error.log             write() 로 새로 남기는 통합 로그
//     botwatch.log          봇 전원 감시 — 복구 실패/포기 줄만
//     backup.log            백업 실패(FAIL) 줄만
//
//   시각은 모두 "yyyy-MM-dd HH:mm:ss" 문자열로 맞춘다. 이 형식은 사전순 정렬이
//   곧 시간순이라 별도 파싱 없이 합칠 수 있다.
//
//   ⚠ 로그 파일은 앞부분이 잘려 나갈 수 있다(각 기록부가 256KB 에서 비움).
//     "전체 기간" 집계가 아니라 "남아 있는 기록" 집계임을 잊지 말 것.
//
//   RhinoJS-safe: var / function 만.
// =====================================================================

var SD = Packages.android.os.Environment.getExternalStorageDirectory().getAbsolutePath();
var ERROR_LOG = SD + "/msgbot/error.log";
var LOG_MAX = 256 * 1024;          // 각 로그 하드 캡 (넘으면 비우고 새로)
var READ_MAX_LINES = 4000;         // 파일 하나에서 읽을 최대 줄 수 (뒤쪽=최신 우선)

// 파일별 수집 규칙. keep 이 있으면 그 검사를 통과한 줄만 에러로 본다.
var SOURCES = [
  { path: SD + "/msgbot/subscriber_error.log", parse: "javadate", bot: null },
  { path: SD + "/msgbot/maple_error.log",      parse: "javadate", bot: "메이플봇" },
  { path: ERROR_LOG,                           parse: "stamp",    bot: null },
  { path: SD + "/msgbot/botwatch.log",         parse: "stamp",    bot: "ChatManager",
    keep: /복구 실패|복구 포기/ },
  { path: SD + "/msgbot_backups/backup.log",   parse: "stamp",    bot: "백업봇",
    keep: /FAIL|실패|오류/ }
];

var MONTHS = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
               Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };

function pad2(n) { return (n < 10 ? "0" : "") + n; }

function nowStamp() {
  try {
    var f = new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss");
    f.setTimeZone(java.util.TimeZone.getTimeZone("Asia/Seoul"));
    return String(f.format(new java.util.Date()));
  } catch (_) { return ""; }
}

// 몇 시간 전 시각을 같은 형식으로 (기간 필터 비교용)
function stampHoursAgo(hours) {
  try {
    var cal = java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone("Asia/Seoul"));
    cal.add(java.util.Calendar.HOUR_OF_DAY, -Math.abs(Number(hours) || 0));
    var f = new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss");
    f.setTimeZone(java.util.TimeZone.getTimeZone("Asia/Seoul"));
    return String(f.format(cal.getTime()));
  } catch (_) { return ""; }
}

// ── 기록 ────────────────────────────────────────────────────────────
// 새로 남기는 에러는 처음부터 통일 형식으로 쓴다.
//   "yyyy-MM-dd HH:mm:ss [봇이름] 위치: 내용"
function write(botName, where, e) {
  try {
    var f = new java.io.File(ERROR_LOG);
    if (f.exists() && f.length() > LOG_MAX) {
      try { new java.io.FileWriter(ERROR_LOG, false).close(); } catch (_) {}
    }
    var detail = String(e && e.message ? e.message : e);
    try { if (e && e.lineNumber != null) detail += " @" + String(e.fileName) + ":" + String(e.lineNumber); } catch (_) {}
    var fw = new java.io.FileWriter(ERROR_LOG, true);
    fw.write(nowStamp() + " [" + String(botName) + "] " + String(where) + ": " +
             detail.replace(/[\r\n]+/g, " ") + "\n");
    fw.close();
    return true;
  } catch (_) { return false; }
}

// ── 읽기 ────────────────────────────────────────────────────────────
// 파일 뒤쪽(최신)이 중요하므로, 넘치면 앞을 버린다.
function readLines(path) {
  var br = null;
  try {
    var f = new java.io.File(path);
    if (!f.exists() || !f.isFile()) return [];
    br = new java.io.BufferedReader(
        new java.io.InputStreamReader(new java.io.FileInputStream(f), "UTF-8"));
    var out = [], line;
    while ((line = br.readLine()) !== null) {
      var s = String(line);
      if (!s.replace(/\s/g, "")) continue;
      out.push(s);
      if (out.length > READ_MAX_LINES) out.shift();
    }
    return out;
  } catch (_) { return []; }
  finally { if (br) try { br.close(); } catch (_) {} }
}

// "Sun Aug 03 14:02:11 KST 2026" → "2026-08-03 14:02:11"
var JAVADATE_RE = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) (\d{1,2}) (\d{2}:\d{2}:\d{2}) [^ ]+ (\d{4})\s*(.*)$/;
// "2026-08-03 14:02:11 나머지"
var STAMP_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+(.*)$/;

// 한 줄 → { ts, bot, text } 또는 null(형식 불일치)
function parseLine(line, kind, defaultBot) {
  var ts = "", rest = "";
  if (kind === "javadate") {
    var m = JAVADATE_RE.exec(line);
    if (!m) return null;
    var mon = MONTHS[m[1]];
    if (!mon) return null;
    ts = m[4] + "-" + mon + "-" + pad2(Number(m[2])) + " " + m[3];
    rest = m[5];
  } else {
    var s = STAMP_RE.exec(line);
    if (!s) return null;
    ts = s[1];
    rest = s[2];
  }

  // "[봇/워커] 위치: 내용" 이면 봇 이름을 뽑는다 (subscriber_error.log 형식)
  var bot = defaultBot || "?";
  var b = /^\[([^\]\/]+)(?:\/[^\]]*)?\]\s*(.*)$/.exec(rest);
  if (b) { bot = b[1]; rest = b[2]; }
  return { ts: ts, bot: String(bot), text: String(rest) };
}

// 같은 에러끼리 묶기 위한 지문. 매번 달라지는 부분(숫자·해시·주소·시각)을 지운다.
// 이걸 안 하면 "3번째 줄에서 실패"가 줄 번호마다 다른 에러로 세어진다.
function fingerprint(text) {
  return String(text)
    .replace(/0x[0-9a-fA-F]+/g, "#")
    .replace(/\b[0-9a-fA-F]{16,}\b/g, "#")
    .replace(/https?:\/\/\S+/g, "URL")
    .replace(/\/[\w./\-가-힣]+\.(js|db|log|json)/g, "PATH")
    .replace(/\d+/g, "N")
    .replace(/\s+/g, " ")
    .replace(/^\s+|\s+$/g, "")
    .slice(0, 160);
}

// 모든 소스를 읽어 시간순으로 합친다.
//   opts.hours  이 시간 안의 것만 (없으면 전부)
//   opts.bot    이 봇 것만 (부분일치, 대소문자 무시)
// 반환: { entries: [{ts,bot,text}...], sources: [{name,lines,kept}], skipped }
function collect(opts) {
  var o = opts || {};
  var since = o.hours ? stampHoursAgo(o.hours) : "";
  // 시각 계산이 실패하면(빈 문자열) 기간 필터가 조용히 무력화된다. "최근 6시간" 이라
  // 적힌 채 전체가 나오면 오히려 오해를 부르므로, 실패했다는 걸 결과에 실어 보낸다.
  var sinceFailed = !!(o.hours && !since);
  var want = o.bot ? String(o.bot).toLowerCase() : "";
  var entries = [], sources = [], skipped = 0;

  for (var i = 0; i < SOURCES.length; i++) {
    var src = SOURCES[i];
    var lines = readLines(src.path);
    var kept = 0;
    for (var j = 0; j < lines.length; j++) {
      var raw = lines[j];
      if (src.keep && !src.keep.test(raw)) continue;
      var p = parseLine(raw, src.parse, src.bot);
      if (!p) { skipped++; continue; }           // 형식이 안 맞는 줄(이어붙은 스택 등)
      if (since && p.ts < since) continue;
      if (want && p.bot.toLowerCase().indexOf(want) === -1) continue;
      entries.push(p);
      kept++;
    }
    if (lines.length) {
      var nm = String(src.path).replace(/^.*\//, "");
      sources.push({ name: nm, lines: lines.length, kept: kept });
    }
  }
  entries.sort(function (a, b) { return a.ts < b.ts ? -1 : (a.ts > b.ts ? 1 : 0); });
  return { entries: entries, sources: sources, skipped: skipped, sinceFailed: sinceFailed };
}

// 봇별 건수 + 같은 에러 묶음. 반환: { total, byBot:[{bot,n}], groups:[{n,bot,first,last,sample}] }
function summarize(entries) {
  var byBot = {}, groups = {};
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    byBot[e.bot] = (byBot[e.bot] || 0) + 1;
    var key = e.bot + " " + fingerprint(e.text);
    var g = groups[key];
    if (!g) groups[key] = { n: 1, bot: e.bot, first: e.ts, last: e.ts, sample: e.text };
    else { g.n++; g.last = e.ts; }
  }
  var bots = [], k;
  for (k in byBot) if (byBot.hasOwnProperty(k)) bots.push({ bot: k, n: byBot[k] });
  bots.sort(function (a, b) { return b.n - a.n; });

  var gs = [];
  for (k in groups) if (groups.hasOwnProperty(k)) gs.push(groups[k]);
  gs.sort(function (a, b) { return b.n - a.n || (a.last < b.last ? 1 : -1); });

  return { total: entries.length, byBot: bots, groups: gs };
}

module.exports = {
  ERROR_LOG: ERROR_LOG,
  SOURCES: SOURCES,
  write: write,
  collect: collect,
  summarize: summarize,
  fingerprint: fingerprint,
  nowStamp: nowStamp,
  stampHoursAgo: stampHoursAgo,
  parseLine: parseLine
};
