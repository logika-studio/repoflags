# If you already ran, installed or opened the repository

This is the checklist for G10. It is informational, not legal advice. repoflags does not recover funds, does not ask
for payments and makes no promise that money can be recovered. Nobody who offers to do it for you is working for us.

Do not run the repoflags script as a first step: the priority is damage control. The analysis can come later, only if
the user wants it, to know what to report.

Follow the steps in this order. Do not judge or name any person (G8): describe what happened, with dates and links.

### 1. Isolate the device and do not format it

- Disconnect the device from the network now (Wi-Fi off, cable out).
- Do not format it and do not delete anything. The device and the repository folder are evidence.
- Do not open the project again and do not run anything else from it.

### 2. Move funds and change credentials from a different device

Use a different, uncompromised device for everything in this step.

- Move any remaining funds to a new wallet created with a new seed phrase. Never reuse the old seed phrase.
- Change the passwords and the two-factor authentication of email, exchanges, GitHub and npm, and of the password manager.
- Revoke and recreate SSH keys, GitHub personal access tokens and npm tokens, cloud and API keys (including those in
  `.env` files of other projects on that device) and signing keys. A new password does not revoke a stolen token or key.
- Sign out of every active session where the service allows it, including sessions saved in the browser of that device
  (cookies, saved passwords, wallet extensions).

### 3. Revoke token approvals

If the theft may have used a token approval (allowance), revoke the approvals of the affected wallets from the different
device, using the revocation tool of the relevant blockchain explorer. Do this after the funds are moved, not before.

### 4. Collect evidence

Do this before the pages and messages disappear:

- transaction hashes and wallet addresses;
- screenshots of the conversations (platform, username, URL, date and time visible);
- the link to the repository or package, the commit SHA, and the files received (for example `package.json`);
- the original emails;
- a SHA-256 hash of every saved file, and a note of the date and time you saved it.

Keep the originals unchanged. Only after the evidence is preserved should you consider wiping and reinstalling the
machine, and preferably with the help of a professional.

### 5. Report to the platforms

Reporting removes the bait for the next person.

- GitHub: use "Report repository" in the sidebar of the repository, or the abuse form at
  https://support.github.com/contact/report-abuse.
- npm: use the "Report malware" button on the package page, with the package name, the versions and the evidence
  (https://docs.npmjs.com/reporting-malware-in-an-npm-package).
- The platform where the contact started (a freelance marketplace, a professional network, a messaging app): use its
  report function on the message and on the profile.

### 6. File a police report

- In Italy: the Polizia Postale, https://www.commissariatodips.it. "Segnala online" reports a fact for verification and
  does not replace the formal complaint; the online pre-complaint for cybercrime needs SPID or CIE and must then be
  formalized in person within 48 hours, and the page says the service is experimental in some offices only. Elsewhere,
  file the complaint at any police office. Bring the evidence from step 4.
- Outside Italy: the national authority equivalent to the Polizia Postale for cybercrime in your country.
- Where it applies (United States): the FBI Internet Crime Complaint Center, https://www.ic3.gov.
- After filing, give the report number to the exchange that received the funds.

### 7. Ignore anyone offering fund recovery

Anyone who contacts you offering to recover the funds is running a second scam: they ask for an advance fee or a
"tax" and disappear. Do not pay, do not share your seed phrase, do not install software they send.

- Consob warns that fake lawyers use its name and logo and that it does not recover credits:
  https://www.consob.it/web/consob/occhio-alle-truffe-
- The FBI IC3 warns that most recovery companies are scams. Law enforcement does not charge victims a fee for
  investigating crimes: https://www.ic3.gov/PSA/2024/PSA240624

## Sources and date

Channels verified on 2026-Nov-01 from official pages and the platforms' own documentation. Pages change: if a link
fails, search for the official page of the same service instead of following a link from a message you received.
This checklist is informational and not legal advice; for a legal opinion, ask a lawyer.
