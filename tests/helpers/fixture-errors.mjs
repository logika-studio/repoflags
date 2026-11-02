// Test helper: when a fixture that needs a symlink or an unusual file name cannot be created, the test may be
// skipped only for the one known environment limit; any other error is a failure (review tests WR-09).
// In CI (CI set and not "false") nothing is skipped: there links and names must work, a skip would be a silent regression.
const inCi = (env) => Boolean(env.CI) && String(env.CI).toLowerCase() !== 'false';

/** Skip reason for a failed fs.symlink, or null when the error must fail the test. */
export function linkSkipReason(e, { platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32' && e?.code === 'EPERM' && !inCi(env)) return 'symlink creation not permitted on this Windows account: EPERM';
  return null;
}

/** Skip reason for a file name the file system refuses, or null when the error must fail the test. */
export function nameSkipReason(e, { env = process.env } = {}) {
  if ((e?.code === 'EILSEQ' || e?.code === 'EINVAL') && !inCi(env)) return `file name not supported here: ${e.code}`;
  return null;
}
