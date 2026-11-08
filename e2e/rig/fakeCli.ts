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
        *'"text":"make it fail"'*|*'"text":"please make it fail"'*)
          printf '{"type":"system","subtype":"init","session_id":"e2e-session","model":"e2e","tools":[],"mcp_servers":[{"name":"obsidian-vault","status":"connected"}]}\\n'
          printf '{"type":"result","subtype":"success","result":"There is an issue with the selected model (e2e-model).","session_id":"e2e-session","num_turns":1,"is_error":true,"api_error_status":404,"usage":{"input_tokens":0,"output_tokens":0}}\\n' ;;
        *'"text":"hang forever"'*)
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
  *) sleep 0.4; printf '{"type":"result","subtype":"success","is_error":false,"result":"Fixture task completed"}\\n' ;;
esac
`;

const FAKE_CODEX = `import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const args = process.argv.slice(2);
const modelFlag = args.findIndex(arg => arg === "-m" || arg === "--model");
const model = modelFlag >= 0 ? args[modelFlag + 1] : null;
appendFileSync(join(dirname(fileURLToPath(import.meta.url)), "codex-argv.log"), JSON.stringify({ argv: args, model }) + "\\n");
if (args.includes("--version")) {
  console.log("0.0.0-e2e (codex)");
} else if (args[0] === "login" && args[1] === "status") {
  console.error("Logged in using ChatGPT");
} else if (args.includes("app-server")) {
  for await (const line of createInterface({ input: process.stdin })) {
    const message = JSON.parse(line);
    if (message.method === "initialize") console.log(JSON.stringify({ id: message.id, result: {} }));
    else if (message.method === "model/list") console.log(JSON.stringify({ id: message.id, result: { data: [{ id: "e2e-codex-model", model: "e2e-codex-model", displayName: "E2E Codex model", hidden: false }], nextCursor: null } }));
  }
} else if (args[0] === "exec" && args.includes("--json")) {
  console.log(JSON.stringify({ type: "thread.started", thread_id: "e2e-codex-session" }));
  console.log(JSON.stringify({ type: "item.completed", item: { id: "e2e-codex-message", type: "agent_message", text: "pong from codex (" + (model ?? "default") + ")" } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
} else {
  console.error("Unsupported fixture Codex command");
  process.exitCode = 2;
}
`;

// Keep commands outside the modeled protocols hermetic as well.
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
  const codex = join(bin, "codex");
  await writeFile(join(bin, "codex.mjs"), FAKE_CODEX);
  await writeFile(join(bin, "codex-argv.log"), "");
  const nodeExecutable = `'${process.execPath.replace(/'/g, "'\\''")}'`;
  await writeFile(codex, `#!/bin/sh\nexec ${nodeExecutable} "$(dirname "$0")/codex.mjs" "$@"\n`);
  await chmod(codex, 0o755);
  for (const name of ["opencode"]) {
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
