// Pure helpers for the MCP bridge: token generation and client config snippets.

/** Generate a URL-safe random token. Uses Web Crypto when available. */
export function generateToken(bytes = 24): string {
  const arr = new Uint8Array(bytes);
  // eslint-disable-next-line obsidianmd/no-global-this -- Electron/Node global (crypto/process/require), not window-scoped; globalThis works in the node test env and is mobile-safe via optional chaining
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) {
    c.getRandomValues(arr);
  } else {
    for (let i = 0; i < bytes; i++) arr[i] = Math.floor(Math.random() * 256);
  }
  let s = "";
  for (const b of arr) s += b.toString(16).padStart(2, "0");
  return s;
}

export interface BridgeInfo {
  port: number;
  token: string;
}

/** Env var that, when set, sources the MCP bearer token instead of plugin data. */
export const MCP_TOKEN_ENV = "OBSIDIAN_COMPANION_MCP_TOKEN";

/** The literal shell/JSON reference to the env var, for share-safe snippets. */
export function mcpTokenEnvRef(): string {
  return "${" + MCP_TOKEN_ENV + "}";
}

/** Mask a secret for display: short prefix + suffix, middle bulleted. */
export function maskToken(token: string): string {
  const t = (token ?? "").trim();
  if (!t) return "";
  if (t.length <= 8) return "•".repeat(t.length);
  return `${t.slice(0, 4)}${"•".repeat(Math.max(4, t.length - 8))}${t.slice(-4)}`;
}

export interface ResolvedToken {
  /** The real token (env wins over stored), or "" when none is configured. */
  token: string;
  source: "env" | "stored" | "none";
}

/**
 * Resolve the bearer token, preferring the environment over stored settings so a
 * user can keep the secret out of this vault's (possibly synced) data.json.
 */
export function resolveMcpToken(env: Record<string, string | undefined>, stored: string): ResolvedToken {
  const fromEnv = (env[MCP_TOKEN_ENV] ?? "").trim();
  if (fromEnv) return { token: fromEnv, source: "env" };
  const s = (stored ?? "").trim();
  if (s) return { token: s, source: "stored" };
  return { token: "", source: "none" };
}

export function bridgeUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp`;
}

function requireToken(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) throw new Error("MCP bridge snippets require a non-empty bearer token.");
  return trimmed;
}

/** The `claude mcp add` command for Claude Code (HTTP transport). */
export function claudeCodeCommand(info: BridgeInfo): string {
  const token = requireToken(info.token);
  return `claude mcp add --transport http obsidian-vault ${bridgeUrl(info.port)} --header "Authorization: Bearer ${token}"`;
}

/** A claude_desktop_config.json fragment (uses mcp-remote to bridge HTTP→stdio). */
export function claudeDesktopConfig(info: BridgeInfo): string {
  const token = requireToken(info.token);
  const args = ["-y", "mcp-remote", bridgeUrl(info.port), "--header", `Authorization: Bearer ${token}`];
  return JSON.stringify(
    {
      mcpServers: {
        "obsidian-vault": {
          command: "npx",
          args,
        },
      },
    },
    null,
    2,
  );
}
