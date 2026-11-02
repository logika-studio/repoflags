// DET-06: known-malicious (MAL-*) and advisory lookups on OSV querybatch (D-15).
// Sends only name, ecosystem and version per query; no per-id detail lookups (RESEARCH Pitfall 5).
import { createHttp } from '../util/http.mjs';
import { sanitizeEvidence } from '../util/sanitize.mjs';

export const CHECK = 'osv';

const URL_BATCH = 'https://api.osv.dev/v1/querybatch';
const BATCH_SIZE = 1000;
const MAX_BATCHES = 50;
const MAX_IDS_SHOWN = 10;
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const TITLE_MAL = 'Dependency version listed as malicious in OSV';
const TITLE_ADV = 'Known advisories for dependency versions (secondary information)';

class Shape extends Error {}

async function postBatch(http, queries) {
  const res = await http.json(URL_BATCH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ queries }),
  });
  if (res.status !== 200) throw new Shape(`status ${res.status}`);
  const results = res.body && res.body.results;
  if (!Array.isArray(results) || results.length !== queries.length) throw new Shape('unexpected response shape');
  return results;
}

function idsOf(result) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.vulns)) return [];
  const out = [];
  for (const v of result.vulns) {
    if (v && typeof v.id === 'string' && ID_RE.test(v.id)) out.push(v.id);
  }
  return out;
}

const nextToken = (r) => (r && typeof r.next_page_token === 'string' && r.next_page_token ? r.next_page_token : null);

export async function run(input, ctx) {
  const unique = new Map();
  for (const d of input.deps ?? []) {
    if (d.version === null || d.version === undefined) continue;
    const key = `${d.name}@${d.version}`;
    if (!unique.has(key)) unique.set(key, d);
  }
  const items = [...unique.values()];
  if (items.length === 0) return { signals: [], notVerified: [] };

  const http = createHttp(ctx);
  const found = new Map(); // dep -> Set(ids)
  const notVerified = [];
  let sent = 0;
  let checked = 0;
  let stopped = null;

  const record = (dep, ids) => {
    if (ids.length === 0) return;
    const set = found.get(dep) ?? new Set();
    ids.forEach((i) => set.add(i));
    found.set(dep, set);
  };

  try {
    for (let from = 0; from < items.length && sent < MAX_BATCHES; from += BATCH_SIZE) {
      const slice = items.slice(from, from + BATCH_SIZE);
      let queries = slice.map((d) => ({ package: { name: d.name, ecosystem: 'npm' }, version: d.version }));
      let owners = slice;
      sent++;
      let results = await postBatch(http, queries);
      checked += slice.length;
      for (;;) {
        const pending = [];
        results.forEach((r, i) => {
          record(owners[i], idsOf(r));
          const tok = nextToken(r);
          if (tok) pending.push({ dep: owners[i], q: { ...queries[i], page_token: tok } });
        });
        if (pending.length === 0 || sent >= MAX_BATCHES) {
          if (pending.length > 0) notVerified.push({ check: CHECK, reason: `${pending.length} result pages not fetched: batch limit reached`, names: pending.map((p) => p.dep.name) });
          break;
        }
        owners = pending.map((p) => p.dep);
        queries = pending.map((p) => p.q);
        sent++;
        results = await postBatch(http, queries);
      }
    }
  } catch (e) {
    stopped = e instanceof Shape ? e.message : `lookup failed (${e && e.kind ? e.kind : 'error'})`;
  }

  const remaining = items.length - checked;
  if (stopped) {
    notVerified.push({ check: CHECK, reason: `${sanitizeEvidence(stopped)}: dependencies not checked` });
  } else if (remaining > 0) {
    // `names` (dropped by the report) tells config-resolution WHICH packages were not looked up.
    notVerified.push({ check: CHECK, reason: `batch limit of ${MAX_BATCHES} reached: ${remaining} dependencies not checked`, names: items.slice(checked).map((d) => d.name) });
  }

  const signals = [];
  let advisoryDeps = 0;
  let firstAdvisoryDep = null;
  // The same advisory often covers several versions of a package: each id is counted and listed once (01/11).
  const advisoryIds = new Set();
  for (const [dep, set] of found) {
    const ids = [...set];
    const mal = ids.filter((i) => i.startsWith('MAL-'));
    const adv = ids.filter((i) => !i.startsWith('MAL-'));
    if (mal.length > 0) {
      signals.push({
        rule: 'osv-malicious', severity: 'high', title: TITLE_MAL, file: dep.file, line: null,
        evidence: sanitizeEvidence(`${dep.name}@${dep.version}: ${mal.join(', ')}`),
        refs: mal.map((i) => `https://osv.dev/vulnerability/${i}`),
      });
    }
    if (adv.length > 0) {
      advisoryDeps++;
      firstAdvisoryDep ??= dep;
      adv.forEach((i) => advisoryIds.add(i));
    }
  }
  const advisoryCount = advisoryIds.size;
  if (advisoryCount > 0) {
    const shown = [...advisoryIds].slice(0, MAX_IDS_SHOWN).join(', ');
    const where = advisoryDeps === 1 ? `${firstAdvisoryDep.name}@${firstAdvisoryDep.version}` : `${advisoryDeps} dependency versions`;
    signals.push({
      rule: 'osv-advisory', severity: 'info', title: TITLE_ADV, file: firstAdvisoryDep.file, line: null,
      evidence: sanitizeEvidence(`${advisoryCount} advisories in ${where}: ${shown}${advisoryCount > MAX_IDS_SHOWN ? ', …' : ''}`, 400),
      refs: [],
    });
  }
  return { signals, notVerified };
}
