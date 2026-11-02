// Resource limits for acquisition. Every refusal is recorded in `reached`.
import { DEFAULT_LIMITS, MAX_TIMER_MS } from '../constants.mjs';

const TIMER_KEYS = ['globalTimeoutMs', 'requestTimeoutMs', 'regexTimeoutMs'];

export function createLimits(options = {}) {
  const lim = { ...DEFAULT_LIMITS, ...(options.limits ?? options) };
  for (const k of TIMER_KEYS) if (lim[k] > MAX_TIMER_MS) lim[k] = MAX_TIMER_MS;
  const reached = new Set();
  let files = 0;
  let total = 0;

  function refuse(name, reason) {
    reached.add(name);
    return { ok: false, reason };
  }

  return {
    values: lim,
    markReached(name) {
      reached.add(name);
    },
    admit(path, size, kind) {
      const perFile = kind === 'lockfile' ? lim.maxLockfileBytes : lim.maxFileBytes;
      const perFileName = kind === 'lockfile' ? 'maxLockfileBytes' : 'maxFileBytes';
      if (size > perFile) return refuse(perFileName, `file larger than ${perFile} bytes`);
      if (files + 1 > lim.maxFiles) return refuse('maxFiles', `more than ${lim.maxFiles} files`);
      if (total + size > lim.maxTotalBytes) return refuse('maxTotalBytes', `total size above ${lim.maxTotalBytes} bytes`);
      files += 1;
      total += size;
      return { ok: true };
    },
    snapshot() {
      return {
        maxFileBytes: lim.maxFileBytes,
        maxLockfileBytes: lim.maxLockfileBytes,
        maxFiles: lim.maxFiles,
        maxTotalBytes: lim.maxTotalBytes,
        requestTimeoutMs: lim.requestTimeoutMs,
        globalTimeoutMs: lim.globalTimeoutMs,
        maxLineLength: lim.maxLineLength,
        reached: [...reached],
      };
    },
  };
}
