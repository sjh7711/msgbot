const bot = BotManager.getCurrentBot();

// =====================================================================
// 단어퀴즈봇 — 한글 자모 5개 단어 워들
//
// 메시지 수신: ChatManager 의 broadcast 큐 구독.
//   ChatManager 가 켜져 있어야 메시지를 받음.
// =====================================================================

const BOT_NAME = "단어퀴즈봇";

// stdict.db 경로 (msgbot 폴더에 위치)
const DICT_DB_PATH = Packages.android.os.Environment
    .getExternalStorageDirectory().getAbsolutePath() + "/msgbot/stdict.db";

// ─── 단어 빈도 DB 경로 ──────────────────────────────────────────────────────
// freq.db 를 /sdcard/msgbot/ 에 넣어두세요
const FREQ_DB_PATH = Packages.android.os.Environment
    .getExternalStorageDirectory().getAbsolutePath() + "/msgbot/freq.db";

// ─── 한글 자모 테이블 ───────────────────────────────────────────────────────
const CHOSUNG  = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
const JUNGSUNG = ['ㅏ','ㅐ','ㅑ','ㅒ','ㅓ','ㅔ','ㅕ','ㅖ','ㅗ','ㅘ','ㅙ','ㅚ','ㅛ','ㅜ','ㅝ','ㅞ','ㅟ','ㅠ','ㅡ','ㅢ','ㅣ'];
const JONGSUNG = ['','ㄱ','ㄲ','ㄳ','ㄴ','ㄵ','ㄶ','ㄷ','ㄹ','ㄺ','ㄻ','ㄼ','ㄽ','ㄾ','ㄿ','ㅀ','ㅁ','ㅂ','ㅄ','ㅅ','ㅆ','ㅇ','ㅈ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];

// 단자음 14개 / 단모음 10개
const BASE_CONSONANTS = ['ㄱ','ㄴ','ㄷ','ㄹ','ㅁ','ㅂ','ㅅ','ㅇ','ㅈ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
const BASE_VOWELS     = ['ㅏ','ㅑ','ㅓ','ㅕ','ㅗ','ㅛ','ㅜ','ㅠ','ㅡ','ㅣ'];

// 쌍자음 초성 → 단자음 2개로 확장 (ㄲ는 ㄱ+ㄱ으로 2개 카운트)
const CHO_EXPAND = {
    'ㄲ': ['ㄱ','ㄱ'], 'ㄸ': ['ㄷ','ㄷ'],
    'ㅃ': ['ㅂ','ㅂ'], 'ㅆ': ['ㅅ','ㅅ'], 'ㅉ': ['ㅈ','ㅈ']
};

// 복모음 → 단모음으로 완전 분해
const JUNG_EXPAND = {
    'ㅐ': ['ㅏ','ㅣ'],        // ㅏ+ㅣ     (2개)
    'ㅒ': ['ㅑ','ㅣ'],        // ㅑ+ㅣ     (2개)
    'ㅔ': ['ㅓ','ㅣ'],        // ㅓ+ㅣ     (2개)
    'ㅖ': ['ㅕ','ㅣ'],        // ㅕ+ㅣ     (2개)
    'ㅘ': ['ㅗ','ㅏ'],        // ㅗ+ㅏ     (2개)
    'ㅙ': ['ㅗ','ㅏ','ㅣ'],   // ㅗ+ㅏ+ㅣ  (3개)
    'ㅚ': ['ㅗ','ㅣ'],        // ㅗ+ㅣ     (2개)
    'ㅝ': ['ㅜ','ㅓ'],        // ㅜ+ㅓ     (2개)
    'ㅞ': ['ㅜ','ㅓ','ㅣ'],   // ㅜ+ㅓ+ㅣ  (3개)
    'ㅟ': ['ㅜ','ㅣ'],        // ㅜ+ㅣ     (2개)
    'ㅢ': ['ㅡ','ㅣ']         // ㅡ+ㅣ     (2개)
};

// 겹받침 → 단자음 2개로 확장
const JONG_EXPAND = {
    'ㄳ': ['ㄱ','ㅅ'], 'ㄵ': ['ㄴ','ㅈ'], 'ㄶ': ['ㄴ','ㅎ'],
    'ㄺ': ['ㄹ','ㄱ'], 'ㄻ': ['ㄹ','ㅁ'], 'ㄼ': ['ㄹ','ㅂ'],
    'ㄽ': ['ㄹ','ㅅ'], 'ㄾ': ['ㄹ','ㅌ'], 'ㄿ': ['ㄹ','ㅍ'],
    'ㅀ': ['ㄹ','ㅎ'],  'ㅄ': ['ㅂ','ㅅ'],
    'ㄲ': ['ㄱ','ㄱ'],  'ㅆ': ['ㅅ','ㅅ']  // 쌍자음 종성
};

// ─── 게임 상태 (방별 동시 진행 지원) ─────────────────────────────────────────
// 그룹방의 channelId 를 키로 방마다 독립된 퀴즈 상태를 보관한다.
function freshQuizState() {
    return {
        active: false,
        answer: null,
        answerJamo: null,
        room: null,          // !정답을 받을 그룹방 NAME (bot.send 대상)
        attemptsLeft: 0,
        history: [],         // [{word, jamo, emoji}, ...]
        awaitingWord: false, // !퀴즈 입력 후 !출제 대기중
        setterName: null,    // !퀴즈 를 입력한 사람의 닉네임
        openedAt: 0          // !퀴즈 입력 순서(최근일수록 큼)
    };
}
var games = {};              // channelId(group) -> quiz state
var _gameOpenSeq = 0;        // openedAt 단조 증가 카운터

// userhash.db 경로 (msgbot 폴더에 위치)
var USERHASH_DB_PATH = Packages.android.os.Environment
    .getExternalStorageDirectory().getAbsolutePath() + "/msgbot/userhash.db";

// 닉네임이 등장한 방(room) 목록: 공유 캐시(신뢰) 우선, 미스 시 userhash.db 폴백
// schema: userhash(hash TEXT PRIMARY KEY, name, room, first_seen, last_seen)
function roomsForNickname(name) {
    var out = [];
    // 1) 공유 캐시(직접복호화로 채워진 신뢰값, room 포함) 우선
    try {
        var hits = kt.findUserIdsByName(name, false);
        for (var hi = 0; hi < hits.length; hi++) { if (hits[hi].room) out.push(hits[hi].room); }
    } catch(_) {}
    if (out.length) return out;
    // 2) 폴백: userhash.db (평문 name 인덱스)
    var db = null; var cur = null;
    try {
        db = Packages.android.database.sqlite.SQLiteDatabase.openDatabase(
            USERHASH_DB_PATH, null,
            Packages.android.database.sqlite.SQLiteDatabase.OPEN_READONLY
        );
        cur = db.rawQuery("SELECT DISTINCT room FROM userhash WHERE name = ?", [name]);
        while (cur.moveToNext()) {
            var r = cur.getString(0);
            if (r != null) out.push(String(r));
        }
    } catch(e) {
        return out;
    } finally {
        try { if (cur) cur.close(); } catch(_) {}
        try { if (db) db.close(); } catch(_) {}
    }
    return out;
}

// ─── DB 함수 ────────────────────────────────────────────────────────────────
function openDictDB() {
    return Packages.android.database.sqlite.SQLiteDatabase.openDatabase(
        DICT_DB_PATH, null,
        Packages.android.database.sqlite.SQLiteDatabase.OPEN_READONLY
    );
}

function openFreqDB() {
    return Packages.android.database.sqlite.SQLiteDatabase.openDatabase(
        FREQ_DB_PATH, null,
        Packages.android.database.sqlite.SQLiteDatabase.OPEN_READONLY
    );
}

// ─── 한글 분해 ──────────────────────────────────────────────────────────────
function decomposeSyllable(ch) {
    var code = ch.charCodeAt(0) - 0xAC00;
    if (code < 0 || code >= 11172) return null;
    return {
        cho:  CHOSUNG[Math.floor(code / (21 * 28))],
        jung: JUNGSUNG[Math.floor((code % (21 * 28)) / 28)],
        jong: JONGSUNG[code % 28]
    };
}

// 단어 → 단자음/단모음 배열.
// 쌍자음(ㄲ→ㄱ+ㄱ)·복모음(ㅐ→ㅏ+ㅣ, ㅘ→ㅗ+ㅏ)·겹받침(ㄺ→ㄹ+ㄱ)은 각각 확장해서 카운팅.
// 모든 초성·중성·종성이 테이블로 커버되므로 정상 한글에는 null이 나오지 않음
// (한글 음절이 아닌 문자가 섞이면 null 반환).
function decomposeToBaseJamo(word) {
    var jamos = [];
    for (var i = 0; i < word.length; i++) {
        var s = decomposeSyllable(word[i]);
        if (!s) return null;

        // 초성: 단자음이면 1개, 쌍자음이면 확장해서 2개
        if (BASE_CONSONANTS.indexOf(s.cho) !== -1) {
            jamos.push(s.cho);
        } else if (CHO_EXPAND[s.cho]) {
            var ce = CHO_EXPAND[s.cho];
            for (var k = 0; k < ce.length; k++) jamos.push(ce[k]);
        } else {
            return null;
        }

        // 중성: 단모음이면 1개, 복모음이면 단모음으로 확장(ㅐ→ㅏ+ㅣ 등)
        if (BASE_VOWELS.indexOf(s.jung) !== -1) {
            jamos.push(s.jung);
        } else if (JUNG_EXPAND[s.jung]) {
            var je = JUNG_EXPAND[s.jung];
            for (var k = 0; k < je.length; k++) jamos.push(je[k]);
        } else {
            return null;
        }

        // 종성: 없으면 스킵, 단자음이면 1개, 겹받침이면 확장해서 2개
        if (s.jong === '') {
            // 없음
        } else if (BASE_CONSONANTS.indexOf(s.jong) !== -1) {
            jamos.push(s.jong);
        } else if (JONG_EXPAND[s.jong]) {
            var ke = JONG_EXPAND[s.jong];
            for (var k = 0; k < ke.length; k++) jamos.push(ke[k]);
        } else {
            return null;
        }
    }
    return jamos;
}

// ─── 사전 검사 ──────────────────────────────────────────────────────────────
function isWordInDict(word) {
    var db = null; var cur = null;
    try {
        db = openDictDB();
        cur = db.rawQuery("SELECT 1 FROM words WHERE norm=? LIMIT 1", [word]);
        return cur.moveToFirst();
    } catch(e) { return false; }
    finally { if (cur) cur.close(); if (db) db.close(); }
}

// ─── 단어 뜻 조회 (없으면 null) ─────────────────────────────────────────────
function getWordMeaning(word) {
    var db = null; var cur = null;
    try {
        db = openDictDB();
        cur = db.rawQuery("SELECT meaning FROM words WHERE norm=? LIMIT 1", [word]);
        if (cur.moveToFirst()) {
            return cur.getString(0);
        }
        return null;
    } catch(e) { return null; }
    finally { if (cur) cur.close(); if (db) db.close(); }
}

// ─── 빈도 DB에서 여러 단어의 빈도를 한 번에 조회 ────────────────────────────
// WHERE word IN (...) 한 번으로 묶어 DB 핸들 1회로 처리.
// 반환: { word: freq }, DB에 없는 단어는 맵에 없음(호출부에서 0 처리).
function getWordFreqMap(words) {
    var map = {};
    if (!words || words.length === 0) return map;
    var db = null; var cur = null;
    try {
        db = openFreqDB();
        var placeholders = [];
        for (var i = 0; i < words.length; i++) placeholders.push('?');
        cur = db.rawQuery(
            "SELECT word, freq FROM word_freq WHERE word IN (" + placeholders.join(',') + ")",
            words
        );
        while (cur.moveToNext()) {
            map[cur.getString(0)] = cur.getInt(1);
        }
    } catch(e) { /* 조회 실패 시 전부 0으로 취급 */ }
    finally { if (cur) cur.close(); if (db) db.close(); }
    return map;
}

// ─── 랜덤 유효 단어 선택 (빈도 기반) ──────────────────────────────────────
// 1단계: 랜덤으로 후보 20개 수집
// 2단계: freq.db에서 각 단어의 빈도 조회
// 3단계: 빈도가 가장 높은 단어 선정
function getRandomValidWord() {
    var db = null; var cur = null;
    var candidates = [];

    try {
        db = openDictDB();
        // 1~2음절 단어를 랜덤으로 최대 300개 가져와 자모 5개 단어 수집
        cur = db.rawQuery(
            "SELECT norm FROM words WHERE length(norm) BETWEEN 1 AND 2 ORDER BY RANDOM() LIMIT 500",
            []
        );
        while (cur.moveToNext() && candidates.length < 20) {
            var word = cur.getString(0);
            var jamos = decomposeToBaseJamo(word);
            if (jamos && jamos.length === 5) {
                candidates.push({ word: word, jamo: jamos });
            }
        }
    } catch(e) {
        return null;
    } finally {
        if (cur) cur.close();
        if (db) db.close();
    }

    if (candidates.length === 0) return null;

    // 2단계: 후보 빈도를 한 번에 조회 후 내림차순 정렬
    var wordList = [];
    for (var i = 0; i < candidates.length; i++) wordList.push(candidates[i].word);
    var freqMap = getWordFreqMap(wordList);
    for (var i = 0; i < candidates.length; i++) {
        candidates[i].freq = freqMap[candidates[i].word] || 0;
    }
    candidates.sort(function(a, b) { return b.freq - a.freq; });

    // 3단계: 상위 5개 중 랜덤 선택 (후보가 5개 미만이면 전체 중 랜덤)
    var pool = candidates.slice(0, 5);
    return pool[Math.floor(Math.random() * pool.length)];
}

// ─── 피드백 생성 (워들 방식) ─────────────────────────────────────────────────
// ✅ = 위치·자모 모두 일치 (O, 초록)
// ⚠️ = 자모는 포함되나 위치 다름 (△, 노랑)
// ❌ = 해당 자모 없음 (X, 빨강)
function getFeedback(answerJamo, guessJamo) {
    var result  = new Array(5);
    var ansPool = answerJamo.slice();
    var matched = [false, false, false, false, false];

    // 1pass: 정확한 위치
    for (var i = 0; i < 5; i++) {
        if (guessJamo[i] === answerJamo[i]) {
            result[i]  = '✅';
            ansPool[i] = null;
            matched[i] = true;
        }
    }

    // 2pass: 포함 여부 / 없음
    for (var i = 0; i < 5; i++) {
        if (matched[i]) continue;
        var found = false;
        for (var j = 0; j < 5; j++) {
            if (ansPool[j] !== null && ansPool[j] === guessJamo[i]) {
                found = true;
                ansPool[j] = null;
                break;
            }
        }
        result[i] = found ? '⚠️' : '❌';
    }
    return result;
}

// ─── 힌트 라인 빌드 ─────────────────────────────────────────────────────────
// 정답 : 확정 위치(✅)만 표시, 나머지는 ?
// 재료 : ⚠️자모 / 아직 미사용 BASE 자모
function buildHintLines(history) {
    var knownPos     = ['❓', '❓', '❓', '❓', '❓'];
    var absentSet    = {};  // ❌만 나온 자모
    var presentSet   = {};  // ✅ 또는 ⚠️ 에 한 번이라도 등장
    // 자모별 "정답에 최소 몇 개 존재" (한 추리에서 ✅+⚠️ 합산의 최댓값)
    var minCount     = {};
    // 자모별 확정된 위치 집합
    var confirmedPos = {};

    for (var h = 0; h < history.length; h++) {
        var jamos  = history[h].jamo.split(' ');
        var emojis = history[h].emoji.split(' ');
        var thisCount = {};  // 이번 추리에서 ✅+⚠️ 카운트

        for (var i = 0; i < 5; i++) {
            var j = jamos[i], e = emojis[i];
            if (e === '✅') {
                knownPos[i]    = j;
                presentSet[j]  = true;
                thisCount[j]   = (thisCount[j] || 0) + 1;
                if (!confirmedPos[j]) confirmedPos[j] = {};
                confirmedPos[j][i] = true;
            } else if (e === '⚠️') {
                presentSet[j] = true;
                thisCount[j]  = (thisCount[j] || 0) + 1;
            } else {
                absentSet[j] = true;
            }
        }

        for (var j in thisCount) {
            if (!minCount[j] || thisCount[j] > minCount[j]) minCount[j] = thisCount[j];
        }
    }

    // ✅/⚠️ 등장 자모는 absent에서 제거
    for (var j in presentSet) delete absentSet[j];

    // wrongPosSet: 정답에 최소 N개 필요한데 확정 위치가 N개 미만인 자모
    var wrongPosSet = {};
    for (var j in minCount) {
        var confirmed = confirmedPos[j] ? Object.keys(confirmedPos[j]).length : 0;
        if (minCount[j] > confirmed) wrongPosSet[j] = true;
    }

    var allBase = BASE_CONSONANTS.concat(BASE_VOWELS);

    // 1파트: 잘못된 위치 자모들
    var goodList = Object.keys(wrongPosSet);

    // 2파트: ❌로 제거되지 않았고 한번 이상 ✅/⚠️로 등장한 자모 (위치 확정 완료, 1파트 제외)
    var placedList = [];
    for (var j in presentSet) {
        if (!wrongPosSet[j]) placedList.push(j);
    }

    // 3파트: ❌로 제거되지 않았고 한번도 등장하지 않은 자모 (미검증)
    var untriedList = [];
    for (var k = 0; k < allBase.length; k++) {
        var b = allBase[k];
        if (!absentSet[b] && !presentSet[b]) untriedList.push(b);
    }

    return (
        '정답 : ' + knownPos.join(' ') + '\n' +
        '재료 : ' + (goodList.length    ? goodList.join('')    : '-') +
        ' / '   + (placedList.length  ? placedList.join('')  : '-') +
        ' / '   + (untriedList.length ? untriedList.join('') : '-')
    );
}

// ─── 누적 히스토리 메시지 빌드 ───────────────────────────────────────────────
function buildGuessReply(history, attemptsLeft) {
    var lines = ['남은 기회: ' + attemptsLeft + '회'];
    for (var i = 0; i < history.length; i++) {
        lines.push(history[i].word + '/' + history[i].jamo + ' : ' + history[i].emoji);
    }
    lines.push(buildHintLines(history));
    return lines.join('\n');
}

function buildEndReply(history) {
    var lines = [];
    for (var i = 0; i < history.length; i++) {
        lines.push(history[i].word + '/' + history[i].jamo + ' : ' + history[i].emoji);
    }
    return lines.join('\n');
}

// ─── 게임 초기화 (방별) ─────────────────────────────────────────────────────
// 해당 방의 게임 엔트리를 완전히 제거한다(다음 !퀴즈 때 새로 생성).
function resetGame(chanId) {
    if (chanId == null) return;
    delete games[String(chanId)];
}

// ═══════════════════════════════════════════════════════════════════════════
// 오늘의 단어 맞히기 집계 (!오늘단어)
//
// KakaoTalk.db 의 미니게임 결과 카드(type=71)를 오늘자 + 현재 방 기준으로 모아
// 참가자별 시도횟수/성공여부/연승을 정리해 보여준다. user_id→닉네임 복호화 +
// su/sqlite3 인프라는 lib/kakao-decrypt.js 로 분리했다
// (영구 su 셸 재사용 → su 스폰 비용 제거, sqlite3 -readonly, 이름 TTL 캐시).
// ════════════════════════════════════════════════════════════════
var kt = (function() {
  var libPath = "/sdcard/msgbot/lib/kakao-decrypt.js";
  try {
    if (typeof bot.getRootPath === "function") {
      libPath = bot.getRootPath() + "/../../lib/kakao-decrypt.js";
    }
  } catch(_) {}
  return require(libPath);
})();


// ── 미니게임 카드 파싱 ──
// 한 줄이 워들 칸 이모지(🟥🟦🟧🟨🟩🟪🟫⬛⬜)만으로 이뤄졌으면 grid 줄(=추리 1회)
function _wg_isGridLine(ln) {
  if (!/[\uD83D][\uDFE5-\uDFEB]|[⬛⬜]/.test(ln)) return false;
  return ln.replace(/[\uD83D][\uDFE5-\uDFEB]|[⬛⬜]/g, '').replace(/\s/g, '').length === 0;
}
// attachment(복호화 JSON) → { success, attempts, streak, date }; 단어맞히기 아니면 null
function _wg_parse(attStr) {
  var P = {}, C = {};
  try { var o = JSON.parse(attStr); P = o.P || {}; C = o.C || {}; } catch(_) { return null; }
  var me = String(P.ME || "");
  // 단어맞히기 게임 카드 식별: attachment 에 word-guessing 식별자가 있으면
  // "성공!"/"실패!"/"🎉 N번째 정답자입니다!" 카드 모두 포함 (ME 문구에 의존 안 함)
  if (String(attStr).indexOf("word-guessing") === -1) return null;
  var D = "";
  try { D = String(C.TI.TD.D || ""); } catch(_) {}
  var lines = D.split("\n");
  var attempts = 0, streak = null, date = "";
  for (var i = 0; i < lines.length; i++) {
    var t = lines[i].replace(/^\s+|\s+$/g, "");
    if (!t) continue;
    if (_wg_isGridLine(t)) attempts++;                          // grid 줄 수 = 시도횟수
    var sm = t.match(/연승\s*[:：]?\s*(\d+)/); if (sm) streak = parseInt(sm[1], 10);
    if (!date) { var dm = t.match(/(\d{4}\s*년.*?일)/); if (dm) date = dm[1]; }
  }
  // "실패!" 카드만 실패. "성공!"·"🎉 N번째 정답자입니다!"(1~1000)는 정답을 맞힌 것이므로 성공
  return { success: me.indexOf("실패") === -1, attempts: attempts, streak: streak, date: date };
}
// 오늘 0시(로컬) epoch 초 (created_at 은 초 단위)
function _wg_todayStart() {
  var cal = java.util.Calendar.getInstance();
  cal.set(java.util.Calendar.HOUR_OF_DAY, 0); cal.set(java.util.Calendar.MINUTE, 0);
  cal.set(java.util.Calendar.SECOND, 0); cal.set(java.util.Calendar.MILLISECOND, 0);
  return Math.floor(cal.getTimeInMillis() / 1000);
}
// ── !오늘단어 핸들러 ──
function handleTodayWord(msg) {
  if (!kt.isReady()) { msg.reply("⚠️ KakaoTalk DB 접근 불가 (root/sqlite3 확인)"); return; }
  // broadcast 가 전달한 channelId(=chat_id)를 그대로 사용 → 현재 방으로 한정 (DB 역추적 불필요)
  var chatId = String(msg.channelId != null ? msg.channelId : "").replace(/[^0-9]/g, "");
  if (!chatId) { msg.reply("방 정보를 확인할 수 없습니다."); return; }
  var where = "type = 71 AND created_at >= " + _wg_todayStart() + " AND chat_id = " + chatId;
  var rows = kt.runSqlite(kt.DB1_PATH,
    "SELECT user_id, message, attachment, v FROM chat_logs WHERE " + where + " ORDER BY created_at ASC;");
  if (rows == null) { msg.reply("⚠️ 조회 실패 (sqlite3 오류)"); return; }

  var byUid = {}, dateHeader = "";
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i], enc = null;
    try { enc = (JSON.parse(r.v || "{}")).enc; } catch(_) {}
    if (enc == null || !r.user_id) continue;
    var key = kt.keyFor(r.user_id, enc);
    // 단어맞히기 카드 인식은 _wg_parse(attachment 의 word-guessing) 가 담당 → message 사전필터 불필요
    var p = _wg_parse(r.attachment ? String(kt.decrypt(key, r.attachment) || "") : "");
    if (!p) continue;
    if (!dateHeader && p.date) dateHeader = p.date;
    // 같은 사람이 2번 이상 올려도(재공유/포워딩 등) 최초 1건(정식 자동게시)만 집계
    if (!byUid[r.user_id])
      byUid[r.user_id] = { uid: r.user_id, attempts: p.attempts, success: p.success, streak: p.streak };
  }

  var uids = [];
  for (var k in byUid) uids.push(k);
  if (!uids.length) { msg.reply("오늘 참가한 '단어 맞히기' 기록이 없습니다."); return; }
  var names = kt.getUserNames(uids);

  var list = [];
  for (var k in byUid) { byUid[k].name = names[k] || ("user_" + k); list.push(byUid[k]); }
  list.sort(function(a, b) {                                    // 성공 우선 → 시도 적은 순
    if (a.success !== b.success) return a.success ? -1 : 1;
    return (a.attempts || 99) - (b.attempts || 99);
  });

  var nSuccess = 0;
  for (var i = 0; i < list.length; i++) if (list[i].success) nSuccess++;

  var out = ["📋 오늘의 단어 맞히기\n" + (dateHeader ? " (" + dateHeader + ")" : "")];
  out.push("참가 " + list.length + "명 · 성공 " + nSuccess + " / 실패 " + (list.length - nSuccess));
  out.push("──────────────");
  for (var i = 0; i < list.length; i++) {
    var x = list[i];
    var line = (i + 1) + ". " + x.name + " — " + (x.success ? "✅ " + x.attempts + "회" : "❌ 실패 " + x.attempts + "회");
    if (x.success && x.streak != null) line += " · 🔥" + x.streak + "연승";
    out.push(line);
  }
  msg.reply(out.join("\n"));
}

// ─── 프리필터 ───────────────────────────────────────────────────────────────
function isMyCommand(text) {
    if (!text) return false;
    if (text === '!오늘단어') return true;
    if (text === '!퀴즈' || text === '!단어퀴즈' || text === '!퀴즈종료') return true;
    if (text === '!랜덤' || text === '!랜덤출제' || text === '!랜덤퀴즈') return true;
    if (text === '!정답' || text === '!단어') return true;
    if (text.indexOf('!출제 ') === 0) return true;
    if (text.indexOf('!퀴즈출제 ') === 0) return true;
    if (text.indexOf('!단어출제 ') === 0) return true;
    if (text.indexOf('!사전 ') === 0) return true;
    if (text.indexOf('!정답 ') === 0) return true;
    if (text.indexOf('!단어 ') === 0) return true;
    return false;
}

// ─── 메시지 처리 (워커 스레드에서 호출) ─────────────────────────────────────
function handleMessage(msg) {
    try {
        var text = msg.content.trim();
        var room = msg.room;
        // 그룹방 채널 키(숫자만). DM/그룹 어디서 들어와도 그 방 고유 키.
        var chanId = String(msg.channelId != null ? msg.channelId : "").replace(/[^0-9]/g, "");
        // 이 방의 게임 상태(없을 수 있음). 추리/정답 경로는 quizState 별칭으로 접근.
        var st = chanId ? games[chanId] : null;
        var quizState = st;   // 기존 quizState.* 접근을 방별 객체로 별칭 (undefined 가드 필요)

        // ── !오늘단어 : 오늘의 단어 맞히기 집계 (DB 직접 조회) ──
        if (text === '!오늘단어') { handleTodayWord(msg); return; }

        // ── !퀴즈 ────────────────────────────────────────────────────────────
        if (text === '!퀴즈' || text === '!단어퀴즈') {
            if (!chanId) { msg.reply("방 정보를 확인할 수 없습니다."); return; }
            var g = games[chanId] || freshQuizState();
            games[chanId] = g;
            if (g.active) {
                msg.reply("단어퀴즈가 이미 진행 중입니다.\n!퀴즈종료 로 현재 게임을 종료할 수 있습니다.");
                return;
            }
            g.awaitingWord = true;
            g.room         = room;                 // 그룹방 NAME (bot.send 대상)
            g.setterName   = (function(){ try { return kt.resolveSender(msg).name; } catch(_) { return msg.author ? msg.author.name : null; } })();
            g.openedAt     = ++_gameOpenSeq;
            // 30초 내 !출제(또는 !랜덤)로 단어가 설정되지 않으면 대기 상태를 조용히 해제.
            // (다른 사람이 다시 출제할 수 있도록. openedAt 토큰으로 그 사이 새로 연 퀴즈는 건드리지 않음.)
            (function(cid, tok) {
                setTimeout(function() {
                    var gg = games[cid];
                    if (gg && gg.awaitingWord && !gg.active && gg.openedAt === tok) {
                        delete games[cid];
                    }
                }, 30000);
            })(chanId, g.openedAt);
            msg.reply(
                "개인톡으로 \"!출제 [단어]\" 를 입력하세요. (30초 내 미출제 시 자동 해제)\n" +
                "※ 랜덤 출제는 이 방에서 !랜덤 을 입력하세요."
            );
            return;
        }

        // ── !퀴즈종료 ────────────────────────────────────────────────────────
        if (text === '!퀴즈종료') {
            if (!st || !st.active) {
                msg.reply("진행 중인 퀴즈가 없습니다.");
                return;
            }
            var ans = st.answer;
            resetGame(chanId);
            msg.reply("퀴즈를 종료합니다.\n정답 : \"" + ans + "\"");
            return;
        }

        // ── !출제 [단어] ─────────────────────────────────────────────────────
        // 개인톡(DM)에서 입력하여 단어를 비공개로 출제.
        // DM 방의 channelId 는 그룹방과 다르고, 사람도 방마다 user_id(hash)가 다르므로
        // 닉네임(직접복호화)으로 대기중인 그룹방을 찾아 라우팅한다.
        if (text.indexOf('!출제 ') === 0 || text.indexOf('!퀴즈출제 ') === 0 || text.indexOf('!단어출제 ') === 0) {
            var setterN = (function(){ try { return kt.resolveSender(msg).name; } catch(_) { return msg.author ? msg.author.name : null; } })();

            // 1. !퀴즈 로 출제 대기중인 방 수집
            var waiting = [];
            for (var wk in games) {
                if (games[wk] && games[wk].awaitingWord === true) waiting.push(wk);
            }
            // 2. 대기방 없음
            if (!waiting.length) {
                msg.reply("단어퀴즈 출제 대기중인 방이 없습니다.");
                return;
            }

            // 3. 후보 선정 (닉네임 기반)
            //   (a) 이 닉네임이 직접 !퀴즈 를 연 방
            var cand = [];
            for (var ci = 0; ci < waiting.length; ci++) {
                if (setterN != null && games[waiting[ci]].setterName === setterN) cand.push(waiting[ci]);
            }
            //   (b) (a)가 비면: userhash.db 에서 이 닉네임이 등장한 방 집합으로 멤버십 폴백
            if (!cand.length && setterN != null) {
                var rooms = roomsForNickname(setterN);
                if (rooms.length) {
                    var roomSet = {};
                    for (var ri = 0; ri < rooms.length; ri++) roomSet[rooms[ri]] = true;
                    for (var ci2 = 0; ci2 < waiting.length; ci2++) {
                        if (roomSet[games[waiting[ci2]].room]) cand.push(waiting[ci2]);
                    }
                }
            }
            // 4. 후보 없음
            if (!cand.length) {
                msg.reply("닉네임으로 현재 계신 방을 확인할 수 없습니다.");
                return;
            }
            // 5. 여러 개면 가장 최근에 연 방(openedAt 최대) 선택
            var chosen = cand[0];
            for (var pi = 1; pi < cand.length; pi++) {
                if (games[cand[pi]].openedAt > games[chosen].openedAt) chosen = cand[pi];
            }
            var target = games[chosen];

            // 6. 출제 단어 검증 후 선택된 방의 상태에 세팅
            var parts = text.split(' '); var word = parts[1] ? parts[1].trim() : "";
            if (!word) { msg.reply("사용법: !출제 [단어]"); return; }

            var jamos = decomposeToBaseJamo(word);
            if (!jamos || jamos.length !== 5) {
                var countInfo = jamos ? ('현재 ' + jamos.length + '개') : '분해 불가';
                msg.reply(
                    "\"" + word + "\" 은(는) 사용할 수 없는 단어입니다. (" + countInfo + ")\n\n" +
                    "단자음/단모음으로 분해 시 정확히 5개여야 합니다.\n" +
                    "• 쌍자음(ㄲ→ㄱ+ㄱ), 겹받침(ㄺ→ㄹ+ㄱ)은 2개로 계산\n" +
                    "• 복모음도 분해됩니다: ㅐ→ㅏ+ㅣ, ㅔ→ㅓ+ㅣ, ㅝ→ㅜ+ㅓ 등\n\n" +
                    "예) 꿩(ㄱ+ㄱ+ㅜ+ㅓ+ㅇ=5개)·꼬리·세다·배다"
                );
                return;
            }
            if (!isWordInDict(word)) {
                msg.reply("사전에 없는 단어: " + word);
                return;
            }

            target.active       = true;
            target.answer       = word;
            target.answerJamo   = jamos;
            target.attemptsLeft = 5;
            target.history      = [];
            target.awaitingWord = false;
            msg.reply("✅ 문제출제 완료! (" + target.room + ")");

            bot.send(target.room,
                "문제출제 완료. 추리를 시작하세요.\n" +
                "!정답 [단어] 로 도전! (총 5회 기회)\n" +
                "✅정위치  ⚠️포함  ❌없음"
            );
            return;
        }

        // ── !랜덤 (이 방에서 !퀴즈 실행 후에만 가능) ─────────────────────────
        if (text === '!랜덤' || text === '!랜덤출제' || text === '!랜덤퀴즈') {
            if (!st || (!st.awaitingWord && !st.active)) {
                msg.reply("먼저 퀴즈를 진행할 방에서 !퀴즈 를 입력해주세요.");
                return;
            }
            if (st.active) {
                msg.reply("이미 퀴즈가 진행 중입니다.\n!퀴즈종료 로 종료 후 다시 시도하세요.");
                return;
            }

            var result = getRandomValidWord();
            if (!result) {
                msg.reply("랜덤 단어 출제에 실패했습니다. 잠시 후 다시 시도해주세요.");
                return;
            }

            st.active       = true;
            st.answer       = result.word;
            st.answerJamo   = result.jamo;
            st.attemptsLeft = 5;
            st.history      = [];
            st.awaitingWord = false;
            st.room         = room;

            bot.send(st.room,
                "랜덤출제 완료. 추리를 시작하세요.\n" +
                "!정답 [단어] 로 도전! (총 5회 기회)\n" +
                "✅정위치  ⚠️포함  ❌없음"
            );
            return;
        }

        // ── !사전 [단어] ─────────────────────────────────────────────────────
        if (text.indexOf('!사전 ') === 0) {
            var lookupWord = text.slice('!사전 '.length).trim();
            if (!lookupWord) { msg.reply("사용법: !사전 [단어]"); return; }
            var meaning = getWordMeaning(lookupWord);
            if (meaning !== null) {
                msg.reply(lookupWord + " : " + meaning);
            } else {
                msg.reply("사전에 없는 단어: " + lookupWord);
            }
            return;
        }

        // ── !정답 [단어] / !단어 [단어] ──────────────────────────────────────
        if ((text === '!정답' || text === '!단어') && quizState && quizState.active) {
            msg.reply(buildGuessReply(quizState.history, quizState.attemptsLeft));
            return;
        }

        if (text.indexOf('!정답 ') === 0 || text.indexOf('!단어 ') === 0) {
            // 이 방(chanId)에 활성 퀴즈가 없으면: 이 방이 출제 대기방이면 안내, 아니면 무시
            if (!quizState || !quizState.active) {
                if (st) msg.reply("진행 중인 퀴즈가 없습니다.");
                return;
            }

            var prefixLen = (text.indexOf('!정답 ') === 0) ? '!정답 '.length : '!단어 '.length;
            var guess = text.slice(prefixLen).trim();
            if (!guess) { msg.reply("사용법: !정답 [단어]"); return; }

            var guessJamo = decomposeToBaseJamo(guess);
            if (!guessJamo || guessJamo.length !== 5) {
                msg.reply(
                    "유효하지 않은 단어: " + guess + "(" + (guessJamo ? (guessJamo.length + '개 사용') : '분해 불가') + ")"
                );
                return;
            }
            if (!isWordInDict(guess)) {
                msg.reply("사전에 없는 단어: " + guess);
                return;
            }

            var feedback  = getFeedback(quizState.answerJamo, guessJamo);
            var jamoLine  = guessJamo.join(' ');
            var emojiLine = feedback.join(' ');
            // 자모열이 완전히 일치하면(피드백 전부 ✅) 정답 처리.
            // 이 게임은 자모로 단어를 구분하므로 자모 동일 단어(예: 도끼/독기)는
            // 표기가 달라도 게임상 구분 불가능 → 둘 다 정답으로 인정.
            var isCorrect = (guess === quizState.answer) ||
                            feedback.every(function(e){ return e === '✅'; });

            quizState.attemptsLeft--;
            quizState.history.push({ word: guess, jamo: jamoLine, emoji: emojiLine });

            if (isCorrect) {
                var ans     = quizState.answer;
                var endMsg  = buildEndReply(quizState.history);
                resetGame(chanId);
                msg.reply(endMsg + "\n\n🎉 \"" + ans + "\" 정답입니다!");
                return;
            }

            if (quizState.attemptsLeft <= 0) {
                var ans     = quizState.answer;
                var endMsg  = buildEndReply(quizState.history);
                resetGame(chanId);
                msg.reply(endMsg + "\n\n기회를 모두 사용했습니다.\n정답 : \"" + ans + "\"");
                return;
            }

            msg.reply(buildGuessReply(quizState.history, quizState.attemptsLeft));
            return;
        }

    } catch(e) {
        try { msg.reply("오류: " + (e && e.message ? e.message : e)); } catch(_) {}
    }
}

// ─── 메시지 큐 + 워커 스레드 (ChatManager 구독, 공유 모듈) ───────────────────
var WORKER_NAME = "WORD_QUIZ_BOT_WORKER";

var subscribe = (function() {
  var libPath = "/sdcard/msgbot/lib/subscriber.js";
  try {
    if (typeof bot.getRootPath === "function") {
      libPath = bot.getRootPath() + "/../../lib/subscriber.js";
    }
  } catch(_) {}
  return require(libPath);
})();

subscribe(BOT_NAME, WORKER_NAME, function(msg) {
  if (!isMyCommand(String(msg.content || "").trim())) return;
  handleMessage(msg);
});

// ─── 보일러플레이트 ─────────────────────────────────────────────────────────
function onMessage(rawMsg) {}  // 메시지는 ChatManager 큐로 들어옴
bot.addListener(Event.MESSAGE, onMessage);

function onCommand(msg) {}
bot.setCommandPrefix("@");
bot.addListener(Event.COMMAND, onCommand);


function onCreate(savedInstanceState, activity) {
    var textView = new Packages.android.widget.TextView(activity);
    textView.setText("단어퀴즈봇");
    textView.setTextColor(Packages.android.graphics.Color.DKGRAY);
    activity.setContentView(textView);
}
function onStart(activity) {}
function onResume(activity) {}
function onPause(activity) {}
function onStop(activity) {}
function onRestart(activity) {}
function onDestroy(activity) {}
function onBackPressed(activity) {}

bot.addListener(Event.Activity.CREATE, onCreate);
bot.addListener(Event.Activity.START, onStart);
bot.addListener(Event.Activity.RESUME, onResume);
bot.addListener(Event.Activity.PAUSE, onPause);
bot.addListener(Event.Activity.STOP, onStop);
bot.addListener(Event.Activity.RESTART, onRestart);
bot.addListener(Event.Activity.DESTROY, onDestroy);
bot.addListener(Event.Activity.BACK_PRESSED, onBackPressed);
