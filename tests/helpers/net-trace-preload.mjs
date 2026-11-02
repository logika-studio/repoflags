// Test-only preload (node --import), 03-02 / D-81: records where a Node process connects, at socket level, for the G6
// measurement. One JSON line per event, only when REPOFLAGS_NETLOG is set. Records host, port, and for child processes
// the file and arguments. Never headers, query strings or the environment. Not part of the shipped skill.
import net from 'node:net';
import dns from 'node:dns';
import fs from 'node:fs';
import cp from 'node:child_process';
import dc from 'node:diagnostics_channel';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';

const LOG = process.env.REPOFLAGS_NETLOG;

if (LOG) {
  const emit = (event) => { try { fs.appendFileSync(LOG, `${JSON.stringify(event)}\n`); } catch { /* tracing must not break the run */ } };

  const origConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function connect(...a) {
    let o = a[0];
    if (Array.isArray(o)) o = o[0];
    if (o && typeof o === 'object') emit({ t: 'connect', host: o.host ?? o.path ?? null, port: o.port == null ? null : Number(o.port) });
    else emit({ t: 'connect', host: typeof a[1] === 'string' ? a[1] : null, port: typeof o === 'number' ? o : null });
    return origConnect.apply(this, a);
  };

  const origLookup = dns.lookup;
  dns.lookup = function lookup(hostname, ...rest) {
    emit({ t: 'lookup', host: String(hostname) });
    return origLookup.call(this, hostname, ...rest);
  };
  const origPLookup = dns.promises.lookup;
  dns.promises.lookup = function lookup(hostname, ...rest) {
    emit({ t: 'lookup', host: String(hostname) });
    return origPLookup.call(this, hostname, ...rest);
  };

  dc.subscribe('undici:request:create', (m) => {
    try { emit({ t: 'undici', host: new URL(m.request.origin).hostname }); } catch { /* origin not a URL */ }
  });

  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
    const orig = cp[name];
    cp[name] = function wrapped(file, args, ...rest) {
      emit({ t: 'exec', file: String(file), args: Array.isArray(args) ? args.map(String) : [] });
      return orig.call(this, file, args, ...rest);
    };
  }
  // execFile carries util.promisify.custom ({stdout, stderr}); without it promisify resolves to a bare string and
  // token.mjs sees no token (03-06). Node's own custom calls the unwrapped execFile: this one goes through the wrapper.
  const tracedExecFile = cp.execFile;
  Object.defineProperty(tracedExecFile, promisify.custom, {
    value(...a) {
      let child;
      const p = new Promise((resolve, reject) => {
        child = tracedExecFile(...a, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stdout, stderr })) : resolve({ stdout, stderr })));
      });
      p.child = child;
      return p;
    },
  });
  syncBuiltinESMExports();
}
