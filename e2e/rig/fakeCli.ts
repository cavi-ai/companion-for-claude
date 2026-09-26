// The rig's hermetic bin dir: fake claude/codex/opencode plus a login-shell
// stub, so no test can ever reach a real agent CLI binary on this machine.

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const FAKE_CLAUDE = `#!/bin/sh
log="$(dirname "$0")/claude-argv.log"
case "$*" in
  *--version*) printf '2.1.257 (Claude Code)\\n' ;;
  *"auth status"*) printf '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}\\n' ;;
  *"plugin marketplace list --json"*) printf '[{"name":"cavi-ai","repo":"cavi-ai/plugins"}]\\n' ;;
  *"plugin list --json"*) printf '[{"id":"obsidian-agent@cavi-ai","enabled":true}]\\n' ;;
  *"--input-format stream-json"*)
    printf 'ARGV %s\\n' "$*" >> "$log"
    while IFS= read -r line; do
      printf 'STDIN %s\\n' "$line" >> "$log"
      case "$line" in
        *"make it fail"*)
          printf '{"type":"system","subtype":"init","session_id":"e2e-session","model":"e2e","tools":[],"mcp_servers":[{"name":"obsidian-vault","status":"connected"}]}\\n'
          printf '{"type":"result","subtype":"success","result":"There is an issue with the selected model (e2e-model).","session_id":"e2e-session","num_turns":1,"is_error":true,"api_error_status":404,"usage":{"input_tokens":0,"output_tokens":0}}\\n' ;;
        *"hang forever"*)
          printf '{"type":"system","subtype":"init","session_id":"e2e-session","model":"e2e","tools":[],"mcp_servers":[{"name":"obsidian-vault","status":"connected"}]}\\n'
          trap '' INT TERM
          while :; do sleep 1; done ;;
        *"weakens my continuity claim"*)
          printf '{"type":"system","subtype":"init","session_id":"e2e-session","model":"e2e","tools":[],"mcp_servers":[{"name":"obsidian-vault","status":"connected"}]}\\n'
          printf '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"mcp__obsidian-vault__vault_search","input":{"query":"challenges continuity claim"}}]}}\\n'
          printf '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"Research/Alpha/Evidence/Challenge.md — proposed evidence"}]}}\\n'
          printf '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"mcp__obsidian-vault__note_read","input":{"path":"Research/Alpha/Evidence/Challenge.md"}}]}}\\n'
          printf '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t2","content":"> Continuity varies by workflow.\\\\n\\\\nLocator: p. 8 · Review: proposed"}]}}\\n'
          printf '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Your weakest point is scope: the evidence says continuity varies by workflow, so “provenance preserves continuity” is too absolute. Narrow the claim to the workflows where source links remain intact, then review the proposed evidence on page 8."}}}\\n'
          printf '{"type":"result","subtype":"success","result":"Your weakest point is scope: the evidence says continuity varies by workflow, so “provenance preserves continuity” is too absolute. Narrow the claim to the workflows where source links remain intact, then review the proposed evidence on page 8.","session_id":"e2e-session","num_turns":1,"is_error":false,"usage":{"input_tokens":1,"output_tokens":1}}\\n' ;;
        *)
          printf '{"type":"system","subtype":"init","session_id":"e2e-session","model":"e2e","tools":[],"mcp_servers":[{"name":"obsidian-vault","status":"connected"}]}\\n'
          printf '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"pong from claude code"}}}\\n'
          printf '{"type":"result","subtype":"success","result":"pong from claude code","session_id":"e2e-session","num_turns":1,"is_error":false,"usage":{"input_tokens":1,"output_tokens":1}}\\n' ;;
      esac
    done ;;
  *) sleep 0.4; printf '{"type":"result","result":"Fixture task completed"}\\n' ;;
esac
`;

// codex/opencode are not driven by any spec yet; a minimal --version-answering
// stub is enough to keep them off the hermetic PATH's real-binary risk.
const fakeMinimalCli = (name: string): string => `#!/bin/sh
case "$*" in
  *--version*) printf '0.0.0-e2e (${name})\\n' ;;
  *) printf '{"type":"result","result":"fixture ${name} completed"}\\n' ;;
esac
`;

const LOGIN_SHELL = `#!/bin/sh
# Fake $SHELL: Electron apps on macOS probe the user's real interactive PATH by
# shelling out to $SHELL. Echo the rig's own hermetic PATH instead of running
# the given command, so no system PATH (Homebrew, nvm, …) ever leaks in.
printf '__CC_PATH__%s__CC_PATH__\\n' "$PATH"
`;

/** Write the hermetic bin dir once at daemon startup; static content, never rewritten by reset. */
export async function installFakeCli(root: string): Promise<{ bin: string; argvLog: string }> {
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const claude = join(bin, "claude");
  await writeFile(claude, FAKE_CLAUDE);
  await chmod(claude, 0o755);
  for (const name of ["codex", "opencode"]) {
    const path = join(bin, name);
    await writeFile(path, fakeMinimalCli(name));
    await chmod(path, 0o755);
  }
  const loginShell = join(bin, "login-shell");
  await writeFile(loginShell, LOGIN_SHELL);
  await chmod(loginShell, 0o755);
  const argvLog = join(bin, "claude-argv.log");
  await writeFile(argvLog, "");
  return { bin, argvLog };
}
