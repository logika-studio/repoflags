// Fixture of the real fake-client case, as a JS module (never as files on disk).
export const FAKE_TOKEN = 'FAKE_TOKEN_FOR_TESTS_ONLY_0001';
export const PRIVATE_SCOPE_DEP = '@fixture-private/motion-helpers';

export const files = {
  'web/.npmrc': `//registry.npmjs.org/:_authToken=${FAKE_TOKEN}\n`,
  'web/package.json': JSON.stringify(
    {
      name: 'web',
      version: '1.0.0',
      dependencies: {
        next: '14.2.3',
        react: '18.3.1',
        'tailwind-animate-kit': '^2.0.8',
        [PRIVATE_SCOPE_DEP]: '^1.0.0',
      },
    },
    null,
    2,
  ),
  'web/tailwind.config.js': "module.exports = { plugins: [require('tailwind-animate-kit')] };\n",
  'web/package-lock.json': JSON.stringify(
    {
      name: 'web',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        'node_modules/tailwind-animate-kit': { version: '2.0.8' },
        [`node_modules/${PRIVATE_SCOPE_DEP}`]: { version: '1.0.0' },
      },
    },
    null,
    2,
  ),
};
