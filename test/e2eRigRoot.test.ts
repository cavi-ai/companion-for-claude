import { describe, expect, it } from "vitest";
import { rigRootFor, rigRootsFromPs } from "../e2e/rig/client";

describe("e2e rig root", () => {
  it("every worktree of the repo resolves to the main checkout's rig root", () => {
    expect(rigRootFor("/repo/.git", "obsidian-plugin", "/repo/.tmp/worktrees/x/obsidian-plugin")).toBe("/repo/obsidian-plugin/.tmp/e2e-rig");
    expect(rigRootFor("/repo/.git", "obsidian-plugin", "/repo/obsidian-plugin")).toBe("/repo/obsidian-plugin/.tmp/e2e-rig");
  });

  it("falls back to the plugin's own .tmp outside git", () => {
    expect(rigRootFor(null, null, "/x/obsidian-plugin")).toBe("/x/obsidian-plugin/.tmp/e2e-rig");
  });

  it("finds a running rig's root from its Obsidian main process, ignoring helpers and other Obsidians", () => {
    const ps = [
      "/Applications/Obsidian.app/Contents/MacOS/Obsidian /r/wt/obsidian-plugin/.tmp/e2e-rig/vault --user-data-dir=/r/wt/obsidian-plugin/.tmp/e2e-rig/profile --remote-debugging-port=5",
      "/Applications/Obsidian.app/Contents/Frameworks/Obsidian Helper (Renderer).app/Contents/MacOS/Obsidian Helper (Renderer) --type=renderer --user-data-dir=/r/wt/obsidian-plugin/.tmp/e2e-rig/profile",
      "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
    ].join("\n");
    expect(rigRootsFromPs(ps)).toEqual(["/r/wt/obsidian-plugin/.tmp/e2e-rig"]);
  });
});
