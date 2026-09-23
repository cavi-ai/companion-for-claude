import { describe, expect, it, vi } from "vitest";
import { App, FakeElement, WorkspaceLeaf } from "obsidian";
import ClaudeCompanionPlugin from "../../src/main";
import { InboxView } from "../../src/view/InboxView";

const settle = async (turns = 24): Promise<void> => {
  for (let turn = 0; turn < turns; turn++) await Promise.resolve();
};

function harness(): { app: App; view: InboxView; organizeClippings: ReturnType<typeof vi.fn> } {
  const app = new App();
  const plugin = Object.create(ClaudeCompanionPlugin.prototype) as ClaudeCompanionPlugin;
  const organizeClippings = vi.fn(async () => undefined);
  Object.assign(plugin, {
    app,
    settings: { sourceCaptureEnabled: true, sourceInboxFolder: "Clippings", clipOrganizedFolder: "Library" },
    sourceEnrichmentBackendLabel: () => "Claude",
    linkCandidates: () => [],
    organizeClippings,
  });
  return { app, view: new InboxView(new WorkspaceLeaf(app), plugin), organizeClippings };
}

const html = (view: InboxView): string => {
  const walk = (element: FakeElement): string => element.textContent + element.children.map(walk).join(" ");
  return walk(view.contentEl as unknown as FakeElement);
};

describe("Inbox typed clips", () => {
  it("shows auto-typed clips instead of claiming nothing was clipped", async () => {
    const { app, view } = harness();
    app.vault.seed("Clippings/Hugging Face.md", "Body", { mtime: 1, frontmatter: { source_enriched: true, type: "article" } });
    app.vault.seed("Clippings/Qwen.md", "Body", { mtime: 2, frontmatter: { source_enriched: true, type: "video" } });

    await view.render();
    await settle();

    const rendered = html(view);
    expect(rendered).toContain("Qwen");
    expect(rendered).toContain("Hugging Face");
    expect(rendered).not.toContain("Clip something and it'll show up here");
    const count = (view.contentEl as unknown as FakeElement).querySelector(".cc-inbox-typed-count");
    expect(count?.textContent).toBe("2 enriched");
    expect(count?.getAttribute("aria-live")).toBe("polite");
  });

  it("shows typed clips alongside a pending queue", async () => {
    const { app, view } = harness();
    app.vault.seed("Clippings/typed.md", "Body", { mtime: 2, frontmatter: { source_enriched: true, type: "article" } });
    app.vault.seed("Clippings/pending.md", "Body", { mtime: 3 });

    await view.render();
    await settle();

    expect((view.contentEl as unknown as FakeElement).querySelector(".cc-inbox-count")?.textContent).toBe("1 to type");
    expect((view.contentEl as unknown as FakeElement).querySelector(".cc-inbox-typed-count")?.textContent).toBe("1 enriched");
  });

  it("offers Organize into folders for enriched clips and runs the organizer", async () => {
    const { app, view, organizeClippings } = harness();
    app.vault.seed("Clippings/a.md", "Body", { mtime: 1, frontmatter: { source_enriched: true, type: "article" } });

    await view.render();
    await settle();

    const root = view.contentEl as unknown as FakeElement;
    expect(root.querySelector(".cc-inbox-typed")?.querySelector(".cc-eyebrow")?.textContent).toBe("ENRICHED");
    const organize = root.querySelector(".cc-inbox-organize");
    expect(organize?.textContent).toBe("Organize into folders");
    organize?.dispatchEvent({ type: "click" });
    expect(organizeClippings).toHaveBeenCalledTimes(1);
  });

  it("counts every enriched clip but lists the ten newest", async () => {
    const { app, view } = harness();
    for (let i = 0; i < 12; i++) app.vault.seed(`Clippings/c${i}.md`, "Body", { mtime: i, frontmatter: { source_enriched: true, type: "article" } });

    await view.render();
    await settle();

    const root = view.contentEl as unknown as FakeElement;
    expect(root.querySelector(".cc-inbox-typed-count")?.textContent).toBe("12 enriched");
    expect(root.querySelector(".cc-inbox-typed")?.querySelectorAll(".cc-inbox-row")).toHaveLength(10);
  });

  it("keeps the clip-something copy when the inbox is genuinely empty", async () => {
    const { view } = harness();

    await view.render();
    await settle();

    expect(html(view)).toContain("Clip something and it'll show up here");
  });
});
