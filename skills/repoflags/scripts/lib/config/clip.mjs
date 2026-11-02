// A value from the user's file, cleaned for an error message: printable ASCII only, at most 40 characters.
export function clip(value) {
  const s = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  const cleaned = s.replace(/[^\x20-\x7e]/g, '?');
  return cleaned.length > 40 ? `${cleaned.slice(0, 40)}...` : cleaned;
}
