// Test helper: environment for a spawned CLI process that cannot see the runner's real user config.
// HOME/USERPROFILE point at a folder that does not exist, and REPOFLAGS_CONFIG is dropped. (USERPROFILE for win32.)
import os from 'node:os';
import path from 'node:path';

export function hermeticEnv() {
  const home = path.join(os.tmpdir(), 'repoflags-no-such-home');
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.REPOFLAGS_CONFIG;
  return env;
}
