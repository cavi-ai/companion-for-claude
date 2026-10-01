import { App, clearNotices, getNoticeMessages } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ClaudeCompanionPlugin from "../src/main";
import type { EnrichOutcomeLike } from "../src/research/triage";

function harness(outcomes: Record<string, EnrichOutcomeLike>) {
  const app = new App();
  app.vault.seed("Clippings/a.md", "Alpha body", { frontmatter: { title: "Alpha" } });
  app.vault.seed("Clippings/b.md", "Beta body", { frontmatter: { title: "Beta" } });
  const runEnrich = vi.fn(async (file: { path: string }) => outcomes[file.path] ?? ({ status: "enriched" } as const));
  const complete = vi.fn(async (_role: string, _req: { user: string }) => ({
    text: JSON.stringify({ groups: [{ theme: "Alpha theme", summary: "", researchIdea: "", paths: ["Clippings/a.md"] }] }),
  }));
  const plugin = Object.create(ClaudeCompanionPlugin.prototype) as ClaudeCompanionPlugin;
  Object.assign(plugin as unknown as Record<string, unknown>, {
    app,
    settings: { sourceInboxFolder: "Clippings", clipOrganizedFolder: "Library" },
    enrichment: () => ({ runEnrich, markEnrichRecentlyWritten: vi.fn() }),
    router: () => ({ complete, resolve: () => ({ provider: { id: "anthropic" } }) }),
  });
  const triage = () => (plugin as unknown as { triageClippings(folder?: string): Promise<void> }).triageClippings("Clippings");
  return { triage, runEnrich, complete };
}

beforeEach(() => clearNotices());

describe("finding research themes", () => {
  it("keeps going past a failed clip and leaves it out of the model payload", async () => {
    const { triage, complete } = harness({ "Clippings/b.md": { status: "failed", error: new Error("boom") } });

    await triage();

    expect(complete).toHaveBeenCalledOnce();
    const user = complete.mock.calls[0]![1].user;
    expect(user).toContain("Clippings/a.md");
    expect(user).not.toContain("Clippings/b.md");
    expect(getNoticeMessages().some((m) => /^Themes: 1 theme across 1 clipping.*\(1 skipped: could not enrich\)$/.test(m))).toBe(true);
  });

  it("a skipped outcome stops before any model call", async () => {
    const skip = { status: "skipped" as const, reason: "Consent declined" };
    const { triage, runEnrich, complete } = harness({ "Clippings/a.md": skip, "Clippings/b.md": skip });

    await triage();

    expect(runEnrich).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
    expect(getNoticeMessages()).toContain("Finding themes stopped — Consent declined");
  });
});
