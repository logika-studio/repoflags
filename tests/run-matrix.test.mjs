// Review tests WR-04..WR-07: behaviour of scripts/run-matrix.mjs, not the presence of strings in its source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMatrix, parseTapSummary, realSpawn, cli, WSL_PATH_OK } from '../scripts/run-matrix.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'run-matrix.mjs');
const TAP = (t, p, f, s) => `TAP version 13\n# tests ${t}\n# pass ${p}\n# fail ${f}\n# skipped ${s}\n`;
const rts = [{ id: 'a', cmd: 'a', versionArgs: ['-v'], testArgs: ['t'] }];
const ok = { code: 0, stdout: 'v18.0.0\n', stderr: '' };
const mk = (probe, res) => async (cmd, args) => (args[0] === '-v' ? probe : res);

// If the guard were missing, the script must not find any runtime: no PATH, a USERPROFILE that does not exist.
function guardEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^path$/i.test(k)) env[k] = v;
  return { ...env, PATH: '', USERPROFILE: path.join(os.tmpdir(), 'repoflags-no-such-profile'), NODE_TEST_CONTEXT: 'child' };
}
const runScript = (scriptPath) => new Promise((resolve) => {
  execFile(process.execPath, [scriptPath], { env: guardEnv(), timeout: 5000, windowsHide: true }, (error, stdout, stderr) => {
    resolve({ code: error ? error.code : 0, killed: Boolean(error?.killed), stdout, stderr });
  });
});

test('WR-04/WR-05: under the test runner the script exits 0 at once, prints nothing on stdout and says why on stderr', async () => {
  const r = await runScript(SCRIPT);
  assert.equal(r.killed, false);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /run-matrix: skipped under the test runner/);
});

test('WR-05: a different spelling of the same path (drive letter case) is still recognized as the main module', {
  skip: process.platform !== 'win32' && 'drive letters exist only on Windows',
}, async () => {
  const other = SCRIPT[0] === SCRIPT[0].toLowerCase() ? SCRIPT[0].toUpperCase() + SCRIPT.slice(1) : SCRIPT[0].toLowerCase() + SCRIPT.slice(1);
  const r = await runScript(other);
  assert.equal(r.code, 0);
  assert.match(r.stderr, /run-matrix: skipped under the test runner/);
});

test('WR-06: the LAST "# tests" line is the trailer; earlier lines printed by tests are ignored', () => {
  const noise = '    # tests 0\n# tests 99\n# pass 1\n';
  assert.deepEqual(parseTapSummary(noise + TAP(10, 8, 0, 2)), { tests: 10, pass: 8, fail: 0, skipped: 2 });
});

test('WR-06: zero tests is never a pass', async () => {
  const rows = await runMatrix(rts, { spawn: mk(ok, { code: 0, stdout: TAP(0, 0, 0, 0), stderr: '' }) });
  assert.equal(rows[0].tests, 0);
  assert.notEqual(rows[0].status, 'pass');
});

test('WR-06: a run killed after printing its summary keeps the counts and is not a pass', async () => {
  const rows = await runMatrix(rts, { spawn: mk(ok, { code: 3221225794, stdout: TAP(5, 3, 0, 0), stderr: '' }) });
  assert.equal(rows[0].tests, 5);
  assert.equal(rows[0].pass, 3);
  assert.equal(rows[0].status, 'fail');
});

test('WR-06: a timeout is reported as timeout, not as a missing summary', async () => {
  const rows = await runMatrix(rts, { spawn: mk(ok, { code: null, stdout: '', stderr: '', timedOut: true }) });
  assert.equal(rows[0].status, 'timeout');
});

test('WR-06: the kill signature is recognized in UTF-16 output of wsl.exe', async () => {
  const utf16 = 'cygheap read copy failed, Win32 error 299'.split('').join('\u0000');
  const rows = await runMatrix(rts, { spawn: mk(ok, { code: 1, stdout: '', stderr: utf16 }) });
  assert.equal(rows[0].status, 'killed-before-start');
});

test('WR-07: realSpawn passes exit code and stderr, removes NODE_TEST_CONTEXT and never rejects', async () => {
  const prev = process.env.NODE_TEST_CONTEXT;
  process.env.NODE_TEST_CONTEXT = 'child';
  try {
    const r = await realSpawn(process.execPath, ['-e', 'process.stdout.write(String(process.env.NODE_TEST_CONTEXT)); process.stderr.write("e"); process.exit(3)']);
    assert.equal(r.code, 3);
    assert.equal(r.stdout, 'undefined');
    assert.equal(r.stderr, 'e');
  } finally {
    if (prev === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = prev;
  }
  const missing = await realSpawn(path.join(os.tmpdir(), 'repoflags-no-such-binary.exe'), []);
  assert.ok(missing.error);
  assert.equal(missing.code, null);
});

test('WR-07: realSpawn stops a process that outlives its timeout and says so', async () => {
  const t0 = Date.now();
  const r = await realSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 20000);
});

test('WR-07: WSL_PATH_OK accepts a normal path and rejects shell metacharacters', () => {
  assert.ok(WSL_PATH_OK.test('/mnt/c/Work/Example.studio/some-repo'));
  for (const p of ['/mnt/c/a"b', '/mnt/c/$(x)', '/mnt/c/a`b`', '/mnt/c/a;b', '/mnt/c/a\nb']) assert.ok(!WSL_PATH_OK.test(p), JSON.stringify(p));
});

function cliDeps(spawn, argv = []) {
  const out = [];
  const err = [];
  return { deps: { spawn, env: { USERPROFILE: 'C:/Users/x' }, argv, write: (s) => out.push(s), writeErr: (s) => err.push(s), repoRoot: 'C:/r' }, out, err };
}

test('WR-07: cli without WSL pads the four Linux rows as not-available and exits 1', async () => {
  const spawn = async (cmd, args) => (cmd === 'wsl.exe' ? { code: null, stdout: '', stderr: '', error: Object.assign(new Error('x'), { code: 'ENOENT' }) } : (args[0] === '--version' ? ok : { code: 0, stdout: TAP(5, 5, 0, 0), stderr: '' }));
  const { deps, out } = cliDeps(spawn, ['--json']);
  const code = await cli(deps);
  const rows = JSON.parse(out.join(''));
  assert.equal(rows.length, 7);
  assert.equal(rows.filter((r) => r.runtime.startsWith('linux-') && r.status === 'not-available').length, 4);
  assert.equal(code, 1);
});

test('WR-09 (review A): a wslpath killed before starting pads the Linux rows as killed-before-start, never not-available', async () => {
  for (const conv of [{ code: 3221225794, stdout: '', stderr: '' }, { code: 1, stdout: '', stderr: 'C\u0000y\u0000 Win32 error 299' }]) {
    let wslCalls = 0;
    const spawn = async (cmd, args) => {
      if (cmd === 'wsl.exe') { wslCalls += 1; return conv; }
      return args[0] === '--version' ? ok : { code: 0, stdout: TAP(5, 5, 0, 0), stderr: '' };
    };
    const { deps, out } = cliDeps(spawn, ['--json']);
    assert.equal(await cli(deps), 1);
    const linux = JSON.parse(out.join('')).filter((r) => r.runtime.startsWith('linux-'));
    assert.deepEqual(linux.map((r) => r.status), Array(4).fill('killed-before-start'));
    assert.equal(wslCalls, 1, 'never rerun');
  }
});

test('WR-07: cli with every runtime green exits 0', async () => {
  const spawn = async (cmd, args) => {
    if (args.includes('wslpath')) return { code: 0, stdout: '/mnt/c/r\n', stderr: '' };
    const probe = args[0] === '--version' || args.some((a) => /node --version/.test(a));
    return probe ? ok : { code: 0, stdout: TAP(5, 5, 0, 0), stderr: '' };
  };
  const { deps, out } = cliDeps(spawn);
  assert.equal(await cli(deps), 0);
  assert.equal(out.join('').trim().split('\n').length, 9);
});

test('WR-07: cli refuses a WSL path with shell metacharacters, exit 2 and no runtime started', async () => {
  const calls = [];
  const spawn = async (cmd, args) => { calls.push(args); return { code: 0, stdout: '/mnt/c/r"; rm -rf ~; "\n', stderr: '' }; };
  const { deps, err } = cliDeps(spawn);
  assert.equal(await cli(deps), 2);
  assert.equal(calls.length, 1);
  assert.match(err.join(''), /unsupported characters/);
});

test('WR-05: isMainModule compares real paths and rejects other files', async () => {
  const { isMainModule } = await import('../scripts/run-matrix.mjs');
  assert.equal(isMainModule(SCRIPT), true);
  assert.equal(isMainModule(fileURLToPath(import.meta.url)), false);
  assert.equal(isMainModule(undefined), false);
  assert.equal(isMainModule(path.join(os.tmpdir(), 'repoflags-missing', 'run-matrix.mjs')), false);
});

// D-118: a red runtime must name its failing tests, so an intermittent red is never anonymous again.
const failingTap = () => {
  const yaml = ['  ---', '  duration_ms: 12.5', "  failureType: 'testCodeFailure'", "  error: 'Expected values to be strictly equal:\\n\\n1 !== 2\\n'", "  code: 'ERR_ASSERTION'", '  stack: |-'];
  const stack = Array.from({ length: 40 }, (_, i) => `    at frame${i} (file:///x/y.test.mjs:${i}:1)`);
  return ['TAP version 13', '# Subtest: green one', 'ok 1 - green one', '  ---', '  duration_ms: 1', '  ...',
    '# Subtest: the flaky one', 'not ok 2 - the flaky one', ...yaml, ...stack, '  ...',
    '# Subtest: another red', 'not ok 3 - another red', '  ---', '  duration_ms: 3', '  ...',
    '# tests 3', '# pass 1', '# fail 2', '# skipped 0', ''].join('\n');
};
const redSpawn = (isRed) => async (cmd, args) => {
  if (args.includes('wslpath')) return { code: 0, stdout: '/mnt/c/r\n', stderr: '' };
  const probe = args[0] === '--version' || args.some((a) => /node --version/.test(a));
  if (probe) return ok;
  return isRed(cmd, args) ? { code: 1, stdout: failingTap(), stderr: '' } : { code: 0, stdout: TAP(5, 5, 0, 0), stderr: '' };
};

test('D-118: cli prints the "not ok" lines of each failed runtime on stderr, bounded, and nothing for green runtimes', async () => {
  const spawn = redSpawn((cmd, args) => cmd.includes('20.20.2') || args.some((a) => /nvm exec 18 node --test/.test(a)));
  const { deps, out, err } = cliDeps(spawn);
  assert.equal(await cli(deps), 1);
  assert.equal(out.join('').trim().split('\n').length, 9, 'the table on stdout is unchanged');
  const text = err.join('');
  const sections = text.split(/^--- /m).filter(Boolean);
  assert.equal(sections.length, 2, text);
  assert.match(sections[0], /^windows-node-20\.20\.2/);
  assert.match(sections[1], /^linux-wsl-node-18/);
  for (const s of sections) {
    assert.match(s, /not ok 2 - the flaky one/);
    assert.match(s, /error: 'Expected values to be strictly equal/);
    assert.match(s, /not ok 3 - another red/, 'every failing test is named, even after a long stack');
    assert.ok(s.trim().split('\n').length <= 22, `bounded: ${s.split('\n').length} lines`);
    assert.doesNotMatch(s, /green one|frame39/);
  }
});

test('D-118: a very long diagnostic line is cut, so the excerpt stays bounded in characters too', async () => {
  const { failureExcerpt } = await import('../scripts/run-matrix.mjs');
  const tap = ['not ok 1 - long', '  ---', `  error: '${'x'.repeat(50000)}'`, '  ...', '# tests 1', '# fail 1'].join('\n');
  const lines = failureExcerpt(tap);
  assert.match(lines[0], /^not ok 1 - long$/);
  assert.match(lines[1], /^ {2}error: 'x+/);
  for (const l of lines) assert.ok(l.length <= 400, `line of ${l.length} characters`);
  assert.match(lines[1], /\(\d+ more characters\)$/);
});

test('D-118: a green matrix writes nothing on stderr', async () => {
  const { deps, err } = cliDeps(redSpawn(() => false));
  assert.equal(await cli(deps), 0);
  assert.equal(err.join(''), '');
});
