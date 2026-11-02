// DET-04: editor / environment auto-execution (VS Code tasks, devcontainer, .envrc). Files are only read as text.
import { selectKind } from '../acquire/select.mjs';
import { parseJsonc, findKeyLine } from '../util/jsonc.mjs';
import { sanitizeEvidence } from '../util/sanitize.mjs';
import { tasksFallback, settingsFallback, devcontainerFallback } from './editor-fallback.mjs';
import { MAX_COMMAND, norm, flatten, taskParts, commandIndicators } from './editor-commands.mjs';
import { settingsSignals } from './editor-settings.mjs';

export const RULE = 'editor-autorun';
const DEV_RULE = 'devcontainer-command';
const ENVRC_RULE = 'envrc';
const LIFECYCLE = ['onCreateCommand', 'updateContentCommand', 'postCreateCommand', 'postStartCommand', 'postAttachCommand'];

const own = (o, k) => o !== null && typeof o === 'object' && Object.hasOwn(o, k);
const baseOf = (file) => file.split('/').pop().toLowerCase();

function taskSignals(file, text, root, signals) {
  const tasks = own(root, 'tasks') && Array.isArray(root.tasks) ? root.tasks : own(root, 'command') ? [root] : [];
  let cursor = 1;
  for (const task of tasks) {
    if (task === null || typeof task !== 'object') continue;
    const runOn = own(task, 'runOptions') && own(task.runOptions, 'runOn') ? task.runOptions.runOn : null;
    if (runOn !== 'folderOpen') continue;
    const line = findKeyLine(text, 'runOn', cursor);
    if (line !== null) cursor = line + 1;
    // Everything the task can run: platform blocks, shell, npm script, dependsOn (review WR-01); indicators first.
    const parts = taskParts(task, tasks);
    const ev = ['runOn: folderOpen'];
    if (own(task, 'presentation') && own(task.presentation, 'reveal') && task.presentation.reveal === 'never') ev.push('reveal: never');
    ev.push(...new Set(parts.flatMap((p) => commandIndicators(p.slice(p.indexOf(': ') + 2)))));
    ev.push(...parts);
    signals.push({
      rule: RULE, severity: 'high', title: 'Task runs automatically when the folder is opened',
      file, line, evidence: sanitizeEvidence(ev.join('; ')), refs: [],
    });
  }
}

export function detect(files, ctx) {
  const signals = [];
  const notVerified = [];
  for (const [file, { text }] of files) {
    const kind = selectKind(file);
    const base = baseOf(file);
    if (kind === 'envrc') {
      // Assumption A9: any .envrc is a direnv script; it runs only after the user runs `direnv allow`.
      const lines = String(text).split(/\r?\n/);
      const idx = lines.findIndex((l) => l.trim() !== '');
      signals.push({
        rule: ENVRC_RULE, severity: 'medium', title: 'direnv script present (runs after direnv allow)',
        file, line: idx === -1 ? 1 : idx + 1,
        evidence: sanitizeEvidence(idx === -1 ? '(empty)' : norm(lines[idx])), refs: [],
      });
      continue;
    }
    const isTasks = kind === 'editor' && base === 'tasks.json';
    const isSettings = kind === 'editor' && base === 'settings.json';
    const isWorkspace = kind === 'editor' && base.endsWith('.code-workspace'); // tasks + settings (review WR-09)
    const isDev = kind === 'devcontainer' && (base === 'devcontainer.json' || base === '.devcontainer.json');
    if (!isTasks && !isSettings && !isWorkspace && !isDev) continue;
    const parsed = parseJsonc(text);
    if (!parsed.ok || parsed.value === null || typeof parsed.value !== 'object') {
      const check = isDev ? DEV_RULE : RULE;
      notVerified.push({ check, reason: `unparseable JSONC: ${sanitizeEvidence(file)}` });
      signals.push({
        rule: check, severity: 'medium', title: 'Editor or dev container file could not be parsed: commands not fully checked',
        file, line: 1, evidence: 'not valid JSONC; the editor may still read it: keys found by a text scan are listed separately', refs: [],
      });
      if (isTasks || isWorkspace) signals.push(...tasksFallback(file, String(text), RULE));
      if (isSettings || isWorkspace) signals.push(...settingsFallback(file, String(text), RULE));
      if (isDev) signals.push(...devcontainerFallback(file, String(text), DEV_RULE, ['initializeCommand', ...LIFECYCLE]));
      continue;
    }
    const root = parsed.value;
    if (isTasks) taskSignals(file, text, root, signals);
    else if (isSettings) signals.push(...settingsSignals(file, text, root, RULE));
    else if (isWorkspace) {
      if (own(root, 'tasks') && root.tasks && typeof root.tasks === 'object') taskSignals(file, text, root.tasks, signals);
      if (own(root, 'settings')) signals.push(...settingsSignals(file, text, root.settings, RULE));
    } else {
      for (const key of ['initializeCommand', ...LIFECYCLE]) {
        if (!own(root, key)) continue;
        const cmd = flatten(root[key]);
        if (!cmd) continue;
        const host = key === 'initializeCommand';
        // Indicators first, so that truncation never hides them behind a long harmless prefix (review WR-10).
        const ind = commandIndicators(cmd);
        const head = ind.length ? `indicator: ${ind.join(', ')} | ` : '';
        signals.push({
          rule: DEV_RULE, severity: host ? 'high' : 'medium',
          title: host ? 'Dev container command runs on the host before the container starts' : 'Dev container lifecycle command',
          file, line: findKeyLine(text, key),
          evidence: sanitizeEvidence(`${head}${key}${host ? ' (runs on the host)' : ''}: ${cmd.slice(0, MAX_COMMAND)}`), refs: [],
        });
      }
    }
  }
  return { signals, notVerified };
}
