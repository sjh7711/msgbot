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
  check('사용자 지정 토픽에서만', /var evidence = isCustomTopic\s*[\r\n]+\s*\? fetchAuditEvidence/.test(QSRC), true);
  check('근거를 감사 대상에 실음', /auditTarget\.evidence = evidence\.answer;/.test(QSRC), true);
  check('출처도 함께', /auditTarget\.evidence_sources = srcList;/.test(QSRC), true);
  check('근거 우선 지시', /기억과 evidence 가 다르면 evidence 를 우선/.test(QSRC), true);
  check('  → 근거 없으면 지시도 없음', /\(evidence \? "evidence/.test(QSRC), true);
  check('  → 미언급을 부정으로 보지 않게', /부정된 것으로 보지 말고/.test(QSRC), true);
  check('생성은 별도 스레드 (워커 안 막음)',
        QSRC.indexOf('new java.lang.Thread') < QSRC.indexOf('data = generateQuiz(customTopic, room)'), true);
}

console.log('\n' + (fail === 0 ? '✅ ' : '❌ ') + pass + ' 통과, ' + fail + ' 실패');
process.exit(fail === 0 ? 0 : 1);
