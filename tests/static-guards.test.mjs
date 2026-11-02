import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripJs, CALLS, matchLines } from './helpers/js-strip.mjs';
import { importViolations, codeViolations } from './helpers/source-policy.mjs';
import { runMatrix, parseTapSummary, buildRuntimes, toMarkdown } from '../scripts/run-matrix.mjs';
import { hitsOutsideSentences, SAFE_RE, ALLOWED_SAFE_SENTENCES } from './helpers/skill-md.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = path.join(ROOT, 'skills');
const SKIP = new Set(['.git', 'node_modules', '.planning', '.claude']);

async function walk(dir, accept, out = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, accept, out);
    else if (accept(e.name)) out.push(full);
  }
  return out;
}

const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');
const read = async (f) => fs.readFile(f, 'utf8');
const sources = async () => Promise.all((await walk(SKILL, (n) => n.endsWith('.mjs'))).map(async (f) => ({ file: rel(f), raw: await read(f) })));
const jsonAndSources = async () => Promise.all((await walk(SKILL, (n) => n.endsWith('.mjs') || n.endsWith('.json'))).map(async (f) => ({ file: rel(f), raw: await read(f) })));

/** Lines of `text` where `re` matches, as "file:line". The text is scanned as a whole, so `eval\n(x)` is a match (WR-02). */
const where = (file, text, re) => matchLines(text, re).map((l) => `${file}:${l}`);
const scan = (files, re, pick = (f) => f.raw) => files.flatMap((f) => where(f.file, pick(f), re));
const none = (hits, msg) => assert.deepEqual(hits, [], `${msg}: ${hits.join(', ')}`);

test('no leftover contract modules', async () => {
  const all = await jsonAndSources();
  none(scan(all, /not implemented in this build|added in plan 01-08|read in plan 01-03/), 'contract markers');
});

test('the word "safe" never appears in the tool (G7)', async () => {
  none(scan(await jsonAndSources(), /safe/i), 'forbidden word');
});

// Review tests IN-08: SKILL.md, prompts and READMEs (Phase 2/4) were outside the G7 check.
const isG7Text = (n) => /\.(mjs|json|md)$/i.test(n);
const g7Root = (n) => /^readme([.-].*)?\.md$/i.test(n);

test('IN-08: the G7 check covers skill markdown and root READMEs (self-check)', () => {
  for (const n of ['a.mjs', 'schema.json', 'SKILL.md', 'prompt.md']) assert.ok(isG7Text(n), n);
  for (const n of ['README.md', 'README.it.md', 'readme.md']) assert.ok(g7Root(n), n);
  assert.ok(!g7Root('CLAUDE.md') && !g7Root('package.json'));
});

// D-69: SKILL.md and references/*.md must name the word to forbid it, so they leave the total ban and are checked by
// the sentence allowlist in tests/skill-md-body.test.mjs. Every other markdown under skills/ keeps the total ban.
const isSkillProse = (f) => /^skills\/[^/]+\/(SKILL\.md|references\/[^/]+\.md)$/.test(rel(f));

test('the word "safe" never appears in skill markdown (except the prose checked by phrase) or in a root README (G7, IN-08)', async () => {
  const skill = (await walk(SKILL, isG7Text)).filter((f) => !isSkillProse(f));
  const roots = (await fs.readdir(ROOT, { withFileTypes: true })).filter((e) => e.isFile() && g7Root(e.name)).map((e) => path.join(ROOT, e.name));
  const files = await Promise.all([...skill, ...roots].map(async (f) => ({ file: rel(f), raw: await read(f) })));
  none(scan(files, /safe/i), 'forbidden word');
});

test('D-69: the prose excluded from the total ban is covered by the phrase allowlist test (self-check)', async () => {
  for (const p of ['skills/repoflags/SKILL.md', 'skills/repoflags/references/incident-response.md']) {
    assert.ok(isSkillProse(path.join(ROOT, p)), p);
  }
  for (const p of ['skills/repoflags/README.md', 'skills/repoflags/scripts/x.md', 'skills/repoflags/references/a/b.md', 'skills/repoflags/scripts/a.mjs']) {
    assert.ok(!isSkillProse(path.join(ROOT, p)), p);
  }
  // Review CR-B-14: the check used to grep another test file for a string. It now runs the phrase check itself on
  // every file excluded from the total ban, so the exclusion cannot leave prose unchecked.
  const excluded = (await walk(SKILL, isG7Text)).filter(isSkillProse);
  assert.ok(excluded.length >= 2, 'SKILL.md and the references are found');
  const hits = [];
  for (const f of excluded) hits.push(...hitsOutsideSentences(await read(f), SAFE_RE, ALLOWED_SAFE_SENTENCES).map((h) => `${rel(f)} ${h}`));
  none(hits, 'verdict word in skill prose');
  assert.notDeepEqual(hitsOutsideSentences('It is safe to open.', SAFE_RE, ALLOWED_SAFE_SENTENCES), [], 'self-check');
});

// Review CR-B-19: without .gitattributes the line endings of the published files depend on the committer's autocrlf.
test('CR-B-19: .gitattributes forces LF for the markdown, module and JSON files', async () => {
  const attrs = (await read(path.join(ROOT, '.gitattributes'))).split(/\r?\n/).map((l) => l.trim().split(/\s+/));
  for (const pattern of ['*.md', '*.mjs', '*.json']) {
    const line = attrs.find((a) => a[0] === pattern);
    assert.ok(line, `rule for ${pattern}`);
    assert.ok(line.includes('text') && line.includes('eol=lf'), `${pattern}: text eol=lf`);
  }
});

test('no eval, new Function, dynamic import, require, delete or write APIs (code only, strings and comments ignored)', async () => {
  const all = await sources();
  const code = (f) => stripJs(f.raw);
  for (const [name, re] of Object.entries(CALLS)) none(scan(all, re, code), `call ${name}`);
  none(scan(all, /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|mkdtemp|mkdtempSync)\b/, code), 'disk write API');
});

test('child_process only in token.mjs, vm only in text-scan.mjs', async () => {
  const all = await sources();
  const spec = /(?:from\s+|import\s*)['"](?:node:)?(child_process|vm)['"]/;
  const hits = all.flatMap((f) => {
    const out = [];
    f.raw.split('\n').forEach((l, i) => {
      const m = spec.exec(l);
      if (!m) return;
      const allowed = m[1] === 'child_process' ? 'lib/acquire/token.mjs' : 'lib/util/text-scan.mjs';
      if (!f.file.endsWith(allowed)) out.push(`${f.file}:${i + 1} (${m[1]})`);
    });
    return out;
  });
  none(hits, 'unexpected import');
});

test('every import is node:* or relative (zero dependencies)', async () => {
  const bad = [];
  for (const f of await sources()) {
    for (const m of f.raw.matchAll(/(?:from\s+|import\s*\(?\s*)['"]([^'"]+)['"]/g)) {
      if (!m[1].startsWith('node:') && !m[1].startsWith('./') && !m[1].startsWith('../')) bad.push(`${f.file}: ${m[1]}`);
    }
  }
  none(bad, 'external import');
});

// Review tests WR-03: only child_process and vm were bound to one file; network, require and worker modules were
// importable without failing any test. The policy is a positive allowlist, proven here on samples.
const RULE_FILE = 'skills/repoflags/scripts/lib/rules/sample.mjs';
const NL = String.fromCharCode(10);

test('WR-03: the import policy rejects modules that bypass the bans (self-check)', () => {
  const samples = [
    "import net from 'node:net';", "import http from 'node:http';", "import https from 'node:https';",
    "import tls from 'node:tls';", "import dns from 'node:dns';", "import dgram from 'node:dgram';",
    "import { Worker } from 'node:worker_threads';", "import inspector from 'node:inspector';",
    "import { createRequire } from 'node:module';", "import * as m from 'node:module';", "export { connect } from 'node:http2';",
    `import {${NL}  connect,${NL}} from 'node:net';`, "import 'node:net';", "import fs from 'fs';", "import x from 'left-pad';",
    "import { execFile } from 'node:child_process';", "import vm from 'node:vm';",
  ];
  for (const src of samples) assert.notDeepEqual(importViolations(RULE_FILE, src), [], src);
  const home = 'skills/repoflags/scripts/lib/rules/config-files.mjs';
  for (const src of ["import { builtinModules, createRequire } from 'node:module';", "import mod from 'node:module';"]) {
    assert.notDeepEqual(importViolations(home, src), [], src);
  }
});

test('WR-03: network and native escapes in code are rejected outside their single home (self-check)', () => {
  const samples = [
    'process.binding("fs");', 'process.dlopen(m, p);', 'process._linkedBinding("x");', "process['binding']('fs');",
    'await fetch(u);', 'const f = globalThis.fetch;', 'new WebSocket(u);', 'new XMLHttpRequest();', 'new EventSource(u);',
    "const u = 'http://evil.example/x';", "const u = 'ws://evil.example/x';", "const u = 'wss://evil.example/x';",
  ];
  for (const src of samples) assert.notDeepEqual(codeViolations(RULE_FILE, stripJs(src), src), [], src);
});

test('WR-03: what the tool needs stays allowed (self-check)', () => {
  const ok = [
    ['skills/repoflags/scripts/lib/rules/sample.mjs', "import fs from 'node:fs/promises';\nimport path from 'node:path';\nimport { promisify } from 'node:util';"],
    ['skills/repoflags/scripts/lib/rules/config-files.mjs', "import { builtinModules } from 'node:module';"],
    ['skills/repoflags/scripts/lib/acquire/token.mjs', "import { execFile } from 'node:child_process';"],
    ['skills/repoflags/scripts/lib/util/text-scan.mjs', "import vm from 'node:vm';\nimport { AsyncLocalStorage } from 'node:async_hooks';"],
  ];
  for (const [file, src] of ok) assert.deepEqual(importViolations(file, src), [], src);
  assert.deepEqual(codeViolations('skills/repoflags/scripts/lib/util/http.mjs', 'await ctx.fetch(u);', ''), []);
  assert.deepEqual(codeViolations('skills/repoflags/scripts/lib/analyze.mjs', 'fetch: deps.fetch ?? globalThis.fetch,', ''), []);
  assert.deepEqual(codeViolations(RULE_FILE, 'const re = /^https?:\\/\\//;', 'const re = /^https?:\\/\\//;'), []);
});

test('every import of the tool respects the policy; no network or native escape outside util/http.mjs (WR-03)', async () => {
  const all = await sources();
  none(all.flatMap((f) => importViolations(f.file, f.raw)), 'import policy');
  none(all.flatMap((f) => codeViolations(f.file, stripJs(f.raw), f.raw)), 'code policy');
});

test('no API newer than Node 18.3', async () => {
  const api = /import\.meta\.(dirname|filename)|\.(toSorted|toReversed|findLast|findLastIndex)\s*\(|Object\.groupBy|AbortSignal\.any|URL\.canParse|\bfs\.glob\b|readdir\w*\([^)]*recursive/;
  none(scan(await sources(), api, (f) => stripJs(f.raw)), 'API above Node 18');
});

test('network URLs only toward the three allowlisted hosts; links only to osv.dev, github.com, npmjs.com', async () => {
  const bad = [];
  for (const f of await sources()) {
    for (const m of f.raw.matchAll(/https:\/\/([A-Za-z0-9.-]+)/g)) {
      const host = m[1];
      if (!['api.github.com', 'api.osv.dev', 'registry.npmjs.org', 'osv.dev', 'github.com', 'www.npmjs.com', 'registry.yarnpkg.com'].includes(host)
        && !/example\.invalid$/.test(host)) bad.push(`${f.file}: ${host}`);
    }
  }
  none(bad, 'unexpected host');
});

test('no .mjs in skills/ above 300 lines; package.json has no dependencies', async () => {
  const long = (await sources()).filter((f) => f.raw.split('\n').length > 300).map((f) => f.file);
  none(long, 'file above 300 lines');
  const pkg = JSON.parse(await read(path.join(ROOT, 'package.json')));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
});

test('CI workflow exists: 3 OS x Node 18/20/22/24, no installs, no secrets, read-only', async () => {
  const yml = await read(path.join(ROOT, '.github', 'workflows', 'ci.yml'));
  assert.match(yml, /os: \[ubuntu-latest, windows-latest, macos-latest\]/);
  assert.match(yml, /node: \[18, 20, 22, 24\]/); // IN-02: the local matrix already runs 24
  assert.match(yml, /node --test/);
  assert.match(yml, /contents: read/);
  assert.doesNotMatch(yml, /npm (i|install|ci)\b|secrets\./i);
});

// Review tests WR-11: tags are mutable (supply chain), the checkout token stayed in .git/config while hostile
// fixtures run, and a regressed ReDoS test could burn 360 minutes per cell.
test('WR-11: CI pins actions by commit SHA, drops the checkout token, has timeouts and no duplicate runs', async () => {
  const yml = await read(path.join(ROOT, '.github', 'workflows', 'ci.yml'));
  const uses = [...yml.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 2, 'actions expected');
  for (const u of uses) assert.match(u, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, u);
  assert.match(yml, /uses: actions\/checkout@[0-9a-f]{40}[^\n]*\n\s+with:\s*\n\s+persist-credentials: false/);
  assert.match(yml, /^permissions:\s*\n\s+contents: read\s*$/m);
  assert.match(yml, /timeout-minutes: \d+/);
  assert.match(yml, /concurrency:/);
  assert.match(yml, /push:\s*\n\s+branches: \[main\]/);
});

// Review tests WR-10: `node --test` from the root also collected .claude/worktrees/*/tests (other branches) and
// anything under .planning. Every entry point runs the suite from tests/ only. `node --test tests/` is not portable:
// Node 22 reads the argument as a module path, so the runner starts in tests/ and uses its default discovery.
test('WR-10: npm test, CI and the local matrix run node --test from tests/ only', async () => {
  const pkg = JSON.parse(await read(path.join(ROOT, 'package.json')));
  assert.equal(pkg.scripts.test, 'cd tests && node --test');
  const yml = await read(path.join(ROOT, '.github', 'workflows', 'ci.yml'));
  assert.match(yml, /- run: node --test\s*\n\s*working-directory: tests/);
  const list = buildRuntimes({ repoRoot: 'C:/r', wslRoot: '/mnt/c/r', userProfile: 'C:/Users/x' });
  for (const r of list.filter((x) => x.id.startsWith('windows-'))) assert.equal(r.cwd, path.join('C:/r', 'tests'), r.id);
  for (const r of list.filter((x) => x.id.startsWith('linux-'))) assert.match(r.testArgs.at(-1), /cd "\/mnt\/c\/r\/tests" && /, r.id);
});

// A script outside tests/ whose basename matches node --test discovery would be run as a test (T-01-60).
const DISCOVERY = /^(test-.*|.*\.test\.[^.]+|.*-test\.[^.]+|.*_test\.[^.]+|test\.[^.]+)$/;
// Data files are never loaded as modules by node --test (measured on Node 22.13.1: a `test-report.yml` next to a
// `test-a.mjs` is not collected). The issue form `.github/ISSUE_TEMPLATE/test-report.yml` (D-108) is one of them.
const DATA_FILE = /\.(ya?ml|md|json)$/i;
const discovered = (n) => DISCOVERY.test(n) && !DATA_FILE.test(n);

test('discovery: no file outside tests/ has a node --test basename', async () => {
  const all = await walk(ROOT, discovered);
  none(all.map(rel).filter((r) => !r.startsWith('tests/')), 'script collected by node --test');
});

test('discovery pattern recognizes the dangerous names (self-check)', () => {
  for (const n of ['test-matrix.mjs', 'a.test.mjs', 'a-test.js', 'a_test.cjs', 'test.mjs', 'test-a.ts', 'test-x.cjs']) assert.ok(discovered(n), n);
  assert.ok(!discovered('run-matrix.mjs'));
  for (const n of ['test-report.yml', 'test-a.yaml', 'test-notes.md', 'a.test.json']) assert.ok(!discovered(n), n);
});

test('test-matrix: run-matrix exits at once under the test runner and hardcodes no user path', async () => {
  const src = await read(path.join(ROOT, 'scripts', 'run-matrix.mjs'));
  assert.match(src, /NODE_TEST_CONTEXT/);
  assert.match(src, /USERPROFILE/);
  assert.doesNotMatch(src, /luigi/i);
  assert.match(src, /shell: false/);
});

const TAP = (t, p, f, s) => `TAP version 13\n# tests ${t}\n# pass ${p}\n# fail ${f}\n# skipped ${s}\n`;
const rts = [{ id: 'a', cmd: 'a', versionArgs: ['-v'], testArgs: ['t'] }];

test('test-matrix: parseTapSummary reads the trailer', () => {
  assert.deepEqual(parseTapSummary(TAP(10, 8, 0, 2)), { tests: 10, pass: 8, fail: 0, skipped: 2 });
  assert.equal(parseTapSummary('garbage'), null);
});

test('test-matrix: pass, fail, not-available and killed-before-start with simulated spawn', async () => {
  const mk = (probe, res) => async (cmd, args) => (args[0] === '-v' ? probe : res);
  const ok = { code: 0, stdout: 'v18.0.0\n', stderr: '' };
  let rows = await runMatrix(rts, { spawn: mk(ok, { code: 0, stdout: TAP(5, 5, 0, 0), stderr: '' }) });
  assert.deepEqual(rows[0], { runtime: 'a', version: 'v18.0.0', tests: 5, pass: 5, fail: 0, skipped: 0, status: 'pass' });
  rows = await runMatrix(rts, { spawn: mk(ok, { code: 1, stdout: TAP(5, 4, 1, 0), stderr: '' }) });
  assert.equal(rows[0].status, 'fail');
  rows = await runMatrix(rts, { spawn: mk({ code: null, stdout: '', stderr: '', error: Object.assign(new Error('x'), { code: 'ENOENT' }) }, null) });
  assert.equal(rows[0].status, 'not-available');
  rows = await runMatrix(rts, { spawn: mk(ok, { code: 3221225794, stdout: '', stderr: '' }) });
  assert.equal(rows[0].status, 'killed-before-start');
  rows = await runMatrix(rts, { spawn: mk(ok, { code: 1, stdout: '', stderr: 'cygheap read copy failed ... Win32 error 299' }) });
  assert.equal(rows[0].status, 'killed-before-start');
});

test('test-matrix: a killed runtime is probed once and never rerun automatically', async () => {
  let calls = 0;
  const spawn = async () => { calls += 1; return { code: 3221225794, stdout: '', stderr: '' }; };
  const rows = await runMatrix(rts, { spawn });
  assert.equal(rows[0].status, 'killed-before-start');
  assert.equal(calls, 1);
});

test('test-matrix: runtime list is 3 Windows + 4 Linux and the table renders', () => {
  const list = buildRuntimes({ repoRoot: 'C:/r', wslRoot: '/mnt/c/r', userProfile: 'C:/Users/x' });
  assert.equal(list.length, 7);
  assert.equal(list.filter((r) => r.id.startsWith('linux-')).length, 4);
  assert.match(toMarkdown([{ runtime: 'a', version: 'v1', tests: 1, pass: 1, fail: 0, skipped: 0, status: 'pass' }]), /\| a \| v1 \| 1 \| 1 \| 0 \| 0 \| pass \|/);
});
