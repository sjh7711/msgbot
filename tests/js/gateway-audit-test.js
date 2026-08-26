// lib/gateway.js + 상식퀴즈봇 근거 주입 배선 검증
const fs = require('fs'), vm = require('vm'), path = require('path'), os = require('os');
let pass = 0, fail = 0;
function check(n, a, e) { const x = JSON.stringify(a), y = JSON.stringify(e);
  if (x === y) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + '\n    기대: ' + y + '\n    실제: ' + x); } }

const QSRC = fs.readFileSync('e:/msgbot/Bots/상식퀴즈봇/상식퀴즈봇.js', 'utf8');

// gateway.js 를 가짜 HTTP 와 함께 올린다
function loadGw(responder, opts) {
  const o = opts || {};
  const SD = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-'));
  fs.mkdirSync(path.join(SD, 'msgbot'), { recursive: true });
  if (!o.noKey) fs.writeFileSync(path.join(SD, 'msgbot', 'qwen_key'), 'K\n');
  const log = [];
  function JFile(p) { this._p = String(p); this.exists = () => fs.existsSync(this._p); }
  const ctx = {
    JSON, Math, String, Number, Array, Object, RegExp, Date, console,
    Packages: { android: { os: { Environment: { getExternalStorageDirectory: () => ({ getAbsolutePath: () => SD }) } } } },
    java: {
      io: { File: JFile,
        FileInputStream: function (f) { this._t = fs.readFileSync(f._p, 'utf8'); },
        InputStreamReader: function (s) { return s; },
        BufferedReader: function (r) { const t = r._t || ''; const L = t.length ? t.split(/\r?\n/) : [];
          if (L.length && L[L.length - 1] === '') L.pop(); let i = 0;
          this.readLine = () => (i < L.length ? L[i++] : null); this.close = () => {}; },
        OutputStreamWriter: function (out) { this.write = (s) => out.write(String(s)); this.flush = () => {}; this.close = () => {}; } },
      lang: { StringBuilder: function () { this._s = ''; this.append = (x) => { this._s += String(x); return this; }; this.toString = () => this._s; } },
      net: { URL: function (u) { this.openConnection = () => {
        const req = { url: String(u), body: '', headers: {} }; log.push(req);
        const out = { write: (s) => { req.body += s; } };
        return { setRequestMethod: (m) => { req.method = String(m); },
                 setRequestProperty: (k, v) => { req.headers[String(k)] = String(v); },
                 setDoOutput: () => {}, setConnectTimeout: (v) => { req.ct = v; }, setReadTimeout: (v) => { req.rt = v; },
                 getOutputStream: () => out,
                 getResponseCode: () => { req.res = responder(req); return req.res.code; },
                 getInputStream: () => ({ _t: req.res.text }), getErrorStream: () => ({ _t: req.res.text }),
                 disconnect: () => {} }; }; } },
    },
    module: { exports: {} },
  };
  ctx.require = () => ({});
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync('e:/msgbot/lib/gateway.js', 'utf8'), ctx, { filename: 'gateway.js' });
  return { mod: ctx.module.exports, log };
}

const OK = () => ({ code: 200, text: JSON.stringify({ route: 'web_search', answer: '호영과 라라는 아니마 [S1]',
  sources: [{ source_id: 'S1', title: '나무위키', final_url: 'https://namu.wiki/x' }], elapsed_ms: 4800 }) });

console.log('\n[1] 요청 형태');
{
  const g = loadGw(OK);
  const r = g.mod.search('메이플스토리 사실 확인. 레프 종족?', 3);
  const b = JSON.parse(g.log[0].body);
  check('endpoint', g.log[0].url, 'http://192.168.0.55:18082/v1/ask');
  check('mode=search 고정', b.mode, 'search');
  check('언어', b.language, 'ko');
  check('max_results', b.max_results, 3);
  check('Authorization', g.log[0].headers.Authorization, 'Bearer K');
  check('연결 타임아웃 짧게', g.log[0].ct <= 5000, true);
  check('읽기 타임아웃 20초', g.log[0].rt, 20000);
  check('결과', [r.answer, r.sources.length], ['호영과 라라는 아니마 [S1]', 1]);
}

console.log('\n[2] 실패는 예외 대신 { error } — 출제를 막지 않는다');
{
  check('연결 실패', !!loadGw(() => { throw new Error('refused'); }).mod.search('메이플 종족').error, true);
  check('429', !!loadGw(() => ({ code: 429, text: '{"detail":"한도"}' })).mod.search('메이플 종족').error, true);
  check('빈 answer', !!loadGw(() => ({ code: 200, text: '{"answer":""}' })).mod.search('메이플 종족').error, true);
  // 출처 없는 답은 모델 기억과 다를 바 없다 — 근거로 쓰면 안 된다
  check('출처 0개는 근거 아님',
        loadGw(() => ({ code: 200, text: '{"answer":"그렇다","sources":[]}' })).mod.search('메이플 종족').error, '출처 없는 응답');
  check('키 없음', !!loadGw(OK, { noKey: true }).mod.search('메이플 종족').error, true);
  check('짧은 질의', !!loadGw(OK).mod.search('x').error, true);
}

console.log('\n[3] 상식퀴즈봇 배선');
{
  check('게이트웨이 모듈 방어적 로드', /var GATEWAY = \(function\(\)[\s\S]{0,320}catch\(_\) \{ return null; \}/.test(QSRC), true);
  check('근거 조회 함수', /function fetchAuditEvidence\(topic, question, choices, answerText\)/.test(QSRC), true);
  check('  → GATEWAY 없으면 즉시 null', /if \(!GATEWAY\) return null;/.test(QSRC), true);
  check('  → 어떤 실패도 null (출제 계속)', /catch \(_\) \{ return null; \}/.test(QSRC), true);
  check('사용자 지정 토픽에서만 (조회 위치: generateQuiz)', /var evidence = customTopic\s*[\r\n]+\s*\? fetchAuditEvidence/.test(QSRC), true);
  check('근거를 감사 대상에 실음', /auditTarget\.evidence = evidence\.answer;/.test(QSRC), true);
  check('출처도 함께', /auditTarget\.evidence_sources = srcList;/.test(QSRC), true);
  check('근거 우선 지시', /기억과 evidence 가 다르면 evidence 를 우선/.test(QSRC), true);
  check('  → 근거 없으면 지시도 없음', /\(evidence \? "evidence/.test(QSRC), true);
  check('  → 미언급을 부정으로 보지 않게', /부정된 것으로 보지 말고/.test(QSRC), true);
  check('생성은 별도 스레드 (워커 안 막음)',
        QSRC.indexOf('new java.lang.Thread') < QSRC.indexOf('data = generateQuiz(customTopic, room)'), true);
}


// ── 이의신청 근거 (2026-08-26 추가) ──────────────────────────────
console.log('\n[4] 이의신청도 검색 근거를 쓴다');
{
  check('근거 조회 (토픽 조건 없음)', /var appealEvidence = fetchAuditEvidence\(/.test(QSRC), true);
  check('  → round.topic 을 질의에 사용', /round\.topic \|\| "상식", round\.question, round\.choices/.test(QSRC), true);
  check('  → topic 을 실제로 읽어옴 (SELECT)', /appeal_verdict, topic " \+/.test(QSRC), true);
  check('  → readRoundCursor 가 채움', /topic: cur\.getString\(9\) \|\| ""/.test(QSRC), true);
  check('프롬프트에 근거 블록', /evidenceBlock \+ "출제자 해설: "/.test(QSRC), true);
  check('  → 근거 우선 지시', /이 근거가 다르면 근거를 우선하세요/.test(QSRC), true);
  check('  → 미언급을 부정으로 보지 않게', /근거가 다루지 않은 내용은 부정된 것으로 보지 말고/.test(QSRC), true);
  check('  → 근거 없으면 블록은 빈 문자열', /var evidenceBlock = "";/.test(QSRC), true);
}
{
  // 실패해도 판정은 진행하되, 무엇에 기대어 판정했는지 밝힌다
  check('사용 여부를 결과에 실음', /data\._evidenceUsed = !!appealEvidence;/.test(QSRC), true);
  check('근거 있음 표시', /🔎 웹 검색 근거를 확인해 판정했습니다/.test(QSRC), true);
  check('근거 없음 경고', /⚠ 검색 근거를 확인하지 못해 모델 지식만으로 판정했습니다/.test(QSRC), true);
}

console.log('\n[5] 출제 실패 기록 (2026-08-26)');
{
  check('실패 테이블', /CREATE TABLE IF NOT EXISTS quiz_gen_failure/.test(QSRC), true);
  check('  → 후보 원문까지 저장', /" question TEXT," \+/.test(QSRC) && /" choices TEXT," \+/.test(QSRC), true);
  check('기록 함수', /function logGenFailure\(room, topic, isCustom, attempt, reason, cand\)/.test(QSRC), true);
  check('  → 보관 상한', /GEN_FAILURE_KEEP = 300/.test(QSRC), true);
  check('  → 오래된 것부터 정리', /DELETE FROM quiz_gen_failure WHERE rowid NOT IN/.test(QSRC), true);
  check('반복 상단에서 직전 후보 기록',
        /logGenFailure\(room, topic, !!customTopic, attempt, lastError, data\)/.test(QSRC), true);
  check('마지막 시도도 기록',
        /logGenFailure\(room, topic, !!customTopic, MAX_GEN_ATTEMPTS, lastError, data\)/.test(QSRC), true);
  check('토픽 검증 불가 즉시종료 경로도 기록',
        /logGenFailure\(room, topic, true, attempt \+ 1, lastError, data\)/.test(QSRC), true);
  check('조회 명령', /var FAIL_CMD = "!출제실패";/.test(QSRC), true);
  check('  → 관리자만 (아니면 무응답)',
        /function handleGenFailure[\s\S]{0,160}ADMIN\.isAdmin\(msg\.author\.hash\)\) return;/.test(QSRC), true);
  check('  → 디스패치', /text === FAIL_CMD \|\| text\.indexOf\(FAIL_CMD \+ " "\) === 0/.test(QSRC), true);
  const help = fs.readFileSync('e:/msgbot/Bots/도움말봇/도움말봇.js', 'utf8');
  const rows = help.split('\n').filter((l) => /"!출제실패"/.test(l));
  check('도움말 2개 전부 숨김', [rows.length, rows.filter((l) => /admin: true/.test(l)).length], [2, 2]);
}

console.log('\n[6] 쓰이지 않는 필드는 반려가 아니라 정규화');
{
  // 실측: !상식 서울시립대학교 4시도 중 3시도가 이 형식 하나로 날아갔다.
  // 문제 자체는 멀쩡했고, 채점에 쓰지도 않는 필드였다.
  check('객관식 acceptable → 비움', /if \(data\.acceptable\.length !== 0\) data\.acceptable = \[\];/.test(QSRC), true);
  check('  → 더는 반려하지 않음', /"객관식 허용답안 배열이 비어있지 않음"/.test(QSRC), false);
  check('주관식 choices → 비움', /if \(data\.choices\.length !== 0\) data\.choices = \[\];/.test(QSRC), true);
  check('  → 더는 반려하지 않음', /"주관식 보기 배열이 비어있지 않음"/.test(QSRC), false);
  // 진짜 형식 오류는 그대로 반려해야 한다
  check('정답 번호 형식은 여전히 반려', /"객관식 정답 형식 오류: "/.test(QSRC), true);
  check('보기 수 오류도 여전히 반려', /"객관식 보기 수 오류"/.test(QSRC), true);
  check('주관식 허용답안 수는 여전히 검사', /"주관식 허용답안 수 오류: "/.test(QSRC), true);
  const py = fs.readFileSync('e:/msgbot/tests/quiz_policy_regression.py', 'utf8');
  check('Python 미러도 같이 바뀜',
        /candidate\["acceptable"\] = \[\]/.test(py) && /candidate\["choices"\] = \[\]/.test(py), true);
}

console.log('\n[7] 근거가 있으면 현재·최신 사전 차단을 푼다');
{
  // 실측: "!상식 서울시립대학교" 4시도가 모두 이 사유로 반려됐다. 문항은 전신 기관·
  // 상징동물 같은 역사·안정 사실이었고 "현재"는 대상을 가리키는 지시어였다.
  check('정책이 근거 여부를 받는다',
        /function localQuizPolicyError\(data, referenceDate, isCustomTopic, hasEvidence\)/.test(QSRC), true);
  check('  → 지정 토픽 + 근거일 때만 통과',
        /if \(!\(isCustomTopic && hasEvidence\) &&/.test(QSRC), true);
  check('근거를 로컬 정책보다 먼저 조회',
        QSRC.indexOf('var evidence = customTopic') < QSRC.indexOf('var localPolicyError = localQuizPolicyError'), true);
  check('  → 정책에 넘긴다',
        /localQuizPolicyError\(data, referenceDate, !!customTopic, !!evidence\)/.test(QSRC), true);
  check('감사에도 같은 근거를 넘긴다 (재조회 없음)',
        /auditQuiz\(data, topic, wantMulti, answerText, room, referenceDate, !!customTopic, evidence\)/.test(QSRC), true);
  check('  → 감사는 넘겨받은 것만 씀', /var evidence = preEvidence \|\| null;/.test(QSRC), true);
  check('  → 감사 안에서 다시 조회하지 않음', /var evidence = isCustomTopic\s*\n\s*\? fetchAuditEvidence/.test(QSRC), false);
  const py = fs.readFileSync('e:/msgbot/tests/quiz_policy_regression.py', 'utf8');
  check('Python 미러도 같은 게이트', /evidence_available: bool = False/.test(py), true);
  check('  → 게이트 회귀 단언 존재', /def assert_evidence_gate\(\)/.test(py), true);
  check('  → main 에서 실행', /assert_evidence_gate\(\)\s*\n\s*assert_javascript_contract\(\)/.test(py), true);
}

console.log('\n' + (fail === 0 ? '✅ ' : '❌ ') + pass + ' 통과, ' + fail + ' 실패');
process.exit(fail === 0 ? 0 : 1);
