// =====================================================================
// 도움말봇 — 명령어 설명 중앙 관리 + !도움 검색 + 유사 명령 자동 제안
//
//  · ChatManager broadcast 큐를 구독(공용 subscriber.js)하여 모든 메시지를 봄.
//  · !도움 / !ㄷㅇ / !기능 / !ㄱㄴ [명령어|주제] → 관련 설명 출력 (예: !도움 상식 / !도움 zqt)
//  · 인식 안 되는 !명령(오타 등) → 편집거리/접두사 기준으로 비슷한 명령 자동 제안.
//    (가까운 게 없으면 조용히 무시 → 소음 방지)
//
//  ★ 명령어 설명은 아래 REGISTRY 한 곳에서만 관리한다.
//    다른 봇의 명령이 바뀌면 여기 REGISTRY 도 갱신할 것.
// =====================================================================

var bot = BotManager.getCurrentBot();
var BOT_NAME = "도움말봇";
var WORKER_NAME = "HELP_BOT_WORKER";

// 긴 설명 접기용 제로폭 공백 스페이서 (카카오톡 "더보기")
var LONG_MSG_SPACER = "​".repeat(500);

// ─── 명령어 레지스트리 (단일 진실원) ────────────────────────────────────────
//  topic   : 봇 이름
//  aliases : !도움 으로 이 주제를 찾을 때 쓰는 키워드
//  commands: { display(인자 포함 표기), triggers(실제 호출 토큰), desc(설명), admin(관리자/숨김) }
var REGISTRY = [
  {
    topic: "상식퀴즈봇",
    aliases: ["상식", "상식퀴즈", "퀴즈", "ㅅㅅ", "ㅈㄷ", "quiz"],
    commands: [
      { display: "!상식 / !ㅅㅅ",        triggers: ["!상식", "!ㅅㅅ"], desc: "랜덤 토픽으로 새 상식 퀴즈 출제", admin: false },
      { display: "!상식 [토픽]",         triggers: ["!상식", "!ㅅㅅ"], desc: "지정 토픽으로 새 상식 퀴즈 출제 (일일 한도 적용)", admin: false },
      { display: "!ㅈㄷ [답]",           triggers: ["!ㅈㄷ"],         desc: "답안 제출 (30초 이내, 1회만)", admin: false },
      { display: "!상식순위",            triggers: ["!상식순위"],     desc: "상식 퀴즈 순위 (점수 = 정답×10 − 오답)", admin: false },
      { display: "!상식종료",            triggers: ["!상식종료"],     desc: "진행 중 퀴즈 강제 종료 및 정답 공개", admin: false },
      { display: "!금지목록",            triggers: ["!금지목록"],     desc: "빈출 정답 상위 50개 목록 조회", admin: true },
      { display: "!이의신청 [N]",        triggers: ["!이의신청"],     desc: "최근(또는 N)회차 정답 재검증 (오답자만)", admin: false },
      { display: "!api [KEY]",          triggers: ["!api"],         desc: "Gemini API 키 등록 (토픽 한도 45회로 상향)", admin: false }
    ]
  },
  {
    topic: "단어퀴즈봇",
    aliases: ["단어퀴즈", "단어", "워들", "출제", "정답", "사전"],
    commands: [
      { display: "!퀴즈",             triggers: ["!퀴즈", "!단어퀴즈"], desc: "개인톡으로 !출제할 단어 입력 대기 시작", admin: false },
      { display: "!출제 [단어]",       triggers: ["!출제", "!퀴즈출제", "!단어출제"], desc: "개인톡에서 단어 제출 → 그 방에 퀴즈 시작", admin: false },
      { display: "!랜덤",             triggers: ["!랜덤", "!랜덤출제", "!랜덤퀴즈"], desc: "빈도 기반 랜덤 단어로 자동 출제", admin: false },
      { display: "!정답 [단어]",       triggers: ["!정답", "!단어"], desc: "자모 5개 단어로 추리 시도 (총 5회)", admin: false },
      { display: "!정답",             triggers: ["!정답", "!단어"], desc: "현재 게임 상태(시도 내역·남은 기회) 조회", admin: false },
      { display: "!퀴즈종료",          triggers: ["!퀴즈종료"],     desc: "진행 중 퀴즈 종료 및 정답 공개", admin: false },
      { display: "!사전 [단어]",       triggers: ["!사전"],         desc: "단어의 사전 뜻 조회", admin: false },
      { display: "!오늘단어",          triggers: ["!오늘단어"],     desc: "오늘의 단어 맞히기 참가자·성공/실패 집계", admin: false }
    ]
  },
  {
    topic: "내전봇",
    aliases: ["내전", "롤내전", "롤", "team", "lol", "5대5"],
    commands: [
      { display: "!닉네임",                triggers: ["!닉네임"],       desc: "내 등록 롤 닉네임 확인", admin: false },
      { display: "!닉네임등록 [롤닉]",      triggers: ["!닉네임등록"],   desc: "롤 닉네임 신규 등록/변경", admin: false },
      { display: "!닉네임재등록 [롤닉]",    triggers: ["!닉네임재등록"], desc: "카카오 계정 변경 시 hash 재연결", admin: false },
      { display: "!내전시작",              triggers: ["!내전시작"],     desc: "내전 모집 시작", admin: false },
      { display: "!내전",                  triggers: ["!내전"],         desc: "내전봇 명령어 도움말", admin: false },
      { display: "!이전게임",              triggers: ["!이전게임"],     desc: "전판 참여자 자동 참가 복원", admin: false },
      { display: "!참가 / !참가취소",       triggers: ["!참가", "!참가취소"], desc: "내전 참가 / 참가 취소", admin: false },
      { display: "!강제참가 [닉,닉,..]",    triggers: ["!강제참가"],     desc: "특정 플레이어 강제 참가 추가", admin: false },
      { display: "!시작",                  triggers: ["!시작"],         desc: "팀 배정 및 게임 시작 (짝수 인원)", admin: false },
      { display: "!팀다시짜기",            triggers: ["!팀다시짜기"],   desc: "팀 재배정 (최소 6명, 짝수)", admin: false },
      { display: "!챔프",                  triggers: ["!챔프"],         desc: "배정된 우리 팀 챔피언 확인(개인톡)", admin: false },
      { display: "!승리왼쪽 / !승리오른쪽", triggers: ["!승리왼쪽", "!승리오른쪽"], desc: "게임 결과 기록: 해당 팀 승리", admin: false },
      { display: "!초기화",                triggers: ["!초기화"],       desc: "내전 모집 상태 초기화", admin: false },
      { display: "!통계 [@이름|롤닉]",      triggers: ["!통계"],         desc: "플레이어 전적 통계 (기본: 본인)", admin: false },
      { display: "!순위",                  triggers: ["!순위"],         desc: "전체 승률 순위(숨김 제외)", admin: false },
      { display: "!ELO [롤닉]",            triggers: ["!ELO", "!elo"],  desc: "ELO 레이팅 순위 또는 특정 플레이어", admin: false },
      { display: "!파트너순위 [@이름|롤닉]", triggers: ["!파트너순위"],   desc: "함께 팀을 이룬 파트너 순위", admin: false },
      { display: "!상대전적 [@이름|롤닉]",   triggers: ["!상대전적"],     desc: "상대팀 대전 기록·승률", admin: false },
      { display: "!팀통계순위",            triggers: ["!팀통계순위"],   desc: "모든 팀 조합 승률 순위", admin: false },
      { display: "!팀통계 [닉1] [닉2]",     triggers: ["!팀통계"],       desc: "두 플레이어 팀별 승률 비교", admin: false },
      { display: "!숨기기 / !숨김해제 [롤닉]", triggers: ["!숨기기", "!숨김해제"], desc: "순위에서 플레이어 숨김/해제", admin: true },
      { display: "!내전기록 [게임ID]",      triggers: ["!내전기록"],     desc: "게임 기록 조회 (기본: 최신)", admin: false },
      { display: "!기록모드 시작",          triggers: ["!기록모드"],     desc: "수동 게임 기록 모드 시작(이후 !기록 …)", admin: true },
      { display: "!기록 왼쪽팀/오른쪽팀 [닉,..]", triggers: ["!기록"],   desc: "수동기록: 양 팀 플레이어 등록", admin: true },
      { display: "!기록 왼쪽챔프/오른쪽챔프 [챔프,..]", triggers: ["!기록"], desc: "수동기록: 양 팀 챔피언 등록", admin: true },
      { display: "!기록 승리 [left|right]", triggers: ["!기록"],         desc: "수동기록: 승리팀 입력", admin: true },
      { display: "!기록 날짜 [YYYY-MM-DD HH:MM]", triggers: ["!기록"],   desc: "수동기록: 게임 날짜 입력", admin: true },
      { display: "!기록 확인 / 저장 / 취소", triggers: ["!기록"],        desc: "수동기록 현황 확인 / 저장 / 취소", admin: true },
      { display: "!회차수정 [게임ID]",      triggers: ["!회차수정"],     desc: "게임 회차 수정 모드 진입", admin: true },
      { display: "!승리 [왼쪽|오른쪽]",     triggers: ["!승리"],         desc: "수정 모드: 승리팀 변경", admin: true },
      { display: "!챔프수정 [팀] [챔프,..]", triggers: ["!챔프수정"],     desc: "수정 모드: 챔피언 변경", admin: true },
      { display: "!수정완료",              triggers: ["!수정완료"],     desc: "회차 수정 완료 및 통계 재계산", admin: true },
      { display: "!무결성검사",            triggers: ["!무결성검사"],   desc: "플레이어 통계 무결성 검사·자동복구", admin: true },
      { display: "!undefined검사",         triggers: ["!undefined검사"], desc: "NULL 닉네임 참가 기록 검사", admin: true },
      { display: "!리로드",                triggers: ["!리로드"],       desc: "봇 스크립트 리로드 (관리자 전용)", admin: true }
    ]
  },
  {
    topic: "zqt",
    aliases: ["zqt", "게임순위", "게임기록", "z", "q", "t", "s"],
    commands: [
      { display: "!게임기록 [yyyyMMdd]",            triggers: ["!게임기록"],   desc: "게임 순위 기록 저장 (여러 줄 입력)", admin: false },
      { display: "!게임순위 [이름|키|기간]",         triggers: ["!게임순위"],   desc: "유저/게임/조합 순위·기간별 상세 조회", admin: false },
      { display: "!완승기록 [이름]",                triggers: ["!완승기록"],   desc: "모든 게임 1등(완승) 횟수", admin: false },
      { display: "!등수통계 [이름]",                triggers: ["!등수통계"],   desc: "유저의 등수 통계 (1~4등 횟수)", admin: false },
      { display: "!월간종합등수 [기간]",            triggers: ["!월간종합등수"], desc: "종합등수의 일평균 순위", admin: false },
      { display: "!유저등록 [이름]",                triggers: ["!유저등록"],   desc: "한글 1글자 유저 이름 등록", admin: false },
      { display: "!게임등록 [게임키]",              triggers: ["!게임등록"],   desc: "영문 1글자 게임키 등록", admin: false },
      { display: "!자동기록 [날짜]",                triggers: ["!자동기록"],   desc: "알림 파일 파싱하여 자동 기록", admin: false },
      { display: "!zqt",                           triggers: ["!zqt"],       desc: "zqt 봇 명령어 설명서", admin: false }
    ]
  },
  {
    topic: "메이플봇",
    aliases: ["메알림", "메이플", "이벤트", "공지", "알림", "maple"],
    commands: [
      { display: "!메알림",          triggers: ["!메알림"],        desc: "메이플 이벤트/공지 알림봇 도움말", admin: false },
      { display: "!메알림 시작",      triggers: ["!메알림 시작"],   desc: "현재 방에 이벤트/공지 알림 구독 등록", admin: false },
      { display: "!메알림 중지",      triggers: ["!메알림 중지"],   desc: "현재 방의 알림 구독 해제", admin: false },
      { display: "!메알림 상태",      triggers: ["!메알림 상태"],   desc: "폴링 상태·구독 방 목록 확인", admin: true },
      { display: "!메알림 확인",      triggers: ["!메알림 확인"],   desc: "현재 이벤트/공지 목록 (최신 10개)", admin: false },
      { display: "!메알림 초기화",    triggers: ["!메알림 초기화"], desc: "감지 목록 초기화 후 재등록", admin: true },
      { display: "!메알림 디버그 이벤트/공지", triggers: ["!메알림 디버그"], desc: "페이지 링크 샘플 출력 (디버그용)", admin: true }
    ]
  },
  {
    topic: "제미니봇",
    aliases: ["제미니", "ㅈㅁㄴ", "gemini", "질문", "ai"],
    commands: [
      { display: "!제미니 [질문] / !ㅈㅁㄴ [질문]", triggers: ["!제미니", "!ㅈㅁㄴ"], desc: "Gemini로 질문에 답변 (키 제공자 무제한, 그 외 1일 10회)", admin: false }
    ]
  },
  {
    topic: "도움말봇",
    aliases: ["도움말", "도움", "검색", "help", "명령어"],
    commands: [
      { display: "!도움 [명령어|주제]", triggers: ["!도움", "!ㄷㅇ", "!기능", "!ㄱㄴ"], desc: "명령어/주제 설명 검색. 인자 없으면 주제 목록", admin: false }
    ]
  },
  {
    topic: "ChatManager",
    aliases: ["chatmanager", "관리", "카톡", "메시지"],
    commands: [
      { display: "!상태",          triggers: ["!상태"],   desc: "등록된 모든 봇의 전원/컴파일 상태", admin: true },
      { display: "!onoff",         triggers: ["!onoff"],  desc: "봇 전원 on/off 토글 (번호 선택, 다중)", admin: true },
      { display: "!compile",       triggers: ["!compile", "!컴파일"], desc: "봇 재컴파일 (번호 선택, 다중/전체)", admin: true },
      { display: "!취소",          triggers: ["!취소"],   desc: "봇 선택 대기 취소", admin: true },
      { display: "!해체 [_id]",     triggers: ["!해체"],   desc: "메시지 복호화 분석(댓글/답장 응답)", admin: true }
    ]
  }
];

// ─── 평탄화 인덱스 ───────────────────────────────────────────────────────────
var FLAT_CMDS = [];
(function buildFlat() {
  for (var i = 0; i < REGISTRY.length; i++) {
    var t = REGISTRY[i];
    for (var j = 0; j < t.commands.length; j++) {
      var c = t.commands[j];
      FLAT_CMDS.push({ display: c.display, triggers: c.triggers, desc: c.desc, admin: !!c.admin, topic: t.topic });
    }
  }
})();

// ─── 유틸 ────────────────────────────────────────────────────────────────────
function leadToken(text) {
  var t = String(text).trim();
  var sp = t.search(/\s/);
  return (sp === -1) ? t : t.substring(0, sp);
}

// 편집거리(Levenshtein). 한글은 아래 decomposeJamo 로 자모열로 바꾼 뒤 비교한다(suggestSimilar).
function lev(a, b) {
  a = String(a); b = String(b);
  var m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  var prev = [], cur = [], i, j;
  for (j = 0; j <= n; j++) prev[j] = j;
  for (i = 1; i <= m; i++) {
    cur[0] = i;
    for (j = 1; j <= n; j++) {
      var cost = (a.charAt(i - 1) === b.charAt(j - 1)) ? 0 : 1;
      var del = prev[j] + 1, ins = cur[j - 1] + 1, sub = prev[j - 1] + cost;
      var mn = del < ins ? del : ins; if (sub < mn) mn = sub;
      cur[j] = mn;
    }
    for (j = 0; j <= n; j++) prev[j] = cur[j];
  }
  return prev[n];
}

// ─── 한글 자모 분해 / 초성 추출 (유사도 매칭용) ──────────────────────────────
// 완성형 한글 음절(가-힣)을 초성+중성+종성 자모열로 분해. 비한글/호환자모는 그대로 통과.
// 자모 단위로 비교하면 받침·모음 1개 차이 같은 "한 끗 오타"를 음절 단위보다 정확히 잡는다.
var _CHO  = ["ㄱ","ㄲ","ㄴ","ㄷ","ㄸ","ㄹ","ㅁ","ㅂ","ㅃ","ㅅ","ㅆ","ㅇ","ㅈ","ㅉ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ"];
var _JUNG = ["ㅏ","ㅐ","ㅑ","ㅒ","ㅓ","ㅔ","ㅕ","ㅖ","ㅗ","ㅘ","ㅙ","ㅚ","ㅛ","ㅜ","ㅝ","ㅞ","ㅟ","ㅠ","ㅡ","ㅢ","ㅣ"];
var _JONG = ["","ㄱ","ㄲ","ㄳ","ㄴ","ㄵ","ㄶ","ㄷ","ㄹ","ㄺ","ㄻ","ㄼ","ㄽ","ㄾ","ㄿ","ㅀ","ㅁ","ㅂ","ㅄ","ㅅ","ㅆ","ㅇ","ㅈ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ"];
function decomposeJamo(s) {
  s = String(s);
  var out = "";
  for (var i = 0; i < s.length; i++) {
    var code = s.charCodeAt(i);
    if (code >= 0xAC00 && code <= 0xD7A3) {
      var idx = code - 0xAC00;
      out += _CHO[Math.floor(idx / 588)] + _JUNG[Math.floor((idx % 588) / 28)] + _JONG[idx % 28];
    } else {
      out += s.charAt(i);
    }
  }
  return out;
}
// 초성열 추출: 음절→초성, 호환 자음자모(ㄱ~ㅎ)→그대로, 그 외("!"·모음·영문)→무시.
function chosung(s) {
  s = String(s);
  var out = "";
  for (var i = 0; i < s.length; i++) {
    var code = s.charCodeAt(i);
    if (code >= 0xAC00 && code <= 0xD7A3) out += _CHO[Math.floor((code - 0xAC00) / 588)];
    else if (code >= 0x3131 && code <= 0x314E) out += s.charAt(i);
  }
  return out;
}

// 메시지가 등록된 명령으로 인식되는가 (정확 일치 또는 "트리거 + 공백" 접두 → 다른 봇이 처리)
function isKnownCommand(text) {
  var t = String(text).trim();
  for (var i = 0; i < FLAT_CMDS.length; i++) {
    var trigs = FLAT_CMDS[i].triggers;
    for (var j = 0; j < trigs.length; j++) {
      var tr = trigs[j];
      if (t === tr) return true;
      if (t.indexOf(tr + " ") === 0) return true;
    }
  }
  return false;
}

// ─── 검색 ────────────────────────────────────────────────────────────────────
function helpHeader() { return "명령어와 관련된 설명입니다." + LONG_MSG_SPACER + "\n"; }

function topicListLine() {
  var ts = [];
  for (var i = 0; i < REGISTRY.length; i++) ts.push(REGISTRY[i].topic);
  return ts.join(", ");
}

function findTopic(q) {
  var ql = String(q).toLowerCase();
  // 정확 일치 우선 (topic 또는 alias)
  for (var i = 0; i < REGISTRY.length; i++) {
    var t = REGISTRY[i];
    if (t.topic.toLowerCase() === ql) return t;
    for (var j = 0; j < t.aliases.length; j++) if (t.aliases[j].toLowerCase() === ql) return t;
  }
  // 부분 일치 (topic/alias 가 질의를 포함)
  for (var k = 0; k < REGISTRY.length; k++) {
    var t2 = REGISTRY[k];
    if (t2.topic.toLowerCase().indexOf(ql) !== -1) return t2;
    for (var m = 0; m < t2.aliases.length; m++) if (t2.aliases[m].toLowerCase().indexOf(ql) !== -1) return t2;
  }
  return null;
}

function findCommands(q) {
  var ql = String(q).toLowerCase();
  var out = [], seen = {};
  for (var i = 0; i < FLAT_CMDS.length; i++) {
    var c = FLAT_CMDS[i];
    var hit = (c.display.toLowerCase().indexOf(ql) !== -1);
    if (!hit) {
      for (var j = 0; j < c.triggers.length; j++) {
        if (c.triggers[j].toLowerCase().indexOf(ql) !== -1) { hit = true; break; }
      }
    }
    if (hit && !seen[c.display]) { seen[c.display] = true; out.push(c); }
  }
  return out;
}

function formatTopic(topic) {
  var lines = ["[" + topic.topic + " 명령어]"];
  var admins = [];
  for (var i = 0; i < topic.commands.length; i++) {
    var c = topic.commands[i];
    if (c.admin) { admins.push("• " + c.display + "\n   └ " + c.desc); continue; }
    lines.push("• " + c.display + "\n   └ " + c.desc);
  }
  if (admins.length) { lines.push(""); lines.push("[관리자 전용]"); for (var k = 0; k < admins.length; k++) lines.push(admins[k]); }
  return lines.join("\n");
}

function formatCommands(cmds) {
  var lines = [];
  for (var i = 0; i < cmds.length; i++) {
    var c = cmds[i];
    lines.push("• " + c.display + (c.admin ? " (관리자)" : "") + "  [" + c.topic + "]\n   └ " + c.desc);
  }
  return lines.join("\n");
}

function handleSearch(arg) {
  arg = String(arg || "").trim();
  if (!arg) {
    return helpHeader() +
      "사용법: !도움 [명령어 또는 주제]\n" +
      "예) !도움 상식   !도움 zqt   !도움 출제\n\n" +
      "[검색 가능한 주제]\n" + topicListLine();
  }
  var q = arg.replace(/^!+/, "");
  var topic = findTopic(q);
  if (topic) return helpHeader() + formatTopic(topic);
  var cmds = findCommands(q);
  if (cmds.length) return helpHeader() + formatCommands(cmds);
  var sg = suggestSimilar("!" + q);
  if (sg) return "검색 결과가 없습니다.\n\n" + sg;
  return "검색 결과가 없습니다.\n\n[검색 가능한 주제]\n" + topicListLine();
}

// 입력이 "초성만"인가? (예: !ㅁㅇㅍ) — 완성 음절·모음이 없고 자음 호환자모만 있을 때.
function isChosungQuery(token) {
  var hasCons = false;
  for (var i = 0; i < token.length; i++) {
    var code = token.charCodeAt(i);
    if (code >= 0xAC00 && code <= 0xD7A3) return false;   // 완성 음절 → 초성쿼리 아님
    if (code >= 0x314F && code <= 0x3163) return false;   // 모음 호환자모 → 아님
    if (code >= 0x3131 && code <= 0x314E) hasCons = true; // 자음 호환자모
  }
  return hasCons;
}

// ─── 유사 명령 제안 (A: 자모 단위 편집거리, B: 초성 매칭) ─────────────────────
var JAMO_MAX = 2;   // 자모 단위 편집거리 임계값(1~2 = 한글 1~2키 오타). 필요시 조정.
function suggestSimilar(token) {
  token = String(token || "");
  if (token.length < 2) return null;                 // "!" 단독 등 무시
  var tokC = chosung(token);                         // 입력의 초성열
  var lines = [], seen = {};

  // 초성만으로 친 경우(예: !ㅁㅇㅍ): 봇 이름/별칭/명령의 초성과 "정확히" 일치하는 것만 제안.
  // (자음만 있는 짧은 입력은 자모 편집거리가 노이즈를 만들어 — 예: !ㅁㅇㅍ↔!ㄷㅇ — 거리 비교를 쓰지 않음)
  if (isChosungQuery(token)) {
    if (tokC.length < 2) return null;
    // 1) 주제(봇 이름/별칭) 초성 일치 → 그 봇의 일반 명령 제안
    for (var t = 0; t < REGISTRY.length && lines.length < 6; t++) {
      var topic = REGISTRY[t];
      var topicHit = (chosung(topic.topic) === tokC);
      if (!topicHit) {
        for (var a = 0; a < topic.aliases.length; a++) {
          if (chosung(topic.aliases[a]) === tokC) { topicHit = true; break; }
        }
      }
      if (!topicHit) continue;
      for (var ci = 0; ci < topic.commands.length && lines.length < 6; ci++) {
        var cc = topic.commands[ci];
        if (cc.admin || seen[cc.display]) continue;
        seen[cc.display] = true;
        lines.push(cc.display + " : " + cc.desc);
      }
    }
    // 2) 명령 트리거 초성 일치도 추가
    for (var f = 0; f < FLAT_CMDS.length && lines.length < 6; f++) {
      var fc = FLAT_CMDS[f];
      if (fc.admin || seen[fc.display]) continue;
      var hit = false;
      for (var g = 0; g < fc.triggers.length; g++) {
        if (chosung(fc.triggers[g]) === tokC) { hit = true; break; }
      }
      if (hit) { seen[fc.display] = true; lines.push(fc.display + " : " + fc.desc); }
    }
    if (!lines.length) return null;
    return "비슷한 명령어 목록입니다.\n" + lines.join("\n");
  }

  // 일반 입력(완성 음절 포함): 자모 편집거리(A) + 트리거 초성(B) + 접두사
  var tokJ = decomposeJamo(token);
  var cand = [];
  for (var i = 0; i < FLAT_CMDS.length; i++) {
    var c = FLAT_CMDS[i];
    if (c.admin) continue;                           // 관리자/숨김 명령은 제안하지 않음
    var best = 999;
    for (var j = 0; j < c.triggers.length; j++) {
      var tr = c.triggers[j];
      var score;
      if (token.indexOf(tr) === 0 || tr.indexOf(token) === 0) {
        score = 0;                                   // 접두사 일치(가장 강함)
      } else {
        score = lev(tokJ, decomposeJamo(tr));        // A: 자모 단위 편집거리
        // B: 초성열이 완전히 같으면(2자 이상) 보조 신호로 끌어올림(받침·모음만 틀린 오타)
        if (tokC.length >= 2 && tokC === chosung(tr) && score > 1.5) score = 1.5;
      }
      if (score < best) best = score;
    }
    if (best === 0 || best === 1.5 || (best <= JAMO_MAX && token.length >= 3)) {
      cand.push({ display: c.display, desc: c.desc, score: best });
    }
  }
  if (!cand.length) return null;                     // 가까운 게 없으면 침묵
  cand.sort(function(a, b) { return a.score - b.score; });
  for (var k = 0; k < cand.length && lines.length < 6; k++) {
    if (seen[cand[k].display]) continue;
    seen[cand[k].display] = true;
    lines.push(cand[k].display + " : " + cand[k].desc);
  }
  return "비슷한 명령어 목록입니다.\n" + lines.join("\n");
}

// ─── 메시지 처리 ─────────────────────────────────────────────────────────────
var HELP_TRIGGERS = ["!도움", "!ㄷㅇ", "!기능", "!ㄱㄴ"];   // 도움말봇 호출 명령
function isHelpTrigger(text) {
  for (var i = 0; i < HELP_TRIGGERS.length; i++) {
    if (text === HELP_TRIGGERS[i] || text.indexOf(HELP_TRIGGERS[i] + " ") === 0) return true;
  }
  return false;
}
function handleHelp(msg) {
  var text = String(msg.content || "").trim();
  if (text.indexOf("!") !== 0) return;               // 명령 아님
  // 도움말 호출 (!도움 / !ㄷㅇ / !기능 / !ㄱㄴ)
  if (isHelpTrigger(text)) {
    var arg = "";
    var sp = text.indexOf(" ");
    if (sp !== -1) arg = text.substring(sp + 1);
    try { msg.reply(handleSearch(arg)); } catch(_) {}
    return;
  }
  // 그 외 !명령: 알려진 명령이면 다른 봇이 처리 → 침묵
  if (isKnownCommand(text)) return;
  // 모르는 명령이면 유사 명령 제안 (없으면 침묵)
  var sg = suggestSimilar(leadToken(text));
  if (sg) { try { msg.reply(sg); } catch(_) {} }
}

// ─── ChatManager 구독 (공용 모듈) ────────────────────────────────────────────
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
  try { handleHelp(msg); } catch(_) {}
});

// ─── 보일러플레이트 ─────────────────────────────────────────────────────────
function onMessage(msg) {}  // 메시지는 ChatManager 큐로 들어옴
bot.addListener(Event.MESSAGE, onMessage);

function onCreate(savedInstanceState, activity) {
  var textView = new Packages.android.widget.TextView(activity);
  textView.setText("도움말봇");
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
