// README visuals (D-116): the self-hosted SVG assets are inert and referenced by both READMEs, and the example output
// in the READMEs is the real output of the script on the real-case fixture, offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../skills/repoflags/scripts/repoflags.mjs';
import { makeIo } from './helpers/io.mjs';
import { materialize } from './helpers/materialize.mjs';
import { makeForbiddenFetch } from './helpers/fake-fetch.mjs';
import { files as realCase } from './fixtures/real-case.mjs';
import { buildRuntimes } from '../scripts/run-matrix.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS_DIR = 'docs/assets';
const ASSETS = ['banner.svg', 'banner-dark.svg', 'logo.svg'].map((n) => `${ASSETS_DIR}/${n}`);
const READMES = ['README.md', 'README.it.md'];
const MAX_BYTES = 15 * 1024;
const G7_RE = new RegExp('sa' + 'fe', 'i');
const XMLNS_URLS = new Set(['http://www.w3.org/2000/svg', 'http://www.w3.org/1999/xlink']);

const read = (p) => fs.readFile(path.join(ROOT, p), 'utf8');

/** Reasons why an SVG text could load, run or link something. Empty = inert. */
function svgProblems(raw) {
  const out = [];
  if (!/^\s*(<\?xml[^>]*\?>\s*)?<svg\b/.test(raw)) out.push('does not start with <svg');
  if (!/<title\b[^>]*>[^<]+<\/title>/.test(raw)) out.push('no <title>');
  for (const [re, why] of [[/<script/i, 'script'], [/<foreignObject/i, 'foreignObject'], [/\son[a-z]+\s*=/i, 'event handler'],
    [/href\s*=\s*["']\s*(https?:|javascript:|data:|\/\/)/i, 'external href'], [/@import/i, '@import'],
    [/url\(\s*["']?\s*(https?:|\/\/)/i, 'external url()'], [/<(image|use|iframe|embed|object)\b/i, 'embedding element'],
    [/font-face/i, 'font-face']]) {
    if (re.test(raw)) out.push(why);
  }
  for (const m of raw.matchAll(/https?:\/\/[^\s"'<>)]+/gi)) {
    const before = raw.slice(Math.max(0, m.index - 12), m.index);
    if (!(XMLNS_URLS.has(m[0]) && /xmlns(:xlink)?=["']$/.test(before))) out.push(`url ${m[0]}`);
  }
  if (G7_RE.test(raw)) out.push('G7 word');
  return out;
}

test('A0 self-check: svgProblems flags every loading or running construct and accepts the xmlns', () => {
  const ok = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><title>t</title><rect/></svg>';
  assert.deepEqual(svgProblems(ok), []);
  const wrap = (body) => ok.replace('<rect/>', body);
  for (const bad of ['<script>x()</script>', '<foreignObject/>', '<rect onload="x()"/>', '<a href="https://example.com">x</a>',
    '<a xlink:href="javascript:x()">x</a>', '<style>@import "x.css";</style>', '<rect fill="url(https://example.com/#g)"/>',
    '<image href="a.png"/>', '<use href="#a"/>', '<style>@font-face{}</style>', '<text>see http://example.com</text>']) {
    assert.notDeepEqual(svgProblems(wrap(bad)), [], bad);
  }
  assert.notDeepEqual(svgProblems(ok.replace('<title>t</title>', '')), []);
});

for (const asset of ASSETS) {
  test(`A1 ${asset}: exists, under 15 KB, inert (no script, foreignObject, external link or font)`, async () => {
    const st = await fs.stat(path.join(ROOT, asset));
    assert.ok(st.size > 0 && st.size < MAX_BYTES, `${asset}: ${st.size} bytes`);
    assert.deepEqual(svgProblems(await read(asset)), []);
  });
}

test('A2 docs/assets holds only the declared SVG assets, each referenced by both READMEs', async () => {
  const present = (await fs.readdir(path.join(ROOT, ASSETS_DIR))).map((n) => `${ASSETS_DIR}/${n}`).sort();
  assert.deepEqual(present, [...ASSETS].sort());
  for (const file of READMES) {
    const raw = await read(file);
    for (const asset of ASSETS) assert.ok(raw.includes(`"${asset}"`), `${file} references ${asset}`);
  }
});

test('A3 both READMEs carry the mermaid "how it works" diagram', async () => {
  for (const file of READMES) {
    const raw = await read(file);
    const block = (raw.match(/```mermaid\n([\s\S]*?)```/) || [])[1];
    assert.ok(block && /^flowchart\b/m.test(block), `${file}: mermaid flowchart`);
    for (const s of ['OSV', 'npm', 'GitHub', '--offline']) assert.ok(block.includes(s), `${file}: ${s}`);
  }
});

// Lines that change from one run to the next: the temp folder name and the time of the run.
const normalize = (line) => line.replace(/repoflags-fx-[A-Za-z0-9]+/g, '<dir>').replace(/At: \S+/, 'At: <time>').trimEnd();

/**
 * Why the README example is not the real output, or null when it is. Line by line equality after `normalize` (the only
 * declared variable parts: folder name and time); trailing empty lines are ignored; no elision is accepted.
 */
function exampleMismatch(example, real) {
  const trim = (lines) => { const out = [...lines]; while (out.length && out[out.length - 1] === '') out.pop(); return out; };
  const [a, b] = [trim(example), trim(real)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return `line ${i + 1}: README ${JSON.stringify(a[i])}, real ${JSON.stringify(b[i])}`;
  }
  return null;
}

test('A4 self-check: the example must be the whole real output, without omitted or invented lines (review B WR-04)', () => {
  const real = ['repoflags 1.0.0 - <dir>', 'Outcome: signals found', 'HIGH', '  [S1] a', '  [S2] b', 'network: none', ''];
  assert.equal(exampleMismatch(real, real), null);
  assert.equal(exampleMismatch(real.slice(0, -1), real), null, 'the trailing newline of the output does not count');
  assert.notEqual(exampleMismatch(real.filter((l) => l !== '  [S2] b'), real), null, 'an omitted signal');
  assert.notEqual(exampleMismatch(real.slice(0, 3), real), null, 'a truncated output');
  assert.notEqual(exampleMismatch(['repoflags 1.0.0 - <dir>', '...', 'network: none'], real), null, 'an elision');
  assert.notEqual(exampleMismatch([...real.slice(0, 2), 'Mode: invented', ...real.slice(2)], real), null, 'an invented line');
});

async function realOutputLines(t) {
  const { dir, cleanup } = await materialize(realCase);
  t.after(cleanup);
  const { io, stdout } = makeIo();
  const noGh = async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); };
  const fetch = makeForbiddenFetch();
  const code = await main([dir, '--offline'], io, { fetch, execGh: noGh, env: {} });
  assert.equal(code, 1);
  assert.equal(fetch.log.length, 0, 'offline: no network call');
  return stdout().split(/\r?\n/).map(normalize);
}

test('A4 the example output in both READMEs is the whole real offline output on the real-case fixture, line by line', async (t) => {
  const real = await realOutputLines(t);
  for (const file of READMES) {
    const raw = await read(file);
    const block = (raw.match(/```text\n(repoflags [\s\S]*?)```/) || [])[1];
    assert.ok(block, `${file}: text block with the report`);
    assert.match(raw, /--offline/);
    assert.equal(exampleMismatch(block.split('\n').map(normalize), real), null, file);
    for (const s of ['Outcome: signals found', 'Mode: offline', 'network: none']) assert.ok(block.includes(s), `${file}: ${s}`);
  }
});

// Claims about where the script was measured follow the local matrix (review B WR-01): the Node majors per operating
// system come from buildRuntimes, never from a range written by hand. The release notes are a work copy that is not in
// the public tree: found by name, checked only where they exist.
async function releaseNotes() {
  const phases = path.join(ROOT, '.plan' + 'ning', 'phases');
  const out = [];
  for (const d of (await fs.readdir(phases).catch(() => [])).sort()) {
    for (const n of await fs.readdir(path.join(phases, d)).catch(() => [])) {
      if (n.endsWith('RELEASE-NOTES.md')) out.push(path.relative(ROOT, path.join(phases, d, n)));
    }
  }
  return out;
}

function measuredMajors() {
  const ids = buildRuntimes({ repoRoot: ROOT, wslRoot: '/repo', userProfile: 'profile' }).map((r) => r.id);
  const majors = (re) => [...new Set(ids.map((id) => (id.match(re) || [])[1]).filter(Boolean).map(Number))].sort((a, b) => a - b);
  return { windows: majors(/^windows-node-(\d+)/), wsl: majors(/^linux-wsl-node-(\d+)/) };
}

test('A5 the script platforms in both READMEs and in the release notes are exactly the measured matrix', async () => {
  const { windows, wsl } = measuredMajors();
  assert.ok(windows.length && wsl.length, 'matrix runtimes');
  const claims = [`Windows (Node ${windows.join(', ')})`, `WSL (Node ${wsl.join(', ')})`];
  const notes = await releaseNotes();
  if (await fs.stat(path.join(ROOT, '.plan' + 'ning', 'STATE.md')).catch(() => null)) assert.ok(notes.length, 'release notes in the work tree');
  for (const file of [...READMES, ...notes]) {
    const raw = await read(file);
    for (const c of claims) assert.ok(raw.includes(c), `${file}: ${c}`);
    assert.doesNotMatch(raw, /Node (\d+) to \d+|Node da \d+ a \d+/, `${file}: a version range that was not measured`);
  }
});
