// DET-03 constants: linear regexes (bounded lengths, no nested quantifiers) and the tooling allowlist.
// Sources are ALWAYS string literals (never /regex/ literals). Ids are kebab-case, no parentheses.
// Thresholds and the allowlist are initial values (D-21 "to be tuned with fixtures"): tune in Phase 3.

// Valid JS spacing everywhere (`require (`, `import{x}from'y'`), re-exports, a `} from` that closes a multi-line
// import list, require.resolve, and require passed around as a value (review CR-03).
export const IMPORT_PATTERNS = [
  { id: 'require-literal', source: '\\brequire\\s*\\(\\s*[\'"]([^\'"\\n]{1,214})[\'"]\\s*\\)', flags: '' },
  { id: 'require-resolve', source: '\\brequire\\.resolve\\s*\\(\\s*[\'"]([^\'"\\n]{1,214})[\'"]', flags: '' },
  // Not after `-`/`.`, nor after a `/` that does not close a block comment (03-06 panel: `'unicorn/prefer-export-from'`
  // is a string, not an import; review 03-A CR-01: `/* x */import` and `x/**/from` are imports).
  { id: 'import-from', source: '(?<![-.])(?<![^*]/)\\b(?:import|export)\\b[^\'"\\n]{0,500}?(?<![-.])(?<![^*]/)\\bfrom\\s*[\'"]([^\'"\\n]{1,214})[\'"]', flags: '' },
  { id: 'import-list-end', source: '\\}\\s*from\\s*[\'"]([^\'"\\n]{1,214})[\'"]', flags: '' },
  { id: 'import-bare', source: '\\bimport\\s*[\'"]([^\'"\\n]{1,214})[\'"]', flags: '' },
  { id: 'import-dynamic', source: '\\bimport\\s*\\(\\s*[\'"]([^\'"\\n]{1,214})[\'"]\\s*\\)', flags: '' },
  { id: 'require-dynamic', source: '\\brequire\\s*\\(\\s*[^\'"\\s)]', flags: '' },
  { id: 'require-concat', source: '\\brequire\\s*\\(\\s*[\'"][^\'"\\n]{0,214}[\'"]\\s*[^\\s)]', flags: '' },
  { id: 'require-alias', source: '[=:,(\\[]\\s*require\\s*(?:[;,)\\]}]|$)', flags: '' },
  { id: 'create-require', source: '\\bcreateRequire\\s*\\(', flags: '' },
];

/** Pattern ids whose match is a module load with no literal package name. */
export const DYNAMIC_IDS = new Set(['require-dynamic', 'require-concat', 'require-alias', 'create-require']);

/** @param {number} escapeRun integer already validated in its band (5-100) by the user config */
export function buildObfuscationPatterns(escapeRun) {
  const n = Math.trunc(escapeRun);
  return [
    { id: 'eval-call', source: '\\beval\\s*\\(', flags: '' },
    { id: 'new-function', source: '\\bnew\\s+Function\\s*\\(', flags: '' },
    { id: 'atob-call', source: '\\batob\\s*\\(', flags: '' },
    { id: 'buffer-base64', source: 'Buffer\\.from\\([^)\\n]{0,200}[\'"]base64[\'"]', flags: '' },
    { id: 'hex-identifier', source: '\\b_0x[0-9a-fA-F]{4,}', flags: '' },
    { id: 'global-bracket-key', source: 'global\\[\\s*[\'"](!|_V)[\'"]\\s*\\]', flags: '' },
    { id: 'child-process', source: '[\'"](node:)?child_process[\'"]', flags: '' },
    // At least `escapeRun` escapes, separated by at most 40 non-backslash characters.
    { id: 'escape-run', source: `(?:\\\\(?:x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4})[^\\\\\\n]{0,40}){${n}}`, flags: '' },
  ];
}

export const OBFUSCATION_PATTERNS = buildObfuscationPatterns(20);

export const MAX_CODE_COLUMN = 300;
export const WHITESPACE_RUN = 40;

// An entry ending with "*" is a prefix; any other entry is an exact package name.
export const TOOLING_ALLOWLIST = new Set([
  'tailwindcss', '@tailwindcss/*', 'tailwindcss-animate', 'postcss', 'autoprefixer', 'next', '@next/*',
  'vite', '@vitejs/*', 'eslint', '@eslint/*', 'eslint-config-*', 'eslint-plugin-*', '@typescript-eslint/*',
  'typescript-eslint', '@babel/*', 'babel-*', 'webpack', 'webpack-*', 'jest', 'ts-jest', 'nuxt', '@nuxt/*',
  'typescript', 'prettier', 'prettier-plugin-*', 'vitest', '@vitest/*', 'rollup', '@rollup/*', 'esbuild',
  '@sveltejs/*', 'svelte', '@astrojs/*', 'astro', 'globals', 'path-browserify',
]);

/**
 * False for a `.`/`..` segment (either separator), a backslash or a percent sign: Node can resolve such a specifier
 * outside the package it starts with (review CR-A-03), so it never matches an allowlist entry, built-in or user.
 */
export function isCanonicalSpecifier(spec) {
  const s = String(spec);
  return !/[\\%]/.test(s) && !s.split('/').some((p) => p === '.' || p === '..');
}

/**
 * @param {string} name package name without subpath @param {Iterable<string>} extra user allowlist (options)
 * @param {{tooling?: boolean}} [opts] tooling=false when the name is served by a registry the repository redirected
 *   (review WR-07): the built-in list no longer means "known tooling"; the user's own list still applies.
 */
export function isAllowlisted(name, extra = [], { tooling = true } = {}) {
  if (!isCanonicalSpecifier(name)) return false;
  for (const set of tooling ? [TOOLING_ALLOWLIST, extra] : [extra]) {
    for (const entry of set) {
      if (entry.endsWith('*') ? name.startsWith(entry.slice(0, -1)) : entry === name) return true;
    }
  }
  return false;
}
