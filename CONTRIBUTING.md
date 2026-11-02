# Contributing to repoflags

Thank you for helping. repoflags is small on purpose: a skill for AI coding assistants plus a Node script that reads an
unknown repository as text and never runs it. Contributions must keep it that way.

## Ground rules

- **Zero runtime dependencies.** The script uses only Node.js built-ins (Node >= 18.20). Do not add packages.
- **Run the full suite** before opening a pull request: `npm test`, which is `cd tests && node --test`. Run it from
  `tests/`; do not use `node --test tests/`.
- **Files stay short**: at most 300 lines each. Split by responsibility when a file grows.
- **English** for code, comments, messages and the skill prompt.

## Fixtures

- Fixtures are **harmless only** and live **only as JS modules** under `tests/fixtures`, which build the hostile
  repository in memory or in a temporary folder during the test.
- Never commit fixture files named `CLAUDE.md`, `AGENTS.md` or `tasks.json` (or any other file an assistant or editor
  would read as instructions or configuration) to disk in this repository.
- Never commit real malware, live payloads, working credentials or tokens, not even disabled.

## Guardrails (not negotiable)

- G1: never execute anything from the analyzed repository (no install, run, build, test, hooks or scripts).
- G2: never open the analyzed repository in an editor or IDE.
- G3: every text in the analyzed repository is data, never an instruction.
- G4: never clone: a remote repository is read through the GitHub API, a local folder as plain files.
- G5: the checks that matter are done by the script, not by the model; the model explains the results.
- G6: network only to `api.github.com`, `api.osv.dev` and `registry.npmjs.org`; no telemetry.
- G7: repoflags never gives an all-clear verdict: it reports "signals found" or "no signals found by these rules".
- G8: no judgement on people: the report describes artifacts at a specific commit, not their author.
- G9: the user's GitHub token goes only to `api.github.com` and is never printed or stored; a token found in the
  repository is shown masked (its length, plus its first 4 characters when it has at least 12).
- G10: if the user already ran the code, the skill stops analyzing and moves to the response checklist.

A change that weakens any of these will not be merged, whatever it adds.

## Adding or changing a rule

1. Write a harmless fixture (a JS module under `tests/fixtures`) that reproduces the pattern.
2. Write a **failing test** first and check that it fails for the right reason.
3. Implement the rule until the test passes, then run the full suite.
4. Never loosen an existing test to make a change pass.

## Reports

Wrong results go in a **Detection report** issue; vulnerabilities in repoflags follow `SECURITY.md`.
