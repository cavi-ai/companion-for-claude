import { App } from "obsidian";
import { describe, it, expect } from "vitest";
import ClaudeCompanionPlugin from "../src/main";
import { parseTemplateNote, slugifyTemplateName, substitutePlaceholders } from "../src/templates/promptTemplates";
import { DEFAULT_SETTINGS } from "../src/types";

describe("slugifyTemplateName", () => {
  it("lowercases, dashes, and strips punctuation", () => {
    expect(slugifyTemplateName("Standup Summary")).toBe("standup-summary");
    expect(slugifyTemplateName("  Q3 Review!! ")).toBe("q3-review");
    expect(slugifyTemplateName("don't panic")).toBe("dont-panic");
    expect(slugifyTemplateName("already-good")).toBe("already-good");
  });

  it("can produce an empty slug for punctuation-only names", () => {
    expect(slugifyTemplateName("!!!")).toBe("");
  });
});

describe("parseTemplateNote", () => {
  it("parses a full note: name, description, model, context", () => {
    const t = parseTemplateNote(
      "Claude/Templates/Standup.md",
      "Standup",
      { name: "Standup Summary", description: "Draft a standup update", model: "claude-opus-4-1", context: { searchVault: true, activeNote: false } },
      "Summarize {active_note} as a standup update.",
    );
    expect(t).toEqual({
      name: "standup-summary",
      description: "Draft a standup update",
      prompt: "Summarize {active_note} as a standup update.",
      model: "claude-opus-4-1",
      context: { searchVault: true, activeNote: false },
      path: "Claude/Templates/Standup.md",
    });
  });

  it("falls back to the file basename and first body line", () => {
    const t = parseTemplateNote("Claude/Templates/Weekly Review.md", "Weekly Review", {}, "Look back at the week.\n\nDetails here.");
    expect(t?.name).toBe("weekly-review");
    expect(t?.description).toBe("Look back at the week.");
    expect(t?.model).toBeUndefined();
    expect(t?.context).toBeUndefined();
  });

  it("ignores unknown context keys and non-boolean values", () => {
    const t = parseTemplateNote("p", "x", { context: { searchVault: "yes", linkedNotes: true, bogus: true } }, "body");
    expect(t?.context).toEqual({ linkedNotes: true });
  });

  it("omits context when the override block is empty", () => {
    const t = parseTemplateNote("p", "x", { context: { bogus: true } }, "body");
    expect(t?.context).toBeUndefined();
  });

  it("rejects notes with an empty body", () => {
    expect(parseTemplateNote("p", "x", { name: "x" }, "   \n ")).toBeNull();
  });

  it("rejects names that slugify to nothing", () => {
    expect(parseTemplateNote("p", "!!!", {}, "body")).toBeNull();
  });
});

describe("substitutePlaceholders", () => {
  it("substitutes selection and active_note", () => {
    expect(substitutePlaceholders("Sel: {selection}\nNote: {active_note}", { selection: "  picked ", activeNote: "whole note" })).toBe(
      "Sel: picked\nNote: whole note",
    );
  });

  it("resolves missing values to empty strings", () => {
    expect(substitutePlaceholders("[{selection}][{active_note}]", {})).toBe("[][]");
  });

  it("leaves unknown placeholders literal", () => {
    expect(substitutePlaceholders('keep {"json": true} and {other}', { selection: "s" })).toBe('keep {"json": true} and {other}');
  });

  it("substitutes repeated occurrences", () => {
    expect(substitutePlaceholders("{selection} vs {selection}", { selection: "x" })).toBe("x vs x");
  });
});

describe("prompt template vault loading", () => {
  it("keeps readable templates available when one sibling cannot be read", async () => {
    const app = new App();
    const broken = app.vault.seed("Claude/Templates/Broken.md", "unreadable");
    app.vault.seed("Claude/Templates/Weekly.md", "Summarize the week.", {
      frontmatter: { name: "Weekly review" },
    });
    const read = app.vault.cachedRead.bind(app.vault);
    app.vault.cachedRead = async (file) => {
      if (file.path === broken.path) throw new Error("permission denied");
      return read(file);
    };
    const plugin = Object.create(ClaudeCompanionPlugin.prototype) as ClaudeCompanionPlugin;
    Object.assign(plugin as unknown as Record<string, unknown>, {
      app,
      settings: { ...structuredClone(DEFAULT_SETTINGS), templatesFolder: "Claude/Templates" },
    });

    await expect(plugin.promptTemplates()).resolves.toEqual([
      expect.objectContaining({ name: "weekly-review", prompt: "Summarize the week." }),
    ]);
  });
});
