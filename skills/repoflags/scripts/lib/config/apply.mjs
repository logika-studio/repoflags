// Late filter for the user configuration (D-58): runs after the chains are computed on ALL signals, so switching a
// component rule off (or suppressing one signal) never dissolves a chain. Pure function.

const REASON = 'disabled by user config';

/**
 * @param {object[]} signals every signal, chains included
 * @param {{disabledRules?: string[]}} config
 * @returns {{signals: object[], notVerified: {check: string, reason: string}[]}}
 */
export function applyUserConfig(signals, { disabledRules = [] } = {}) {
  const off = new Set(disabledRules);
  const kept = [];
  for (const s of signals) {
    if (s.suppressedByUser === true || off.has(s.rule)) continue;
    // The internal flag never reaches the report (the schema rejects undeclared keys on signals).
    const { suppressedByUser: _flag, ...clean } = s;
    kept.push(clean);
  }
  const notVerified = [...off].sort().map((check) => ({ check, reason: REASON }));
  return { signals: kept, notVerified };
}
