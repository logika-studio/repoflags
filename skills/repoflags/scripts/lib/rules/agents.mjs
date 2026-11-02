// DET-07: AI agent instruction files (AGENTS.md, CLAUDE.md, .cursorrules, ...).
// G3: the content of these files is untrusted DATA written to manipulate a model. It is never interpreted:
// it only reaches the report as sanitized, truncated evidence, and never in the title.
import { selectKind } from '../acquire/select.mjs';
import { splitLines, findLines } from '../util/text-scan.mjs';
import { sanitizeEvidence } from '../util/sanitize.mjs';
import { DEFAULT_LIMITS } from '../constants.mjs';

export const RULE = 'ai-instructions';
const TITLE_FLAGGED = 'AI agent instruction file asks to run/install or to suppress warnings';
const TITLE_PRESENT = 'AI agent instruction file present';
const MAX_EXCERPTS = 3;
const EXCERPT_LENGTH = 40;

// English list (D-27) plus the Italian suppression forms from the Phase 3 red team (D-86). Linear patterns, case-insensitive.
export const EXECUTION_PATTERNS = [
  { id: 'execution', source: '\\b(npm|pnpm|yarn|bun)\\s+(i|install|ci|add|run|dev|start|dlx|exec|x)\\b', flags: 'i' },
  { id: 'execution', source: '\\b(npx|bunx)\\s+\\S', flags: 'i' },
  { id: 'execution', source: '\\bnode\\s+\\S+\\.(c|m)?js\\b', flags: 'i' },
  { id: 'execution', source: '\\b(curl|wget)\\b[^\\n]{0,300}\\|\\s*(sh|bash)\\b', flags: 'i' },
  // Review 03-A WR-06: make targets, Python setup scripts, PowerShell download-and-run. Bounded, linear.
  { id: 'execution', source: '\\bmake\\s+(install|all|build|setup|run|dev|start|deps|bootstrap)\\b', flags: 'i' },
  { id: 'execution', source: '\\bpython3?\\s+\\S{1,200}\\.py\\b', flags: 'i' },
  { id: 'execution', source: '\\b(iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\\b[^\\n]{0,300}\\|\\s*(iex|Invoke-Expression)\\b', flags: 'i' },
];

export const SUPPRESSION_PATTERNS = [
  { id: 'suppression', source: "\\b(do\\s+not|don'?t|never|must\\s+not|should\\s+not|mustn'?t|shouldn'?t)\\s+(warn|mention|flag|report|alert|raise|show|emit)\\b", flags: 'i' },
  { id: 'suppression', source: '\\bignore\\s+(the\\s+)?(security|warnings?|alerts?)\\b', flags: 'i' },
  { id: 'suppression', source: '\\bno\\s+need\\s+to\\s+(check|review|scan)\\b', flags: 'i' },
  { id: 'suppression', source: '\\bskip\\s+(the\\s+)?(security|scan|check)\\b', flags: 'i' },
  // Italian forms (D-86), measured as a false negative on the red team scenario H6b. Linear, no nested quantifiers.
  { id: 'suppression', source: "\\bnon\\s+(avvisare|avvertire|segnalare|menzionare|mostrare)\\b", flags: 'i' },
  { id: 'suppression', source: '\\bignora\\s+(gli\\s+)?(avvisi|avvertimenti|allarmi)\\b', flags: 'i' },
  { id: 'suppression', source: "\\bnon\\s+(serve|occorre|c'?[eè]\\s+bisogno\\s+di)\\s+(controllare|verificare|analizzare)\\b", flags: 'i' },
  // Review 03-A WR-05: the class is "negation + verb of warning/checking", in any conjugation, in IT/ES/FR/DE.
  // Bounded stems and gaps only, no nested quantifiers. Other languages are not covered.
  { id: 'suppression', source: '\\bnon\\s+(devi\\s+|dovete\\s+)?(avvis|avvert|segnal|menzion|mostr)\\w{0,6}\\b', flags: 'i' },
  { id: 'suppression', source: "\\bnon\\s+(devi\\s+|dovete\\s+)?dire\\s+(nulla\\s+)?(all'?utente|agli\\s+utenti)", flags: 'i' },
  { id: 'suppression', source: '\\bevita(te)?\\s+di\\s+(segnal|avvis|avvert|menzion)\\w{0,6}\\b', flags: 'i' },
  { id: 'suppression', source: '\\bnon\\s+[eè]\\s+necessario\\s+(controllare|verificare|analizzare)\\b', flags: 'i' },
  { id: 'suppression', source: '\\bno\\s+(avises|avisar|adviertas|advertir|menciones|mencionar|informes|reportes|muestres)\\b', flags: 'i' },
  { id: 'suppression', source: '\\bno\\s+(hace\\s+falta|es\\s+necesario)\\s+(revisar|verificar|comprobar|analizar)\\b', flags: 'i' },
  { id: 'suppression', source: '\\bne\\s+(signale|signalez|mentionne|mentionnez|montre|montrez|avertis|avertissez|pr[eé]viens|pr[eé]venez)\\s+pas\\b', flags: 'i' },
  { id: 'suppression', source: '\\bpas\\s+besoin\\s+de\\s+(v[eé]rifier|contr[oô]ler|analyser)', flags: 'i' },
  { id: 'suppression', source: '\\b(warne|warnt|erw[aä]hne|melde|zeige)\\b[^.\\n]{0,40}\\bnicht\\b', flags: 'i' },
  { id: 'suppression', source: '\\bkeine\\s+([uü]ber)?(pr[uü]fung|kontrolle)\\s+(n[oö]tig|notwendig|erforderlich)', flags: 'i' },
];

const PATTERNS = [...EXECUTION_PATTERNS, ...SUPPRESSION_PATTERNS];

// Typographic apostrophes and exotic spaces become ASCII, invisible characters inside words are dropped, so that
// "Don’t warn" and "w​arn" read like what a model reads (review WR-08). Single character class, linear.
const APOSTROPHES = /[‘’ʼ′＇]/g;
const SPACES = /[   -   　]/g;
// Soft hyphen, Mongolian vowel separator, zero-width, LRM/RLM, bidi embeddings/overrides/isolates, invisible operators
// and BOM (review 03-A WR-07). NFC after the removal, so that a decomposed "e" + U+0300 reads as "è".
const INVISIBLE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
export const normalizeText = (t) => String(t).replace(INVISIBLE, '').normalize('NFC').replace(APOSTROPHES, "'").replace(SPACES, ' ');

/** @param {Map<string,{text:string,size:number}>} files */
export function detect(files, ctx) {
  const signals = [];
  const notVerified = [];
  const maxLine = ctx.options?.limits?.maxLineLength ?? DEFAULT_LIMITS.maxLineLength;
  const timeout = ctx.options?.regexTimeoutMs ?? ctx.options?.limits?.regexTimeoutMs ?? DEFAULT_LIMITS.regexTimeoutMs;

  for (const [file, { text }] of files) {
    if (selectKind(file) !== 'agents') continue;
    const textLines = splitLines(normalizeText(text), maxLine);
    // A phrase or command split over two lines is read on the pair, reported on the first line (review WR-08,
    // 03-A WR-06); a pair whose lines already matched alone adds nothing.
    const pairs = textLines.slice(0, -1).map((l, i) => `${l} ${textLines[i + 1]}`);
    const single = findLines(textLines, PATTERNS, timeout);
    const joined = single.timedOut ? { matches: [], timedOut: false } : findLines(pairs, PATTERNS, timeout);
    const hit = new Set(single.matches.map((m) => m.line));
    const matches = [...single.matches, ...joined.matches.filter((m) => !hit.has(m.line) && !hit.has(m.line + 1))];
    const timedOut = single.timedOut || joined.timedOut;
    // On a timeout the matches found so far are kept (core CR-03 handover); the stop itself is declared.
    if (timedOut) notVerified.push({ check: RULE, reason: `regex budget exceeded on ${sanitizeEvidence(file)}` });
    if (timedOut && !matches.length) continue;
    // One entry per flagged line; the first pattern kind on the line labels the excerpt.
    const byLine = new Map();
    for (const m of matches) if (!byLine.has(m.line)) byLine.set(m.line, { id: m.id, text: m.text });
    const lines = [...byLine.keys()].sort((a, b) => a - b);

    if (!lines.length) {
      signals.push({
        rule: RULE, severity: 'info', title: TITLE_PRESENT, file, line: 1,
        evidence: sanitizeEvidence('no install/execution verbs or suppression phrases found'), refs: [],
      });
      continue;
    }
    const excerpts = lines.slice(0, MAX_EXCERPTS).map((n) => {
      const e = byLine.get(n);
      return `${e.id}: ${sanitizeEvidence(e.text.trim(), EXCERPT_LENGTH)}`;
    });
    signals.push({
      rule: RULE, severity: 'medium', title: TITLE_FLAGGED, file, line: lines[0],
      evidence: sanitizeEvidence(`${lines.length} lines | ${excerpts.join(' | ')}`), refs: [],
    });
  }
  return { signals, notVerified };
}
