import { App, clearNotices, getLastOpenedModal, getNoticeMessages, TFolder, type TFile } from "obsidian";
import { beforeEach, describe, expect, it } from "vitest";
import { ActivityStore } from "../../src/activity/store";
import { ClippingsController } from "../../src/sources/clippings";
import { DEFAULT_SETTINGS } from "../../src/types";

function controller(app: App, reply: unknown[], enrichAutoApply: boolean): ClippingsController {
  const settings = { ...structuredClone(DEFAULT_SETTINGS), enrichAutoApply, sourceInboxFolder: "Clippings", clipOrganizedFolder: "Library" };
  return new ClippingsController({
    app,
    settings: () => settings,
    activity: () => new ActivityStore(),
    enrichment: () => ({}) as never,
    router: () => ({ complete: async () => ({ text: JSON.stringify(reply) }) }) as never,
    diagnostics: () => ({ log: () => {} }) as never,
    providerErrorHint: () => null,
  });
}

const folderOf = (path: string, children: TFile[]): TFolder => Object.assign(new TFolder(path), { children });

beforeEach(() => clearNotices());

describe("organize auto-apply", () => {
  it("asks for review when auto-apply is off and moves without it when on, leaving misc moves unapplied", async () => {
    const app = new App();
    const garden = app.vault.seed("Notes/a.md", "Tomatoes and basil.");
    const stray = app.vault.seed("Notes/b.md", "Unsorted.");
    const reply = [{ path: "Notes/a.md", domain: "garden" }, { path: "Notes/b.md", domain: "misc" }];
    await controller(app, reply, false).organizeFolder(folderOf("Notes", [garden, stray]));
    const review = getLastOpenedModal();
    expect(review?.titleEl.textContent).toBe("Organize 2 clippings");
    review?.close();
    expect(garden.path).toBe("Notes/a.md");

    await controller(app, reply, true).organizeFolder(folderOf("Notes", [garden, stray]));
    expect(getLastOpenedModal()).toBe(review);
    expect(garden.path).toBe("Notes/garden/a.md");
    expect(stray.path).toBe("Notes/b.md");
    expect(getNoticeMessages()).toEqual(["Organized 1 note into Notes/ subfolders."]);
  });

  it("files enriched clippings without the review", async () => {
    const app = new App();
    const opened = getLastOpenedModal();
    const clip = app.vault.seed("Clippings/x.md", "---\nsource_enriched: true\n---\n\nBody.", { frontmatter: { source_enriched: true, title: "Garden tips", summary: "Tips." } });
    const organize = controller(app, [{ path: "Clippings/x.md", domain: "garden" }], true);
    await organize.organizeClippings();
    expect(getLastOpenedModal()).toBe(opened);
    expect(clip.path).toBe("Library/garden/Garden tips.md");
    expect(getNoticeMessages()).toEqual(["Organized 1 clipping into Library/."]);
  });
});
