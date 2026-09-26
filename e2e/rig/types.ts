// Shared types between the rig daemon, its CLI, and the Playwright fixture.
// Declarative — everything here crosses an HTTP boundary, so no functions.

/** A substring/regex match against a provider request body, in declaration order; first match wins. */
export interface ReplyRule {
  match: string;
  flags?: string;
  /** Replies returned in order across repeated matches; the last one repeats once exhausted. */
  replies: string[];
}

export interface FailRule {
  match: string;
  flags?: string;
  status: number;
}

export interface ScenarioOptions {
  fakeClaudeCode?: boolean;
  /** Seed the Claude Code backend with a fake claude that speaks stream-json. */
  claudeCli?: boolean;
  /** Widen PATH to the real ~/.local/bin so the signed-in claude binary resolves. Opt-in, CC_E2E_LIVE=1 only. */
  liveClaude?: boolean;
  /** Seed a genuinely fresh install: no credential, stock onboarding defaults. */
  firstRun?: boolean;
  endpointModels?: string[];
  endpointReply?: string;
  providerReply?: ReplyRule[];
  providerFail?: FailRule[];
  providerDelayMs?: number;
  extraFiles?: Record<string, string>;
  settingsOverride?: Record<string, unknown>;
  embedStub?: boolean;
  theme?: "light" | "dark";
  hidden?: boolean;
}

export interface RigState {
  pid: number;
  obsidianPid: number;
  cdpPort: number;
  controlPort: number;
  token: string;
  root: string;
  vault: string;
  profile: string;
  argvLog: string;
  startedAt: string;
  pluginBuildHash: string;
}

export interface StubPorts {
  providerPort: number;
  endpointPort: number;
  embedPort: number;
}
