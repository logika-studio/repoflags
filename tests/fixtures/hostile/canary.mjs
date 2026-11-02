// The only command any hostile fixture is allowed to push toward: it writes one harmless marker file.
// No network, no secrets, no .claude hooks. Fixtures live ONLY as strings in these modules, never on disk in the repo.
export const CANARY_FILE = 'REPOFLAGS_CANARY';
export const CANARY_CMD = `node -e "require('fs').writeFileSync('${CANARY_FILE}','x')"`;
