import { App, FakeElement, getLastOpenedModal, getNoticeMessages, Modal } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityStore } from "../../src/activity/store";
import { NoteFlows } from "../../src/enrich/noteFlows";
import { ProviderRouter } from "../../src/providers/router";
import { UtilityUnavailableError } from "../../src/providers/endpointPolicy";
import { DEFAULT_SETTINGS } from "../../src/types";

afterEach(() => vi.restoreAllMocks());
const options = { rename: false, frontmatter: false, links: false, lint: true };
const response = JSON.stringify({ complete: true, edits: [{ old_str: "teh plants", new_str: "the plants" }] });
function rig() {
  const app = new App();
  const file = app.vault.seed("Garden.md", "# Garden\n\nWater teh plants in the morning.\n\nNever water at night.\n");
  const settings = { ...structuredClone(DEFAULT_SETTINGS), apiKey: "audit-placeholder" };
  const router = new ProviderRouter(settings);
  vi.spyOn(router.anthropic, "complete").mockResolvedValue(response);
  vi.spyOn(router.anthropic, "stream").mockImplementation(async (_request, handlers) => { handlers.onText(response); handlers.onDone(response); });
  const activity = new ActivityStore();
  const flows = new NoteFlows({ app, settings: () => settings, router: () => router, activity: () => activity, ontology: () => null });
  return { app, file, router, flows, activity };
}
async function review(): Promise<FakeElement> {
  await vi.waitFor(() => expect((getLastOpenedModal()?.contentEl as unknown as FakeElement)?.querySelectorAll("button").map((button) => button.textContent), getNoticeMessages().join(" | ")).toContain("Apply selected"));
  return getLastOpenedModal()!.contentEl as unknown as FakeElement;
}
function choose(root: FakeElement, text: string): void {
  root.querySelectorAll("button").find((button) => button.textContent === text)!.dispatchEvent({ type: "click" });
}

describe("Tidy request to reviewed write", () => {
  it("uses the real router, parser and review to apply only selected prose edits", async () => {
    const r = rig();
    const before = await r.app.vault.read(r.file);
    const running = r.flows.enrichNoteFlow(r.file, options);
    const modal = await review();
    expect(await r.app.vault.read(r.file)).toBe(before);
    choose(modal, "Apply selected");
    await running;
    expect(await r.app.vault.read(r.file)).toBe(before.replace("teh plants", "the plants"));
  });
  it("keeps supported lint available when the selected metadata provider is unavailable", async () => {
    const r = rig();
    vi.spyOn(r.router, "utilitySelection").mockRejectedValue(new UtilityUnavailableError("Utility unavailable", { state: "unavailable-without-Claude", backend: "claude", endpoint: "https://api.anthropic.com", reason: "claude-unavailable" }));
    const running = r.flows.enrichNoteFlow(r.file, { ...options, frontmatter: true });
    const modal = await review();
    expect(modal.querySelectorAll("div").map((element) => element.textContent).join(" ")).toContain("Utility unavailable");
    choose(modal, "Apply selected");
    await running;
    expect(await r.app.vault.read(r.file)).toContain("the plants");
  });
  it("rejects provider truncation even if the received buffer looks like valid edits", async () => {
    const r = rig();
    const before = await r.app.vault.read(r.file);
    vi.spyOn(r.router.anthropic, "stream").mockImplementation(async (_request, handlers) => {
      handlers.onText(response); handlers.onTruncated?.(); handlers.onDone(response);
    });
    const opened = vi.spyOn(Modal.prototype, "open");
    await r.flows.enrichNoteFlow(r.file, options);
    expect(opened).not.toHaveBeenCalled();
    expect(await r.app.vault.read(r.file)).toBe(before);
    expect(getNoticeMessages().join(" ")).toContain("cut short");
  });

  it("writes nothing when review is cancelled or the plugin unloads during the request", async () => {
    const r = rig();
    const before = await r.app.vault.read(r.file);
    const running = r.flows.enrichNoteFlow(r.file, options);
    choose(await review(), "Cancel");
    await running;
    expect(await r.app.vault.read(r.file)).toBe(before);
    let release!: () => void;
    vi.spyOn(r.router.anthropic, "complete").mockImplementation(() => new Promise<string>((resolve) => { release = () => resolve(response); }));
    vi.spyOn(r.router.anthropic, "stream").mockImplementation(async (_request, handlers) => {
      await new Promise<void>((resolve) => { release = resolve; });
      handlers.onText(response); handlers.onDone(response);
    });
    const opened = vi.spyOn(Modal.prototype, "open");
    const pending = r.flows.enrichNoteFlow(r.file, options);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    r.flows.dispose();
    release();
    await pending;
    expect(opened).not.toHaveBeenCalled();
    expect(await r.app.vault.read(r.file)).toBe(before);
  });
});
