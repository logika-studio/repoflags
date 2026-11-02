// Local target paths that would open a network connection are refused before any file system call (review WR-09, G6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTarget } from '../skills/repoflags/scripts/lib/acquire/target.mjs';
import { AnalyzeError } from '../skills/repoflags/scripts/lib/errors.mjs';

const NETWORK_PATHS = [
  '\\\\attacker.example.invalid\\share\\project',
  '//attacker.example.invalid/share/project',
  '\\\\attacker.example.invalid@SSL\\DavWWWRoot\\project',
  '\\\\?\\UNC\\attacker.example.invalid\\share',
  '\\\\?\\C:\\projects\\x',
  '\\\\.\\pipe\\x',
  '/\\attacker.example.invalid\\share',
];

for (const p of NETWORK_PATHS) {
  test(`WR-09: ${JSON.stringify(p)} is refused without touching the file system`, () => {
    let calls = 0;
    const exists = () => {
      calls += 1;
      return true;
    };
    assert.throws(() => resolveTarget(p, { exists }), AnalyzeError);
    assert.equal(calls, 0);
  });
}

test('WR-09: ordinary local paths are still accepted', () => {
  for (const p of ['C:\\work\\repo', 'repo', './repo', '/home/u/repo']) {
    assert.deepEqual(resolveTarget(p, { exists: () => true }), { type: 'local', path: p });
  }
});
