// Review CR-A-02 (Phase 2): D-68 "config inside the analyzed folder" must compare the same folder analyze will read,
// and fail closed when the folder cannot be checked. Temp dirs only, created and removed by the test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { main } from '../skills/repoflags/scripts/repoflags.mjs';
import { loadUserConfig } from '../skills/repoflags/scripts/lib/config/locate.mjs';
import { materialize } from './helpers/materialize.mjs';
import { makeForbiddenFetch } from './helpers/fake-fetch.mjs';
import { makeIo } from './helpers/io.mjs';

const EVIL = { 'package.json': '{"name":"x"}', 'evil.json': '{"limits":{"maxFiles":7}}' };

async function run(argv) {
  const c = makeIo();
  const code = await main(argv, c.io, { fetch: makeForbiddenFetch(), now: () => new Date('2026-11-01T00:00:00Z'), env: {} });
  return { code, out: c.stdout(), err: c.stderr() };
}

test('CR-A-02: blanks around the target do not bypass the inside-the-folder check', async (t) => {
  const m = await materialize(EVIL);
  t.after(m.cleanup);
  const cfg = path.join(m.dir, 'evil.json');
  for (const target of [` ${m.dir}`, `${m.dir} `, `\t${m.dir}  `]) {
    const r = await run([target, '--offline', '--format', 'json', '--config', cfg]);
    assert.equal(r.code, 2, `target ${JSON.stringify(target)} loaded the repo's own config: ${r.out.slice(0, 80)}`);
    assert.match(r.err, /inside the analyzed folder/);
  }
});

test('CR-A-02: when the target cannot be checked on disk the comparison still runs (fail closed)', () => {
  const target = path.resolve('repoflags-virtual-target');
  const fail = () => { throw Object.assign(new Error('spied'), { code: 'ENOENT' }); };
  const deps = { env: {}, stat: fail, readFile: fail, realpath: fail };
  assert.throws(
    () => loadUserConfig({ flag: path.join(target, 'evil.json'), target }, deps),
    /inside the analyzed folder/,
  );
});
