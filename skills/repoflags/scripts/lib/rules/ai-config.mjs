// Agent and MCP configuration that runs commands (review WR-09, gap of D-25/D-27 closed by decision recorded in the
// review fix report): Claude Code project settings (hooks, apiKeyHelper, statusLine), MCP server lists (.mcp.json,
// .cursor/mcp.json, .vscode/mcp.json, .gemini/settings.json). G3: everything here is untrusted data; it only
// reaches the report as sanitized, truncated evidence. Severity: `high` for a command the client runs, `medium` for a
// remote MCP server (it receives the agent's context) and for a file that cannot be parsed.
import { selectKind } from '../acquire/select.mjs';
import { parseJsonc, findKeyLine } from '../util/jsonc.mjs';
import { sanitizeEvidence } from '../util/sanitize.mjs';
import { flatten, commandIndicators, MAX_COMMAND } from './editor-commands.mjs';

export const RULE = 'ai-agent-config';
const TITLE_HOOK = 'AI agent configuration runs a command';
const TITLE_MCP = 'MCP server started by the AI agent from repository configuration';
const TITLE_REMOTE = 'Remote MCP server configured by the repository';
const TITLE_BROKEN = 'AI agent configuration could not be parsed: commands not fully checked';
const MAX_ITEMS = 20;

const own = (o, k) => o !== null && typeof o === 'object' && !Array.isArray(o) && Object.hasOwn(o, k);
const objects = (o) => (o !== null && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o).slice(0, MAX_ITEMS).map((k) => [k, o[k]]) : []);

function evidence(label, cmd) {
  const ind = commandIndicators(cmd);
  return sanitizeEvidence(`${ind.length ? `indicator: ${ind.join(', ')} | ` : ''}${label}: ${cmd.slice(0, MAX_COMMAND)}`);
}

/** Claude Code settings: hooks.<Event>[].hooks[].command, apiKeyHelper, statusLine.command. */
function claudeCommands(root) {
  const out = [];
  for (const [event, groups] of objects(own(root, 'hooks') ? root.hooks : null)) {
    for (const g of [].concat(groups).slice(0, MAX_ITEMS)) {
      for (const h of own(g, 'hooks') ? [].concat(g.hooks).slice(0, MAX_ITEMS) : []) {
        if (own(h, 'command')) out.push([`hook ${event}`, flatten(h.command), event]);
      }
    }
  }
  if (own(root, 'apiKeyHelper')) out.push(['apiKeyHelper', flatten(root.apiKeyHelper), 'apiKeyHelper']);
  if (own(root, 'statusLine') && own(root.statusLine, 'command')) out.push(['statusLine', flatten(root.statusLine.command), 'statusLine']);
  return out.filter(([, c]) => c);
}

/** MCP servers under mcpServers (most clients) or servers (VS Code). */
function mcpSignals(file, text, root) {
  const out = [];
  const servers = [...objects(own(root, 'mcpServers') ? root.mcpServers : null), ...objects(own(root, 'servers') ? root.servers : null)];
  for (const [name, s] of servers) {
    if (own(s, 'command')) {
      const cmd = flatten([s.command, own(s, 'args') ? s.args : []]);
      out.push({ rule: RULE, severity: 'high', title: TITLE_MCP, file, line: findKeyLine(text, name), evidence: evidence(`mcp server ${name}`, cmd), refs: [] });
    } else if (own(s, 'url') || own(s, 'httpUrl') || own(s, 'serverUrl')) {
      const url = flatten(s.url ?? s.httpUrl ?? s.serverUrl).replace(/\?.*$/, '?…');
      out.push({ rule: RULE, severity: 'medium', title: TITLE_REMOTE, file, line: findKeyLine(text, name), evidence: sanitizeEvidence(`mcp server ${name}: ${url}`), refs: [] });
    }
  }
  return out;
}

/** @param {Map<string,{text:string,size:number}>} files */
export function detect(files) {
  const signals = [];
  const notVerified = [];
  for (const [file, { text }] of files) {
    if (selectKind(file) !== 'aiconfig') continue;
    const parsed = parseJsonc(text);
    if (!parsed.ok || parsed.value === null || typeof parsed.value !== 'object') {
      notVerified.push({ check: RULE, reason: `unparseable JSONC: ${sanitizeEvidence(file)}` });
      signals.push({ rule: RULE, severity: 'medium', title: TITLE_BROKEN, file, line: 1, evidence: 'not valid JSONC; the agent may still read it', refs: [] });
      continue;
    }
    const root = parsed.value;
    for (const [label, cmd, key] of claudeCommands(root)) {
      signals.push({ rule: RULE, severity: 'high', title: TITLE_HOOK, file, line: findKeyLine(text, key), evidence: evidence(label, cmd), refs: [] });
    }
    signals.push(...mcpSignals(file, text, root));
  }
  return { signals, notVerified };
}
