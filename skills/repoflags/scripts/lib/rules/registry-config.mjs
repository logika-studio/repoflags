// Registries configured by the repository in .npmrc / .yarnrc / .yarnrc.yml: which URL, for which scope (null =
// the default registry). Shared by dep-specs (custom registry signal) and config-files (an allowlisted name served
// by a redirected registry is not "known tooling" any more, review WR-07). Linear regexes, lines cut to MAX_LINE.
import { selectKind } from '../acquire/select.mjs';

const MAX_LINE = 2000;
const PUBLIC_HOSTS = new Set(['registry.npmjs.org', 'registry.yarnpkg.com']);

// Quoted and scoped keys; `.yarnrc` v1 separates key and value with a space (review WR-11).
const NPMRC = /^\s*"?(@[^\s:="]+)?:?registry"?\s*=\s*"?([^"\s]+)/i;
const YARNRC = /^\s*"?(@[^\s:="]+)?:?registry"?(?:\s*=\s*|\s+)"?([^"\s]+)/i;
// `.yarnrc.yml`: npmRegistryServer anywhere on the line (flow mappings), a scope in a flow mapping, a URL as key.
const YML_SERVER = /(?:^|[\s{,])["']?npmRegistryServer["']?\s*:\s*["']?([^"'\s,}]+)/;
const YML_FLOW_SCOPE = /["']?([A-Za-z0-9._~-]{1,100})["']?\s*:\s*\{\s*["']?npmRegistryServer["']?\s*:/;
const YML_URL_KEY = /^\s*["']?((?:https?:)?\/\/[^"'\s]+?)["']?\s*:(?:\s|$)/i;
const YML_KEY = /^(\s*)["']?([A-Za-z0-9._~@-]{1,100})["']?\s*:/;

const withScheme = (url) => (url.startsWith('//') ? `https:${url}` : url);

export function isPublicRegistry(url) {
  try {
    const u = new URL(withScheme(String(url)));
    return (u.protocol === 'https:' || u.protocol === 'http:') && PUBLIC_HOSTS.has(u.host.toLowerCase());
  } catch {
    return false;
  }
}

function ymlEntries(lines) {
  const out = [];
  let inScopes = -1; // indent of the `npmScopes:` key, -1 outside
  let scope = null;
  lines.forEach((raw, i) => {
    const line = raw.slice(0, MAX_LINE);
    const key = YML_KEY.exec(line);
    if (key) {
      const indent = key[1].length;
      if (inScopes >= 0 && indent <= inScopes) { inScopes = -1; scope = null; }
      if (key[2] === 'npmScopes') inScopes = indent;
      else if (inScopes >= 0 && scope === null) scope = `@${key[2].replace(/^@/, '')}`;
      else if (inScopes >= 0 && indent <= inScopes + 2) scope = `@${key[2].replace(/^@/, '')}`;
    }
    const server = YML_SERVER.exec(line);
    if (server) {
      const flow = YML_FLOW_SCOPE.exec(line);
      const s = flow ? `@${flow[1].replace(/^@/, '')}` : inScopes >= 0 ? scope : null;
      out.push({ line: i + 1, url: server[1], scope: s });
      return;
    }
    const urlKey = YML_URL_KEY.exec(line);
    if (urlKey) out.push({ line: i + 1, url: urlKey[1], scope: null });
  });
  return out;
}

/** @returns {{file: string, line: number, url: string, scope: string|null}[]} every configured registry */
export function registryEntries(files) {
  const out = [];
  for (const [file, { text }] of files) {
    if (selectKind(file) !== 'npmrc') continue;
    const base = file.slice(file.lastIndexOf('/') + 1).toLowerCase();
    const lines = String(text).split(/\r?\n/);
    if (base === '.yarnrc.yml') {
      for (const e of ymlEntries(lines)) out.push({ file, ...e });
      continue;
    }
    const re = base === '.npmrc' ? NPMRC : base === '.yarnrc' ? YARNRC : null;
    if (!re) continue;
    lines.forEach((l, i) => {
      const m = re.exec(l.slice(0, MAX_LINE));
      if (m) out.push({ file, line: i + 1, url: m[2], scope: m[1] ?? null });
    });
  }
  return out.filter((e) => !e.url.includes('${'));
}

/** Scopes served by a non-public registry, and whether the default registry is non-public. */
export function redirects(files) {
  const scopes = new Set();
  let defaultRedirected = false;
  for (const e of registryEntries(files)) {
    if (isPublicRegistry(e.url)) continue;
    if (e.scope) scopes.add(e.scope.toLowerCase());
    else defaultRedirected = true;
  }
  return { scopes, defaultRedirected };
}
