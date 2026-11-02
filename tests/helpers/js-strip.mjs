// Test helper (not tool code): blanks comments, string contents, template text and regex literals of a JS source,
// keeping every newline so line numbers do not change. Single linear pass, no regex over the whole source.
// `}` and `)` are left out on purpose: a division read as a regex hides code, a regex read as a division only
// leaves its text visible (a false positive is preferred to a false negative, review tests WR-01).
const REGEX_AFTER = new Set('(,=:[!&|?{;+-*%<>~^');
const REGEX_AFTER_WORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await']);
const BS = String.fromCharCode(92);
const isIdent = (c) => /[A-Za-z0-9_$]/.test(c);

export function stripJs(src) {
  const out = src.split('');
  const n = src.length;
  const blank = (from, to) => { for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' '; };
  const tpl = []; // brace depth per open `${`
  let i = 0;
  let lastCh = '';
  let word = '';
  let lastWord = '';
  let inTemplate = false;
  let incDec = false; // last token is ++ or --: a following `/` is a division (`i++ / 2`)

  const flushWord = () => { if (word) { lastWord = word; word = ''; } };
  const regexAllowed = () => !incDec && (lastCh === '' || REGEX_AFTER.has(lastCh) || (isIdent(lastCh) && REGEX_AFTER_WORDS.has(lastWord)));

  function readTemplateText() { // i is just after ` or after a closing } of ${}
    const start = i;
    while (i < n) {
      if (src[i] === BS) { i += 2; continue; }
      if (src[i] === '`') { blank(start, i); i++; inTemplate = false; lastCh = 'a'; incDec = false; return; }
      if (src[i] === '$' && src[i + 1] === '{') { blank(start, i); i += 2; tpl.push(0); inTemplate = false; lastCh = '{'; incDec = false; return; }
      i++;
    }
    blank(start, n);
  }

  while (i < n) {
    if (inTemplate) { readTemplateText(); continue; }
    const c = src[i];
    if (!isIdent(c)) flushWord();
    if (c === '/' && src[i + 1] === '/') { const s = i; while (i < n && src[i] !== '\n') i++; blank(s, i); continue; }
    if (c === '/' && src[i + 1] === '*') { const s = i; i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i = Math.min(n, i + 2); blank(s, i); continue; }
    if (c === '"' || c === "'") {
      const s = i + 1; i++;
      while (i < n && src[i] !== c && src[i] !== '\n') i += src[i] === BS ? 2 : 1;
      blank(s, Math.min(i, n)); i++; lastCh = 'a'; incDec = false; continue;
    }
    if (c === '`') { i++; inTemplate = true; continue; }
    if (c === '/' && regexAllowed()) {
      const s = i + 1; let inClass = false; i++;
      while (i < n && src[i] !== '\n' && (inClass || src[i] !== '/')) {
        if (src[i] === BS) { i += 2; continue; }
        if (src[i] === '[') inClass = true; else if (src[i] === ']') inClass = false;
        i++;
      }
      blank(s, Math.min(i, n)); i++; lastCh = 'a'; incDec = false; continue;
    }
    if (tpl.length && c === '{') tpl[tpl.length - 1]++;
    if (tpl.length && c === '}') {
      if (tpl[tpl.length - 1] === 0) { tpl.pop(); i++; inTemplate = true; continue; }
      tpl[tpl.length - 1]--;
    }
    if (isIdent(c)) word += c;
    if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') {
      incDec = (c === '+' || c === '-') && src[i - 1] === c && !incDec;
      lastCh = c;
    }
    i++;
  }
  return out.join('');
}

// Dangerous call shapes, to be matched against the WHOLE stripJs() output (`\s` spans newlines). `eval` and
// `Function` are forbidden as identifiers, not only as calls: `(0, eval)(x)`, `const e = eval`, `Function('...')`.
export const CALLS = {
  eval: /(?<![\w$])eval(?![\w$])/,
  newFunction: /(?<![\w$])Function(?![\w$])/,
  constructor: /(?<![\w$])constructor\s*\.\s*constructor(?![\w$])/,
  dynImport: /(?<![\w$.])import\s*\(/,
  require: /(?<![\w$.])require\s*\(/,
  remove: /(?<![\w$])(rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync)\s*\(/,
};

/** 1-based line numbers of every match of `re` in `text`, scanning the text as a whole. */
export function matchLines(text, re) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  const lines = [];
  for (const m of text.matchAll(g)) {
    const line = text.slice(0, m.index).split('\n').length;
    if (lines[lines.length - 1] !== line) lines.push(line);
  }
  return lines;
}

/** "name:line" for every CALLS match in the stripped source. */
export function codeHits(src) {
  const code = stripJs(src);
  return Object.entries(CALLS).flatMap(([name, re]) => matchLines(code, re).map((l) => `${name}:${l}`));
}
