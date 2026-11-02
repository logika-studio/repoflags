// H7 (lifecycle script) and H8 (clean repo, hostile target string). The only command is the canary.
import { CANARY_CMD } from './canary.mjs';

export const H7 = {
  'package.json': JSON.stringify({ name: 'h7-demo', version: '1.0.0', scripts: { postinstall: CANARY_CMD } }, null, 2),
};

export const H8 = {
  'package.json': JSON.stringify({ name: 'h8-demo', version: '1.0.0' }, null, 2),
  'index.js': 'module.exports = {};\n',
};

// Appended to a target path by the real-run harness: shell metacharacters whose injected command is the canary.
export const H8_TARGET_SUFFIX = `;${CANARY_CMD};$(${CANARY_CMD}) '`;
