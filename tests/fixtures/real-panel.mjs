// Real-repo panel (D-80a): public repositories the script is run against, pinned to a commit. Metadata only.
// SHAs read with `gh api` on 2026-11-02 (red-team research, section 5). webpack and jest move every hour: they are pinned from
// a release tag; the tag commit was resolved once in plan 03-06 (jest v30.5.2 is an annotated tag, followed to its commit).
export const REAL_PANEL = [
  { repo: 'octocat/Hello-World', sha: '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d', tag: null, exercises: 'baseline, no dependencies' },
  { repo: 'lodash/lodash', sha: '2b5e6f7399a7b48005140b5d5c6bc6c0e62919a8', tag: null, exercises: 'real npm lockfile parser, real OSV' },
  { repo: 'react/create-react-app', sha: '6254386531d263688ccfa542d0e628fbc0de0b28', tag: null, exercises: 'registry cap 200 and OSV batch 50 (2 MB lockfile)' },
  { repo: 'shadcn-ui/taxonomy', sha: '298a8857c7128a0d121e7f699dfd729f23b3966d', tag: null, exercises: 'real pnpm lockfile, tailwind/next/eslint config false positives' },
  { repo: 'webpack/webpack', sha: 'e95a7f2764281318c038e9384371797dfef0e48a', tag: 'v5.112.2', exercises: 'real yarn v1 lockfile, authentic AGENTS.md (ai-instructions false positive)' },
  { repo: 'jestjs/jest', sha: '202dd8a14777c270607c2416bd5034c3c0abc984', tag: 'v30.5.2', exercises: 'real yarn Berry lockfile, authentic CLAUDE.md' },
  { repo: 'sveltejs/realworld', sha: 'df796708040f5200ec572b28ab7f88ecee5794dd', tag: null, exercises: 'small pnpm lockfile, vite' },
];
