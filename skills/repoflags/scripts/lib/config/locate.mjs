// Finds and reads the user's configuration file. Order (D-54): --config flag > REPOFLAGS_CONFIG > the file in the
// user's home. Never the analyzed folder, never the cwd: a repository must not be able to hand over its own settings.
// The only module that imports node:os (D-69). Messages never contain the file path (it holds the user name, D-34).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AnalyzeError } from '../errors.mjs';
import { decodeText } from '../util/decode.mjs';
import { validateConfig } from './validate.mjs';

export const MAX_CONFIG_BYTES = 65536;

// UNC and device paths (\\host\share, //host/share, \\?\, \\.\): even a stat opens an SMB/WebDAV connection to a
// host chosen by whoever wrote the path (G6, review CR-A-01). Same test as resolveTarget, leading blanks tolerated.
const NETWORK_PATH = /^\s*[\\/]{2}/;
const NETWORK_MSG = 'network or device paths are not accepted';

function homeOf(deps) {
  if (typeof deps.homedir === 'function') return deps.homedir() || null;
  if (deps.env) {
    // Injected env (tests, embedding): the real home is not consulted, so a suite never reads the runner's config.
    const win = (deps.platform ?? process.platform) === 'win32';
    return deps.env[win ? 'USERPROFILE' : 'HOME'] || null;
  }
  // The real home only for the CLI entry point (deps.realUser): any other caller gets none (review WR-A-03).
  return deps.realUser === true ? os.homedir() || null : null;
}

function realOrResolved(p, realpath) {
  try {
    return realpath(p);
  } catch {
    return path.resolve(p);
  }
}

function isInside(file, folder, win) {
  const norm = (p) => (win ? p.toLowerCase() : p);
  const rel = path.relative(norm(folder), norm(file));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// D-68: a flag or variable pointing into the analyzed folder would let an injected agent load the repo's own file.
function assertOutsideTarget(file, target, io) {
  if (typeof target !== 'string') return;
  // resolveTarget trims: the comparison must use the folder analyze will read (review CR-A-02).
  const t = target.trim();
  if (t === '') return;
  // resolveTarget refuses it before any fs call; a stat here would open the connection first (CR-A-01).
  if (NETWORK_PATH.test(t)) throw new AnalyzeError(`${NETWORK_MSG}: copy the folder to a local disk first`);
  // No early return when the folder cannot be checked: the resolved paths are compared anyway (fail closed, CR-A-02).
  const real = realOrResolved(file, io.realpath);
  const folder = realOrResolved(path.resolve(t), io.realpath);
  if (isInside(real, folder, io.win)) throw new AnalyzeError('the config file cannot be inside the analyzed folder');
}

function readConfigFile(file, io, { optional }) {
  let st;
  try {
    st = io.stat(file);
  } catch (e) {
    // Missing home file: no configuration. Present but unreadable: said, never ignored in silence (D-53, IN-A-05).
    if (optional && (e?.code === 'ENOENT' || e?.code === 'ENOTDIR')) return null;
    if (optional) throw new AnalyzeError('config file in the home could not be read');
    throw new AnalyzeError('config file not found or not readable');
  }
  if (!st.isFile()) {
    if (optional) return null;
    throw new AnalyzeError('config path is not a file');
  }
  if (st.size > MAX_CONFIG_BYTES) throw new AnalyzeError(`config file is larger than ${MAX_CONFIG_BYTES} bytes`);
  let buf;
  try {
    buf = io.readFile(file);
  } catch {
    throw new AnalyzeError('config file could not be read');
  }
  if (buf.length > MAX_CONFIG_BYTES) throw new AnalyzeError(`config file is larger than ${MAX_CONFIG_BYTES} bytes`);
  try {
    return JSON.parse(decodeText(buf));
  } catch {
    throw new AnalyzeError('config file is not valid JSON');
  }
}

/**
 * @param {{flag?: string, target?: string}} args
 * @param {{env?: object, homedir?: () => string, readFile?: Function, stat?: Function, realpath?: Function, platform?: string, realUser?: boolean}} deps
 *   realUser: true only from the CLI entry point; without it, env or homedir, no real user configuration is read.
 * @returns {{options: object, facts: object} | null} null when there is no configuration file
 */
export function loadUserConfig({ flag, target } = {}, deps = {}) {
  const io = {
    stat: deps.stat ?? ((p) => fs.statSync(p)),
    readFile: deps.readFile ?? ((p) => fs.readFileSync(p)),
    // native: canonical form from the OS (8.3 short names, drive letter case), as analyze reads it (CR-A-02).
    realpath: deps.realpath ?? ((p) => fs.realpathSync.native(p)),
    win: (deps.platform ?? process.platform) === 'win32',
  };
  // process.env only for the CLI entry point, like the home (review WR-A-03).
  const env = deps.env ?? (deps.realUser === true ? process.env : {});
  let file = null;
  let explicit = false;
  let raw = null;
  if (flag !== undefined) raw = String(flag);
  else if (typeof env.REPOFLAGS_CONFIG === 'string' && env.REPOFLAGS_CONFIG !== '') raw = env.REPOFLAGS_CONFIG;
  if (raw !== null) {
    file = path.resolve(raw);
    explicit = true;
    if (NETWORK_PATH.test(raw) || NETWORK_PATH.test(file)) throw new AnalyzeError(`${NETWORK_MSG} for the config file`);
  } else {
    const home = homeOf(deps);
    if (!home) return null;
    file = path.join(home, '.config', 'repoflags', 'config.json');
  }
  if (explicit) assertOutsideTarget(file, target, io);
  const json = readConfigFile(file, io, { optional: !explicit });
  return json === null ? null : validateConfig(json);
}
