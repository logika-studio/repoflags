# Security policy

repoflags checks an unknown repository before you open, install or run it. This page explains where to report a
problem with repoflags itself, a wrong result, or a malicious package you found with it.

Whatever you report, **never paste tokens, credentials, private repository content or live malicious payloads** into an
issue or a message. Describe the artifact (package name, version, file path, commit SHA, OSV ID) instead.

## Reporting a vulnerability in repoflags

A vulnerability is a way to make repoflags itself do something it must not do: execute or open anything from the
analyzed repository, follow instructions written in it, send data to a host other than `api.github.com`,
`api.osv.dev` and `registry.npmjs.org`, or print or store a token.

Please report it privately, not in a public issue:

- **GitHub private vulnerability reporting**: open the **Security** tab of this repository and choose
  **Report a vulnerability**.
- **Email**: `tech-area@logikastudio.it`, with "repoflags vulnerability" in the subject.

Include the version of repoflags, the client and model you used, and the smallest input that shows the problem. If the
input is a hostile repository, describe it or reduce it to harmless text: do not attach working malware.

## False positives and false negatives

A false positive is a signal on something harmless; a false negative is a known malicious pattern that repoflags did
not flag. Both are welcome and both are public: open an issue with the **Detection report** form
(`detection-report`) and include, when you have them:

- the package name and version, or the file path that was flagged or missed;
- the OSV ID (for example a `MAL-` entry) that applies;
- the commit SHA of the analyzed repository.

Never paste tokens, credentials or live malicious payloads in the form. A description of the pattern is enough.

## Active malicious packages

If repoflags helped you find a malicious package that is still published, report it where it can be taken down, not
only here:

- **npm**: use the **Report malware** button on the package page, with the package name, all affected versions and
  the evidence (https://docs.npmjs.com/reporting-malware-in-an-npm-package).
- **OSV**: malicious package entries (`MAL-` IDs) come from the OpenSSF Malicious Packages repository
  (https://github.com/ossf/malicious-packages), published in OSV format on https://osv.dev. Follow the contribution
  instructions of that repository.
- **GitHub**: use **Report repository** on the repository page, or the abuse form at
  https://support.github.com/contact/report-abuse.

If you already ran code from the repository, stop and follow the response checklist in
`skills/repoflags/references/incident-response.md` before anything else.

## What we do not do

- We do not judge people or accounts. Reports are about artifacts: a package, a file, a commit. Do not name or accuse
  people in issues; the maintainers will edit or close issues that do.
- We do not promise a response time. This is a free project maintained on a best-effort basis; private reports are
  read first.
- repoflags never gives an all-clear verdict, and neither do we: "no signals found by these rules" is the best outcome
  it can report.
