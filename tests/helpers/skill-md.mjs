// Test helper (not tool code): reads skills/repoflags/SKILL.md and its references/ for the static prompt tests (D-63).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from './frontmatter.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SKILL_DIR = path.join(ROOT, 'skills', 'repoflags');
export const REFERENCES_DIR = path.join(SKILL_DIR, 'references');

// The only runnable command of the skill. The target is always between single quotes (review CR-B-01): the shell
// expands an unquoted `&`, `;`, `|` or `$(...)` of an attacker-supplied link before the script starts.
export const COMMAND = 'node "${CLAUDE_SKILL_DIR}/scripts/repoflags.mjs" \'<target>\' --format json';
export const ALLOWED_TOOLS = 'Bash(node "${CLAUDE_SKILL_DIR}/scripts/repoflags.mjs" *)';

// Exact lines allowed inside fenced code blocks of the body (the two /plugin lines are written by plan 02-05).
export const ALLOWED_CODE_LINES = [
  COMMAND,
  '/plugin marketplace add logika-studio/repoflags',
  '/plugin install repoflags@logika-studio',
];

// G7: the word "safe" is allowed only inside these sentences (forbid it, or quote the user's question).
// Every sentence must really occur in the scanned files, so the allowlist cannot rot.
export const ALLOWED_SAFE_SENTENCES = [
  'is this repo safe or legit?',
  'Never call a repository "safe"',
  'the word "safe"',
];

// Synonyms (secure, clean, legit, trustworthy) are allowed on the G7 line itself and inside these sentences.
export const ALLOWED_SYNONYM_SENTENCES = ['is this repo safe or legit?', 'no "does not mean it is risk-free", "harmless" or "benign"'];

// The only sentence allowed to name the --config flag in the body (the model never passes it).
export const CONFIG_BAN_SENTENCE = 'Never pass `--config`';

// Review 03-A CR-03: the closing limit is a fixed sentence the model copies, never composes (English and Italian).
export const LIMIT_SENTENCE_EN = 'Static analysis only: nothing from the repository was executed, and these rules can miss new techniques.';
export const LIMIT_SENTENCE_IT = 'Solo analisi statica: nulla del repository è stato eseguito, e queste regole possono non rilevare tecniche nuove.';
// Review 03-A WR-02: Italian verdict words (any gender and number).
export const IT_VERDICT_RE = /\b(sicur[oaie]|pulit[oaie]|affidabil[ei]|innocu[oaie])\b/i;

export const SAFE_RE =/\b(un)?safe(r|st|ly|ty|ness|guard)?\b/i;
export const SYNONYM_RE = /\b(secure(ly)?|clean|legit|trustworthy|harmless|benign|risk-free|cleared)\b/i;
export const PHONE_RE = /\+?\d[\d ()-]{7,}\d/;

/** Fenced code blocks of `body`: [{ start (1-based file line of the fence), lines: [{ n, text }] }]. */
export function fencedBlocks(body, bodyStartLine) {
  const blocks = [];
  let open = null;
  body.split('\n').forEach((text, i) => {
    const n = bodyStartLine + i;
    if (/^\s*```/.test(text)) {
      if (open) {
        blocks.push(open);
        open = null;
      } else {
        open = { start: n, lines: [] };
      }
    } else if (open) {
      open.lines.push({ n, text });
    }
  });
  if (open) throw new Error(`unclosed code fence at line ${open.start}`);
  return blocks;
}

/** Non-empty block lines that are not in the exact allowlist, as "line N: text". */
export function disallowedCodeLines(blocks, allowed = ALLOWED_CODE_LINES) {
  return blocks.flatMap((b) => b.lines.filter((l) => l.text.trim() !== '' && !allowed.includes(l.text.trim())).map((l) => `line ${l.n}: ${l.text}`));
}

/** Lines of `text` where `re` still matches after the allowed sentences are removed. */
export function hitsOutsideSentences(text, re, sentences, skipLine = () => false) {
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (skipLine(line)) return;
    let rest = line;
    for (const s of sentences) rest = rest.split(s).join(' ');
    if (re.test(rest)) hits.push(`line ${i + 1}: ${line.trim()}`);
  });
  return hits;
}

/** Text of the `## <prefix>...` section of `body`, up to the next `## ` heading ('' when missing). */
export function sectionOf(body, prefix) {
  const lines = body.split(/\r?\n/);
  const from = lines.findIndex((l) => l.startsWith(`## ${prefix}`));
  if (from < 0) return '';
  let to = lines.findIndex((l, i) => i > from && /^## /.test(l));
  if (to < 0) to = lines.length;
  return lines.slice(from, to).join('\n');
}

export function readSkill() {
  const raw = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
  const { fields, body, bodyStartLine } = parseFrontmatter(raw);
  const references = fs.existsSync(REFERENCES_DIR)
    ? fs.readdirSync(REFERENCES_DIR).filter((n) => n.endsWith('.md')).sort()
    : [];
  return { raw, fields, body, bodyStartLine, codeBlocks: fencedBlocks(body, bodyStartLine), references };
}

export const readReference = (name) => fs.readFileSync(path.join(REFERENCES_DIR, name), 'utf8');
