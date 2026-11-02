// Test helper (not tool code): import and code policy of the shipped sources (review tests WR-03).
// `file` is the path relative to the repo root. Specifiers are read from the raw text (stripJs blanks strings).
const SPEC = /(?:from\s+|import\s*)['"]([^'"]+)['"]/g;

// Positive allowlist of node:* modules: null = any file, string = the only file allowed to import it.
const NODE_ALLOWED = {
  fs: null,
  'fs/promises': null,
  path: null,
  os: 'lib/config/locate.mjs',
  url: null,
  util: null,
  async_hooks: null,
  child_process: 'lib/acquire/token.mjs',
  vm: 'lib/util/text-scan.mjs',
  module: 'lib/rules/config-files.mjs',
};
// node:module only for the list of builtin names: createRequire would bypass the ban on require().
const MODULE_IMPORT_OK = /^import\s*\{\s*builtinModules\s*\}\s*from\s*['"]node:module['"]/;

function statementAt(raw, index) {
  const start = Math.max(raw.lastIndexOf('import', index), raw.lastIndexOf('export', index), 0);
  return raw.slice(start, raw.indexOf(';', index) + 1 || raw.length);
}

/** Violations of the import policy in one source file, as "file: reason". */
export function importViolations(file, raw) {
  const bad = [];
  for (const m of raw.matchAll(SPEC)) {
    const spec = m[1];
    if (spec.startsWith('./') || spec.startsWith('../')) continue;
    if (!spec.startsWith('node:')) { bad.push(`${file}: external ${spec}`); continue; }
    const name = spec.slice('node:'.length);
    if (!Object.prototype.hasOwnProperty.call(NODE_ALLOWED, name)) { bad.push(`${file}: ${spec} not on the allowlist`); continue; }
    const home = NODE_ALLOWED[name];
    if (home && !file.endsWith(home)) bad.push(`${file}: ${spec} outside ${home}`);
    else if (name === 'module' && !MODULE_IMPORT_OK.test(statementAt(raw, m.index))) bad.push(`${file}: node:module beyond builtinModules`);
  }
  return bad;
}

// Code shapes matched on the stripped code. `fetch` lives only in util/http.mjs (the single network exit) and in
// analyze.mjs, which injects globalThis.fetch as the default dependency.
const FETCH_HOMES = ['lib/util/http.mjs', 'lib/analyze.mjs'];
const CODE_BANS = [
  ['native binding', /(?<![\w$])process\s*(?:\.\s*(?:binding|dlopen|_linkedBinding)(?![\w$])|\[)/],
  ['network API', /(?<![\w$])(?:WebSocket|XMLHttpRequest|EventSource)(?![\w$])/],
];
const RAW_BANS = [['plain or websocket URL', /\b(?:http|wss?):\/\/[A-Za-z0-9]/]];

/** Violations found in the stripped code (`code`) and in the raw text (`raw`) of one source file. */
export function codeViolations(file, code, raw) {
  const bad = [];
  for (const [what, re] of CODE_BANS) if (re.test(code)) bad.push(`${file}: ${what}`);
  for (const [what, re] of RAW_BANS) if (re.test(raw)) bad.push(`${file}: ${what}`);
  if (/(?<![\w$])fetch(?![\w$])/.test(code) && !FETCH_HOMES.some((h) => file.endsWith(h))) bad.push(`${file}: fetch outside util/http.mjs`);
  return bad;
}
