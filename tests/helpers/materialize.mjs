// Writes an in-memory fixture to a fresh temp folder (never inside the project cwd).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Retries cover EBUSY/EPERM from antivirus or indexers on Windows (review tests IN-04).
const remove = (dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });

/** @param {Record<string,string>} fileMap path (POSIX) -> content */
export async function materialize(fileMap, { prefix = 'repoflags-fx-' } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    for (const [rel, content] of Object.entries(fileMap)) {
      const full = path.join(dir, ...rel.split('/'));
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content);
    }
  } catch (e) {
    await remove(dir).catch(() => {});
    throw e;
  }
  return { dir, cleanup: () => remove(dir) };
}
