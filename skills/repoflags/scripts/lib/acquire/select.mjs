// Pure file selection: which paths are worth reading, and in which order to download them.

const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb']);
const NPMRC = new Set(['.npmrc', '.yarnrc', '.yarnrc.yml']);
const AGENT_NAMES = new Set(['agents.md', 'claude.md', 'gemini.md', '.cursorrules', '.windsurfrules', '.clinerules']);

/** @returns {null|'manifest'|'gyp'|'lockfile'|'npmrc'|'config'|'editor'|'devcontainer'|'envrc'|'agents'|'aiconfig'|'husky'|'patch'} */
export function selectKind(path) {
  const p = String(path).toLowerCase();
  const parts = p.split('/');
  if (parts.includes('node_modules')) return null;
  const base = parts[parts.length - 1];
  const dirs = parts.slice(0, -1);

  if (base === 'package.json') return 'manifest';
  // npm runs `node-gyp rebuild` on install when a binding.gyp is present (review rules WR-04).
  if (base === 'binding.gyp') return 'gyp';
  if (LOCKFILES.has(base)) return 'lockfile';
  if (NPMRC.has(base)) return 'npmrc';
  if (base === '.envrc') return 'envrc';
  if (base === '.devcontainer.json' || dirs.includes('.devcontainer')) return 'devcontainer';
  // Agent and MCP configuration that runs commands (review rules WR-09).
  const parent = dirs[dirs.length - 1];
  if (base === '.mcp.json' || (base === 'mcp.json' && (parent === '.cursor' || parent === '.vscode'))) return 'aiconfig';
  if (parent === '.claude' && (base === 'settings.json' || base === 'settings.local.json')) return 'aiconfig';
  if (parent === '.gemini' && base === 'settings.json') return 'aiconfig';
  if (dirs.includes('.vscode') && base.endsWith('.json')) return 'editor';
  if (base.endsWith('.code-workspace')) return 'editor';
  if (dirs.includes('.husky')) return 'husky';
  // patch-package applies these to node_modules on install (review rules WR-03).
  if (dirs[dirs.length - 1] === 'patches' && base.endsWith('.patch')) return 'patch';
  if (AGENT_NAMES.has(base)) return 'agents';
  if (p === '.github/copilot-instructions.md') return 'agents';
  if (p.startsWith('.github/instructions/')) return 'agents';
  if (p.startsWith('.cursor/rules/')) return 'agents';
  if (/\.config\.(js|cjs|mjs|ts|cts|mts)$/.test(base)) return 'config';
  if (/^\..*rc\.(js|cjs|mjs)$/.test(base)) return 'config';
  return null;
}

/**
 * True only for selected files that are binary by format. Any other selected file is text by name: a NUL byte
 * in it must not switch the rules off, since npm, Node or an editor still read it (class of review CR-02).
 */
export function binaryByFormat(path) {
  return String(path).toLowerCase().split('/').pop() === 'bun.lockb';
}

/** Lower number = downloaded first (matters when the request budget is limited). */
export function downloadPriority(path) {
  const kind = selectKind(path);
  const root = !String(path).includes('/');
  switch (kind) {
    case 'manifest': return root ? 0 : 7;
    case 'npmrc': return 1;
    case 'editor': return 2;
    case 'aiconfig': return 2;
    case 'config': return root ? 3 : 8;
    case 'devcontainer': return 4;
    case 'lockfile': return 5;
    case 'agents': return 6;
    default: return 8;
  }
}

// NP-01: past this many files of one kind, the rest of that kind drops below every other kind, so that padding
// with thousands of one cheap kind (e.g. `.npmrc`) cannot push a `.vscode/tasks.json` out of maxFiles.
export const KIND_QUOTA = 50;
const FLOODED = 9;
const depth = (p) => String(p).split('/').length;
const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Items in admission order: priority, with each kind's quota filled by its shallowest paths first. */
export function orderByPriority(items, pathOf) {
  const prio = new Map();
  const count = new Map();
  const shallowFirst = [...items].sort((a, b) => depth(pathOf(a)) - depth(pathOf(b)) || byPath(pathOf(a), pathOf(b)));
  for (const it of shallowFirst) {
    const p = pathOf(it);
    const kind = selectKind(p) ?? '';
    const n = (count.get(kind) ?? 0) + 1;
    count.set(kind, n);
    prio.set(it, n > KIND_QUOTA ? FLOODED : downloadPriority(p));
  }
  return [...items].sort((a, b) => prio.get(a) - prio.get(b) || byPath(pathOf(a), pathOf(b)));
}
