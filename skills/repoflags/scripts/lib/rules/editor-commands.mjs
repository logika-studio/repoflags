// Command text of VS Code tasks and dev container entries, and the indicators computed on it (DET-04, D-25).
// String operations only, no regex built from input.

export const MAX_COMMAND = 2000;
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const WRAPPERS = new Set(['sudo', 'env', 'exec', 'command', 'nohup']);

export const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const own = (o, k) => o !== null && typeof o === 'object' && Object.hasOwn(o, k);

/** String, array or object (D-25) → one flat text. */
export function flatten(v, depth = 0) {
  if (typeof v === 'string') return norm(v);
  if (depth > 3) return '';
  if (Array.isArray(v)) return norm(v.map((x) => flatten(x, depth + 1)).join(' '));
  if (v !== null && typeof v === 'object') {
    return Object.keys(v).map((k) => flatten(v[k], depth + 1)).filter(Boolean).join('; ');
  }
  return '';
}

/** `command` + `args` of a task-like object (a task or its windows/linux/osx block). */
export function taskCommand(task) {
  const parts = [];
  if (own(task, 'command') && typeof task.command === 'string') parts.push(task.command);
  if (own(task, 'args') && Array.isArray(task.args)) for (const a of task.args) parts.push(typeof a === 'string' ? a : (a && a.value) || '');
  return norm(parts.join(' ')).slice(0, MAX_COMMAND);
}

const PLATFORMS = ['windows', 'linux', 'osx'];

function shellOf(o) {
  return own(o, 'options') && own(o.options, 'shell') && own(o.options.shell, 'executable') && typeof o.options.shell.executable === 'string'
    ? norm(o.options.shell.executable).slice(0, MAX_COMMAND) : '';
}

/** What a task really runs, part by part (review WR-01): command, platform blocks, shell, npm script. */
function ownParts(task, prefix = '') {
  const parts = [];
  const cmd = taskCommand(task);
  if (cmd) parts.push(`${prefix}command: ${cmd}`);
  const shell = shellOf(task);
  if (shell) parts.push(`${prefix}shell: ${shell}`);
  if (own(task, 'type') && task.type === 'npm' && own(task, 'script') && typeof task.script === 'string') parts.push(`${prefix}npm script: ${norm(task.script)}`);
  for (const p of PLATFORMS) {
    if (!own(task, p) || task[p] === null || typeof task[p] !== 'object') continue;
    const c = taskCommand(task[p]);
    const s = shellOf(task[p]);
    if (c || s) parts.push(`${prefix}platform override: ${p}: ${[c, s && `shell: ${s}`].filter(Boolean).join('; ')}`);
  }
  return parts;
}

/** Parts of the task plus those of the tasks it depends on (one level, by label). */
export function taskParts(task, tasks) {
  const parts = ownParts(task);
  const deps = own(task, 'dependsOn') ? [].concat(task.dependsOn) : [];
  for (const d of deps.slice(0, 10)) {
    const label = typeof d === 'string' ? d : d && typeof d === 'object' && typeof d.label === 'string' ? d.label : null;
    const target = label === null ? null : tasks.find((t) => t && typeof t === 'object' && own(t, 'label') && t.label === label);
    if (target && target !== task) parts.push(...ownParts(target, `dependsOn ${norm(label)}: `));
  }
  return parts;
}

/** Basename of a program token, without quotes and a Windows `.exe`. */
function program(token) {
  const t = String(token).replace(/["']/g, '');
  const base = t.slice(Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\')) + 1).toLowerCase();
  return base.endsWith('.exe') ? base.slice(0, -4) : base;
}

/** First program after a pipe, skipping wrappers such as sudo (review WR-10). */
function pipedProgram(segment) {
  const tokens = segment.trim().split(' ').filter(Boolean);
  let i = 0;
  while (i < tokens.length && (WRAPPERS.has(program(tokens[i])) || tokens[i].startsWith('-'))) i++;
  return i < tokens.length ? program(tokens[i]) : '';
}

/** Indicators on a flattened command: fetch piped into a shell (any pipe), node run on a non-JS file. */
export function commandIndicators(cmd) {
  const out = [];
  const text = norm(cmd);
  const lower = text.toLowerCase();
  if (lower.includes('curl') || lower.includes('wget')) {
    const segments = lower.split('|').slice(1);
    if (segments.some((s) => SHELLS.has(pipedProgram(s)))) out.push('pipe to shell');
  }
  const tokens = text.split(' ');
  for (let i = 0; i < tokens.length - 1; i++) {
    if (program(tokens[i]) !== 'node' || tokens[i + 1].startsWith('-')) continue;
    if (!/\.(?:js|cjs|mjs)$/i.test(tokens[i + 1].replace(/["']/g, ''))) {
      out.push('node on non-JS file');
      break;
    }
  }
  return out;
}
