import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSkill, readReference, sectionOf, PHONE_RE } from './helpers/skill-md.mjs';

// Step 0 of SKILL.md: the user already ran / installed / opened something -> no script, straight to the checklist (D-60).
function step0(s) {
  const lines = s.body.split('\n');
  const from = lines.findIndex((l) => /^#{2,3}\s.*Already executed/i.test(l));
  assert.ok(from >= 0, 'a heading containing "Already executed" exists');
  let to = lines.findIndex((l, i) => i > from && /^#{2,3}\s/.test(l));
  if (to < 0) to = lines.length;
  return { text: lines.slice(from, to).join('\n'), line: s.bodyStartLine + from };
}

test('Step 0 comes before the first code block and links the checklist', () => {
  const s = readSkill();
  const st = step0(s);
  assert.ok(st.line < s.codeBlocks[0].start, 'Step 0 before the command');
  assert.match(st.text, /references\/incident-response\.md/);
});

test('Step 0 tells the model not to run the script and shows the first actions inline (D-60)', () => {
  const { text } = step0(readSkill());
  assert.match(text, /do not run the script/i);
  assert.match(text, /disconnect/i);
  assert.match(text, /do not format/i);
  assert.match(text, /different, uncompromised device/i);
  assert.match(text, /new wallet/i);
  assert.match(text, /ignore anyone offering to recover/i);
});

// Review CR-B-02: a session started inside the repository has already loaded its files for coding agents and its
// settings before the skill starts. That is G10, not an analysis.
test('CR-B-02: a session started inside the repository goes to Step 0, and Step 1 stops on the working directory', () => {
  const s = readSkill();
  const { text } = step0(s);
  assert.match(text, /session of this assistant was started inside the repository folder/i);
  assert.match(text, /folder that contains it/i);
  const step1 = sectionOf(s.body, 'Step 1');
  assert.match(step1, /`\.`/);
  assert.match(step1, /current working directory/i);
  assert.match(step1, /contains it or is contained in it/i);
  assert.match(step1, /already open in this assistant \(G2\)/i);
  assert.match(step1, /Go to Step 0/);
  assert.match(step1, /may already have been read as instructions/i);
});

// Review CR-B-11: changing the GitHub password does not revoke a stolen PAT or SSH key, the usual target of these
// installers; nor the npm token, cloud keys in other projects' .env files, or browser sessions.
test('CR-B-11: the checklist and Step 0 rotate SSH keys, access tokens, API keys in .env files and browser sessions', () => {
  const flat = (s) => s.replace(/\s+/g, ' ');
  const text = readReference('incident-response.md');
  const from = text.search(/^###\s+2\./m);
  const to = text.search(/^###\s+3\./m);
  const step2 = flat(text.slice(from, to));
  for (const re of [/SSH key/i, /personal access token/i, /npm token/i, /`\.env` files of other projects/i, /sessions saved in the browser/i]) {
    assert.match(step2, re);
  }
  const s0 = flat(step0(readSkill()).text);
  assert.match(s0, /SSH key|access token/i);
  assert.match(s0, /`\.env`/);
});

test('Step 0 does not promise recovery and judges nobody (G8)', () => {
  const { text } = step0(readSkill());
  assert.doesNotMatch(text, /we (can|will) recover|funds will be (recovered|returned)/i);
  assert.doesNotMatch(text, /https?:\/\//i);
  assert.doesNotMatch(text, PHONE_RE);
});

const MARKERS = [
  /Isolate/i,
  /different device/i,
  /Revoke token approvals/i,
  /Collect evidence/i,
  /Report to/i,
  /police report/i,
  /fund recovery/i,
];

test('incident-response.md: the seven steps of D-61 are headings in the right order', () => {
  const lines = readReference('incident-response.md').split('\n');
  let prev = -1;
  MARKERS.forEach((re, i) => {
    const at = lines.findIndex((l) => new RegExp(`^###\\s+${i + 1}\\.\\s`).test(l));
    assert.ok(at >= 0, `step ${i + 1} heading`);
    assert.match(lines[at], re, `step ${i + 1} text`);
    assert.ok(at > prev, `step ${i + 1} after step ${i}`);
    prev = at;
  });
});

test('incident-response.md: do not format comes before any reinstall, and reinstall comes after the evidence step', () => {
  const text = readReference('incident-response.md');
  const format = text.search(/do not format/i);
  const reinstall = text.search(/reinstall/i);
  assert.ok(format >= 0 && reinstall >= 0);
  assert.ok(format < reinstall);
  assert.ok(reinstall > text.search(/^###\s+4\./m), 'reinstall only after step 4');
});

test('incident-response.md: informational, dated channels, no phone number, no attribution', () => {
  const text = readReference('incident-response.md');
  assert.match(text, /not legal advice/i);
  assert.match(text, /verified on 2026-/);
  assert.doesNotMatch(text, PHONE_RE);
  assert.match(text, /no promise|cannot promise|does not promise/i);
  assert.match(text, /law enforcement does not charge/i);
});

// Review 03-A WR-03 (red team H9): Step 0 merged a certainty (the user ran it) and a possibility (the session started
// inside the repository), and the model wrote the first actions as conditionals ("if you ran it...").
test('03-review WR-03: Step 0 separates the user who ran it (0a) from the session started inside the repository (0b)', () => {
  const { text } = step0(readSkill());
  const a = text.indexOf('**0a');
  const b = text.indexOf('**0b');
  assert.ok(a >= 0 && b > a, 'two labelled cases, 0a before 0b');
  assert.match(text.slice(a, b), /already ran, installed, started or opened/i);
  assert.match(text.slice(b), /session of this assistant was started inside the repository folder/i);
  assert.match(text.slice(b).replace(/\s+/g, ' '), /tell the user to close this session/i);
});

test('03-review WR-03: the first actions are direct instructions, never conditionals, also in case 0b', () => {
  const flatText = step0(readSkill()).text.replace(/\s+/g, ' ');
  assert.match(flatText, /never as a condition \(no "if you ran it"/i);
  assert.match(flatText, /In case 0b they are the default/i);
});
