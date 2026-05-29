/**
 * Codex `~/.codex/config.toml` upsert helpers.
 *
 * Both functions are ported byte-identical from the legacy
 * `loopback/cli/setup.js` (with TS types added) so behavior is unchanged.
 */

/**
 * Read the `[mcp_servers.loopback.env]` block from a TOML string. Returns
 * a plain object of preserved keys; the caller folds them back into the
 * rewritten loopback block to preserve any env vars the user added.
 */
export function readCodexEnvBlock(content: string): Record<string, string> {
  const lines = String(content).replace(/\r\n/g, '\n').split('\n');
  let inEnv = false;
  const out: Record<string, string> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '[mcp_servers.loopback.env]') {
      inEnv = true;
      continue;
    }
    if (inEnv && trimmed.startsWith('[') && trimmed.endsWith(']')) {
      inEnv = false;
      continue;
    }
    if (!inEnv) continue;
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"((?:\\.|[^"\\])*)"\s*$/);
    if (!m) continue;
    try {
      out[m[1]] = JSON.parse('"' + m[2] + '"');
    } catch {
      out[m[1]] = m[2];
    }
  }
  return out;
}

/**
 * Remove every existing `[mcp_servers.loopback...]` block from the TOML
 * string and append the new block. Empty `block` argument = remove only.
 */
export function upsertCodexBlock(content: string, block: string): string {
  const lines = String(content).replace(/\r\n/g, '\n').split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; ) {
    const t = lines[i].trim();
    if (t === '[mcp_servers.loopback]' || t.startsWith('[mcp_servers.loopback.')) {
      i++;
      while (i < lines.length) {
        const n = lines[i].trim();
        if (n.startsWith('[') && n.endsWith(']') && !n.startsWith('[mcp_servers.loopback.')) break;
        if (n === '[mcp_servers.loopback]') break;
        i++;
      }
      continue;
    }
    kept.push(lines[i]);
    i++;
  }
  const base = kept.join('\n').trim();
  return (base ? base + '\n\n' : '') + block.trim() + '\n';
}
