// Lockfile and manifest fixtures as JS strings (never as files on disk). Hosts use the reserved .invalid TLD.
// pnpm and yarn formats are ASSUMED (RESEARCH A6, low confidence): hand-written, not captured from real tools.

export const npmV3 = JSON.stringify({
  name: 'app',
  lockfileVersion: 3,
  packages: {
    '': { name: 'app', version: '1.0.0', dependencies: { a: '^1.0.0' }, devDependencies: { '@s/b': '^2.0.0' } },
    'node_modules/a': { version: '1.0.2', resolved: 'https://registry.npmjs.org/a/-/a-1.0.2.tgz' },
    'node_modules/a/node_modules/@s/b': { version: '2.0.1', hasInstallScript: true },
    'node_modules/@s/b': { version: '2.0.0' },
    'node_modules/aliased': { name: 'real-name', version: '3.0.0' },
    'node_modules/linked': { resolved: 'packages/linked', link: true },
    'node_modules/gitdep': { version: '1.0.0', resolved: 'git+ssh://git@example.invalid/x.git#abc' },
  },
});

export const npmV1 = JSON.stringify({
  name: 'app',
  lockfileVersion: 1,
  requires: true,
  dependencies: {
    a: { version: '1.0.0', resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz', requires: { c: '^1.0.0' }, dependencies: { c: { version: '1.1.0' } } },
    d: { version: 'git+https://example.invalid/d.git#deadbeef' },
  },
});

export const npmV2 = JSON.stringify({
  lockfileVersion: 2,
  packages: { '': { dependencies: { a: '1.0.0' } }, 'node_modules/a': { version: '1.0.0' } },
  dependencies: { a: { version: '1.0.0' } },
});

export const pnpmV5 = `lockfileVersion: 5.4

specifiers:
  a: 1.0.0

packages:

  /a/1.0.0:
    resolution: {integrity: sha512-AAAA}
    dev: false

  /@s/b/2.0.0_react@18.3.1:
    resolution: {integrity: sha512-BBBB}
    requiresBuild: true
    dev: false
`;

export const pnpmV6 = `lockfileVersion: '6.0'

packages:

  /a@1.0.0:
    resolution: {integrity: sha512-AAAA}
    dev: false

  /@s/b@2.0.0(react@18.3.1):
    resolution: {tarball: https://example.invalid/b-2.0.0.tgz}
    dev: false
`;

export const pnpmV9 = `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      a:
        specifier: 1.0.0
        version: 1.0.0

packages:

  a@1.0.0:
    resolution: {integrity: sha512-AAAA}

  '@s/b@2.0.0':
    resolution: {integrity: sha512-BBBB}
    requiresBuild: true

snapshots:

  a@1.0.0: {}

  '@s/b@2.0.0(react@18.3.1)': {}
`;

export const yarnV1 = `# yarn lockfile v1


"a@^1.0.0", a@~1.0.0:
  version "1.0.2"
  resolved "https://registry.yarnpkg.com/a/-/a-1.0.2.tgz#abcdef"
  integrity sha512-AAAA

"@s/b@^2.0.0":
  version "2.0.1"
  resolved "https://example.invalid/b/-/b-2.0.1.tgz"
`;

export const yarnBerry = `__metadata:
  version: 6
  cacheKey: 8

"a@npm:^1.0.0":
  version: 1.0.2
  resolution: "a@npm:1.0.2"
  checksum: abc

"@s/b@npm:^2.0.0":
  version: 2.0.1
  resolution: "@s/b@npm:2.0.1"

"gitpkg@https://example.invalid/g.git":
  version: 0.0.1
  resolution: "gitpkg@https://example.invalid/g.git#commit=abc"

"app@workspace:.":
  version: 0.0.0-use.local
  resolution: "app@workspace:."
`;

export const pkgJson = (deps = {}, extra = {}) => JSON.stringify({ name: 'p', version: '1.0.0', dependencies: deps, ...extra }, null, 2);

export const NON_REGISTRY_SPECS = {
  x: 'git+https://example.invalid/x.git',
  y: 'https://example.invalid/y.tgz',
  z: 'file:../z',
  w: 'someuser/somerepo',
  v: 'github:u/r',
};

export const IGNORED_SPECS = { ws: 'workspace:*', alias: 'npm:other@1.0.0', plain: '^1.2.3', tag: 'latest', scoped: '@s/x@1.0.0' };

/** Builds a big npm v3 lockfile in memory. */
export function bigNpmLock(n) {
  const packages = { '': { dependencies: { pkg0: '1.0.0' } } };
  for (let i = 0; i < n; i++) packages[`node_modules/pkg${i}`] = { version: `1.0.${i}`, resolved: `https://registry.npmjs.org/pkg${i}/-/pkg${i}-1.0.${i}.tgz` };
  return JSON.stringify({ lockfileVersion: 3, packages });
}

export const HOSTILE_NAMES = {
  '': { dependencies: { '../x': '1.0.0', 'a b': '1.0.0', ['n'.repeat(215)]: '1.0.0', 'bad\u0007name': '1.0.0', good: '1.0.0' } },
};

// 03-06 panel: npm aliases (webpack yarn.lock v1, jest yarn.lock Berry) and a Berry lockfile with only workspaces
// (jest benchmarks/test-file-overhead). Minimal excerpts rebuilt by hand.
export const yarnV1Alias = `# yarn lockfile v1


"@x/react-is-18@npm:react-is@^18.3.1":
  version "18.3.1"
  resolved "https://registry.yarnpkg.com/react-is/-/react-is-18.3.1.tgz#abc"
`;

export const yarnBerryAlias = `__metadata:
  version: 8

"@babel-8/core@npm:@babel/core@^8.0.0":
  version: 8.0.5
  resolution: "@babel/core@npm:8.0.5"

"c@npm:^3.0.0":
  version: 3.1.0
  resolution: "c@npm:3.1.0"
`;

export const yarnBerryWorkspaceOnly = `__metadata:
  version: 6

"root-workspace-0b6124@workspace:.":
  version: 0.0.0-use.local
  resolution: "root-workspace-0b6124@workspace:."
`;
