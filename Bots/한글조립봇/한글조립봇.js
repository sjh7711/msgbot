const bot = BotManager.getCurrentBot();

// =====================================================================
// 한글조립봇 — 자모 5개 워들 보조 (후보 필터링)
//
// 명령어:
//   !조립 [단어(코드)]...  — 추측 추가 & 후보 조회
//   !조립                  — 현재 후보 조회 (세션 있을 때)
//   !조립 초기화           — 세션 초기화
//   !조립 취소             — 마지막 추측 제거
//
// 코드: 1=정위치  2=포함(위치다름)  3=없음
// 코드는 기본 자모 순서. 쌍자음·복모음·겹받침은 분해해서 셈.
//   예) 사슴 → ㅅ ㅏ ㅅ ㅡ ㅁ (5개) → !조립 사슴(11333)
// =====================================================================

const BOT_NAME = "한글조립봇";

const DICT_DB_PATH = Packages.android.os.Environment
    .getExternalStorageDirectory().getAbsolutePath() + "/msgbot/stdict.db";

// ─── 자모 테이블 ──────────────────────────────────────────────────────────────
const CHOSUNG  = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
const JUNGSUNG = ['ㅏ','ㅐ','ㅑ','ㅒ','ㅓ','ㅔ','ㅕ','ㅖ','ㅗ','ㅘ','ㅙ','ㅚ','ㅛ','ㅜ','ㅝ','ㅞ','ㅟ','ㅠ','ㅡ','ㅢ','ㅣ'];
const JONGSUNG = ['','ㄱ','ㄲ','ㄳ','ㄴ','ㄵ','ㄶ','ㄷ','ㄹ','ㄺ','ㄻ','ㄼ','ㄽ','ㄾ','ㄿ','ㅀ','ㅁ','ㅂ','ㅄ','ㅅ','ㅆ','ㅇ','ㅈ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
const BASE_CONSONANTS = ['ㄱ','ㄴ','ㄷ','ㄹ','ㅁ','ㅂ','ㅅ','ㅇ','ㅈ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
const BASE_VOWELS     = ['ㅏ','ㅑ','ㅓ','ㅕ','ㅗ','ㅛ','ㅜ','ㅠ','ㅡ','ㅣ'];
const CHO_EXPAND = {
    'ㄲ': ['ㄱ','ㄱ'], 'ㄸ': ['ㄷ','ㄷ'],
    'ㅃ': ['ㅂ','ㅂ'], 'ㅆ': ['ㅅ','ㅅ'], 'ㅉ': ['ㅈ','ㅈ']
};
const JUNG_EXPAND = {
    'ㅐ': ['ㅏ','ㅣ'], 'ㅒ': ['ㅑ','ㅣ'], 'ㅔ': ['ㅓ','ㅣ'], 'ㅖ': ['ㅕ','ㅣ'],
    'ㅘ': ['ㅗ','ㅏ'], 'ㅙ': ['ㅗ','ㅏ','ㅣ'], 'ㅚ': ['ㅗ','ㅣ'],
    'ㅝ': ['ㅜ','ㅓ'], 'ㅞ': ['ㅜ','ㅓ','ㅣ'], 'ㅟ': ['ㅜ','ㅣ'],
    'ㅢ': ['ㅡ','ㅣ']
};
const JONG_EXPAND = {
    'ㄳ': ['ㄱ','ㅅ'], 'ㄵ': ['ㄴ','ㅈ'], 'ㄶ': ['ㄴ','ㅎ'],
    'ㄺ': ['ㄹ','ㄱ'], 'ㄻ': ['ㄹ','ㅁ'], 'ㄼ': ['ㄹ','ㅂ'],
    'ㄽ': ['ㄹ','ㅅ'], 'ㄾ': ['ㄹ','ㅌ'], 'ㄿ': ['ㄹ','ㅍ'],
    'ㅀ': ['ㄹ','ㅎ'], 'ㅄ': ['ㅂ','ㅅ'],
    'ㄲ': ['ㄱ','ㄱ'], 'ㅆ': ['ㅅ','ㅅ']
};

// ─── 한글 분해 ────────────────────────────────────────────────────────────────
function decomposeSyllable(ch) {
    var code = ch.charCodeAt(0) - 0xAC00;
    if (code < 0 || code >= 11172) return null;
    return {
        cho:  CHOSUNG[Math.floor(code / (21 * 28))],
        jung: JUNGSUNG[Math.floor((code % (21 * 28)) / 28)],
        jong: JONGSUNG[code % 28]
    };
}

function decomposeToBaseJamo(word) {
    var jamos = [];
    for (var i = 0; i < word.length; i++) {
        var s = decomposeSyllable(word[i]);
        if (!s) return null;
        if (BASE_CONSONANTS.indexOf(s.cho) !== -1) {
            jamos.push(s.cho);
        } else if (CHO_EXPAND[s.cho]) {
            var ce = CHO_EXPAND[s.cho];
            for (var k = 0; k < ce.length; k++) jamos.push(ce[k]);
        } else { return null; }
        if (BASE_VOWELS.indexOf(s.jung) !== -1) {
            jamos.push(s.jung);
        } else if (JUNG_EXPAND[s.jung]) {
            var je = JUNG_EXPAND[s.jung];
            for (var k = 0; k < je.length; k++) jamos.push(je[k]);
        } else { return null; }
        if (s.jong === '') {
            // 종성 없음
        } else if (BASE_CONSONANTS.indexOf(s.jong) !== -1) {
            jamos.push(s.jong);
        } else if (JONG_EXPAND[s.jong]) {
            var ke = JONG_EXPAND[s.jong];
            for (var k = 0; k < ke.length; k++) jamos.push(ke[k]);
        } else { return null; }
    }
    return jamos;
}

// ─── 사전 캐시 (1~2글자, 기본자모 5개짜리만) ─────────────────────────────────
// stdict.db 의 1~2글자 단어를 미리 분해해서 메모리에 보관.
// 필터링이 단순 배열 순회가 되어 추측마다 DB 조회 없이 빠르게 동작.
var _cache5 = null;

function loadCache5() {
    if (_cache5 !== null) return _cache5;
    var db = null; var cur = null;
    var result = [];
    try {
        db = Packages.android.database.sqlite.SQLiteDatabase.openDatabase(
            DICT_DB_PATH, null,
            Packages.android.database.sqlite.SQLiteDatabase.OPEN_READONLY
        );
        cur = db.rawQuery(
            "SELECT norm FROM words WHERE length(norm) BETWEEN 1 AND 2", []
        );
        while (cur.moveToNext()) {
            var word = cur.getString(0);
            var jamo = decomposeToBaseJamo(word);
            if (jamo && jamo.length === 5) {
                result.push({ word: word, jamo: jamo });
            }
        }
    } catch(e) {
        _cache5 = [];
        return _cache5;
    } finally {
        if (cur) try { cur.close(); } catch(_) {}
        if (db) try { db.close(); } catch(_) {}
    }
    _cache5 = result;
    return _cache5;
}

// ─── 추측 파싱: "사슴(11333)" → {word, jamos, codes} ─────────────────────────
function parseGuessToken(token) {
    token = token.trim();
    var paren = token.indexOf('(');
    if (paren < 0) return { error: '"' + token + '" 형식 오류 (단어(코드) 형태)' };
    var wordPart = token.slice(0, paren).trim();
    var codeStr  = token.slice(paren + 1).replace(')', '').trim();

    var jamos = decomposeToBaseJamo(wordPart);
    if (!jamos) return { error: '"' + wordPart + '" 분해 불가 (한글이 아닌 문자)' };

    var codes = [];
    for (var i = 0; i < codeStr.length; i++) {
        var c = codeStr[i];
        if (c === '1' || c === '2' || c === '3') codes.push(parseInt(c));
    }

    if (jamos.length !== codes.length) {
        return {
            error: '"' + wordPart + '" 자모 ' + jamos.length + '개 / 코드 ' + codes.length + '개 불일치\n' +
                   '분해: ' + jamos.join(' ')
        };
    }

    return { word: wordPart, jamos: jamos, codes: codes };
}

// ─── 제약 추출 ────────────────────────────────────────────────────────────────
function extractConstraints(guesses) {
    var fixed    = {};   // {index: jamo} — 위치 확정 (code=1)
    var mustMap  = {};   // {jamo: {index: true}} — 포함이지만 해당 위치엔 없음 (code=2)
    var excl     = {};   // {jamo: true} — 완전 제외 (code=3, 동일 추측에 1·2 없음)
    var maxCount = {};   // {jamo: N} — 정답에 최대 N개 (코드3과 코드1·2가 같은 추측에 공존)

    for (var g = 0; g < guesses.length; g++) {
        var jamos = guesses[g].jamos;
        var codes = guesses[g].codes;

        // 이 추측에서 코드=1·2로 등장한 자모와 그 개수
        var countInGuess = {};   // jamo → code=1·2 개수
        var has3InGuess  = {};   // jamo → code=3 존재 여부
        for (var i = 0; i < jamos.length; i++) {
            if (codes[i] === 1 || codes[i] === 2) {
                countInGuess[jamos[i]] = (countInGuess[jamos[i]] || 0) + 1;
            } else if (codes[i] === 3) {
                has3InGuess[jamos[i]] = true;
            }
        }

        for (var i = 0; i < jamos.length; i++) {
            if (codes[i] === 1) {
                fixed[i] = jamos[i];
            } else if (codes[i] === 2) {
                if (!mustMap[jamos[i]]) mustMap[jamos[i]] = {};
                mustMap[jamos[i]][i] = true;
            } else if (codes[i] === 3) {
                if (!countInGuess[jamos[i]]) {
                    // 이 추측에서 코드=1·2 없음 → 정답에 아예 없음
                    excl[jamos[i]] = true;
                }
                // 코드=1·2와 공존하는 코드=3은 개수 상한만 기록 (아래에서 처리)
            }
        }

        // 코드=3과 코드=1·2가 같은 자모에 공존 → 정답에 정확히 countInGuess[jamo]개
        // 예) 논조에서 ㄴ이 코드2·코드3 → 정답에 ㄴ 정확히 1개 → maxCount[ㄴ] = 1
        for (var jamo in has3InGuess) {
            if (countInGuess[jamo]) {
                var n = countInGuess[jamo];
                if (maxCount[jamo] === undefined || n < maxCount[jamo]) {
                    maxCount[jamo] = n;
                }
            }
        }
    }

    var must = [];
    for (var jamo in mustMap) must.push({ jamo: jamo, excl: mustMap[jamo] });

    return { fixed: fixed, must: must, excl: excl, maxCount: maxCount };
}

// ─── 후보 필터링 ──────────────────────────────────────────────────────────────
// 사전 단어 각각을 제약 조건으로 걸러냄.
// make_all_words+permutations 대신 이 방식 사용: 의미상 동치이면서 연산량이 1/1000 이하.
function filterCandidates(constraints) {
    var all   = loadCache5();
    var fixed = constraints.fixed;
    var must  = constraints.must;
    var excl  = constraints.excl;
    var result = [];

    outer:
    for (var i = 0; i < all.length; i++) {
        var jamo = all[i].jamo;

        // 1. 고정 위치 확인
        for (var pos in fixed) {
            if (jamo[parseInt(pos)] !== fixed[pos]) continue outer;
        }

        // 2. 제외 자모 확인
        for (var j = 0; j < 5; j++) {
            if (excl[jamo[j]]) continue outer;
        }

        // 3. 필수 포함 자모 확인 (제외 위치 이외에 있어야 함)
        var remaining = jamo.slice();
        for (var m = 0; m < must.length; m++) {
            var mj    = must[m].jamo;
            var mexcl = must[m].excl;
            var found = false;
            for (var j = 0; j < 5; j++) {
                if (remaining[j] === mj && !mexcl[j]) {
                    remaining[j] = null;
                    found = true;
                    break;
                }
            }
            if (!found) continue outer;
        }

        // 4. 자모 개수 상한 확인 (코드3·코드2가 같은 자모에 공존했을 때)
        var maxCount = constraints.maxCount;
        for (var mj in maxCount) {
            var cnt = 0;
            for (var j = 0; j < 5; j++) { if (jamo[j] === mj) cnt++; }
            if (cnt > maxCount[mj]) continue outer;
        }

        result.push(all[i].word);
    }

    return result;
}

// ─── 세션 (방별) ─────────────────────────────────────────────────────────────
var sessions = {};  // room -> { guesses: [{word, jamos, codes}] }

function getSession(room) {
    if (!sessions[room]) sessions[room] = { guesses: [] };
    return sessions[room];
}

// ─── 결과 출력 ────────────────────────────────────────────────────────────────
function fmtConstraints(c, guessCount) {
    var fp = [];
    for (var pos in c.fixed) fp.push((parseInt(pos) + 1) + '번=' + c.fixed[pos]);

    var mp = [];
    for (var m = 0; m < c.must.length; m++) {
        var mj = c.must[m].jamo;
        var ep = [];
        for (var p in c.must[m].excl) ep.push(parseInt(p) + 1);
        mp.push(ep.length ? mj + '(≠' + ep.sort().join(',') + '번)' : mj);
    }

    var ej = [];
    for (var jamo in c.excl) ej.push(jamo);
    ej.sort();

    return (
        '[' + guessCount + '회] ' +
        '고정:' + (fp.length ? fp.join(' ') : '-') + ' ' +
        '필수:' + (mp.length ? mp.join(' ') : '-') + ' ' +
        '제외:' + (ej.length ? ej.join('') : '-')
    );
}

function sendResult(msg, c, candidates, guessCount) {
    var header = fmtConstraints(c, guessCount);
    if (candidates.length === 0) {
        msg.reply(header + '\n후보 없음 — 코드 입력을 확인하세요');
    } else if (candidates.length === 1) {
        msg.reply(header + '\n정답: ' + candidates[0]);
    } else {
        var rows = [];
        for (var i = 0; i < candidates.length; i += 6) {
            rows.push(candidates.slice(i, i + 6).join('  '));
        }
        msg.reply(header + '\n후보 ' + candidates.length + '개:\n' + rows.join('\n'));
    }
}

var HELP_TEXT =
    '한글 조립 보조기 (자모 5개 단어)\n' +
    '!조립 [단어(코드)]  추측 추가 & 후보 조회\n' +
    '!조립               현재 후보 조회\n' +
    '!조립 초기화        세션 초기화\n' +
    '!조립 취소          마지막 추측 제거\n\n' +
    '코드: 1=정위치  2=포함(위치다름)  3=없음\n' +
    '코드 수 = 기본자모 수 (쌍자음·복모음·겹받침은 분해)\n' +
    '사슴 → ㅅ ㅏ ㅅ ㅡ ㅁ (5개)\n' +
    '예) !조립 사슴(11333) 가선(31213)';

// ─── 명령어 처리 ─────────────────────────────────────────────────────────────
function handleMessage(msg) {
    var text = msg.content.trim();
    var room = msg.room;

    if (text === '!조립') {
        var sess = sessions[room];
        if (!sess || sess.guesses.length === 0) {
            msg.reply(HELP_TEXT);
            return;
        }
        var c = extractConstraints(sess.guesses);
        sendResult(msg, c, filterCandidates(c), sess.guesses.length);
        return;
    }

    if (text === '!조립 초기화' || text === '!조립 리셋') {
        sessions[room] = { guesses: [] };
        msg.reply('세션 초기화');
        return;
    }

    if (text === '!조립 취소') {
        var sess = getSession(room);
        if (sess.guesses.length === 0) {
            msg.reply('취소할 추측이 없습니다');
            return;
        }
        var removed = sess.guesses.pop();
        msg.reply('"' + removed.word + '" 제거 (남은 추측: ' + sess.guesses.length + '개)');
        return;
    }

    if (text.indexOf('!조립 ') === 0) {
        var tokenStr = text.slice('!조립 '.length).trim();
        var tokens   = tokenStr.split(/\s+/);
        var sess     = getSession(room);
        var errors   = [];

        for (var t = 0; t < tokens.length; t++) {
            if (!tokens[t]) continue;
            var parsed = parseGuessToken(tokens[t]);
            if (parsed.error) {
                errors.push(parsed.error);
            } else {
                sess.guesses.push(parsed);
            }
        }

        if (errors.length) {
            msg.reply(errors.join('\n'));
            return;
        }

        var c = extractConstraints(sess.guesses);
        sendResult(msg, c, filterCandidates(c), sess.guesses.length);
        return;
    }
}

// ─── 프리필터 ─────────────────────────────────────────────────────────────────
function isMyCommand(text) {
    return text === '!조립' || text.indexOf('!조립 ') === 0;
}

// ─── 워커 스레드 ─────────────────────────────────────────────────────────────
var msgQueue  = new java.util.concurrent.LinkedBlockingQueue();
var WORKER_NAME = "HANGUL_ASSEMBLER_BOT_WORKER";

(function killOldThreads() {
    try {
        var root = java.lang.Thread.currentThread().getThreadGroup();
        while (root.getParent() != null) root = root.getParent();
        var n   = root.activeCount() + 32;
        var arr = java.lang.reflect.Array.newInstance(java.lang.Thread, n);
        var got = root.enumerate(arr, true);
        for (var i = 0; i < got; i++) {
            var t = arr[i];
            if (!t || String(t.getName() || "") !== WORKER_NAME) continue;
            try { t.interrupt(); } catch(_) {}
        }
    } catch(_) {}
})();

(function registerWithChatManager() {
    try {
        var sysProps = java.lang.System.getProperties();
        var REG_KEY  = "__CHATMANAGER_REGISTRY__";
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
            if (!isMyCommand(text.trim())) continue;
            var room = String(task.get("room") || "");
            var msg = {
                content: text,
                room: room,
                reply: (function(r) { return function(s) { try { bot.send(r, s); } catch(_) {} }; })(room)
            };
            handleMessage(msg);
        } catch(_) {}
    }
}, WORKER_NAME).start();

function onMessage(rawMsg) {}
bot.addListener(Event.MESSAGE, onMessage);

function onCommand(msg) {}
bot.setCommandPrefix("@");
bot.addListener(Event.COMMAND, onCommand);

function onCreate(savedInstanceState, activity) {
    var tv = new Packages.android.widget.TextView(activity);
    tv.setText("한글조립봇");
    tv.setTextColor(Packages.android.graphics.Color.DKGRAY);
    activity.setContentView(tv);
}
function onStart(activity)    {}
function onResume(activity)   {}
function onPause(activity)    {}
function onStop(activity)     {}
function onRestart(activity)  {}
function onDestroy(activity)  {}
function onBackPressed(activity) {}

bot.addListener(Event.Activity.CREATE, onCreate);
bot.addListener(Event.Activity.START, onStart);
bot.addListener(Event.Activity.RESUME, onResume);
bot.addListener(Event.Activity.PAUSE, onPause);
bot.addListener(Event.Activity.STOP, onStop);
bot.addListener(Event.Activity.RESTART, onRestart);
bot.addListener(Event.Activity.DESTROY, onDestroy);
bot.addListener(Event.Activity.BACK_PRESSED, onBackPressed);
