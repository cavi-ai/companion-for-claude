import { describe, expect, it } from "vitest";
import type { Page } from "@playwright/test";
import { selectRigPage } from "../e2e/rig/pageOps";

const vault = "/repo/obsidian-plugin/.tmp/e2e-rig/vault";

function page(url: string, basePath?: string): Page {
  return { url: () => url, evaluate: async () => basePath } as unknown as Page;
}

describe("rig vault isolation", () => {
  it("rejects a personal vault before the rig can reload or reset its plugin", async () => {
    await expect(selectRigPage([page("app://obsidian.md/index.html", "/personal/vault")], vault))
      .rejects.toThrow(/outside the test vault/);
  });

  it("rejects a personal vault even when the test vault is also open", async () => {
    await expect(selectRigPage([
      page("app://obsidian.md/index.html", vault),
      page("app://obsidian.md/index.html", "/personal/vault"),
    ], vault)).rejects.toThrow(/outside the test vault/);
  });

  it("selects the test vault while ignoring popouts and windows still loading", async () => {
    const testPage = page("app://obsidian.md/index.html", vault);
    expect(await selectRigPage([
      page("about:blank", "/personal/vault"),
      page("app://obsidian.md/index.html"),
      testPage,
    ], vault)).toBe(testPage);
  });
});
