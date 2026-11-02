import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectKind } from '../skills/repoflags/scripts/lib/acquire/select.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', '.planning', '.claude']);
const BAD_FILES = new Set([
  'agents.md', 'gemini.md', '.cursorrules', '.windsurfrules', '.clinerules', 'copilot-instructions.md',
  'tasks.json', '.npmrc', '.yarnrc', '.yarnrc.yml', '.envrc', 'devcontainer.json', '.devcontainer.json',
]);
const BAD_DIRS = new Set(['.vscode', '.cursor', '.devcontainer', '.husky', '.gemini', '.continue']);
// Same list as the tool (IN-03): whatever selectKind reads as instructions or as config that runs commands.
const TRAP_KINDS = new Set(['agents', 'aiconfig', 'editor', 'devcontainer', 'envrc', 'npmrc', 'husky']);
const isTrapFile = (rel, name) => TRAP_KINDS.has(selectKind(rel)) || name.startsWith('.aider');

async function walk(dir, rel, found, readdir = (d) => fs.readdir(d, { withFileTypes: true })) {
  for (const e of await readdir(dir)) {
    const name = e.name.toLowerCase();
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (rel === '' && SKIP_DIRS.has(name)) continue; // root only, any case (WR-10)
      if (BAD_DIRS.has(name)) found.push(r);
      await walk(path.join(dir, e.name), r, found, readdir);
    } else {
      const rootClaude = name === 'claude.md' && rel === ''; // the project instructions of this repo
      if (!rootClaude && (BAD_FILES.has(name) || isTrapFile(r, name))) found.push(r);
    }
  }
}

/** In-memory readdir over a nested object (string = file, object = folder): no trap file is ever written to disk. */
function fakeReaddir(tree) {
  return async (dir) => {
    const parts = path.relative('/root', dir).split(path.sep).filter(Boolean);
    let node = tree;
    for (const p of parts) node = node[p];
    return Object.entries(node).map(([name, v]) => ({ name, isDirectory: () => typeof v === 'object' }));
  };
}

test('no trap files on disk in the development repo', async () => {
  const found = [];
  await walk(ROOT, '', found);
  assert.deepEqual(found, [], `trap files found: ${found.join(', ')}`);
});

// Review tests WR-10: SKIP_DIRS matched by name at any depth, so a nested .claude or .planning hid trap files.
test('WR-10: only the root .git, node_modules, .planning and .claude are skipped; nested ones are walked', async () => {
  const tree = {
    '.claude': { 'agents.md': 'x' },
    tests: { fixtures: { '.claude': { 'agents.md': 'x' }, '.planning': { 'tasks.json': 'x' }, '.CLAUDE': { '.cursorrules': 'x' } } },
  };
  const found = [];
  await walk(path.resolve('/root'), '', found, fakeReaddir(tree));
  assert.deepEqual(found.sort(), ['tests/fixtures/.CLAUDE/.cursorrules', 'tests/fixtures/.claude/agents.md', 'tests/fixtures/.planning/tasks.json']);
});

// Review tests IN-03: the trap names were a second list, out of step with what the rules read as agent or AI config.
test('IN-03: every path the tool reads as agent, AI or editor config is a trap file here, plus aider and continue', async () => {
  const tree = {
    'CLAUDE.md': 'x',
    '.github': { instructions: { 'x.instructions.md': 'x' } },
    '.mcp.json': 'x',
    '.gemini': { 'settings.json': 'x' },
    '.aider.conf.yml': 'x',
    '.continue': { 'config.json': 'x' },
    'w.code-workspace': 'x',
  };
  const found = [];
  await walk(path.resolve('/root'), '', found, fakeReaddir(tree));
  assert.deepEqual(found.sort(), [
    '.aider.conf.yml', '.continue', '.gemini', '.gemini/settings.json', '.github/instructions/x.instructions.md', '.mcp.json', 'w.code-workspace',
  ]);
});
