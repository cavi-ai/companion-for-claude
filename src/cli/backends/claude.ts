// Claude Code CLI backend: thin CliBackend wrapper over the existing argv/streamJson/runtime modules.

import { buildClaudeArgv } from "../argv";
import { parseAuthStatus } from "../runtime";
import { parseCliLine } from "../streamJson";
import type { CliBackend } from "./types";

export const claudeBackend: CliBackend = {
  id: "claude-cli",
  label: "Claude Code",
  binary: "claude",
  processModel: "persistent",
  supportsPermissionPrompt: true,
  supportsMcp: true,
  signInHint: "run `claude auth login`",
  async probe(run) {
    const { stdout } = await run(["auth", "status"]);
    return parseAuthStatus(stdout);
  },
  buildArgv(input) {
    return buildClaudeArgv(input);
  },
  parseLine(line) {
    return parseCliLine(line);
  },
};
