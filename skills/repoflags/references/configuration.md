# Configuring repoflags

The configuration belongs to the user. It is one optional JSON file; without it the script runs with its defaults.
The agent never creates or edits it on its own (see the Configuration section of `SKILL.md`).

## Where the file is

The script looks for the file in this order and uses the first one that applies:

1. the `--config <file>` flag (run by the user, never by the agent);
2. the `REPOFLAGS_CONFIG` environment variable;
3. `~/.config/repoflags/config.json` (on Windows, under the user profile folder).

The analyzed repository and the current working directory are never read for configuration: a repository must not be
able to hand over its own settings. A `--config` or `REPOFLAGS_CONFIG` that points inside the analyzed folder is
rejected. A missing file at the default location is fine; a missing file at an explicit location is an error. The
file is at most 65536 bytes and must be valid JSON. Unknown keys, out-of-range values and unknown rule ids make the
script stop with exit code 2 and a message that names the key, never the file path.

## Keys

| Key | Type | Default | Min | Max |
| --- | --- | --- | --- | --- |
| `language` | language tag such as `it` or `pt-BR` | none | | |
| `limits` | object, see below | built-in | | |
| `thresholds` | object, see below | built-in | | |
| `rules` | object `<rule-id>: false` | all rules on | | |
| `allowlist` | object, see below | empty | | |

`limits` (positive integers): `maxFileBytes` (default 1048576), `maxLockfileBytes` (10485760), `maxFiles` (2000),
`maxTotalBytes` (52428800), `timeoutSeconds` (120), `requestTimeoutSeconds` (15). The command line flags override them.
Each value is at most 2147483647; `timeoutSeconds` and `requestTimeoutSeconds` at most 2147483.

`thresholds` (integers, only inside the range):

| Key | Type | Default | Min | Max |
| --- | --- | --- | --- | --- |
| `maxCodeColumn` | integer | 300 | 100 | 1000 |
| `whitespaceRun` | integer | 40 | 10 | 200 |
| `escapeRun` | integer | 20 | 5 | 100 |

They tune the `config-obfuscation` rule: the column after which a line in a config file counts as hidden code, the
length of a whitespace run, and the number of consecutive escape sequences.

`allowlist` holds `configPackages` (names that `config-require-nonstandard` should not flag: an exact name, a prefix of
three or more characters in total before a final `*`, scope included (so `@acme/a*` is accepted), or `@scope/*`; at
most 200 entries) and `lifecycleCommands` (exact
`package.json` script commands, at most 100 entries of at most 1000 characters).

`language` sets the language of the agent's answer (rule ids, outcomes and field names stay in English). The agent
reads it from the report's `config` field, never from the file.

## Rules you can turn off, and rules you cannot

`rules` accepts only `false`; a rule is on unless you list it. Any rule id of the tool can be listed except the three
integrity rules `limits-skipped-critical`, `rule-failed` and `scan-incomplete`: they cannot be disabled, because they
tell the reader that the scan was partial or a rule crashed. Turning a rule off adds a `notVerified` item to the report.
Switching off `lifecycle-script` also switches off the signals for git hooks and `patch-package`, which share its id.

## What the allowlist lowers and what it cannot silence

- A package in `configPackages` still produces its `config-require-nonstandard` signal, now marked as suppressed by the
  user and lowered in severity. It is dropped from chain signals, but a `chain-private-dependency` signal still appears.
- A command in `lifecycleCommands` is compared as the whole command after trimming and collapsing whitespace, not as a
  prefix. It applies only to `package.json` scripts, not to husky or other git hooks. A matching script without
  other indicators is lowered in severity.
- These signals cannot be silenced by any allowlist: `osv-malicious`, `npmrc-auth-token`, `editor-autorun` and
  `chain-private-dependency`.

## Transparency

When a configuration was loaded, the report has a `config` field (schema 1.1.0) with the disabled rules, the
thresholds that differ from the defaults, the number of allowlist entries and the language. Each disabled rule is also
listed in `notVerified` with the reason `disabled by user config`. The console output adds a `Config:` line. The path of
the file is never printed. A check that was turned off is not a check that passed.

## Example

```json
{
  "language": "it",
  "thresholds": { "maxCodeColumn": 400 },
  "rules": { "repo-metadata": false },
  "allowlist": {
    "configPackages": ["@acme/*"],
    "lifecycleCommands": ["tsc -p tsconfig.build.json"]
  }
}
```

## What no setting changes

Remember that no setting turns off G1-G3: nothing from the analyzed repository is executed, it is never opened in an editor, and its
text is always data. There is no key for them.
