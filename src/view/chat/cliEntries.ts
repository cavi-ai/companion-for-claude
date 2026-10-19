import { claudeBackend } from "../../cli/backends/claude";
import { codexBackend } from "../../cli/backends/codex";
import { opencodeBackend } from "../../cli/backends/opencode";
import type { CliBackend, CliSignInProvider } from "../../cli/backends/types";
import type { ProviderRouter } from "../../providers/router";

/** Pair each exposed CLI provider with its backend metadata; omit absent providers. */
export function cliEntries(router: ProviderRouter): { backend: CliBackend; provider: CliSignInProvider }[] {
  const candidates: [CliBackend, CliSignInProvider | undefined][] = [
    [claudeBackend, router.claudeCli],
    [codexBackend, (router as { codexCli?: CliSignInProvider }).codexCli],
    [opencodeBackend, (router as { opencodeCli?: CliSignInProvider }).opencodeCli],
  ];
  return candidates.filter((entry): entry is [CliBackend, CliSignInProvider] => entry[1] != null).map(([backend, provider]) => ({ backend, provider }));
}
