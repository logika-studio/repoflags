// Review CR-A-01 (Phase 2): a UNC or device path, as target or as config file, must be refused before ANY fs call.
// PC safety: every fs entry point is a spy that records and throws; no real network or SMB access is ever attempted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../skills/repoflags/scripts/repoflags.mjs';
import { loadUserConfig } from '../skills/repoflags/scripts/lib/config/locate.mjs';
import { AnalyzeError } from '../skills/repoflags/scripts/lib/errors.mjs';
import { makeForbiddenFetch } from './helpers/fake-fetch.mjs';
import { makeIo } from './helpers/io.mjs';

const NETWORK = /^\s*[\\/]{2}/;
const NETWORK_PATHS = [
  '\\\\attacker.invalid\\share\\repo',
  '//attacker.invalid/share/repo',
  '\\\\?\\UNC\\attacker.invalid\\share\\repo',
  '\\\\.\\pipe\\x',
  '\\\\localhost\\C$\\x',
];

/** fs spies: every call is recorded and throws, so nothing is touched on disk or on the network. */
function spies() {
  const calls = [];
  const spy = (name) => (p) => {
    calls.push([name, String(p)]);
    throw Object.assign(new Error(`${name} spied`), { code: 'ENOENT' });
  };
  return { calls, deps: { stat: spy('stat'), readFile: spy('readFile'), realpath: spy('realpath'), exists: (p) => { calls.push(['exists', String(p)]); return false; } } };
}

const networkCalls = (calls) => calls.filter(([, p]) => NETWORK.test(p));

test('CR-A-01: a UNC/device target with REPOFLAGS_CONFIG set is refused before any fs call on it', async () => {
  for (const target of NETWORK_PATHS) {
    const { calls, deps } = spies();
    const c = makeIo();
    const code = await main([target, '--offline'], c.io, {
      ...deps, fetch: makeForbiddenFetch(), env: { REPOFLAGS_CONFIG: 'C:/somewhere/cfg.json' },
    });
    assert.equal(code, 2, target);
    assert.deepEqual(networkCalls(calls), [], `fs touched a network path for ${target}`);
    assert.match(c.stderr(), /network or device paths are not accepted/, target);
  }
});

test('CR-A-01: loadUserConfig never stats a UNC/device target (defense in depth for embedders)', () => {
  for (const target of NETWORK_PATHS) {
    const { calls, deps } = spies();
    assert.throws(() => loadUserConfig({ flag: 'C:/somewhere/cfg.json', target }, { ...deps, env: {} }), AnalyzeError);
    assert.deepEqual(networkCalls(calls), [], `fs touched a network path for ${target}`);
  }
});

test('CR-A-01: a UNC/device config path (flag or env, also with blanks around) is refused before any fs call', () => {
  const configs = [...NETWORK_PATHS.map((p) => `${p}\\cfg.json`), ' \\\\attacker.invalid\\s\\c.json', '\\\\?\\C:\\x\\cfg.json'];
  for (const cfg of configs) {
    for (const args of [{ flag: cfg }, {}]) {
      const { calls, deps } = spies();
      const env = args.flag === undefined ? { REPOFLAGS_CONFIG: cfg } : {};
      assert.throws(
        () => loadUserConfig({ ...args, target: 'C:/local/target' }, { ...deps, env }),
        (e) => e instanceof AnalyzeError && /network or device paths are not accepted/.test(e.message) && !e.message.includes('attacker'),
        cfg,
      );
      assert.deepEqual(calls, [], `fs touched for ${cfg}`);
    }
  }
});
