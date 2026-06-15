const bot = BotManager.getCurrentBot();

// =====================================================================
// 메이플봇 — 메이플스토리 이벤트/공지 신규 게시물 알림
//  - https://maplestory.nexon.com/News/Event  폴링 (30초 ±10초)
//  - https://maplestory.nexon.com/News/Notice 폴링 (동일 주기)
//  - !메알림 시작   : 현재 방에 알림 등록
//  - !메알림 중지   : 알림 중지
//  - !메알림 상태   : 현재 상태 확인
//  - !메알림 확인   : 현재 이벤트/공지 목록 조회
//  - !메알림 초기화 : 감지 목록 초기화
//
// 메시지 수신: ChatManager 의 broadcast 큐 구독.
//   ChatManager 가 켜져 있어야 동작.
//   ChatManager 는 KakaoTalk DB 만 읽으므로 packageName 은 항상
//   "com.kakao.talk" 로 고정됨 (다른 메신저 구독 불가).
// =====================================================================

const BOT_NAME = "메이플봇";

// === 상수 ===
var TARGETS = [
    { key: "event",  url: "https://maplestory.nexon.com/News/Event",  label: "메이플 이벤트"  },
    { key: "notice", url: "https://maplestory.nexon.com/News/Notice", label: "메이플 공지사항" }
];
var BASE_URL     = "https://maplestory.nexon.com";
var POLL_BASE_MS = 30000;
var POLL_JITTER  = 10000;
var STATE_PATH   = Packages.android.os.Environment
                     .getExternalStorageDirectory().getAbsolutePath()
                     + "/msgbot/maple_state.json";

// === 런타임 상태 ===
var notifyTargets = []; // [{ room, packageName }, ...]
var keepPolling   = false;
var pollThread    = null;

// =====================================================================
// 상태 파일 I/O
// =====================================================================
function loadState() {
    try {
        var f = new java.io.File(STATE_PATH);
        if (!f.exists()) return {};
        var br = new java.io.BufferedReader(
            new java.io.InputStreamReader(new java.io.FileInputStream(f), "UTF-8"));
        var sb = new java.lang.StringBuilder();
        var line;
        while ((line = br.readLine()) !== null) sb.append(line);
        br.close();
        return JSON.parse(String(sb.toString())) || {};
    } catch (e) { return {}; }
}

function saveState(data) {
    try {
        var f = new java.io.File(STATE_PATH);
        var parent = f.getParentFile();
        if (parent && !parent.exists()) parent.mkdirs();
        var fw = new java.io.OutputStreamWriter(
            new java.io.FileOutputStream(f), "UTF-8");
        fw.write(JSON.stringify(data));
        fw.flush();
        fw.close();
    } catch (e) {}
}

// =====================================================================
// HTTP 페치
// =====================================================================
function fetchHtml(url) {
    try {
        var conn = new java.net.URL(url).openConnection();
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(20000);
        conn.setRequestProperty("User-Agent",
            "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36");
        conn.setRequestProperty("Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
        conn.setRequestProperty("Accept-Language", "ko-KR,ko;q=0.9");
        if (conn.getResponseCode() !== 200) { conn.disconnect(); return null; }
        var br = new java.io.BufferedReader(
            new java.io.InputStreamReader(conn.getInputStream(), "UTF-8"));
        var sb = new java.lang.StringBuilder();
        var line;
        while ((line = br.readLine()) !== null) sb.append(line).append("\n");
        br.close();
        conn.disconnect();
        return String(sb.toString());
    } catch (e) { return null; }
}

// =====================================================================
// 공통 헬퍼
// =====================================================================
function decodeEntities(s) {
    return s.replace(/&amp;/g, "&")
            .replace(/&lt;/g,  "<")
            .replace(/&gt;/g,  ">")
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'");
}

// aBlock: <a href="...">...</a> 구간 HTML
function extractEventTitle(aBlock, fallbackId) {
    var parts = [];

    // <em class="modify_common">수정N</em> 텍스트 (제목 변경 감지용)
    var modMatch = aBlock.match(/<em[^>]*class="[^"]*modify_common[^"]*"[^>]*>([^<]*)<\/em>/);
    if (modMatch) {
        var mod = modMatch[1].trim();
        if (mod) parts.push(mod);
    }

    // <span> 내 텍스트 — modify_common em 제거 후 카테고리 태그 등
    var spanMatch = aBlock.match(/<span[^>]*>([\s\S]*?)<\/span>/);
    if (spanMatch) {
        var spanInner = spanMatch[1]
            .replace(/<em[^>]*class="[^"]*modify_common[^"]*"[^>]*>[\s\S]*?<\/em>/g, "")
            .replace(/<[^>]+>/g, "")
            .trim();
        if (spanInner) parts.push(spanInner);
    }

    // <em class="event_listMt"> — 메인 제목
    var emMatch = aBlock.match(/<em[^>]*class="[^"]*event_listMt[^"]*"[^>]*>([\s\S]*?)<\/em>/);
    if (emMatch) {
        var main = emMatch[1].replace(/<[^>]+>/g, "").trim();
        if (main) parts.push(main);
    }

    var result = parts.join(" ").replace(/\s+/g, " ").trim();
    return result ? decodeEntities(result) : ("#" + fallbackId);
}

// =====================================================================
// 이벤트 페이지 파싱 — div.event_board > ul > li 기반
// =====================================================================
function parseEventPage(html) {
    var events     = [];
    var seenInPage = {};

    // event_board div 안의 <ul>...</ul> 구간만 추출
    var boardIdx = html.indexOf('class="event_board"');
    if (boardIdx === -1) return events;
    var ulStart = html.indexOf("<ul", boardIdx);
    if (ulStart === -1) return events;
    var ulEnd = html.indexOf("</ul>", ulStart);
    if (ulEnd === -1) return events;
    var scope = html.substring(ulStart, ulEnd + 5);

    // 각 <li> 항목 순회
    var liRe = /<li[^>]*>([\s\S]*?)<\/li>/g;
    var m;
    while ((m = liRe.exec(scope)) !== null) {
        var li = m[1];
        var hrefMatch = li.match(/href="(\/News\/Event\/[A-Za-z][A-Za-z0-9]*\/(\d+)[^"]*)"/);
        if (!hrefMatch) continue;
        var id = hrefMatch[2];
        if (seenInPage[id]) continue;
        seenInPage[id] = true;
        events.push({ id: id, url: BASE_URL + hrefMatch[1], title: extractEventTitle(li, id) });
    }
    return events;
}

// =====================================================================
// 공지 페이지 파싱 — div.news_board 기반
// href="/News/Notice/카테고리/ID", <em><img alt="[공지]">, <span>제목</span>
// =====================================================================
function parseNoticePage(html) {
    var events     = [];
    var seenInPage = {};
    // 카테고리(영문) + 숫자 ID 형식만 매칭
    var re = /href="(\/News\/Notice\/[A-Za-z][A-Za-z0-9]*\/(\d{4,})[^"]*)"/g;
    var m;
    while ((m = re.exec(html)) !== null) {
        var path = m[1];
        var id   = m[2];
        if (seenInPage[id]) continue;
        seenInPage[id] = true;
        var url     = BASE_URL + path;
        var snippet = html.substring(m.index, Math.min(html.length, m.index + 600));
        var aEnd    = snippet.indexOf("</a>");
        var aBlock  = aEnd > 0 ? snippet.substring(0, aEnd + 4) : snippet.substring(0, 500);

        // 분류 태그: <em><img alt="[공지]" ...></em>
        var category = "";
        var imgMatch = aBlock.match(/<img[^>]+alt="(\[[^\]]+\])"[^>]*>/);
        if (imgMatch) category = imgMatch[1];

        // 제목: <span>텍스트</span>
        var title = "";
        var spanMatch = aBlock.match(/<span[^>]*>([\s\S]*?)<\/span>/);
        if (spanMatch) {
            title = spanMatch[1].replace(/<[^>]+>/g, "").trim();
        }

        var fullTitle = category
            ? (title ? category + " " + title : category)
            : (title || ("#" + id));

        events.push({ id: id, url: url, title: decodeEntities(fullTitle) });
    }
    return events;
}

// =====================================================================
// 타깃별 파서 호출
// =====================================================================
function parsePage(html, target) {
    if (target.key === "notice") return parseNoticePage(html);
    return parseEventPage(html);
}

// =====================================================================
// 디버그 — 페이지 href 샘플
// =====================================================================
function debugHrefs(html, keyword, limit) {
    var result = [];
    var re = /href="([^"]+)"/g;
    var m;
    while ((m = re.exec(html)) !== null && result.length < limit) {
        if (m[1].toLowerCase().indexOf(keyword.toLowerCase()) !== -1) result.push(m[1]);
    }
    return result;
}

// =====================================================================
// 알림 전송 — 상태 파일의 notifyTargets 기준으로 전송 (스레드 안전)
// =====================================================================
function sendNotify(message, targets) {
    for (var i = 0; i < targets.length; i++) {
        try {
            bot.send(targets[i].room, message);
        } catch (e) {
            try {
                var logPath = Packages.android.os.Environment
                    .getExternalStorageDirectory().getAbsolutePath()
                    + "/msgbot/maple_error.log";
                var fw = new java.io.FileWriter(logPath, true);
                fw.write(new java.util.Date().toString() + " sendNotify error: " + e + "\n");
                fw.close();
            } catch (le) {}
        }
    }
}

// =====================================================================
// 폴링 한 사이클 — 모든 타깃 순회
// seenIds 값: { title: "저장된 제목" } 또는 true (구버전 호환)
// =====================================================================
function checkAndNotify() {
    var state    = loadState();
    var seenIds  = state.seenIds || {};
    // 스레드에서 전역 notifyTargets 대신 파일에서 로드해 가시성 문제 회피
    var targets  = state.notifyTargets || [];
    var needSave = false;
    var toNotify = [];

    for (var t = 0; t < TARGETS.length; t++) {
        var target = TARGETS[t];
        var html   = fetchHtml(target.url);
        if (!html) continue;

        var events = parsePage(html, target);
        if (!events.length) continue;

        // 이 카테고리의 첫 폴링 여부 판단
        var isFirst = true;
        for (var k in seenIds) {
            if (seenIds.hasOwnProperty(k) && k.indexOf(target.key + ":") === 0) {
                isFirst = false;
                break;
            }
        }

        for (var i = 0; i < events.length; i++) {
            var ev     = events[i];
            var key    = target.key + ":" + ev.id;
            var stored = seenIds[key];

            if (!stored) {
                if (!isFirst) toNotify.push({ label: target.label, ev: ev, type: "new" });
                seenIds[key] = { title: ev.title };
                needSave = true;
            } else {
                var prevTitle = (stored === true) ? null : stored.title;
                if (prevTitle !== null && prevTitle !== ev.title) {
                    toNotify.push({ label: target.label, ev: ev, type: "updated", prevTitle: prevTitle });
                    seenIds[key] = { title: ev.title };
                    needSave = true;
                } else if (stored === true) {
                    seenIds[key] = { title: ev.title };
                    needSave = true;
                }
            }
        }
    }

    if (needSave) {
        // 폴링 스레드가 시작할 때 로드한 state로 덮어쓰면 notifyTargets가 유실되므로
        // 저장 직전에 다시 로드해서 seenIds만 갱신
        var latestState = loadState();
        latestState.seenIds = seenIds;
        saveState(latestState);
    }

    if (!targets.length) return;

    for (var j = 0; j < toNotify.length; j++) {
        var item = toNotify[j];
        var out;
        if (item.type === "updated") {
            out = "[" + item.label + "] (제목 수정)\n" +
                  item.prevTitle + "\n→ " + item.ev.title + "\n" + item.ev.url;
        } else {
            out = "[" + item.label + "]\n" + item.ev.title + "\n" + item.ev.url;
        }
        sendNotify(out, targets);
        if (j < toNotify.length - 1) {
            try { java.lang.Thread.sleep(1000); } catch (e) {}
        }
    }
}

// =====================================================================
// 폴링 스레드 시작 / 중지
// =====================================================================
function startPolling() {
    if (keepPolling) return;
    keepPolling = true;

    pollThread = new java.lang.Thread(new java.lang.Runnable({
        run: function () {
            while (keepPolling) {
                try { checkAndNotify(); } catch (e) {}
                var delay = POLL_BASE_MS + Math.floor((Math.random() * 2 - 1) * POLL_JITTER);
                delay = Math.max(20000, Math.min(40000, delay));
                try { java.lang.Thread.sleep(delay); } catch (ie) { break; }
            }
        }
    }));
    pollThread.setDaemon(true);
    pollThread.setName("maple-poll");
    pollThread.start();
}

function stopPolling() {
    keepPolling = false;
    if (pollThread) { pollThread.interrupt(); pollThread = null; }
}

// =====================================================================
// 초기화
// =====================================================================
(function init() {
    var state = loadState();
    if (state.notifyTargets && state.notifyTargets.length) {
        notifyTargets = state.notifyTargets;
        startPolling();
    }
})();

// =====================================================================
// 메시지 핸들러 (워커 스레드에서 호출됨)
// =====================================================================
function handleMessage(msg) {
    var text = (msg.content || "").replace(/^\s+|\s+$/g, "");

    if (text === "!메알림") {
        msg.reply(
            "[메이플 이벤트/공지 알림봇]\n" +
            "!메알림 시작 — 이 방에 알림 설정\n" +
            "!메알림 중지 — 알림 중지\n" +
            "!메알림 상태 — 현재 상태 확인\n" +
            "!메알림 확인 — 현재 이벤트/공지 목록"
            // !메알림 초기화        — 감지 목록 초기화
            // !메알림 디버그 이벤트 — 이벤트 페이지 링크 샘플
            // !메알림 디버그 공지   — 공지 페이지 링크 샘플
        );
        return;
    }

    if (text === "!메알림 디버그 이벤트" || text === "!메알림 디버그 공지") {
        var isEvent = text.indexOf("이벤트") !== -1;
        var tgt     = isEvent ? TARGETS[0] : TARGETS[1];
        var html = fetchHtml(tgt.url);
        if (!html) { msg.reply("페이지 로드 실패"); return; }

        var keyword = isEvent ? "event" : "notice";
        var hrefs   = debugHrefs(html, keyword, 15);
        if (!hrefs.length) {
            msg.reply("[" + keyword + "] 포함 링크 없음 (JS 렌더링 페이지일 수 있음)\n" +
                      "HTML 크기: " + html.length + "자\n" +
                      "전체 href 샘플 (최대 10개):\n" +
                      debugHrefs(html, "/", 10).join("\n"));
        } else {
            msg.reply("발견된 링크 (" + hrefs.length + "개):\n" + hrefs.join("\n"));
        }
        return;
    }

    if (text === "!메알림 시작") {
        // 이미 구독 중인 방이면 중복 추가 방지
        var alreadyIn = false;
        for (var i = 0; i < notifyTargets.length; i++) {
            if (notifyTargets[i].room === msg.room && notifyTargets[i].packageName === msg.packageName) {
                alreadyIn = true;
                break;
            }
        }
        if (alreadyIn) {
            msg.reply("이 방은 이미 메이플 알림을 구독 중입니다.");
            return;
        }
        notifyTargets.push({ room: msg.room, packageName: msg.packageName });
        var state = loadState();
        state.notifyTargets = notifyTargets;
        saveState(state);
        if (!keepPolling) startPolling();
        msg.reply("메이플 이벤트/공지 알림 구독 완료!");
        return;
    }

    if (text === "!메알림 중지") {
        var before = notifyTargets.length;
        notifyTargets = notifyTargets.filter(function(tgt) {
            return !(tgt.room === msg.room && tgt.packageName === msg.packageName);
        });
        if (notifyTargets.length === before) {
            msg.reply("이 방은 메이플 알림을 구독하고 있지 않습니다.");
            return;
        }
        var state = loadState();
        state.notifyTargets = notifyTargets;
        saveState(state);
        // 구독 방이 0개가 되면 폴링도 중지
        if (notifyTargets.length === 0) stopPolling();
        msg.reply("메이플 이벤트/공지 알림 구독을 해제했습니다.");
        return;
    }

    if (text === "!메알림 상태") {
        var status  = keepPolling ? "실행 중" : "중지됨";
        var state   = loadState();
        var seenIds = state.seenIds || {};
        var evCnt   = 0;
        var ntCnt   = 0;
        for (var k in seenIds) {
            if (!seenIds.hasOwnProperty(k)) continue;
            if (k.indexOf("event:") === 0) evCnt++;
            else if (k.indexOf("notice:") === 0) ntCnt++;
        }
        var roomLines = notifyTargets.length
            ? notifyTargets.map(function(tgt) { return "  • " + tgt.room; }).join("\n")
            : "  (없음)";
        msg.reply(
            "폴링 상태: " + status + "\n" +
            "구독 방 (" + notifyTargets.length + "개):\n" + roomLines + "\n" +
            "감지된 이벤트: " + evCnt + "개\n" +
            "감지된 공지: " + ntCnt + "개"
        );
        return;
    }

    if (text === "!메알림 확인") {
        for (var t = 0; t < TARGETS.length; t++) {
            var tgt    = TARGETS[t];
            var html   = fetchHtml(tgt.url);
            if (!html) { msg.reply("[" + tgt.label + "] 페이지 로드 실패"); continue; }
            var events = parsePage(html, tgt);
            if (!events.length) { msg.reply("[" + tgt.label + "] 파싱 실패"); continue; }
            var lines = ["[" + tgt.label + "]"];
            var limit = Math.min(events.length, 10);
            for (var i = 0; i < limit; i++) {
                lines.push("\n• " + events[i].title);
                // 첫 번째 게시물 URL 뒤에 구분자 삽입
                lines.push("  " + events[i].url + " " + (i === 0 ? "​".repeat(500) : ""));
            }
            if (events.length > 10) lines.push("\n... 외 " + (events.length - 10) + "개");
            msg.reply(lines.join("\n"));
        }
        return;
    }

    if (text === "!메알림 초기화") {
        var state = loadState();
        state.seenIds = {};
        saveState(state);
        msg.reply(
            "감지 목록을 초기화했습니다.\n" +
            "다음 폴링 시 현재 게시물들을 새 기준으로 등록합니다.\n" +
            "(재등록 완료 이후부터 신규 게시물 알림)"
        );
        return;
    }
}

// ─── 프리필터 ───────────────────────────────────────────────────────────────
function isMyCommand(text) {
    if (!text) return false;
    var t = text.replace(/^\s+|\s+$/g, "");
    return t.indexOf("!메알림") === 0;
}

// ─── 메시지 큐 + 워커 스레드 (ChatManager 구독) ─────────────────────────────
var msgQueue = new java.util.concurrent.LinkedBlockingQueue();
var WORKER_NAME = "MAPLE_BOT_WORKER";

(function killOldThreads() {
    try {
        var root = java.lang.Thread.currentThread().getThreadGroup();
        while (root.getParent() != null) root = root.getParent();
        var n = root.activeCount() + 32;
        var arr = java.lang.reflect.Array.newInstance(java.lang.Thread, n);
        var got = root.enumerate(arr, true);
        for (var i = 0; i < got; i++) {
            var t = arr[i];
            if (!t) continue;
            if (String(t.getName() || "") === WORKER_NAME) {
                try { t.interrupt(); } catch(_) {}
            }
        }
    } catch(_) {}
})();

(function registerWithChatManager() {
    try {
        var sysProps = java.lang.System.getProperties();
        var REG_KEY = "__CHATMANAGER_REGISTRY__";
        var registry = sysProps.get(REG_KEY);
        if (registry == null) {
            registry = new java.util.concurrent.ConcurrentHashMap();
            sysProps.put(REG_KEY, registry);
        }
        registry.put(BOT_NAME, msgQueue);
    } catch(_) {}
})();

new java.lang.Thread(function() {
    while (!java.lang.Thread.currentThread().isInterrupted()) {
        var task = null;
        try { task = msgQueue.take(); } catch(_) { return; }
        try {
            if (!(task instanceof java.util.HashMap)) continue;
            var text = String(task.get("text") || "");
            if (!isMyCommand(text)) continue;
            var room = String(task.get("room") || "");
            var name = String(task.get("name") || "익명");
            var hash = String(task.get("hash") || "");
            var msg = {
                content: text,
                room: room,
                packageName: "com.kakao.talk",  // ChatManager 경유는 항상 카카오톡
                author: { name: name, hash: hash },
                reply: (function(r){ return function(s){ try { bot.send(r, s); } catch(_) {} }; })(room)
            };
            handleMessage(msg);
        } catch(_) {}
    }
}, WORKER_NAME).start();


function onMessage(rawMsg) {}  // 메시지는 ChatManager 큐로 들어옴
bot.addListener(Event.MESSAGE, onMessage);


function onCommand(msg) {}
bot.setCommandPrefix("@");
bot.addListener(Event.COMMAND, onCommand);


function onCreate(savedInstanceState, activity) {
    var textView = new Packages.android.widget.TextView(activity);
    textView.setText("메이플봇");
    textView.setTextColor(Packages.android.graphics.Color.DKGRAY);
    activity.setContentView(textView);
}

function onStart(activity) {}
function onResume(activity) {}
function onPause(activity) {}
function onStop(activity) {}
function onRestart(activity) {}
function onDestroy(activity) { stopPolling(); }
function onBackPressed(activity) {}

bot.addListener(Event.Activity.CREATE, onCreate);
bot.addListener(Event.Activity.START, onStart);
bot.addListener(Event.Activity.RESUME, onResume);
bot.addListener(Event.Activity.PAUSE, onPause);
bot.addListener(Event.Activity.STOP, onStop);
bot.addListener(Event.Activity.RESTART, onRestart);
bot.addListener(Event.Activity.DESTROY, onDestroy);
bot.addListener(Event.Activity.BACK_PRESSED, onBackPressed);
