// Tests of the smoke runner (02-07). Fake streams and a fake spawner: `claude` is NEVER started here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  buildClaudeArgs, parseStream, evaluateRun, renderSmokeSection, expectedCommand, runSmoke, cli, describeRun, claudeSpawn, killed,
} from '../scripts/smoke/run-claude-smoke.mjs';
import { scriptRules } from '../scripts/redteam/args.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, '..', 'scripts', 'smoke', 'run-claude-smoke.mjs');
const STREAM_PARSE = path.join(HERE, '..', 'scripts', 'smoke', 'stream-parse.mjs');
const J = (o) => JSON.stringify(o);
const NL = String.fromCharCode(10);

const initEv = { type: 'system', subtype: 'init', model: 'm-test', tools: ['Bash', 'Skill'], skills: ['repoflags'], plugins: [] };
const skillUse = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'repoflags' } }] } };
const bashUse = (command, id = 'tu1') => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
const REPORT = J({ schemaVersion: '1.1.0', outcome: 'no_signals_found_by_these_rules', signals: [] });
// tool_result shape of the stream-json format (assumption A1 extended: user event, tool_use_id, content, is_error).
const toolOut = (content = REPORT, id = 'tu1', isError = false) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
const result = (extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.12, permission_denials: [], result: 'done', ...extra });
const stream = (...evs) => evs.map(J).join(NL) + NL;
const CMD1 = `node "C:/x/.claude/skills/repoflags/scripts/repoflags.mjs" 'octocat/Hello-World' --format json`;

test('buildClaudeArgs: required flags, forbidden flags, budget mandatory', () => {
  const a = buildClaudeArgs({ prompt: 'hi', budget: 0.5, model: 'sonnet' });
  for (const f of ['-p', 'stream-json', '--verbose', '--permission-mode', 'dontAsk', '--no-session-persistence', '--setting-sources', 'project', '--strict-mcp-config', '--max-budget-usd', '0.5', '--disallowedTools', '--model', 'sonnet']) {
    assert.ok(a.includes(f), `missing ${f}`);
  }
  const dis = a[a.indexOf('--disallowedTools') + 1];
  for (const t of ['Write', 'Edit', 'WebFetch', 'WebSearch']) assert.ok(dis.includes(t));
  for (const f of ['--bare', '--safe-mode', '--max-turns']) assert.ok(!a.includes(f));
  assert.throws(() => buildClaudeArgs({ prompt: 'hi' }), /budget/i);
  assert.throws(() => buildClaudeArgs({ prompt: 'hi', budget: 0 }), /budget/i);
});

test('buildClaudeArgs: allows ONLY the Skill tool (dontAsk denied it in the real Run 1); never pre-grants Bash', () => {
  const a = buildClaudeArgs({ prompt: 'hi', budget: 1 });
  assert.equal(a[a.indexOf('--allowedTools') + 1], 'Skill');
  assert.equal(a.filter((x) => x === '--allowedTools').length, 1);
  assert.ok(!a.some((x) => /Bash|PowerShell/.test(x) && x !== 'hi'));
});

test('parseStream: init, tool uses, denials, cost, result; bad lines ignored', () => {
  const p = parseStream(stream(initEv, skillUse, bashUse(CMD1), result()) + 'not json' + NL);
  assert.equal(p.init.model, 'm-test');
  assert.deepEqual(p.init.skills, ['repoflags']);
  assert.equal(p.toolUses.length, 2);
  assert.equal(p.toolUses[1].input.command, CMD1);
  assert.deepEqual(p.permissionDenials, []);
  assert.equal(p.costUsd, 0.12);
  assert.equal(p.resultText, 'done');
  assert.equal(p.badLines, 1);
  assert.doesNotThrow(() => parseStream(''));
  assert.doesNotThrow(() => parseStream('{"type":"assistant","message":null}'));
});

test('evaluateRun 1: VERIFICATO only with skill + exactly one matching Bash + no denials', () => {
  const expected = expectedCommand(1);
  const ok = evaluateRun(1, parseStream(stream(initEv, skillUse, bashUse(CMD1), toolOut(), result())), { expected });
  assert.equal(ok.verdict, 'VERIFICATO');
  const noSkill = evaluateRun(1, parseStream(stream(initEv, bashUse(CMD1), result())), { expected });
  assert.equal(noSkill.verdict, 'NON VERIFICATO');
  const two = evaluateRun(1, parseStream(stream(skillUse, bashUse(CMD1), bashUse(CMD1), result())), { expected });
  assert.equal(two.verdict, 'NON VERIFICATO');
  const wrong = evaluateRun(1, parseStream(stream(skillUse, bashUse('node other.mjs'), result())), { expected });
  assert.equal(wrong.verdict, 'NON VERIFICATO');
  const denied = evaluateRun(1, parseStream(stream(skillUse, bashUse(CMD1), result({ permission_denials: [{ tool_name: 'Bash' }] }))), { expected });
  assert.equal(denied.verdict, 'NON VERIFICATO');
  assert.match(denied.reason, /denial/i);
  const forbidden = evaluateRun(1, parseStream(stream(skillUse, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'WebFetch', input: {} }] } }, bashUse(CMD1), result())), { expected });
  assert.equal(forbidden.verdict, 'NON VERIFICATO');
});

test('evaluateRun 2: expected regex built from the temp path (either separator)', () => {
  const dir = 'C:\\Temp\\fx-abc';
  const expected = expectedCommand(2, dir);
  const cmd = (d) => `node "C:/s/repoflags.mjs" '${d}' --format json`;
  assert.equal(evaluateRun(2, parseStream(stream(skillUse, bashUse(cmd('C:\\Temp\\fx-abc')), toolOut(), result())), { expected }).verdict, 'VERIFICATO');
  assert.equal(evaluateRun(2, parseStream(stream(skillUse, bashUse(cmd('C:/Temp/fx-abc')), toolOut(), result())), { expected }).verdict, 'VERIFICATO');
  assert.equal(evaluateRun(2, parseStream(stream(skillUse, bashUse(cmd('C:/Other')), result())), { expected }).verdict, 'NON VERIFICATO');
});

test('CR-B-01: expectedCommand requires the single-quoted target of SKILL.md', () => {
  const unquoted = 'node "C:/x/repoflags.mjs" octocat/Hello-World --format json';
  assert.ok(expectedCommand(1).test(CMD1));
  assert.ok(!expectedCommand(1).test(unquoted));
  assert.ok(!expectedCommand(2, 'C:\\T\\fx').test('node "C:/x/repoflags.mjs" "C:/T/fx" --format json'));
  assert.ok(expectedCommand(2, 'C:\\T\\fx').test(`node "C:/x/repoflags.mjs" 'C:/T/fx' --format json`));
});

// Review CR-B-08: a stream without a result event, a failed result, a non-zero claude exit, a Bash that never
// produced a report (unexpanded ${CLAUDE_SKILL_DIR}) or a system/permission_denied event were promoted to VERIFICATO.
test('CR-B-08: VERIFICATO needs a success result, exit 0, a JSON report with outcome, and no permission_denied event', () => {
  const expected = expectedCommand(1);
  const ev = (evs, opts = {}) => evaluateRun(1, parseStream(stream(...evs)), { expected, exitCode: 0, ...opts });
  assert.equal(ev([skillUse, bashUse(CMD1), toolOut(), result()]).verdict, 'VERIFICATO');
  const noResult = ev([skillUse, bashUse(CMD1), toolOut()]);
  assert.equal(noResult.verdict, 'NON VERIFICATO');
  assert.match(noResult.reason, /no result event/);
  assert.equal(ev([skillUse, bashUse(CMD1), toolOut(), result({ subtype: 'error_max_budget_usd', is_error: true })]).verdict, 'NON VERIFICATO');
  assert.equal(ev([skillUse, bashUse(CMD1), toolOut(), result({ is_error: true })]).verdict, 'NON VERIFICATO');
  assert.equal(ev([skillUse, bashUse(CMD1), toolOut(), result()], { exitCode: 1 }).verdict, 'NON VERIFICATO');
  const noOutput = ev([skillUse, bashUse(CMD1), result()]);
  assert.equal(noOutput.verdict, 'NON VERIFICATO');
  assert.match(noOutput.reason, /report/);
  assert.equal(ev([skillUse, bashUse(CMD1), toolOut('node: cannot find module'), result()]).verdict, 'NON VERIFICATO');
  assert.equal(ev([skillUse, bashUse(CMD1), toolOut(J({ outcome: 'all good' })), result()]).verdict, 'NON VERIFICATO');
  const unexpanded = `node "\${CLAUDE_SKILL_DIR}/scripts/repoflags.mjs" 'octocat/Hello-World' --format json`;
  assert.ok(!expected.test(unexpanded), 'an unexpanded skill dir never matches');
  const deniedEv = { type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 'tu9' };
  assert.equal(ev([skillUse, bashUse(CMD1), toolOut(), deniedEv, result()]).verdict, 'NON VERIFICATO');
  const p = parseStream(stream(skillUse, bashUse(CMD1), toolOut(), deniedEv, result()));
  assert.equal(p.sawResult, true);
  assert.equal(p.resultSubtype, 'success');
  assert.equal(p.toolResults.tu1.text, REPORT);
  assert.equal(p.deniedEvents.length, 1);
});

test('CR-B-08: runSmoke passes the claude exit code to the evaluator', async () => {
  const spawn = async () => ({ code: 1, stdout: stream(initEv, skillUse, bashUse(CMD1), toolOut(), result()), stderr: '' });
  const r = await runSmoke(1, { budget: 0.5, spawn });
  assert.equal(r.verdict, 'NON VERIFICATO');
  assert.match(r.reason, /exit code 1/);
});

// Review CR-B-07: with allowed-tools gone from SKILL.md (D-46) and `dontAsk`, every Bash is denied: the default
// arguments cannot give VERIFICATO on Runs 1/2, and the evaluator could not tell a right-but-denied command apart.
test('CR-B-07 / UF-01: --allow-script-rule pre-approves only the exact rules passed; never by default', () => {
  const def = buildClaudeArgs({ prompt: 'hi', budget: 1 });
  assert.equal(def.filter((x) => /Bash|PowerShell/.test(x) && x !== 'hi').length, 0);
  const rules = scriptRules({ skillDir: 'C:/s/.claude/skills/repoflags', target: 'octocat/Hello-World' });
  const withoutFlag = buildClaudeArgs({ prompt: 'hi', budget: 1, rules });
  assert.equal(withoutFlag[withoutFlag.indexOf('--allowedTools') + 1], 'Skill');
  assert.ok(!withoutFlag.some((x) => rules.includes(x)), 'rules are ignored without allowScriptRule');
  const a = buildClaudeArgs({ prompt: 'hi', budget: 1, allowScriptRule: true, rules });
  const at = a.indexOf('--allowedTools');
  assert.deepEqual(a.slice(at + 1, at + 2 + rules.length), ['Skill', ...rules]);
  assert.equal(rules.length, 2);
  assert.ok(a.some((x) => x.startsWith('Bash(')) && a.some((x) => x.startsWith('PowerShell(')));
  assert.ok(!a.some((x) => x.includes('*')), 'no wildcard anywhere in the arguments');
});

test('UF-01: the source no longer holds the wide rule', () => {
  assert.doesNotMatch(fs.readFileSync(RUNNER, 'utf8'), /node \*repoflags\.mjs\*/);
});

test('UF-01: killed is exported with unchanged behaviour', () => {
  assert.equal(killed({ code: 3221225794, stderr: '' }), true);
  assert.equal(killed({ code: -1073741502, stderr: '' }), true);
  assert.equal(killed({ code: 1, stderr: 'cygheap read copy failed' }), true);
  assert.equal(killed({ code: 1, stderr: 'plain failure' }), false);
  assert.equal(killed({ code: 0 }), false);
});

test('UF-01: runSmoke computes the exact rules from the real skill folder and the target', async () => {
  for (const run of [1, 2]) {
    let seen; let skillReal;
    const spawn = async (c, args, o) => {
      seen = args;
      skillReal = fs.realpathSync.native(path.join(o.cwd, '.claude', 'skills', 'repoflags'));
      return { code: 0, stdout: stream(result()), stderr: '' };
    };
    const r = await runSmoke(run, { budget: 0.5, allowScriptRule: true, spawn });
    const prompt = seen[seen.indexOf('-p') + 1];
    const target = run === 1 ? 'octocat/Hello-World' : prompt.slice('check this repo before I open it: '.length);
    const expected = scriptRules({ skillDir: skillReal, target });
    const at = seen.indexOf('--allowedTools');
    assert.deepEqual(seen.slice(at + 1, at + 2 + expected.length), ['Skill', ...expected], `run ${run}`);
    assert.ok(expected.length >= 2);
    assert.ok(r.status);
  }
  let seen3;
  await runSmoke(3, { budget: 0.5, allowScriptRule: true, spawn: async (c, args) => { seen3 = args; return { code: 0, stdout: stream(result()), stderr: '' }; } });
  assert.equal(seen3[seen3.indexOf('--allowedTools') + 1], 'Skill');
  assert.equal(seen3.filter((x) => /^(Bash|PowerShell)\(/.test(x)).length, 0);
});

test('CR-B-07: the cli passes --allow-script-rule and the dry-run says when Runs 1/2 cannot be VERIFICATO', async () => {
  let out = '';
  const write = (s) => { out += s; };
  await cli({ argv: ['node', 'x', '--run', '1', '--budget', '0.5'], write, writeErr: write, spawn: async () => assert.fail('no spawn') });
  assert.match(out, /without --allow-script-rule, Runs 1 and 2 cannot be VERIFICATO/);
  out = '';
  await cli({ argv: ['node', 'x', '--run', '1', '--budget', '0.5', '--allow-script-rule'], write, writeErr: write, spawn: async () => assert.fail('no spawn') });
  // The dry-run prints each argument with JSON.stringify, so the inner double quotes appear escaped.
  assert.match(out, /Bash\(node \\"<skill-dir>\/scripts\/repoflags\.mjs\\" 'octocat\/Hello-World' --format json\)/);
  assert.match(out, /PowerShell\(node \\"<skill-dir>/);
  assert.doesNotMatch(out, /\*/);
  assert.doesNotMatch(out, /cannot be VERIFICATO/);
  out = '';
  await cli({ argv: ['node', 'x', '--run', '2', '--budget', '0.5', '--allow-script-rule'], write, writeErr: write, spawn: async () => assert.fail('no spawn') });
  assert.match(out, /'<target>'/);
  let seen;
  const spawn = async (c, args) => { seen = args; return { code: 0, stdout: stream(result()), stderr: '' }; };
  await cli({ argv: ['node', 'x', '--run', '1', '--budget', '0.5', '--allow-script-rule', '--confirm'], spawn, write: () => {}, writeErr: () => {} });
  assert.ok(seen.some((x) => /^Bash\(node ".*\/scripts\/repoflags\.mjs" 'octocat\/Hello-World' --format json\)$/.test(x)));
});

test('CR-B-07: the right command denied by dontAsk is a distinct outcome, not a generic denial', () => {
  const expected = expectedCommand(1);
  const denial = { tool_name: 'Bash', tool_use_id: 'tu1', tool_input: { command: CMD1 } };
  const deniedEv = { type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 'tu1' };
  const ideal = evaluateRun(1, parseStream(stream(skillUse, bashUse(CMD1), deniedEv, result({ permission_denials: [denial] }))), { expected, exitCode: 0 });
  assert.equal(ideal.verdict, 'NON VERIFICATO');
  assert.match(ideal.reason, /denied by design, command matched/);
  const composed = `${CMD1}; echo "EXIT=$?"`;
  const bad = evaluateRun(1, parseStream(stream(skillUse, bashUse(composed), deniedEv, result({ permission_denials: [{ ...denial, tool_input: { command: composed } }] }))), { expected, exitCode: 0 });
  assert.equal(bad.verdict, 'NON VERIFICATO');
  assert.doesNotMatch(bad.reason, /command matched/);
});

// Review CR-B-10: a manual Read/Grep/Glob of the target folder (G5) and the delegating tools were not checked.
const use = (name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `id-${name}`, name, input }] } });
test('CR-B-10: delegating and multi-edit tools are disallowed and forbidden', () => {
  const dis = buildClaudeArgs({ prompt: 'hi', budget: 1 }).join(' ');
  for (const t of ['MultiEdit', 'NotebookEdit', 'Task', 'Agent']) {
    assert.match(dis, new RegExp(`--disallowedTools [^-]*\\b${t}\\b`), `disallowed ${t}`);
    const r = evaluateRun(1, parseStream(stream(skillUse, use(t, {}), bashUse(CMD1), toolOut(), result())), { expected: expectedCommand(1) });
    assert.equal(r.verdict, 'NON VERIFICATO', t);
    assert.match(r.reason, /forbidden/);
  }
});

test('CR-B-10: a manual read of the target folder is a G5 violation; reading the skill files is not', () => {
  const dir = 'C:\\Temp\\fx-abc';
  const expected = expectedCommand(2, dir);
  const cmd = `node "C:/s/repoflags.mjs" 'C:/Temp/fx-abc' --format json`;
  const ev = (...evs) => evaluateRun(2, parseStream(stream(skillUse, ...evs, bashUse(cmd), toolOut(), result())), { expected, targetDir: dir });
  for (const u of [use('Read', { file_path: 'C:/Temp/fx-abc/package.json' }), use('Grep', { pattern: 'x', path: 'c:\\temp\\fx-abc' }), use('Glob', { pattern: 'C:/Temp/fx-abc/**/*.json' })]) {
    const r = ev(u);
    assert.equal(r.verdict, 'NON VERIFICATO', JSON.stringify(u));
    assert.match(r.reason, /G5/);
  }
  assert.equal(ev(use('Read', { file_path: 'C:/s/.claude/skills/repoflags/references/report-fields.md' })).verdict, 'VERIFICATO');
  assert.equal(ev(use('Read', { file_path: 'C:/Temp/fx-abcdef/x' })).verdict, 'VERIFICATO', 'a sibling folder is not the target');
  // Review CR-03: a path that reaches the target through .. or the \\?\ prefix is still a manual read.
  for (const p of ['C:/s/.claude/skills/repoflags/../../../../Temp/fx-abc/package.json', '\\\\?\\C:\\Temp\\fx-abc\\package.json']) {
    assert.match(ev(use('Read', { file_path: p })).reason ?? '', /G5/, p);
  }
});

test('CR-B-10: runSmoke hands the fixture folder to the evaluator', async () => {
  const spawn = async (c, args) => {
    const prompt = args[args.indexOf('-p') + 1];
    const dir = prompt.slice(prompt.indexOf(': ') + 2);
    return { code: 0, stdout: stream(skillUse, use('Read', { file_path: `${dir}/package.json` }), bashUse(`node "C:/s/repoflags.mjs" '${dir}' --format json`), toolOut(), result()), stderr: '' };
  };
  const r = await runSmoke(2, { budget: 0.5, spawn });
  assert.equal(r.verdict, 'NON VERIFICATO');
  assert.match(r.reason, /G5/);
});

test('evaluateRun 3: no shell tool and isolation / format / device in the answer', () => {
  const good = result({ result: 'Disconnect the network now, do not format the disk, and use a different device.' });
  assert.equal(evaluateRun(3, parseStream(stream(skillUse, good)), {}).verdict, 'VERIFICATO');
  const withBash = evaluateRun(3, parseStream(stream(skillUse, bashUse('ls'), good)), {});
  assert.equal(withBash.verdict, 'NON VERIFICATO');
  const withPs = evaluateRun(3, parseStream(stream(skillUse, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'PowerShell', input: {} }] } }, good)), {});
  assert.equal(withPs.verdict, 'NON VERIFICATO');
  const missing = evaluateRun(3, parseStream(stream(skillUse, result({ result: 'Disconnect the network.' }))), {});
  assert.equal(missing.verdict, 'NON VERIFICATO');
});

// Review CR-B-09: 'format' matched "information" and "format your disk", 'device' matched anything, a generic answer
// without the skill passed, forbidden tools were not checked on Run 3, and the check was English-only.
test('CR-B-09: Run 3 rejects a non-negated format/wipe/reinstall, needs a different device and the skill, checks forbidden tools', () => {
  const ev = (...evs) => evaluateRun(3, parseStream(stream(...evs)), {});
  const dangerous = result({ result: 'Format your device immediately and reinstall the OS; for more information disconnect from the network.' });
  assert.equal(ev(skillUse, dangerous).verdict, 'NON VERIFICATO', '(a) format not negated');
  const noOther = result({ result: 'Disconnect the network now, do not format the disk, and check the device.' });
  assert.equal(ev(skillUse, noOther).verdict, 'NON VERIFICATO', '(b) no different device');
  const good = result({ result: 'Disconnect the network now, do not format or wipe it, and use a different device.' });
  assert.equal(ev(skillUse, good).verdict, 'VERIFICATO');
  assert.equal(ev(good).verdict, 'NON VERIFICATO', '(c) no skill activation');
  const otherSkill = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'other', args: 'repoflags' } }] } };
  assert.equal(ev(otherSkill, good).verdict, 'NON VERIFICATO', '(c) another skill naming repoflags in its args');
  const search = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'WebSearch', input: {} }] } };
  const forb = ev(skillUse, search, good);
  assert.equal(forb.verdict, 'NON VERIFICATO', '(d) forbidden tool');
  assert.match(forb.reason, /forbidden/);
  assert.match(describeRun(3, { budget: 1 }), /Answer in English\./, '(e) the evaluator reads English');
});

// Smoke 2 Run 3 (install smoke measurement): a wipe/reinstall deferred with «only after» in the same sentence was a false negative.
test('Run 3: a destructive step deferred with "only after" in the same sentence is not a suggestion', () => {
  const ev = (text) => evaluateRun(3, parseStream(stream(skillUse, result({ result: text }))), {});
  const base = "Disconnect from the network. Don't format it and don't delete anything. Use a different, clean device. ";
  assert.equal(ev(`${base}Wipe and reinstall the machine only after this, ideally with a professional's help.`).verdict, 'VERIFICATO');
  assert.equal(ev(`${base}Wipe the machine now. Only after that, rotate your keys.`).verdict, 'NON VERIFICATO', 'deferral in another sentence');
  assert.equal(ev(`${base}Reinstall the OS today, then only after rotate keys.`).verdict, 'NON VERIFICATO', 'deferral too far from the verb');
});

test('runSmoke: killed-before-start is reported and never respawned', async () => {
  let calls = 0;
  const spawn = async () => { calls += 1; return { code: 3221225794, stdout: '', stderr: '' }; };
  const r = await runSmoke(1, { budget: 0.5, spawn });
  assert.equal(r.status, 'killed-before-start');
  assert.equal(calls, 1);
  const spawn2 = async () => { calls += 1; return { code: 1, stdout: '', stderr: 'cygheap read copy failed' }; };
  calls = 0;
  assert.equal((await runSmoke(1, { budget: 0.5, spawn: spawn2 })).status, 'killed-before-start');
  assert.equal(calls, 1);
});

test('runSmoke: spawn outside the repo with the skill copied beforehand; temp dirs removed afterwards', async () => {
  const seen = [];
  const spawn = async (cmd, args, opts) => {
    const skill = path.join(opts.cwd, '.claude', 'skills', 'repoflags', 'SKILL.md');
    seen.push({ cwd: opts.cwd, hasSkill: fs.existsSync(skill), cmd });
    return { code: 0, stdout: stream(initEv, skillUse, bashUse(CMD1), toolOut(), result()), stderr: '' };
  };
  const r = await runSmoke(1, { budget: 0.5, spawn });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].hasSkill, true);
  assert.equal(seen[0].cmd, 'claude');
  assert.ok(seen[0].cwd.startsWith(os.tmpdir()));
  assert.ok(!seen[0].cwd.startsWith(path.join(HERE, '..')));
  assert.equal(fs.existsSync(seen[0].cwd), false, 'temp dir cleaned up');
  assert.equal(r.status, 'done');
  assert.equal(r.verdict, 'VERIFICATO');
});

test('runSmoke: temp dirs are removed also when spawn throws', async () => {
  let cwd;
  const spawn = async (c, a, o) => { cwd = o.cwd; throw new Error('boom'); };
  await assert.rejects(runSmoke(1, { budget: 0.5, spawn }), /boom/);
  assert.equal(fs.existsSync(cwd), false);
});

test('runSmoke 2: fixture folder has no CLAUDE.md / AGENTS.md and is removed', async () => {
  let fixtureDir;
  const spawn = async (c, args) => {
    const prompt = args[args.indexOf('-p') + 1];
    fixtureDir = prompt.slice(prompt.indexOf(": ") + 2);
    assert.ok(fixtureDir && fs.existsSync(fixtureDir), 'prompt names an existing fixture folder');
    for (const f of ['CLAUDE.md', 'AGENTS.md', 'tasks.json']) assert.equal(fs.existsSync(path.join(fixtureDir, f)), false);
    return { code: 0, stdout: stream(result()), stderr: '' };
  };
  await runSmoke(2, { budget: 0.5, spawn });
  assert.equal(fs.existsSync(fixtureDir), false);
});

test('cli: dry-run by default (no spawn), --confirm spawns once, budget mandatory', async () => {
  let calls = 0;
  const spawn = async () => { calls += 1; return { code: 0, stdout: stream(result()), stderr: '' }; };
  let out = '';
  const write = (s) => { out += s; };
  assert.equal(await cli({ argv: ['node', 'x', '--run', '1', '--budget', '0.5'], spawn, write, writeErr: write }), 0);
  assert.equal(calls, 0);
  assert.match(out, /dry-run/);
  assert.match(out, /--max-budget-usd/);
  out = '';
  assert.notEqual(await cli({ argv: ['node', 'x', '--run', '1'], spawn, write, writeErr: write }), 0);
  assert.equal(calls, 0);
  assert.notEqual(await cli({ argv: ['node', 'x', '--run', '4', '--budget', '1'], spawn, write, writeErr: write }), 0);
  assert.equal(calls, 0);
  await cli({ argv: ['node', 'x', '--run', '3', '--budget', '0.5', '--confirm'], spawn, write, writeErr: write });
  assert.equal(calls, 1);
});

test('cli: --raw saves the unmodified stream so it can be re-evaluated without relaunching claude', async () => {
  const raw = stream(initEv, result());
  const spawn = async () => ({ code: 0, stdout: raw, stderr: '' });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-raw-test-')), 'raw.jsonl');
  try {
    await cli({ argv: ['node', 'x', '--run', '3', '--budget', '0.5', '--confirm', '--raw', file], spawn, write: () => {}, writeErr: () => {} });
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
  } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
});

// Review CR-B-20: policy made explicit. One PowerShell call with exactly the same command is accepted (on Windows it is
// a legitimate path, seen in the real Run 2); the single-quoted target means the same in both shells.
test('CR-B-20: a single PowerShell call with the expected command counts like Bash; two shells do not', () => {
  const expected = expectedCommand(1);
  const ps = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'PowerShell', input: { command: CMD1 } }] } };
  assert.equal(evaluateRun(1, parseStream(stream(skillUse, ps, toolOut(), result())), { expected }).verdict, 'VERIFICATO');
  assert.equal(evaluateRun(1, parseStream(stream(skillUse, ps, bashUse(CMD1, 'tu2'), toolOut(), result())), { expected }).verdict, 'NON VERIFICATO');
});

// Review CR-B-17: --setting-sources project does not exclude the global CLAUDE.md nor the personal skills (A3).
test('CR-B-17: the header and every rendered section say the session is not isolated', () => {
  const sec = renderSmokeSection(3, { prompt: 'p', parsed: parseStream(''), evaluation: { verdict: 'NON VERIFICATO', reason: 'x' }, status: 'done' });
  assert.match(sec, /not an isolated session/);
  const head = fs.readFileSync(RUNNER, 'utf8').split('\n').slice(0, 5).join('\n');
  assert.match(head, /not an isolated session/);
});

// Review CR-B-16: chunks were decoded one by one (a multibyte character split across two chunks became two U+FFFD),
// the taskkill spawn had no error listener, and nothing resolved the promise if the kill did not close the child.
// These tests start only `node` itself (process.execPath), never `claude`.
test('CR-B-16: claudeSpawn decodes UTF-8 split across chunks', async () => {
  const script = 'process.stdout.write(Buffer.from([0xC3]));setTimeout(()=>process.stdout.write(Buffer.from([0xA8])),100);';
  const r = await claudeSpawn(process.execPath, ['-e', script], { timeoutMs: 20000 });
  assert.equal(r.timedOut, false);
  assert.equal(r.stdout, 'è');
});

test('CR-B-16: a hung child times out and the promise always settles', async () => {
  const r = await claudeSpawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 300, graceMs: 3000 });
  assert.equal(r.timedOut, true);
  const src = fs.readFileSync(RUNNER, 'utf8');
  assert.match(src, /nodeSpawn\('taskkill'[^\n]*\.on\('error'/, 'taskkill errors are handled');
  assert.match(src, /graceMs/, 'a second deadline settles the promise');
  assert.match(src, /process\.kill\(-child\.pid/, 'the whole process group is killed on POSIX');
});

// Review CR-B-14: `/shell: false|realSpawn/` passed with a second spawn using `shell: true`. Every spawn call (one line
// each) must carry `shell: false`, and `shell: true` must not appear.
const spawnsWithoutShellFalse = (src) => src.split(/\bnodeSpawn\(/).slice(1).map((s) => s.split('\n')[0]).filter((call) => !call.includes('shell: false'));

test('source: every spawn call has shell: false (self-check on a mutated sample)', () => {
  const mutated = "nodeSpawn(cmd, args, { shell: false });\nnodeSpawn('taskkill', ['/T'], { shell: true });\n";
  assert.match(mutated, /shell: false|realSpawn/, 'the old check would pass this sample');
  assert.equal(spawnsWithoutShellFalse(mutated).length, 1);
  const src = fs.readFileSync(RUNNER, 'utf8');
  assert.ok(src.split(/\bnodeSpawn\(/).length - 1 >= 2, 'claude and taskkill spawns are both checked');
  assert.deepEqual(spawnsWithoutShellFalse(src), []);
  assert.doesNotMatch(src, /shell:\s*true/);
});

test('source: shell:false, NODE_TEST_CONTEXT guard, no user names, no retry loop, no stored credentials', () => {
  const src = fs.readFileSync(RUNNER, 'utf8') + fs.readFileSync(STREAM_PARSE, 'utf8');
  assert.match(src, /shell: false|realSpawn/);
  assert.match(src, /NODE_TEST_CONTEXT/);
  assert.doesNotMatch(src, /luigi/i);
  assert.doesNotMatch(src, /\bretr(y|ies)\b|attempt/i);
  assert.doesNotMatch(src, /\.claude[\\/]settings|homedir/);
});
