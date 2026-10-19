import { App } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveArtifactNote, saveChatNote, savePlanNote } from "../../src/artifacts/artifactStore";

const originalTimezone = process.env.TZ;
afterEach(() => {
  vi.useRealTimers();
  if (originalTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimezone;
});

describe.each([
  ["America/New_York", "2026-10-16T00:14:29Z", "2026-10-15"],
  ["Pacific/Auckland", "2026-10-16T12:14:29Z", "2026-10-17"],
  ["America/New_York", "2027-01-01T01:00:00Z", "2026-12-31"],
  ["Pacific/Auckland", "2026-12-31T12:00:00Z", "2027-01-01"],
  ["America/New_York", "2026-03-01T01:00:00Z", "2026-02-28"],
  ["America/New_York", "2026-03-08T06:59:00Z", "2026-03-08"],
  ["America/New_York", "2026-03-08T07:01:00Z", "2026-03-08"],
  ["UTC", "2026-10-16T12:00:00Z", "2026-10-16"],
])("saved dates in %s at %s", (timezone, instant, expected) => {
  it.each(["chat", "plan", "artifact"] as const)("dates a new %s by the local calendar", async (kind) => {
    process.env.TZ = timezone;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(instant));
    const app = new App();
    const file = kind === "chat" ? await saveChatNote(app, "Saved", "Pilot", "Reply")
      : kind === "plan" ? await savePlanNote(app, "Saved", "Pilot", "## Build tasks\n- [ ] Read")
        : await saveArtifactNote(app, "Saved", { title: "Pilot", html: "<html>Pilot</html>" }, { height: 400, baseTags: [] });
    expect(file.path).toBe(`Saved/${expected} — Pilot.md`);
    expect(await app.vault.cachedRead(file)).toContain(`created: "${expected}"`);
  });
});
