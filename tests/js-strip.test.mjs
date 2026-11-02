import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripJs, CALLS, codeHits } from './helpers/js-strip.mjs';

const hits = (src) => Object.entries(CALLS).filter(([, re]) => re.test(stripJs(src))).map(([k]) => k);

test('strings, regex literals, comments and template text hide calls', () => {
  for (const src of [
    "const s = 'eval(x)';", 'const r = /rm\\(/;','// import(x)', '/* new Function() */', 'const t = `rm(${a})`;',
    'const s = "require(\\"x\\")";', "const r = /[/]eval\\(/g;", 'x = a / b; // eval(c)',
  ]) assert.deepEqual(hits(src), [], src);
});

test('real calls are still found', () => {
  assert.deepEqual(hits('const t = `${rm(a)}`;'), ['remove']);
  assert.deepEqual(hits('fs.rm(p)'), ['remove']);
  assert.deepEqual(hits('await import(x)'), ['dynImport']);
  assert.deepEqual(hits('eval (code)'), ['eval']);
  assert.deepEqual(hits("new Function('a')"), ['newFunction']);
  assert.deepEqual(hits('const r = /ab/.test(x) && require(y)'), ['require']);
  assert.deepEqual(hits('return /x/.test(a) ? eval(b) : 0'), ['eval']);
});

test('names that merely end in rm are not calls', () => {
  for (const src of ['transform(x)', 'form(a)', 'confirm(b)', 'obj.transform(x)']) assert.deepEqual(hits(src), [], src);
});

test('division is not mistaken for a regex and nested templates keep code visible', () => {
  assert.deepEqual(hits('const q = a / 2; rm(q); const w = b / 3;'), ['remove']);
  assert.deepEqual(hits('const t = `a ${ `b ${ rm(c) }` } d`;'), ['remove']);
  assert.deepEqual(hits('const t = `a ${ {x: 1}.x } rm(1)`;'), []);
});

// Review tests WR-01: after `i++` the last character is `+`, so `/` was read as a regex and blanked the call.
test('WR-01: division after postfix ++/-- or a closing brace does not hide the call that follows', () => {
  assert.deepEqual(hits('let i = 0; i++ / 2; eval(x); y / 3;'), ['eval']);
  assert.deepEqual(hits('let i = 0; i-- / 2; eval(x); y / 3;'), ['eval']);
  assert.deepEqual(hits('const o = function () {} / 2; eval(x); y / 3;'), ['eval']);
  assert.deepEqual(hits('let i = 0; i++/2; rm(p); y/3;'), ['remove']);
});

test('WR-01: a regex after a binary + or - is still a regex', () => {
  assert.deepEqual(hits("const a = b + /eval\\(/.source;"), []);
  assert.deepEqual(hits("const a = b - /rm\\(/.lastIndex;"), []);
});

// Review tests WR-02: the guard matched line by line, so a call split across lines passed; indirect eval forms
// and `Function(...)` without `new` were not patterns at all.
test('WR-02: calls split across lines and indirect eval/Function forms are found, with the line of the match', () => {
  const NL = String.fromCharCode(10);
  const cases = [
    [`a();${NL}eval${NL}(x);`, ['eval:2']],
    [`const f = new${NL}Function('a');`, ['newFunction:2']],
    [`await import${NL}(x);`, ['dynImport:1']],
    [`const r = require${NL}  (x);`, ['require:1']],
    ['(0, eval)(x);', ['eval:1']],
    ['(0,eval)(x);', ['eval:1']],
    ['const e = eval; e(x);', ['eval:1']],
    ['globalThis.eval(x);', ['eval:1']],
    ["Function('return 1')();", ['newFunction:1']],
    ["globalThis.Function('a');", ['newFunction:1']],
    [`x;${NL}({}).constructor.constructor('a')();`, ['constructor:2']],
    [`a.constructor${NL}  .constructor('a')();`, ['constructor:1']],
  ];
  for (const [src, want] of cases) assert.deepEqual(codeHits(src), want, src);
});

test('WR-02: names that only contain eval or Function are not hits', () => {
  for (const src of ['evaluate(x)', 'medieval(x)', 'isFunction(x)', 'myFunction(x)', 'class A { constructor() {} }', "const s = 'eval(x)';"]) {
    assert.deepEqual(codeHits(src), [], src);
  }
});

test('line numbers and length are preserved', () => {
  const NL = String.fromCharCode(10);
  const src = ["const a = 'x';", '/* a', 'b */', 'const r = /z/;', '`t', 'u`;', 'end();', ''].join(NL);
  const out = stripJs(src);
  assert.equal(out.length, src.length);
  assert.equal(out.split(NL).length, src.split(NL).length);
  assert.match(out.split(NL)[6], /end\(\)/);
  assert.doesNotMatch(out.split(NL)[1], /a/);
});

test('linear on pathological input', () => {
  const t0 = performance.now();
  stripJs('/'.repeat(200000) + '`${'.repeat(5000) + "'".repeat(100000));
  assert.ok(performance.now() - t0 < 1000);
});
