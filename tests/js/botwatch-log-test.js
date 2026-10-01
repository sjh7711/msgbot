// Run: node --test tests/js/botwatch-log-test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const sd = '/storage/emulated/0';
const watchPath = sd + '/msgbot/botwatch.log';
const errSource = fs.readFileSync(path.join(root, 'lib/errlog.js'), 'utf8');
const botSource = fs.readFileSync(path.join(root, 'Bots/로그봇/로그봇.js'), 'utf8');

// Exercise the real collector and subscribed message handler without Android or a live chat.
function harness(contents, options = {}) {
  const files = {};
  if (contents !== null) files[watchPath] = contents;
  let reads = 0;
  const io = {
    File: function (name) {
      this.name = name;
      this.exists = () => Object.hasOwn(files, name);
      this.isFile = () => true;
    },
    FileInputStream: function (name) {
      reads++;
      if (options.readError) throw new Error('Permission denied');
      this.name = typeof name === 'string' ? name : name.name;
    },
    InputStreamReader: function (stream) { this.name = stream.name; },
    BufferedReader: function (reader) {
      const lines = files[reader.name].split('\n');
      let index = 0;
      this.readLine = () => index < lines.length ? lines[index++] : null;
      this.close = () => {};
    }
  };
  const Packages = { android: {
    os: { Environment: { getExternalStorageDirectory: () => ({ getAbsolutePath: () => sd }) } },
    database: { sqlite: { SQLiteDatabase: {
      openOrCreateDatabase: () => ({ execSQL: () => {}, isOpen: () => true })
    } } }
  } };
  const module = { exports: {} };
  vm.runInNewContext(errSource, { module, Packages, java: { io } });
  const errlog = module.exports;
  let onMessage;
  const bot = { getRootPath: () => sd + '/msgbot/Bots/로그봇', addListener: () => {}, setCommandPrefix: () => {} };
  const admin = { levelOf: () => 2, isAdmin: hash => hash === 'admin' };
  vm.runInNewContext(botSource, {
    Packages, BotManager: { getCurrentBot: () => bot }, Event: { Activity: {} },
    require(name) {
      if (name.endsWith('/subscriber.js')) return (botName, workerName, handler) => { onMessage = handler; };
      if (name.endsWith('/errlog.js')) return options.oldModule ? { collect: () => ({}) } : errlog;
      if (name.endsWith('/admin.js')) return options.noAdmin ? null : admin;
      if (name.endsWith('/kakao-decrypt.js')) return {};
      if (name.endsWith('/deletedchat.js')) return { CMD: '!지운채팅', handle: () => false };
      throw new Error('Unexpected dependency: ' + name);
    }
  });
  return {
    errlog,
    reads: () => reads,
    command(content, hash = 'admin') {
      const replies = [];
      onMessage({ content, hash, reply: text => replies.push(text) });
      return replies.join('\n');
    }
  };
}

const fixture = [
  '2026-10-01 13:40:31  eval 복구 포기 — 수동 확인 필요',
  '2026-10-01 12:58:00  eval OFF 감지 → 복구 성공 (1회차)',
  '2026-10-01 13:00:00  도움말봇 OFF 감지 → 복구 성공 (1회차)',
  '2026-10-01 13:02:00  eval OFF 감지 → 복구 실패 (2회차): setPower 후에도 OFF',
  '2026-10-01 13:08:00  eval OFF 감지 → 복구 성공 (3회차)',
  '2026-10-01 13:10:00  도움말봇 안정 — 복구 카운터 리셋 (1회 후)',
  '2026-10-01 13:11:00  이름 있는 봇 복구 포기 — 수동 확인 필요',
  'partial write without a timestamp'
].join('\n');

test('collects successful recovery, failures, abandonment and stability by the affected bot', () => {
  const h = harness(fixture);
  const result = h.errlog.collectWatch('EVAL');
  assert.equal(result.entries.length, 4);
  assert.equal(result.skipped, 1);
  assert.equal(result.entries[0].ts, '2026-10-01 12:58:00');
  assert.equal(result.entries[3].ts, '2026-10-01 13:40:31');
  assert.equal(result.entries[3].bot, 'eval');
  assert.match(result.entries[3].text, /복구 포기/);
  assert.match(h.errlog.collectWatch('도움말').entries[1].text, /안정/);
  assert.equal(h.errlog.collectWatch('이름 있는 봇').entries[0].bot, '이름 있는 봇');
});

test('chat command filters before limiting and includes the supplied incident timestamp', () => {
  const output = harness(fixture).command('  !봇로그 eval 2  ');
  assert.match(output, /최근 2건 \(조회된 기록 4건\)/);
  assert.match(output, /2026-10-01 13:40:31 \[eval\]\n복구 포기/);
  assert.ok(output.indexOf('13:08:00') < output.indexOf('13:40:31'));
  assert.doesNotMatch(output, /도움말봇|12:58:00|13:02:00/);
  assert.match(output, /형식을 읽지 못한 기록 1줄/);
  assert.match(output, /종료 원인 자체는 기록되지 않을 수/);
});

test('default shows the latest 15 and count-only form shows the requested number', () => {
  const rows = Array.from({ length: 20 }, (_, i) =>
    '2026-10-01 13:' + String(i).padStart(2, '0') + ':00  eval OFF 감지 → 복구 성공 (1회차)');
  const h = harness(rows.join('\n'));
  const output = h.command('!봇로그');
  assert.equal((output.match(/\[eval\]/g) || []).length, 15);
  assert.doesNotMatch(output, /13:04:00/);
  assert.match(output, /13:05:00/);
  assert.equal((h.command('!봇로그 3').match(/\[eval\]/g) || []).length, 3);
});

test('admin checks fail closed and unauthorized requests do not read files', () => {
  for (const options of [{}, { noAdmin: true }]) {
    const h = harness(fixture, options);
    assert.match(h.command('!봇로그 eval', options.noAdmin ? 'admin' : 'stranger'), /관리자만/);
    assert.equal(h.reads(), 0);
  }
});

test('missing, empty, unmatched, malformed and unreadable logs are distinguished', () => {
  assert.match(harness(null).command('!봇로그'), /파일이 아직 없습니다/);
  assert.match(harness('').command('!봇로그'), /조회 조건에 맞는 기록이 없습니다/);
  assert.match(harness(fixture).command('!봇로그 없는봇'), /조회 조건에 맞는 기록이 없습니다/);
  assert.match(harness('broken').command('!봇로그'), /형식을 읽지 못한 기록 1줄/);
  const output = harness(fixture, { readError: true }).command('!봇로그');
  assert.match(output, /읽기 실패: Permission denied/);
  assert.doesNotMatch(output, /기록이 없습니다/);
});

test('invalid counts, old modules, help and command boundaries are handled', () => {
  const h = harness(fixture);
  assert.match(h.command('!봇로그 eval 0'), /1~30/);
  assert.match(h.command('!봇로그 31'), /1~30/);
  assert.match(h.command('!봇로그 도움말'), /사용법/);
  assert.equal(h.reads(), 0);
  assert.match(harness(fixture, { oldModule: true }).command('!봇로그'), /업데이트.*재컴파일/);
  assert.equal(h.command('!봇로그아님', ''), '');
});

test('older records beyond the read cap are omitted with an explicit notice', () => {
  const rows = Array.from({ length: 4001 }, () =>
    '2026-10-01 13:40:31  eval 복구 포기 — 수동 확인 필요');
  const h = harness(rows.join('\n'));
  const result = h.errlog.collectWatch('eval');
  assert.equal(result.entries.length, 4000);
  assert.equal(result.truncated, true);
  assert.match(h.command('!봇로그 eval'), /최신 4,000줄/);
});

test('existing error collection still attributes only failed recovery and abandonment to ChatManager', () => {
  const h = harness(fixture);
  const result = h.errlog.collect({ bot: 'ChatManager' });
  assert.equal(result.entries.length, 3);
  assert.ok(result.entries.every(entry => /복구 실패|복구 포기/.test(entry.text)));
  assert.match(h.command('!에러 ChatManager'), /총 3건/);
});
