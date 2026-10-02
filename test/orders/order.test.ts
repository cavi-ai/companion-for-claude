import { describe, expect, it } from "vitest";
import { ORDER_SCAFFOLD, parseOrder, parseSchedule } from "../../src/orders/order";
import type { PromptTemplate } from "../../src/templates/promptTemplates";

const PATH = "Claude/Templates/Follow ups.md";

function template(fm: Record<string, unknown>): PromptTemplate {
  return { name: "follow-ups", description: "d", prompt: "Do the thing {note}", path: PATH, ...(typeof fm.model === "string" ? { model: fm.model } : {}) };
}

describe("parseSchedule", () => {
  it("accepts daily and weekly slots, case-insensitively", () => {
    expect(parseSchedule("daily 08:00")).toEqual({ kind: "daily", hour: 8, minute: 0 });
    expect(parseSchedule("WEEKLY Mon 7:05")).toEqual({ kind: "weekly", day: "mon", hour: 7, minute: 5 });
  });

  it.each(["daily 25:00", "daily 08:60", "hourly", "weekly xyz 08:00", "daily"])("rejects %j", (raw) => {
    expect(parseSchedule(raw)).toEqual({ invalid: `Unrecognised schedule "${raw}" — use "daily 08:00" or "weekly mon 08:00".` });
  });

  it("rejects a non-string value", () => {
    expect(parseSchedule(8)).toEqual({ invalid: 'Unrecognised schedule "8" — use "daily 08:00" or "weekly mon 08:00".' });
  });
});

describe("parseOrder", () => {
  it("builds an order keyed by the template path", () => {
    const fm = { name: "Follow ups", schedule: "daily 08:00", enabled: true, model: "claude-sonnet-5-5" };
    expect(parseOrder(template(fm), fm)).toEqual({
      kind: "order",
      order: {
        id: PATH,
        name: "Follow ups",
        path: PATH,
        prompt: "Do the thing {note}",
        model: "claude-sonnet-5-5",
        enabled: true,
        schedule: { kind: "daily", hour: 8, minute: 0 },
      },
    });
  });

  it("normalizes the on_note folder and tag", () => {
    const fm = { on_note: { folder: "Meetings/", tag: "#Meeting" } };
    const parsed = parseOrder(template(fm), fm);
    expect(parsed.kind === "order" && parsed.order.onNote).toEqual({ folder: "Meetings", tag: "meeting" });
  });

  it("is a plain template without a trigger", () => {
    expect(parseOrder(template({ name: "x" }), { name: "x" })).toEqual({ kind: "template" });
  });

  it("is disabled unless enabled is the boolean true", () => {
    const missing = { schedule: "daily 08:00" };
    const stringy = { schedule: "daily 08:00", enabled: "true" };
    const a = parseOrder(template(missing), missing);
    const b = parseOrder(template(stringy), stringy);
    expect(a.kind === "order" && a.order.enabled).toBe(false);
    expect(b.kind === "order" && b.order.enabled).toBe(false);
  });

  it("reports an invalid schedule with the template path", () => {
    const fm = { schedule: "daily 25:00" };
    expect(parseOrder(template(fm), fm)).toEqual({
      kind: "invalid",
      path: PATH,
      reason: 'Unrecognised schedule "daily 25:00" — use "daily 08:00" or "weekly mon 08:00".',
    });
  });

  it.each([{ on_note: "Meetings" }, { on_note: {} }, { on_note: { folder: 3 } }, { on_note: { folder: "  " } }])("reports an invalid on_note %j", (fm) => {
    expect(parseOrder(template(fm), fm)).toMatchObject({ kind: "invalid", reason: "on_note needs a folder or a tag." });
  });

  it("falls back to the file basename for the name", () => {
    const fm = { schedule: "daily 08:00" };
    const parsed = parseOrder(template(fm), fm);
    expect(parsed.kind === "order" && parsed.order.name).toBe("Follow ups");
  });
});

describe("ORDER_SCAFFOLD", () => {
  it("is disabled, documents the placeholders and carries a valid schedule", () => {
    expect(ORDER_SCAFFOLD).toContain("enabled: false");
    expect(ORDER_SCAFFOLD).toContain("{note}");
    expect(ORDER_SCAFFOLD).toContain("{date}");
    expect(ORDER_SCAFFOLD).toContain("schedule: daily 08:00");
    expect(ORDER_SCAFFOLD).toContain("# on_note:");
  });
});
