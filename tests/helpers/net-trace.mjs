// Test helper (03-02, D-81): reads the JSON-lines log written by net-trace-preload.mjs and asserts the G6 allowlist.
import fs from 'node:fs';

/** Parsed events of a netlog file; a missing file means no events. */
export function readNetLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const stripPort = (h) => String(h).replace(/:\d+$/, '');

// A connect the trace cannot attribute (no host: `connect(443)`, `connect({ port })`) is never counted as allowed.
export const UNKNOWN_HOST = '<unknown>';

/** Set of hosts seen by connect, lookup and undici events (port removed). */
export function hostsOf(events) {
  const hosts = new Set();
  for (const e of events) {
    if (!['connect', 'lookup', 'undici'].includes(e.t)) continue;
    if (e.host) hosts.add(stripPort(e.host));
    else if (e.t === 'connect') hosts.add(UNKNOWN_HOST); // review 03-A WR-09: fail closed
  }
  return hosts;
}

/** Throws naming every host outside the allowlist. */
export function assertHostsAllowed(events, allowed) {
  const off = [...hostsOf(events)].filter((h) => !allowed.includes(h));
  if (off.length) throw new Error(`hosts outside the allowlist: ${off.join(', ')}`);
}

/** Child-process events (file and args only). */
export function execCalls(events) {
  return events.filter((e) => e.t === 'exec');
}
