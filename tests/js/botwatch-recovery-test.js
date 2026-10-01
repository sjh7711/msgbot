const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.resolve(__dirname, '../../Bots/ChatManager/ChatManager.js'), 'utf8');
// Run the real recovery/state-machine functions without starting the Kakao DB poller.
const recovery = source.slice(source.indexOf('function _watchRecover('), source.indexOf('// 선택 입력 파싱:'));
function harness(options = {}) {
  const records = [], powers = [], logs = [];
  let now = 100000, on = false;
  const context = {
    WATCH_BACKOFF_MS: [60000, 300000, 1800000], WATCH_TICK_MS: 30000,
    WATCH_CONFIRM_MS: 90000, WATCH_STABLE_MS: 600000, WATCH_LOG_PATH: 'botwatch.log',
    _watchLastTick: 0, _watchState: {},
    _watchFlushNotices: () => {}, _otherBotNames: () => ['eval'],
    _watchWantOf: () => options.want !== false,
    _watchDiagnostic: (...args) => records.push(args),
    _watchLog: line => logs.push(line), _watchNotify: () => {},
    _watchDiag: { errorDetail: e => e.stack },
    java: { lang: { System: { currentTimeMillis: () => now } } },
    BotManager: {
      prepare: (name, throwOnError) => {
        assert.equal(throwOnError, true);
        if (options.compileError) throw new Error('ReferenceError: missing dependency');
        return 0;
      },
      isCompiled: () => options.compiled !== false,
      setPower: (name, value) => { powers.push(value); on = value; },
      getPower: () => on
    }
  };
  vm.createContext(context); vm.runInContext(recovery, context);
  return { context, records, powers, logs, advance: ms => { now += ms; }, setOn: value => { on = value; } };
}

test('compile exception is retained and failed compilation is never labelled ON', () => {
  const h = harness({ compileError: true });
  const result = h.context._watchRecover('eval');
  assert.equal(result.ok, false);
  assert.match(result.err, /missing dependency/);
  assert.equal(h.powers.length, 0);
  assert.equal(h.records.at(-1)[1], '복구 예외');
  assert.match(h.records.at(-1)[2], /ReferenceError/);
});

test('a silent prepare failure is caught by checking compilation before enabling', () => {
  const h = harness({ compiled: false });
  assert.equal(h.context._watchRecover('eval').ok, false);
  assert.equal(h.powers.length, 0);
  assert.equal(h.records.at(-1)[1], '복구 컴파일 실패');
});

test('recovery resets OFF observation and records a new failure during backoff immediately', () => {
  const h = harness();
  h.context._watchState.eval = { tries: 0, nextAt: 0, okSince: 0, offSince: 10000, gaveUp: false };
  h.context._watchTick();
  assert.equal(h.powers.length, 1);
  assert.equal(h.context._watchState.eval.offSince, 0);
  assert.match(h.logs[0], /전원 ON 확인.*유지 여부 확인 중/);
  h.advance(30000); h.setOn(false); h.context._watchTick();
  assert.equal(h.records.at(-1)[1], 'OFF 최초 감지');
  assert.match(h.records.at(-1)[2], /30초/);
  assert.equal(h.powers.length, 1);
  h.advance(30000); h.context._watchTick();
  assert.equal(h.powers.length, 1, 'must wait for a fresh 90-second confirmation');
  assert.equal(h.records.filter(row => row[1] === 'OFF 최초 감지').length, 1);
});

test('gave-up bot still records a new OFF transition but intentionally disabled bot is untouched', () => {
  const h = harness();
  h.context._watchState.eval = { tries: 3, nextAt: 999999, offSince: 0, okSince: 90000, gaveUp: true };
  h.context._watchTick();
  assert.equal(h.records[0][1], 'OFF 최초 감지');
  assert.equal(h.powers.length, 0);
  const excluded = harness({ want: false });
  excluded.context._watchTick();
  assert.equal(excluded.records.length, 0);
  assert.equal(excluded.powers.length, 0);
});

test('subscriber preserves handler exceptions and records the reason a worker exits', () => {
  const code = fs.readFileSync(path.resolve(__dirname, '../../lib/subscriber.js'), 'utf8');
  const lifecycle = [], errors = [];
  let runnable, takes = 0;
  const group = { getParent: () => null, activeCount: () => 0, enumerate: () => 0 };
  const thread = { isInterrupted: () => false, getId: () => 42, getThreadGroup: () => group };
  function Thread(fn) { runnable = fn; this.start = () => {}; this.getId = () => 42; }
  Thread.currentThread = () => thread;
  function HashMap() { this.get = key => key === 'text' ? '!test' : ''; }
  const java = {
    lang: { Thread, System: { getProperties: () => new Map() }, reflect: { Array: { newInstance: () => [] } } },
    util: {
      HashMap, Date: function () { this.toString = () => 'Thu Oct 01 14:00:00 KST 2026'; },
      concurrent: {
        ConcurrentHashMap: function () { this.put = () => {}; },
        LinkedBlockingQueue: function () { this.take = () => {
          if (takes++ === 0) return new HashMap();
          throw new Error('java.lang.InterruptedException');
        }; }
      }
    },
    io: {
      File: function () { this.exists = () => false; },
      FileWriter: function () { this.write = line => errors.push(line); this.close = () => {}; }
    }
  };
  // java.util.Properties has put rather than JS Map.set.
  java.lang.System.getProperties = () => ({ get: () => null, put: () => {} });
  const module = { exports: {} };
  vm.runInNewContext(code, {
    java, module, BotManager: { getCurrentBot: () => ({ send: () => {} }) },
    Packages: { android: { os: { Environment: { getExternalStorageDirectory: () => ({ getAbsolutePath: () => '/sdcard' }) } } } },
    require: name => name.endsWith('/errlog.js') ? {
      recordEvent: (...args) => lifecycle.push(args), errorDetail: e => e.stack
    } : { registerThread: () => {} }
  });
  module.exports('eval', 'EVAL_BOT_WORKER', () => { throw new Error('handler exploded'); });
  assert.doesNotThrow(() => runnable());
  assert.ok(errors.some(line => /onMessage.*handler exploded/.test(line)));
  assert.ok(lifecycle.some(row => row[1] === '워커 시작'));
  assert.ok(lifecycle.some(row => row[1] === '워커 종료' && /InterruptedException/.test(row[2])));
});
