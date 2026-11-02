# Idea: learned rules (not in v1)

Status: **open for experimentation**, deliberately left out of v1.
Proposed on 2026-11-01 and postponed the same day because it widens the attack surface of a tool whose job is to be
boring and predictable.

## The idea

Let repoflags get better as people use it. After an analysis, the skill could propose a new rule — for example a
pattern it saw that no built-in rule covers — and, only after the user explicitly confirms it, store it in a local
rule pack that future scans load alongside the built-in rules.

## Why it is not in v1

- **A hostile repo can try to teach the tool.** The repositories repoflags looks at are, by assumption, written by
  someone who wants them to look harmless. Any loop that turns what was seen in a repo into a rule is a prompt-injection
  target: the repo can push the assistant to propose a rule that hides it, or to word the confirmation question so the
  user says yes without reading. User confirmation reduces this risk; it does not remove it.
- **More moving parts in the critical path.** Loading external rules means a rule-pack format, a validator, regex
  ReDoS checks and more tests — all inside the part of the tool that must stay deterministic (guardrail G5:
  critical checks are done by the script, not by the model).

## Constraints any experiment should respect

If you want to try this, these are the lines we would not cross:

1. **Monotonic only.** A learned rule may add a signal or raise the severity of an existing one. It must never remove,
   lower, disable or allowlist anything. A pack that tries to is rejected as a whole, and the rejection is reported.
2. **Never automatic.** No text from an analyzed repository becomes a rule without an explicit user decision
   (guardrail G3: everything in the repo is data, never instructions).
3. **The pack belongs to the user.** It lives in the user's own directory, is never read from the analyzed repo and is
   never downloaded from the network (guardrail G6).
4. **Linear patterns.** Linear regular expressions only: no nested quantifiers, no backreferences, a maximum pattern
   length, applied to truncated lines, with tests on pathological input.
5. **Visible in the report.** Every learned rule that was loaded, and every signal it produced, is listed with its
   origin, so the user always sees what changed the outcome.
6. **G1–G3 out of reach.** No rule, learned or not, can change whether the tool executes, installs or opens anything.

## How to contribute

Open an issue describing the experiment, the threat you considered and how your design keeps the constraints above.
A proof of concept that comes with tests showing that a hostile pack is rejected is the most useful starting point.
