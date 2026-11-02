// Clean control repos (D-38): ordinary projects that must produce zero high and zero medium signals.
// In-memory file maps only. The network answers "nothing found" for every package.
const pkg = (o) => JSON.stringify({ version: '1.0.0', ...o }, null, 2);

export const CLEAN_REPOS = {
  'clean-next-tailwind': {
    'package.json': pkg({
      name: 'clean-next-tailwind',
      scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
      dependencies: { next: '14.2.3', react: '18.3.1', 'react-dom': '18.3.1' },
      devDependencies: { tailwindcss: '3.4.4', postcss: '8.4.38', autoprefixer: '10.4.19', '@tailwindcss/forms': '0.5.7', 'tailwindcss-animate': '1.0.7' },
    }),
    'postcss.config.js': 'module.exports = {\n  plugins: { tailwindcss: {}, autoprefixer: {} },\n};\n',
    'tailwind.config.js': "/** @type {import('tailwindcss').Config} */\nmodule.exports = {\n  content: ['./app/**/*.{js,jsx}'],\n  plugins: [require('@tailwindcss/forms'), require('tailwindcss-animate')],\n};\n",
  },
  'clean-husky': {
    'package.json': pkg({ name: 'clean-husky', scripts: { prepare: 'husky', test: 'node --test' }, devDependencies: { husky: '9.0.11' } }),
  },
  'clean-esbuild': {
    'package.json': pkg({ name: 'clean-esbuild', scripts: { build: 'esbuild src/index.js --bundle' }, devDependencies: { esbuild: '0.21.5' } }),
    'package-lock.json': JSON.stringify({
      name: 'clean-esbuild', version: '1.0.0', lockfileVersion: 3, requires: true,
      packages: {
        '': { name: 'clean-esbuild', version: '1.0.0', devDependencies: { esbuild: '0.21.5' } },
        'node_modules/esbuild': { version: '0.21.5', resolved: 'https://registry.npmjs.org/esbuild/-/esbuild-0.21.5.tgz', dev: true, hasInstallScript: true, bin: { esbuild: 'bin/esbuild' } },
      },
    }, null, 2),
  },
  // False positive measured live on 01/11: a clean Next.js site whose next.config.ts loads next-intl/plugin.
  'clean-next-intl': {
    'package.json': pkg({
      name: 'clean-next-intl',
      scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
      dependencies: { next: '15.0.3', react: '19.0.0', 'react-dom': '19.0.0', 'next-intl': '3.25.1' },
    }),
    'next.config.ts': "import type { NextConfig } from 'next';\nimport createNextIntlPlugin from 'next-intl/plugin';\n\nconst withNextIntl = createNextIntlPlugin();\nconst nextConfig: NextConfig = {};\n\nexport default withNextIntl(nextConfig);\n",
  },
};

/** Names declared in package.json files of a file map, to build an all-clean registry answer. */
export function declaredPackages(files) {
  const names = new Set();
  for (const [p, text] of Object.entries(files)) {
    if (!p.endsWith('package.json')) continue;
    const data = JSON.parse(text);
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) for (const n of Object.keys(data[section] ?? {})) names.add(n);
  }
  return [...names];
}
