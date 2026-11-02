// Resolves the CLI argument into a local folder or a GitHub repository.
import { AnalyzeError } from '../errors.mjs';

const OWNER_RE = /^[A-Za-z0-9-]{1,39}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

function checkedRef(ref) {
  if (ref !== null && !validGitRef(ref)) throw new AnalyzeError('invalid ref: not a valid branch, tag or commit name');
  return ref;
}

function validOwnerRepo(owner, repo) {
  return OWNER_RE.test(owner) && REPO_RE.test(repo) && repo !== '.' && repo !== '..';
}

// Characters git check-ref-format refuses anywhere in a ref (controls, space, ~ ^ : ? * [ and backslash).
const REF_FORBIDDEN = /[\u0000-\u0020\u007f~^:?*[\\]/;

/**
 * Ref syntax of git check-ref-format (review WR-06): a ref with `..` or an empty segment would be normalized by
 * new URL into another api.github.com endpoint, requested with the token.
 */
export function validGitRef(ref) {
  if (typeof ref !== 'string' || ref.length < 1 || ref.length > 255) return false;
  if (REF_FORBIDDEN.test(ref) || ref.includes('..') || ref.includes('@{') || ref === '@' || ref.endsWith('.')) return false;
  return ref.split('/').every((seg) => seg !== '' && !seg.startsWith('.') && !seg.endsWith('.lock'));
}

/** @returns {{type:'local', path:string} | {type:'github', owner:string, repo:string, ref:string|null}} */
export function resolveTarget(input, { ref = null, exists = () => false } = {}) {
  const value = String(input ?? '').trim();
  if (!value) throw new AnalyzeError('missing target');

  const url = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^?#]+))?\/?$/.exec(value);
  if (url) {
    if (!validOwnerRepo(url[1], url[2])) throw new AnalyzeError('invalid GitHub URL');
    return { type: 'github', owner: url[1], repo: url[2], ref: checkedRef(ref ?? url[3] ?? null) };
  }

  // UNC and device paths (\\host\share, //host/share, \\?\, \\.\): even checking that they exist opens an
  // SMB/WebDAV connection to a host chosen by whoever sent the path (review WR-09, G6). Refused before any fs call.
  if (/^[\\/]{2}/.test(value)) {
    throw new AnalyzeError('network or device paths are not accepted: copy the folder to a local disk first');
  }
  if (exists(value)) return { type: 'local', path: value };

  const parts = value.split('/');
  if (parts.length === 2 && validOwnerRepo(parts[0], parts[1])) {
    return { type: 'github', owner: parts[0], repo: parts[1], ref: checkedRef(ref ?? null) };
  }
  throw new AnalyzeError('target is neither an existing folder nor a valid owner/repo or GitHub URL');
}
