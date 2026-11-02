// Text decoding shared by every acquisition path. A leading UTF-8 BOM is dropped once, here, because npm,
// VS Code and git accept it while JSON.parse rejects it: left in place it would switch a rule off (review CR-02).

/** Removes one leading U+FEFF. */
export function stripBom(text) {
  const s = String(text);
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * Decodes file bytes without the BOM: UTF-16 when a UTF-16 BOM leads (NP-02: decoded as UTF-8 it reached the text
 * rules as NUL-interleaved bytes and switched them off), UTF-8 otherwise. A trailing odd byte of UTF-16 is dropped.
 */
export function decodeText(buf) {
  const le = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe;
  const be = buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff;
  if (!le && !be) return stripBom(buf.toString('utf8'));
  const body = Buffer.from(buf.subarray(2, buf.length - (buf.length % 2)));
  if (be) body.swap16();
  return body.toString('utf16le');
}
