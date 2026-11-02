// Review 03-A CR-03 / WR-01 / WR-02: G7 closed as a class, not by instance. The closing limit is a fixed sentence the
// model copies; negated, implicit and provisional verdicts are banned as forms, in any language.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readSkill, readReference, hitsOutsideSentences, LIMIT_SENTENCE_EN, LIMIT_SENTENCE_IT, IT_VERDICT_RE,
} from './helpers/skill-md.mjs';

const G7_LINE = (l) => /^- \*\*G7\b/.test(l);
const words = (s) => new RegExp(s.split(' ').join('\\s+'));
const g7 = () => readSkill().body.split('\n').find(G7_LINE) ?? '';

test('03-review CR-03: the limit is a fixed sentence copied word for word, with its Italian version written', () => {
  const { body } = readSkill();
  assert.ok(body.includes(LIMIT_SENTENCE_EN), 'English limit sentence');
  assert.ok(body.includes(LIMIT_SENTENCE_IT), 'Italian limit sentence');
  assert.match(body, words('word for word'));
  assert.match(body, words('add nothing after it'));
});

test('03-review CR-03: negated verdicts are banned as a form on the G7 line', () => {
  for (const s of ['not even negated', '"does not mean', '"does not guarantee', '"does not prove']) assert.ok(g7().includes(s), s);
});

test('03-review WR-01: implicit and provisional verdicts are banned on the G7 line', () => {
  for (const s of ['"yet"', '"so far"', '"for now"', '"nothing suspicious"', '"nothing malicious"', '"no red flags"', '"looks fine"']) {
    assert.ok(g7().includes(s), s);
  }
});

test('03-review WR-02: the verdict words are banned in any language, with the Italian ones named', () => {
  for (const s of ['in any language', '"sicuro"', '"pulito"', '"affidabile"', '"innocuo"', '"finora"', '"per ora"']) assert.ok(g7().includes(s), s);
});

test('03-review WR-01: the outcome is stated with its exact words and no qualifier', () => {
  assert.match(readSkill().body, words('State the outcome with exactly these words and no qualifier'));
});

// Review 03-A IN-01: the JSON outcome values carry underscores; the answer writes them with spaces.
test('03-review IN-01: SKILL.md maps the JSON outcome values to the words written in the answer', () => {
  const flat = readSkill().body.replace(/\s+/g, ' ');
  assert.match(flat, /the JSON values `signals_found` and `no_signals_found_by_these_rules` are written with spaces/);
});

test('03-review CR-03: no G line was removed (G1-G10 in order)', () => {
  const ids = readSkill().body.split('\n').map((l) => /^- \*\*(G\d+)\b/.exec(l)?.[1]).filter(Boolean);
  assert.deepEqual(ids, ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10']);
});

test('03-review WR-02: Italian verdict words appear only on the G7 line (self-check included)', () => {
  assert.notDeepEqual(hitsOutsideSentences('Il repository è pulito.', IT_VERDICT_RE, []), []);
  const s = readSkill();
  const texts = [['SKILL.md', s.raw], ...s.references.map((r) => [`references/${r}`, readReference(r)])];
  for (const [name, text] of texts) assert.deepEqual(hitsOutsideSentences(text, IT_VERDICT_RE, [], G7_LINE), [], name);
});
