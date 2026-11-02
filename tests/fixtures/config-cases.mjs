// Harmless config-file contents used by tests/rule-config.test.mjs. Strings only, never executed or written to disk.

export const IMPORT_CASES = {
  realCase: { 'web/tailwind.config.js': "module.exports = { plugins: [require('tailwind-animate-kit')] };\n" },
  scoped: { 'a.config.js': "require(\"@scope/x/sub\");\nimport x from 'some-pkg';\nimport('other-pkg');\n" },
  dynamicVar: { 'a.config.js': 'const m = "x";\nrequire(m);\n' },
  dynamicConcat: { 'a.config.js': "require('a' + b);\n" },
  builtinsAndRelative: {
    'a.config.js': "require('node:path');\nrequire('fs');\nimport path from 'path';\nrequire('./local.js');\nrequire('../x');\n",
  },
  tooling: {
    'tailwind.config.js': [
      "require('@tailwindcss/forms');", "require('tailwindcss-animate');", "import tailwindcss from 'tailwindcss';",
      "require('autoprefixer');", "require('next');", "require('vite');", "import r from '@vitejs/plugin-react';",
      "require('eslint-plugin-react');", "require('@babel/preset-env');", "require('postcss');", "require('prettier');",
    ].join('\n'),
  },
  custom: { 'a.config.js': "require('my-plugin');\n" },
  notConfig: { 'src/index.js': "require('evil');\n" },
  names: {
    'eslint.config.mjs': "import a from 'pkg-one';\n",
    '.babelrc.js': "require('pkg-two');\n",
    'apps/web/next.config.ts': "import b from 'pkg-three';\n",
    'NEXT.CONFIG.MJS': "import c from 'pkg-four';\n",
  },
  sameLineEvasion: { 'a.config.js': "require('autoprefixer'); require('evil-second');\n" },
};

// Obfuscation cases: text only, nothing here is valid attack code.
export const BLOB_PLAIN = "console.log('fixture')";
export const BLOB_B64 = Buffer.from(BLOB_PLAIN).toString('base64');

export const INDICATOR_LINES = {
  'eval-call': 'eval(payload);',
  'new-function': 'const f = new Function(body);',
  'atob-call': 'const d = atob(blob);',
  'buffer-base64': "const d = Buffer.from(blob, 'base64');",
  'hex-identifier': 'var _0x1a2b = 1;',
  'global-bracket-key': "global['!'] = 1;",
  'global-bracket-key-v': "global['_V'] = 1;",
  'child-process': "const cp = require('child_process');",
};

export const ESCAPES_20 = `const s = "${'\\x41'.repeat(20)}";`;
export const LONG_LINE_400 = `module.exports = {${' '.repeat(10)}};${'/'.repeat(300)}x()`;
export const WHITESPACE_HIDDEN = `module.exports = {};${' '.repeat(60)}x()`;
export const WHITESPACE_TRAILING = `module.exports = {};${' '.repeat(60)}`;
export const WHITESPACE_INDENT = `${' '.repeat(60)}x();`;
export const MULTI_INDICATOR = "eval(atob(blob)); var _0x1a2b = 1;";
