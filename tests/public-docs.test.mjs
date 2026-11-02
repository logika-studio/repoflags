import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { matchLines } from './helpers/js-strip.mjs';
import { IT_VERDICT_RE } from './helpers/skill-md.mjs';
import { maskSecret } from '../skills/repoflags/scripts/lib/util/sanitize.mjs';
import { OUTCOME_TEXT } from '../skills/repoflags/scripts/lib/constants.mjs';

// Static checks on the public documentation (PUB-02, D-103, D-105..D-108, D-114).
// No YAML parser: the issue forms are checked line by line, the repo has zero dependencies.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['.git', 'node_modules', '.planning', '.claude']);
const FORMS = path.join(ROOT, '.github', 'ISSUE_TEMPLATE');

const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');
const readOrNull = async (f) => fs.readFile(f, 'utf8').catch(() => null);
const exists = async (f) => (await readOrNull(f)) !== null;

async function walk(dir, accept, out = []) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, accept, out);
    else if (accept(e.name)) out.push(full);
  }
  return out;
}

async function mustRead(relPath) {
  const raw = await readOrNull(path.join(ROOT, relPath));
  assert.ok(raw !== null, `${relPath} exists`);
  return raw;
}

const where = (file, text, re) => matchLines(text, re).map((l) => `${file}:${l}`);
const none = (hits, msg) => assert.deepEqual(hits, [], `${msg}: ${hits.join(', ')}`);

// G7: the verdict word is banned as a substring, case-insensitive (same semantics as the check on the tool sources).
// Composed at runtime so this file never contains it.
const G7_RE = new RegExp('sa' + 'fe', 'i');

// ---------------------------------------------------------------------------------------------------------------
// Community files
// ---------------------------------------------------------------------------------------------------------------

test('C1 LICENSE is MIT with the Logika.studio copyright (D-105)', async () => {
  const raw = await mustRead('LICENSE');
  assert.equal(raw.split(/\r?\n/)[0].trim(), 'MIT License');
  assert.ok(raw.includes('Copyright (c) 2026 Logika.studio'), 'copyright line');
  assert.ok(raw.includes('THE SOFTWARE IS PROVIDED "AS IS"'), 'warranty disclaimer');
});

test('C2 SECURITY.md explains every reporting route, without promised response times (D-106)', async () => {
  const raw = await mustRead('SECURITY.md');
  for (const s of ['tech-area@logikastudio.it', 'detection-report', 'OSV', 'npm']) assert.ok(raw.includes(s), s);
  assert.match(raw, /private vulnerability reporting/i);
  assert.match(raw, /never paste/i, 'warning against pasting tokens, credentials or live payloads');
  assert.doesNotMatch(raw, /\bSLA\b|within \d+ (hours|days)/i);
});

test('C3 CONTRIBUTING.md states the rules for contributors (D-107)', async () => {
  const raw = await mustRead('CONTRIBUTING.md');
  for (const s of ['npm test', 'cd tests && node --test', 'CLAUDE.md', 'AGENTS.md', 'tasks.json', 'G1', 'G10']) {
    assert.ok(raw.includes(s), s);
  }
  assert.match(raw, /zero runtime dependencies/i);
  assert.match(raw, /failing test/i);
});

/** Splits the `body:` of an issue form into its elements (each starts with `- type:` at any indentation). */
function bodyElements(raw) {
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((l) => /^body:\s*$/.test(l));
  if (start < 0) return [];
  const els = [];
  for (const l of lines.slice(start + 1)) {
    if (/^\S/.test(l)) break;
    if (/^\s*-\s+type:/.test(l)) els.push([l]);
    else if (els.length) els[els.length - 1].push(l);
  }
  return els.map((e) => e.join('\n'));
}

const ids = (raw) => [...raw.matchAll(/^\s+id:\s*["']?([\w-]+)["']?\s*$/gm)].map((m) => m[1]);
const topName = (raw) => (raw.match(/^name:\s*(.+?)\s*$/m) || [])[1];

const FORM_IDS = {
  'test-report.yml': ['client', 'model', 'version', 'os', 'scenario', 'outcome', 'log'],
  'detection-report.yml': ['kind', 'package-or-file', 'osv-id', 'commit', 'details'],
};

test('C4 issue forms have the required keys, valid dropdowns and the expected fields (D-108)', async () => {
  const names = [];
  for (const [file, expected] of Object.entries(FORM_IDS)) {
    const raw = await mustRead(`.github/ISSUE_TEMPLATE/${file}`);
    for (const key of ['name', 'description', 'body']) assert.match(raw, new RegExp(`^${key}:`, 'm'), `${file}: ${key}`);
    names.push(topName(raw));
    assert.match(raw, /do not paste/i, `${file}: warning`);
    const els = bodyElements(raw);
    assert.ok(els.length > 0, `${file}: body elements`);
    for (const el of els.filter((e) => /type:\s*dropdown/.test(e))) assert.match(el, /^\s+options:/m, `${file}: dropdown options`);
    const found = ids(raw);
    for (const id of expected) assert.ok(found.includes(id), `${file}: id ${id}`);
  }
  assert.equal(new Set(names).size, names.length, 'form names are unique');
  const kind = bodyElements(await mustRead('.github/ISSUE_TEMPLATE/detection-report.yml')).find((e) => /id:\s*kind/.test(e));
  assert.match(kind, /false positive/i);
  assert.match(kind, /false negative/i);
});

test('C4 self-check: the body splitter finds dropdowns without options', () => {
  const bad = 'name: x\ndescription: y\nbody:\n  - type: dropdown\n    id: a\n    attributes:\n      label: A\n  - type: input\n    id: b\n';
  const els = bodyElements(bad);
  assert.equal(els.length, 2);
  assert.doesNotMatch(els[0], /^\s+options:/m);
  assert.deepEqual(ids(bad), ['a', 'b']);
});

test('C5 config.yml disables blank issues and links the security policy (D-108)', async () => {
  const raw = await mustRead('.github/ISSUE_TEMPLATE/config.yml');
  assert.match(raw, /^blank_issues_enabled:\s*false\s*$/m);
  assert.ok(raw.includes('https://github.com/logika-studio/repoflags/security/policy'), 'security policy url');
});

async function g7Files() {
  const roots = [];
  for (const n of ['LICENSE', 'SECURITY.md', 'CONTRIBUTING.md']) {
    const f = path.join(ROOT, n);
    if (await exists(f)) roots.push(f);
  }
  const docs = await walk(path.join(ROOT, 'docs'), (n) => /\.md$/i.test(n));
  const forms = await walk(FORMS, (n) => /\.ya?ml$/i.test(n));
  return [...roots, ...docs, ...forms];
}

test('C6 the G7 verdict word never appears in the public docs (D-103)', async () => {
  const files = await g7Files();
  const hits = [];
  for (const f of files) hits.push(...where(rel(f), await fs.readFile(f, 'utf8'), G7_RE));
  none(hits, 'forbidden word');
});

test('C6 self-check: the scanned list covers the public docs and the pattern matches substrings', async () => {
  const scanned = (await g7Files()).map(rel);
  const expected = ['LICENSE', 'SECURITY.md', 'CONTRIBUTING.md', 'docs/ideas/learned-rules.md',
    '.github/ISSUE_TEMPLATE/test-report.yml', '.github/ISSUE_TEMPLATE/detection-report.yml', '.github/ISSUE_TEMPLATE/config.yml'];
  for (const p of expected) {
    if (await exists(path.join(ROOT, p))) assert.ok(scanned.includes(p), `${p} is scanned`);
  }
  assert.ok(scanned.includes('docs/ideas/learned-rules.md'), 'docs/ is walked');
  for (const s of ['sa' + 'fety', 'fail' + 'sa' + 'fe', 'Un' + 'SA' + 'FE']) assert.match(s, G7_RE, s);
  assert.doesNotMatch(OUTCOME_TEXT.none, G7_RE);
});

test('C7 .gitattributes forces LF for the YAML files (D-114)', async () => {
  const attrs = (await mustRead('.gitattributes')).split(/\r?\n/).map((l) => l.trim().split(/\s+/));
  const line = attrs.find((a) => a[0] === '*.yml');
  assert.ok(line, 'rule for *.yml');
  assert.ok(line.includes('text') && line.includes('eol=lf'), '*.yml: text eol=lf');
});

// ---------------------------------------------------------------------------------------------------------------
// README (extended by plan 04-05)
// ---------------------------------------------------------------------------------------------------------------

const README_EN = 'README.md';
const README_IT = 'README.it.md';

// R2: the `## ` headings, in order (D-98, plus the D-116 sections). The Italian file has the same sections in the same order.
const HEADINGS_EN = ['What it does', 'How it works', 'Why it exists', 'Quick start', 'Install', 'Usage', 'Output levels',
  'Example output', 'Configuration', 'Guardrails', 'Limits of v1', 'Tested with / help us test', 'If you already ran it',
  'Reporting', 'Open ideas', 'Compared with web scanners', 'Related projects', 'License'];
const HEADINGS_IT = ['Cosa fa', 'Come funziona', 'Perché esiste', 'Quick start', 'Installazione', 'Uso',
  "Livelli dell'output", 'Esempio di output', 'Personalizzazione', 'Guardrail', 'Limiti della v1',
  'Tested with / aiutaci a testare', "Se l'hai già eseguito", 'Segnalazioni', 'Idee aperte',
  'Confronto con gli scanner web', 'Progetti affini', 'Licenza'];

// R3: strings both READMEs must contain. The hash is the SKILL.md measured by the red team (tests/skill-md-hash.test.mjs).
const REQUIRED = ['/plugin marketplace add logika-studio/repoflags', '/plugin install repoflags@logika-studio',
  'node skills/repoflags/scripts/repoflags.mjs', 'skills/repoflags/references/configuration.md',
  'skills/repoflags/references/incident-response.md', 'docs/ideas/learned-rules.md', 'SECURITY.md', 'CONTRIBUTING.md',
  'LICENSE', 'issues/new?template=test-report.yml', 'tailwind-animate-kit', 'https://osv.dev/vulnerability/MAL-2026-18078',
  '78a7397a764e7bd3acad74e40644330be13102a46189e2aaf37f72b98bf6c2d4'];
const CTA = 'https://logikastudio.it/?utm_source=github&utm_medium=readme&utm_campaign=repoflags';

// R6 (G8, D-99): SHA-256 of the lowercase bare names the READMEs must never contain (lure repository owner and name,
// private scope and its package, publisher account). Only the hashes live here: this file is public.
const FORBIDDEN_NAME_HASHES = new Set([
  '0b859f7135578ae96b71f5ffe722f954728d5cba555e4908b49d530548fbc5fe',
  '3f15541bb17d0b1c82aaf20a5e071c6160c9e41b96afd977eaee751f51bcc1c9',
  '8035e05820725e8e91b46b4e4f8391407e31a36dddd503bfae3085d16d5b10be',
  '5dc9e154c47945d5394d148755087e1113db7b973af81822eb9adbbc4e7c93f0',
  'cfa696c22b49bc4b5a819396298c6b5dc46b96ac25e8e8a3f6faf29d2f9137cc',
]);

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const headings = (raw) => raw.split(/\r?\n/).filter((l) => l.startsWith('## ')).map((l) => l.slice(3).trim());
const readmes = async () => [[README_EN, await mustRead(README_EN)], [README_IT, await mustRead(README_IT)]];

/** Every name a token could hide: whole, without a leading @, each `/` part, and without a trailing dot. */
function nameCandidates(text) {
  const out = new Set();
  for (const token of text.toLowerCase().split(/[^a-z0-9@._/-]+/).filter(Boolean)) {
    for (const c of [token, ...token.split('/')]) {
      for (const d of [c, c.replace(/^@/, '')]) {
        out.add(d).add(d.replace(/\.+$/, ''));
      }
    }
  }
  out.delete('');
  return [...out];
}
const forbiddenNames = (text, hashes = FORBIDDEN_NAME_HASHES) => nameCandidates(text).filter((c) => hashes.has(sha256(c)));

// R8 (D-116): images come only from the self-hosted SVG assets, shields.io static badges and the GitHub CI badge.
// Release badges are out: there is no release yet (D-117). Version and Node badges follow package.json.
const LOCAL_ASSETS = ['docs/assets/banner.svg', 'docs/assets/banner-dark.svg', 'docs/assets/logo.svg'];
const CI_BADGE = 'https://github.com/logika-studio/repoflags/actions/workflows/ci.yml/badge.svg';
const SHIELDS_STATIC_RE = /^https:\/\/img\.shields\.io\/badge\/[A-Za-z0-9%._-]+(\?[A-Za-z0-9=&%._-]*)?$/;
const PKG = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
const shieldsText = (s) => encodeURIComponent(s).replace(/-/g, '--').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const REQUIRED_BADGES = [
  /^https:\/\/img\.shields\.io\/badge\/license-MIT-/,
  /^https:\/\/img\.shields\.io\/badge\/dependencies-0-/,
  new RegExp(`^https://img\\.shields\\.io/badge/node-${shieldsText(PKG.engines.node)}-`),
  new RegExp(`^https://img\\.shields\\.io/badge/version-${shieldsText(PKG.version)}-`),
];
const IMAGE_RES = [/!\[[^\]]*\]\(([^)\s]+)/g, /<img\b[^>]*?\bsrc=["']([^"']+)["']/gi, /<source\b[^>]*?\bsrcset=["']([^"']+)["']/gi];
const imageSources = (raw) => IMAGE_RES.flatMap((re) => [...raw.matchAll(re)].map((m) => m[1]));
const imageTagCount = (raw) => [/!\[[^\]]*\]\s*[([]/g, /<img\b/gi, /<source\b/gi].reduce((n, re) => n + [...raw.matchAll(re)].length, 0);
const allowedImage = (src) => LOCAL_ASSETS.includes(src) || src === CI_BADGE || SHIELDS_STATIC_RE.test(src);

test('R8 self-check: the image allowlist rejects other hosts, release badges and unknown assets', () => {
  for (const s of ['https://example.com/a.png', 'http://img.shields.io/badge/a-b-c', 'docs/assets/other.svg',
    'https://img.shields.io/github/v/release/logika-studio/repoflags', 'https://img.shields.io.evil.example/badge/a-b-c',
    'https://raw.githubusercontent.com/logika-studio/repoflags/main/docs/assets/banner.svg']) {
    assert.ok(!allowedImage(s), s);
  }
  for (const s of [...LOCAL_ASSETS, CI_BADGE, 'https://img.shields.io/badge/license-MIT-blue']) assert.ok(allowedImage(s), s);
  assert.equal(imageTagCount('![a][ref] <img src=x> <source srcset="y">'), 3);
  assert.deepEqual(imageSources('<img alt="a" src=\'docs/assets/logo.svg\'>'), ['docs/assets/logo.svg']);
  assert.match('https://img.shields.io/badge/node-%3E%3D18.20-339933', REQUIRED_BADGES[2]);
});

test('R1 pair: both READMEs exist and link each other in the first five lines (D-98)', async () => {
  const [[, en], [, it]] = await readmes();
  assert.match(en.split(/\r?\n/).slice(0, 5).join('\n'), /\]\(README\.it\.md\)/);
  assert.match(it.split(/\r?\n/).slice(0, 5).join('\n'), /\]\(README\.md\)/);
});

test('R2 README.md: the sections of D-98 in order', async () => {
  assert.deepEqual(headings(await mustRead(README_EN)), HEADINGS_EN);
});

test('R2 README.it.md: the same sections in Italian, in order', async () => {
  assert.deepEqual(headings(await mustRead(README_IT)), HEADINGS_IT);
});

test('R2 pair: same number of sections in the same order', async () => {
  const [[, en], [, it]] = await readmes();
  assert.equal(headings(it).length, headings(en).length);
  assert.equal(HEADINGS_IT.length, HEADINGS_EN.length);
});

for (const file of [README_EN, README_IT]) {
  test(`R3 ${file}: install commands, references, issue form, the real case and the measured prompt hash`, async () => {
    const raw = await mustRead(file);
    const missing = REQUIRED.filter((s) => !raw.includes(s));
    assert.deepEqual(missing, [], `${file} misses: ${missing.join(', ')}`);
  });

  test(`R4 ${file}: the CTA with UTM is there (D-104)`, async () => {
    assert.ok((await mustRead(file)).includes(CTA), 'CTA url');
  });

  test(`R7 ${file}: never the G7 verdict word`, async () => {
    none(where(file, await mustRead(file), G7_RE), 'forbidden word');
  });

  test(`R8 ${file}: images only from the allowlist (local SVG assets, shields.io static badges, CI badge) (D-116)`, async () => {
    const raw = await mustRead(file);
    const srcs = imageSources(raw);
    assert.equal(srcs.length, imageTagCount(raw), 'every image tag has a readable source');
    none(srcs.filter((s) => !allowedImage(s)), 'image outside the allowlist');
    for (const re of REQUIRED_BADGES) assert.ok(srcs.some((s) => re.test(s)), `badge ${re}`);
    assert.ok(srcs.includes(CI_BADGE), 'CI badge');
    assert.match(raw, /<source media="\(prefers-color-scheme: dark\)" srcset="docs\/assets\/banner-dark\.svg">/);
    assert.match(raw, /<img [^>]*src="docs\/assets\/banner\.svg"/);
  });
}

test('R4 README.md: no UTM parameter anywhere in the skill (D-104)', async () => {
  const files = await walk(path.join(ROOT, 'skills'), () => true);
  assert.ok(files.length > 0, 'skills/ is walked');
  const hits = [];
  for (const f of files) hits.push(...where(rel(f), await fs.readFile(f, 'utf8'), /utm_/));
  none(hits, 'utm in the skill');
});

test('R5 pair: every relative Markdown link points to a file of the repository', async () => {
  const broken = [];
  for (const [file, raw] of await readmes()) {
    for (const [, target] of raw.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
      const p = decodeURIComponent(target.split('#')[0]);
      if (!(await exists(path.join(ROOT, p)))) broken.push(`${file}: ${target}`);
    }
  }
  none(broken, 'broken relative links');
});

test('R6 self-check: a bare name hash catches the scoped, slashed and dotted forms only', () => {
  const name = ['zz', 'fixture', 'scope'].join('-');
  const hashes = new Set([sha256(name)]);
  for (const s of [`see @${name}/pkg here`, `see ${name}/pkg`, `the scope ${name}.`, `(${name.toUpperCase()})`]) {
    assert.deepEqual(forbiddenNames(s, hashes), [name], s);
  }
  assert.deepEqual(forbiddenNames('zz-fixture-other and tailwind-animate-kit', hashes), []);
});

test('R7 README.it.md: no Italian verdict word (D-103)', async () => {
  none(where(README_IT, await mustRead(README_IT), IT_VERDICT_RE), 'Italian verdict word');
});

// R9 (review B WR-02, WR-05): the guardrail lines say what the code does. G4: the script has no clone path
// (lib/acquire/github.mjs reads through the API) and SKILL.md forbids suggesting one. G9: a token found in the
// repository is printed masked, with the head length of maskSecret.
const GUARD_DOCS = [README_EN, README_IT, 'CONTRIBUTING.md'];
function guardText(raw, id) {
  const lines = raw.split(/\r?\n/);
  const i = lines.findIndex((l) => new RegExp(`^- (\\*\\*)?${id}\\b`).test(l));
  if (i < 0) return null;
  let end = i + 1;
  while (end < lines.length && /^ {2}\S/.test(lines[end])) end++;
  return lines.slice(i, end).join(' ');
}
const MASK_HEAD = maskSecret('x'.repeat(40)).indexOf('…');

for (const file of GUARD_DOCS) {
  test(`R9 ${file}: G4 never describes a clone`, async () => {
    const g4 = guardText(await mustRead(file), 'G4');
    assert.ok(g4, `${file}: G4 line`);
    assert.doesNotMatch(g4, /if (it )?clon|se clona|when possible|quando possibile/i);
    assert.match(g4, /never clones?|non clona mai/i);
  });

  test(`R9 ${file}: G9 says that a token found in the repository is shown masked, as maskSecret does`, async () => {
    const g9 = guardText(await mustRead(file), 'G9');
    assert.ok(g9, `${file}: G9 line`);
    assert.doesNotMatch(g9, /no token is printed|nessun token viene stampato/i);
    assert.match(g9, new RegExp(`first ${MASK_HEAD} characters|primi ${MASK_HEAD} caratteri`));
    assert.match(g9, /\b12\b/, 'the length from which the head is shown');
  });
}

test('R9 self-check: guardText joins wrapped lines and MASK_HEAD follows the code', () => {
  assert.equal(guardText('- **G9** a\n  b\n- **G10** c', 'G9'), '- **G9** a   b');
  assert.equal(guardText('- G4: x', 'G4'), '- G4: x');
  assert.equal(MASK_HEAD, 4);
  assert.equal(maskSecret('x'.repeat(12)).indexOf('…'), 4);
  assert.equal(maskSecret('x'.repeat(11)).indexOf('…'), 0);
});

// R10 (review B WR-06): every quote of the best outcome is the string the script prints.
// The release body is a work copy that is not in the public tree: found by name, checked only where it exists.
const WORK_DIR = path.join(ROOT, '.plan' + 'ning');
async function findReleaseNotes() {
  const phases = path.join(WORK_DIR, 'phases');
  for (const d of (await fs.readdir(phases).catch(() => [])).sort()) {
    const hit = (await fs.readdir(path.join(phases, d)).catch(() => [])).find((n) => n.endsWith('RELEASE-NOTES.md'));
    if (hit) return rel(path.join(phases, d, hit));
  }
  return null;
}
const RELEASE_NOTES = await findReleaseNotes();
const notesList = () => (RELEASE_NOTES ? [RELEASE_NOTES] : []);
const OUTCOME_QUOTE_RE = /no signals found by [a-z ]*?rules/gi;

test('R10 the public docs and the release notes quote the best outcome exactly as OUTCOME_TEXT.none', async () => {
  const files = [...(await g7Files()).map(rel), README_EN, README_IT, ...notesList()];
  const bad = [];
  for (const f of files) {
    for (const m of (await mustRead(f)).matchAll(OUTCOME_QUOTE_RE)) if (m[0] !== OUTCOME_TEXT.none) bad.push(`${f}: ${m[0]}`);
  }
  none(bad, 'outcome quoted differently from the script');
});

// R11 (review B WR-07): the G8 names check and the compatibility check cover every public doc and the release notes.
const COMPAT_EN_RE = /(works|compatible|tested) with (codex|cursor|opencode|gemini|chatgpt)/i;
const COMPAT_IT_RE = /(funziona|compatibile|testat[oaie]) con (codex|cursor|opencode|gemini|chatgpt)/i;
async function guardedDocs() {
  return [README_EN, README_IT, ...(await g7Files()).map(rel), ...notesList()];
}

test('R6 every public doc and the release notes: no account, lure repository or private scope name (G8, D-99)', async () => {
  const hits = [];
  for (const f of await guardedDocs()) hits.push(...forbiddenNames(await mustRead(f)).map((n) => `${f}: ${n}`));
  none(hits, 'forbidden name');
});

test('R7 every public doc and the release notes: no compatibility claim for clients that were not measured (D-100)', async () => {
  const hits = [];
  for (const f of await guardedDocs()) {
    const raw = await mustRead(f);
    hits.push(...where(f, raw, COMPAT_EN_RE), ...where(f, raw, COMPAT_IT_RE));
  }
  none(hits, 'claim');
});

test('R7 every public doc and the release notes: never the G7 verdict word (D-103)', async () => {
  const hits = [];
  for (const f of await guardedDocs()) hits.push(...where(f, await mustRead(f), G7_RE));
  none(hits, 'forbidden word');
});

test('R11 self-check: the G8 and compatibility guards cover every public doc and the release notes', async () => {
  const guarded = await guardedDocs();
  for (const p of [README_EN, README_IT, 'SECURITY.md', 'CONTRIBUTING.md', 'docs/ideas/learned-rules.md',
    '.github/ISSUE_TEMPLATE/test-report.yml', '.github/ISSUE_TEMPLATE/detection-report.yml', '.github/ISSUE_TEMPLATE/config.yml']) {
    assert.ok(guarded.includes(p), `${p} is guarded`);
  }
  if (await exists(path.join(WORK_DIR, 'STATE.md'))) assert.ok(RELEASE_NOTES, 'the work tree has release notes');
  if (RELEASE_NOTES) assert.ok(guarded.includes(RELEASE_NOTES), 'release notes are guarded');
  for (const s of ['funziona con Codex', 'compatibile con Cursor', 'testata con Gemini']) assert.match(s, COMPAT_IT_RE, s);
  assert.doesNotMatch('Gli altri client non sono stati testati', COMPAT_IT_RE);
});
