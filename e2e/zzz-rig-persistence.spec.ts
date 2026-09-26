import { expect, test } from "./fixtures";
import { liveState } from "./rig/client.ts";

// Sorts last: the final proof that the one rig this run attached to (rig.processId,
// captured once when the worker-scoped fixture first connected) is still the same
// Obsidian process now that every other spec in the suite has run against it.
test("the rig is still the same Obsidian process at the end of the suite", async ({ rig }) => {
  const state = await liveState();
  expect(state?.obsidianPid).toBe(rig.processId);
  expect(() => process.kill(state!.obsidianPid, 0)).not.toThrow();
});
