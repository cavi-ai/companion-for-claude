import { afterEach, describe, expect, it, vi } from "vitest";
import { App, FakeElement, getLastOpenedModal, TFile, WorkspaceLeaf } from "obsidian";
import ClaudeCompanionPlugin from "../src/main";
import { reviewInboxBatchLinks } from "../src/links/inboxBatchReview";
import { BatchDiffModal } from "../src/view/BatchDiffModal";
import { InboxView } from "../src/view/InboxView";

const settle = async (turns = 24): Promise<void> => {
  for (let turn = 0; turn < turns; turn++) await Promise.resolve();
};

const text = (element: FakeElement): string => element.textContent + element.children.map(text).join("");

interface InboxHarness {
  app: App;
  plugin: ClaudeCompanionPlugin;
  view: InboxView;
  alpha: TFile;
  beta: TFile;
}

function createHarness(): InboxHarness {
  const app = new App();
  const alpha = app.vault.seed("Clippings/alpha.md", "Project Atlas leads.\n", { frontmatter: { source_enriched: true } });
  const beta = app.vault.seed("Clippings/beta.md", "Ada Lovelace follows.\n", { frontmatter: { source_enriched: true } });
  app.vault.seed("Notes/Project Atlas.md", "", {});
  app.vault.seed("Notes/Ada Lovelace.md", "", {});

  const plugin = Object.create(ClaudeCompanionPlugin.prototype) as ClaudeCompanionPlugin;
  Object.assign(plugin, {
    app,
    settings: { sourceCaptureEnabled: true, sourceInboxFolder: "Clippings" },
  });
  return { app, plugin, view: new InboxView(new WorkspaceLeaf(app), plugin), alpha, beta };
}

function reviewAll(view: InboxView): void {
  const button = (view.contentEl as unknown as FakeElement).querySelector(".cc-inbox-review-all");
  expect(button?.textContent).toBe("Review all links");
  button?.dispatchEvent({ type: "click" });
}

function applyButton(modal: BatchDiffModal): FakeElement {
  const button = (modal.contentEl as unknown as FakeElement).querySelectorAll("button")
    .find((element) => element.textContent === "Apply selected");
  expect(button).toBeDefined();
  return button!;
}

afterEach(() => vi.useRealTimers());

describe("Inbox batch link review", () => {
  it("catches a regression that hides dynamic Inbox feedback and counts from assistive technology", async () => {
    const { app, plugin, view } = createHarness();
    Object.assign(plugin, { sourceEnrichmentBackendLabel: () => "Ollama · utility-model" });
    app.vault.seed("Clippings/pending.md", "Pending private clip.");

    await view.render();
    await settle();

    for (const selector of [
      ".cc-inbox-operation-status",
      ".cc-inbox-count",
      ".cc-inbox-enrichment-status",
      ".cc-inbox-wireup-count",
    ]) {
      const element = (view.contentEl as unknown as FakeElement).querySelector(selector);
      expect(element?.getAttribute("role"), selector).toBe("status");
      expect(element?.getAttribute("aria-live"), selector).toBe("polite");
    }
  });

  it("catches a regression that abandons readable notes when one initial read fails", async () => {
    const broken = new TFile("Clippings/broken.md", "", 0);
    const readable = new TFile("Clippings/readable.md", "Project Atlas remains.\n", 0);
    const files = new Map([[broken.path, broken], [readable.path, readable]]);

    const result = await reviewInboxBatchLinks(
      [broken, readable],
      [{ path: "Notes/Project Atlas.md", basename: "Project Atlas", aliases: [] }],
      {
        read: async (file) => {
          if (file.path === broken.path) throw new Error("permission denied");
          return file._content;
        },
        getFile: (path) => files.get(path) ?? null,
        process: async (file, transform) => { file._content = transform(file._content); },
        select: async (plans) => plans.map((item) => item.plan.hunks.map(() => true)),
      },
    );

    expect(result).toEqual({
      appliedFiles: 1,
      appliedHunks: 1,
      conflicts: [],
      failures: [{ path: "Clippings/broken.md", message: "Read failed: permission denied" }],
    });
    expect(readable._content).toBe("[[Project Atlas]] remains.\n");
  });

  it("catches a regression that throws without naming an unreadable-only Inbox batch", async () => {
    const broken = new TFile("Clippings/broken.md", "", 0);

    const result = await reviewInboxBatchLinks(
      [broken],
      [{ path: "Notes/Project Atlas.md", basename: "Project Atlas", aliases: [] }],
      {
        read: async () => { throw new Error("file disappeared"); },
        getFile: () => broken,
        process: async () => undefined,
        select: async () => { throw new Error("The modal must not open without a plan."); },
      },
    );

    expect(result).toEqual({
      appliedFiles: 0,
      appliedHunks: 0,
      conflicts: [],
      failures: [{ path: "Clippings/broken.md", message: "Read failed: file disappeared" }],
    });
  });

  it("catches a regression that maps a sorted review selection back to input order", async () => {
    const zeta = new TFile("Clippings/zeta.md", "Project Atlas remains.\n", 0);
    const alpha = new TFile("Clippings/alpha.md", "Ada Lovelace remains.\n", 0);
    const files = new Map([[zeta.path, zeta], [alpha.path, alpha]]);

    await reviewInboxBatchLinks(
      [zeta, alpha],
      [
        { path: "Notes/Project Atlas.md", basename: "Project Atlas", aliases: [] },
        { path: "Notes/Ada Lovelace.md", basename: "Ada Lovelace", aliases: [] },
      ],
      {
        read: async (file) => file._content,
        getFile: (path) => files.get(path) ?? null,
        process: async (file, transform) => { file._content = transform(file._content); },
        select: async () => [[false], [true]],
      },
    );

    expect(alpha._content).toBe("Ada Lovelace remains.\n");
    expect(zeta._content).toBe("[[Project Atlas]] remains.\n");
  });

  it("catches a regression that lets the plugin entry point abort before a readable sibling reaches review", async () => {
    const { app, plugin, alpha, beta } = createHarness();
    const vault = app.vault as unknown as { cachedRead(file: TFile): Promise<string> };
    const read = vault.cachedRead.bind(vault);
    vault.cachedRead = async (file) => {
      if (file.path === alpha.path) throw new Error("permission denied");
      return read(file);
    };

    const result = plugin.reviewInboxLinkSuggestions([alpha, beta]);
    await settle();
    expect(getLastOpenedModal()).toBeInstanceOf(BatchDiffModal);
    applyButton(getLastOpenedModal() as BatchDiffModal).dispatchEvent({ type: "click" });

    expect(await result).toEqual({
      appliedFiles: 1,
      appliedHunks: 1,
      conflicts: [],
      failures: [{ path: "Clippings/alpha.md", message: "Read failed: permission denied" }],
    });
    expect(beta._content).toBe("[[Ada Lovelace]] follows.\n");
  });

  it("catches a regression that starts a second review while the first modal is open", async () => {
    const { app, view } = createHarness();
    await view.render();
    await settle();

    reviewAll(view);
    await settle();
    const modal = getLastOpenedModal();
    expect(modal).toBeInstanceOf(BatchDiffModal);

    const currentButton = (view.contentEl as unknown as FakeElement).querySelector(".cc-inbox-review-all");
    expect(currentButton?.disabled).toBe(true);
    currentButton?.dispatchEvent({ type: "click" });
    expect(getLastOpenedModal()).toBe(modal);

    const betaToggle = (modal!.contentEl as unknown as FakeElement)
      .querySelectorAll(".cc-batch-diff-file-checkbox")[1] as unknown as HTMLInputElement;
    betaToggle.checked = false;
    betaToggle.dispatchEvent({ type: "change" });
    applyButton(modal as BatchDiffModal).dispatchEvent({ type: "click" });
    await settle();

    expect(await app.vault.cachedRead(app.vault.getAbstractFileByPath("Clippings/alpha.md") as TFile)).toBe("[[Project Atlas]] leads.\n");
    expect(await app.vault.cachedRead(app.vault.getAbstractFileByPath("Clippings/beta.md") as TFile)).toBe("Ada Lovelace follows.\n");
    expect(text(view.contentEl as unknown as FakeElement)).toContain("Linked 1 mention in 1 note.");
  });

  it("catches a regression that hides conflict paths and save failures after batch review", async () => {
    const { app, view, alpha, beta } = createHarness();
    await view.render();
    await settle();

    reviewAll(view);
    await settle();
    alpha._content = "Project Atlas changed while reviewing.\n";
    const vault = app.vault as unknown as {
      process(file: TFile, transform: (current: string) => string): Promise<string>;
    };
    const processFile = vault.process.bind(vault);
    vault.process = async (file, transform) => {
      if (file.path === beta.path) throw new Error("disk full");
      return processFile(file, transform);
    };
    applyButton(getLastOpenedModal() as BatchDiffModal).dispatchEvent({ type: "click" });
    await settle();

    expect(text(view.contentEl as unknown as FakeElement)).toContain("1 note changed during review.");
    const details = (view.contentEl as unknown as FakeElement).querySelector(".cc-inbox-link-result-details");
    expect(details).not.toBeNull();
    const detailText = text(details!);
    expect(detailText).toContain("Clippings/alpha.md");
    expect(detailText).toContain("Clippings/beta.md");
    expect(detailText).toContain("disk full");
    expect((view.contentEl as unknown as FakeElement).querySelector(".cc-inbox-operation-status")?.classList.has("cc-inbox-operation-error")).toBe(true);
  });

  it("catches a regression that describes an initial read failure as a save failure", async () => {
    const { app, view, alpha } = createHarness();
    await view.render();
    await settle();
    const vault = app.vault as unknown as { cachedRead(file: TFile): Promise<string> };
    const read = vault.cachedRead.bind(vault);
    let alphaReads = 0;
    vault.cachedRead = async (file) => {
      if (file.path === alpha.path && ++alphaReads === 2) throw new Error("permission denied");
      return read(file);
    };

    reviewAll(view);
    await settle();
    applyButton(getLastOpenedModal() as BatchDiffModal).dispatchEvent({ type: "click" });
    await settle();

    const details = (view.contentEl as unknown as FakeElement).querySelector(".cc-inbox-link-result-details");
    expect(text(details!)).toContain("Could not complete");
    expect(text(details!)).toContain("Clippings/alpha.md: Read failed: permission denied");
  });

  it("catches a regression that lets persistent unreadable Inbox files erase batch failures or reject unhandled", async () => {
    const { app, view } = createHarness();
    await view.render();
    await settle();
    const vault = app.vault as unknown as { cachedRead(file: TFile): Promise<string> };
    vault.cachedRead = async (file) => { throw new Error(`read denied: ${file.path}`); };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);

    try {
      reviewAll(view);
      await settle(64);

      expect(unhandled).toEqual([]);
      expect(text(view.contentEl as unknown as FakeElement)).toContain("No link changes were applied. 2 notes failed.");
      expect((view.contentEl as unknown as FakeElement).querySelector(".cc-inbox-review-all")).not.toBeNull();
      const details = (view.contentEl as unknown as FakeElement).querySelector(".cc-inbox-link-result-details");
      expect(details).not.toBeNull();
      const detailText = text(details!);
      expect(detailText).toContain("Clippings/alpha.md: Read failed: read denied: Clippings/alpha.md");
      expect(detailText).toContain("Clippings/beta.md: Read failed: read denied: Clippings/beta.md");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("catches a regression that removes individual-note review controls from the graph section", async () => {
    const { view } = createHarness();
    await view.render();
    await settle();

    const individual = (view.contentEl as unknown as FakeElement)
      .querySelectorAll(".cc-inbox-enrich")
      .find((button) => button.getAttribute("aria-label") === "Review link suggestions for alpha");
    expect(individual?.disabled).toBe(false);
    individual?.dispatchEvent({ type: "click" });
    await settle();

    expect(getLastOpenedModal()?.constructor.name).toBe("DiffModal");
    getLastOpenedModal()?.close();
  });

  it("catches a regression that renders once for every vault event through InboxView", async () => {
    vi.useFakeTimers();
    const { app, view } = createHarness();
    const vault = app.vault as unknown as {
      cachedRead(file: TFile): Promise<string>;
      trigger(name: string): void;
    };
    const read = vault.cachedRead.bind(vault);
    let reads = 0;
    vault.cachedRead = async (file) => {
      reads++;
      return read(file);
    };
    await view.onOpen();
    await settle();
    reads = 0;

    vault.trigger("create");
    vault.trigger("create");
    vault.trigger("create");
    vi.advanceTimersByTime(99);
    await settle();
    expect(reads).toBe(0);

    vi.advanceTimersByTime(1);
    await settle();
    expect(reads).toBe(2);
  });

  it("catches a regression that lets a closed InboxView process a queued vault refresh", async () => {
    vi.useFakeTimers();
    const { app, view } = createHarness();
    const vault = app.vault as unknown as { trigger(name: string): void };
    await view.onOpen();
    await settle();
    const before = text(view.contentEl as unknown as FakeElement);

    vault.trigger("create");
    await view.onClose();
    vi.runAllTimers();
    await settle();

    expect(text(view.contentEl as unknown as FakeElement)).toBe(before);
  });

  it("catches a regression that lets an older deferred cachedRead scan paint after a later render", async () => {
    const { app, view } = createHarness();
    const vault = app.vault as unknown as { cachedRead(file: TFile): Promise<string> };
    let release: ((content: string) => void) | undefined;
    const firstRead = new Promise<string>((resolve) => { release = resolve; });
    let reads = 0;
    vault.cachedRead = async () => reads++ === 0 ? firstRead : "No mentions remain.\n";

    await view.render();
    await view.render();
    release!("Project Atlas leads.\n");
    await settle();

    expect((view.contentEl as unknown as FakeElement).querySelector(".cc-inbox-wireup")).toBeNull();
    expect(reads).toBe(3);
  });
});
