import { describe, expect, it } from "vitest";
import { CITATION_RULE, gatherContext } from "../../src/context/vaultContext";
import { DEFAULT_SETTINGS } from "../../src/types";
import { linkingApp, setActive } from "./typedVault";

const NO_TOGGLES = { activeNote: false, selection: false, linkedNotes: false, searchVault: false };

describe("gatherContext — citation rule", () => {
  it("asks for section-level citations when only the active note is in context", async () => {
    const app = linkingApp();
    app.vault.seed("Notes/Alpha.md", "## Findings\nStarted in March.");
    setActive(app, "Notes/Alpha.md");
    const ctx = await gatherContext(app, DEFAULT_SETTINGS, { ...NO_TOGGLES, activeNote: true }, "when?");
    expect(ctx.text).toContain(CITATION_RULE);
    expect(CITATION_RULE).toContain("[[Note Name#Heading]]");
  });

  it("asks for citations after an attached note but not after web pages alone", async () => {
    const app = linkingApp();
    app.vault.seed("Notes/Alpha.md", "Alpha body.");
    const page = { url: "https://example.com/a", title: "A", markdown: "Page body." };
    const attached = await gatherContext(app, DEFAULT_SETTINGS, NO_TOGGLES, "q", undefined, [{ path: "Notes/Alpha.md", kind: "note" }]);
    const pages = await gatherContext(app, DEFAULT_SETTINGS, NO_TOGGLES, "q", undefined, [], [page as never]);
    expect(attached.text).toContain(CITATION_RULE);
    expect(pages.text).toContain("Page body.");
    expect(pages.text).not.toContain(CITATION_RULE);
  });

  it("drops the rule when the context budget has no room for it", async () => {
    const app = linkingApp();
    app.vault.seed("Notes/Alpha.md", "x".repeat(500));
    setActive(app, "Notes/Alpha.md");
    const ctx = await gatherContext(app, { ...DEFAULT_SETTINGS, contextCharBudget: 300 }, { ...NO_TOGGLES, activeNote: true }, "q");
    expect(ctx.text).not.toContain(CITATION_RULE);
  });
});
