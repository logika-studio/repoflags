// VS Code workspace settings (settings.json or the `settings` of a .code-workspace): automatic tasks, and
// executables the editor runs from a path inside the repository (review WR-09). Read from parsed JSONC only.
import { findKeyLine } from '../util/jsonc.mjs';
import { sanitizeEvidence } from '../util/sanitize.mjs';

const own = (o, k) => o !== null && typeof o === 'object' && !Array.isArray(o) && Object.hasOwn(o, k);
const EXEC_KEYS = ['python.defaultInterpreterPath', 'python.pythonPath', 'eslint.nodePath', 'typescript.tsdk', 'git.path', 'terminal.integrated.shell.windows', 'terminal.integrated.shell.linux', 'terminal.integrated.shell.osx'];
const PROFILE_KEYS = ['terminal.integrated.profiles.windows', 'terminal.integrated.profiles.linux', 'terminal.integrated.profiles.osx'];
// Absolute, home or environment-based paths point outside the repository; node_modules holds installed packages.
const OUTSIDE = /^([A-Za-z]:[\\/]|\/|~|\$\{env:|\$\{userHome\})/;

function insideRepo(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const v = value.trim().replace(/^\$\{workspaceFolder(?::[^}]*)?\}[\\/]?/, './');
  return !OUTSIDE.test(v) && !/(^|[\\/])node_modules([\\/]|$)/.test(v);
}

/** @returns {object[]} signals for one settings object */
export function settingsSignals(file, text, settings, rule) {
  const out = [];
  if (own(settings, 'task.allowAutomaticTasks') && settings['task.allowAutomaticTasks'] === 'on') {
    out.push({
      rule, severity: 'medium', title: 'Workspace allows automatic tasks without prompt',
      file, line: findKeyLine(text, 'task.allowAutomaticTasks'), evidence: 'task.allowAutomaticTasks: on', refs: [],
    });
  }
  const paths = [];
  for (const key of EXEC_KEYS) if (own(settings, key) && insideRepo(settings[key])) paths.push([key, settings[key]]);
  for (const key of PROFILE_KEYS) {
    const profiles = own(settings, key) ? settings[key] : null;
    for (const name of profiles && typeof profiles === 'object' ? Object.keys(profiles).slice(0, 20) : []) {
      const p = profiles[name];
      if (own(p, 'path') && [].concat(p.path).some(insideRepo)) paths.push([`${key}.${name}.path`, [].concat(p.path).join(', ')]);
    }
  }
  for (const [key, value] of paths) {
    out.push({
      rule, severity: 'medium', title: 'Workspace setting runs an executable from inside the repository',
      file, line: findKeyLine(text, key.startsWith('terminal.integrated.profiles') ? key.split('.').slice(0, 4).join('.') : key) ?? 1,
      evidence: sanitizeEvidence(`${key}: ${value}`), refs: [],
    });
  }
  return out;
}
