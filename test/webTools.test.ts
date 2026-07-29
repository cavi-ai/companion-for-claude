import { describe, it, expect, vi } from "vitest";
import { App } from "obsidian";
import { VaultTools } from "../src/mcp/vaultTools";

function tools(opts: { webSearch?: (q: string, c: number) => Promise<string>; webFetch?: (u: string) => Promise<string> } = {}) {
  const app = new App();
  return new VaultTools(app as never, { allowWrites: false, defaultFolder: "Claude", ...opts });
}

describe("web tools", () => {
  it("advertises web_search / web_fetch only when the impls are wired", () => {
    expect(tools().definitions().map(({ name }) => name)).not.toEqual(expect.arrayContaining(["web_search", "web_fetch"]));
    const names = tools({ webSearch: async () => "", webFetch: async () => "" }).definitions().map(({ name }) => name);
    expect(names).toEqual(expect.arrayContaining(["web_search", "web_fetch"]));
  });

  it("dispatches with the capped count and returns the impl's result", async () => {
    const webSearch = vi.fn(async () => "results here");
    const vt = tools({ webSearch });
    expect(await vt.call("web_search", { query: "obsidian", count: 99 })).toBe("results here");
    expect(webSearch).toHaveBeenCalledWith("obsidian", 10);
  });

  it("web_fetch delegates to the impl", async () => {
    const webFetch = vi.fn(async () => "# Page");
    const vt = tools({ webFetch });
    expect(await vt.call("web_fetch", { url: "https://example.test" })).toBe("# Page");
    expect(webFetch).toHaveBeenCalledWith("https://example.test");
  });

  it("fails closed with an actionable error when a tool is called while disabled", async () => {
    await expect(tools().call("web_search", { query: "q" })).rejects.toThrow(/disabled/i);
    await expect(tools().call("web_fetch", { url: "https://x.test" })).rejects.toThrow(/disabled/i);
  });
});
