import { App, clearNotices, FakeElement, getNoticeMessages, type TFile } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/types";
import { ChatSession } from "../../src/view/chat/chatSession";
import { Transcript, type TranscriptDeps } from "../../src/view/chat/Transcript";
import type { TranscriptHost } from "../../src/view/chat/hosts";

function harness() {
  const app = new App();
  const settings = { ...structuredClone(DEFAULT_SETTINGS), autoTagOnSave: false };
  const chat = new ChatSession({ writes: () => false, setWrites: () => undefined, save: async () => undefined, notify: () => undefined });
  const transcript = new Transcript(app, { settings } as TranscriptHost, chat, {
    renderMarkdownInto: async (el: HTMLElement, text: string) => { el.setText(text); },
  } as TranscriptDeps);
  const list = new FakeElement();
  transcript.messagesEl = list as unknown as HTMLElement;
  return { app, transcript, list };
}

describe("chat reply actions and provenance", () => {
  it("updates the user source label while a previous assistant answer remains visible", () => {
    const { transcript, list } = harness();
    transcript.renderStoredMessage({ role: "user", content: "Summarize", contextSources: ["active note: Original.md"] });
    transcript.renderStoredMessage({ role: "assistant", content: "The original answer" });
    transcript.annotateContext(["active note: Replacement.md"]);
    expect(list.querySelector(".cc-user")!.querySelectorAll(".cc-context-note").map((element) => element.textContent)).toEqual(["+ context: active note: Replacement.md"]);
    expect(list.querySelector(".cc-assistant")!.querySelectorAll(".cc-context-note")).toHaveLength(0);
    transcript.annotateContext([]);
    expect(list.querySelectorAll(".cc-context-note")).toHaveLength(0);
  });
  it.each([
    { name: "factual bullets", reply: "- The pilot involved four participants and had no control group.\n- Participants preferred a consolidated checklist.\n- Productivity and error reductions remain unproven.", plan: false },
    { name: "numbered findings", reply: "1. Four participants took part.\n2. There was no control group.", plan: false },
    { name: "ordinary checklist", reply: "## Reading checklist\n- [ ] Read the pilot report", plan: false },
    { name: "quoted plan example", reply: "```markdown\n## Build tasks\n- [ ] Create the parser\n```", plan: false },
    { name: "explicit plan", reply: "## Build tasks\n- [ ] Create the parser\n- [x] Write tests", plan: true },
    { name: "artifact plan", reply: "```claude-html\n<!DOCTYPE html><html><head><title>Parser plan</title></head><body>Plan</body></html>\n```\n\n## Build tasks\n- [ ] Create the parser", plan: true },
  ])("classifies $name for actions and saved-note metadata", async ({ reply, plan }) => {
    const { app, transcript, list } = harness();
    const opened: TFile[] = [];
    app.workspace.getLeaf = () => ({ openFile: async (file: TFile) => { opened.push(file); } }) as never;
    transcript.renderStoredMessage({ role: "assistant", content: reply });
    const buttons = list.querySelectorAll("button");
    const labels = buttons.map((button) => button.getAttribute("aria-label"));
    expect(labels.includes("Implement")).toBe(plan);
    expect(labels.includes("Build")).toBe(plan);
    buttons.find((button) => ["Save as note", "Save artifact"].includes(button.getAttribute("aria-label") ?? ""))!.dispatchEvent({ type: "click" });
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    const saved = await app.vault.read(opened[0]!);
    expect(opened[0]!.path.startsWith(plan ? "Claude/Plans/" : "Claude/Chats/")).toBe(true);
    expect(saved).toContain(plan ? 'type: "plan"' : 'type: "chat"');
    expect(saved).toContain(reply);
    if (!plan) expect(saved).not.toContain('type: "plan"');
  });

  it.each([undefined, "/summarize"])("replays recorded context for a user message with display %s", (display) => {
    const { transcript, list } = harness();
    transcript.renderStoredMessage({ role: "user", content: "Summarize", ...(display ? { display } : {}), contextSources: ["active note: Notes/Original.md"] });
    expect(list.querySelector(".cc-context-note")?.textContent).toContain("Notes/Original.md");
  });

  it("does not invent source context for legacy messages", () => {
    const { transcript, list } = harness();
    transcript.renderStoredMessage({ role: "user", content: "Old request" });
    expect(list.querySelector(".cc-context-note")?.textContent).toBe("Context details unavailable");
  });

  it("opens the actual saved plain reply, including a collision-adjusted filename", async () => {
    const { app, transcript, list } = harness();
    const opened: TFile[] = [];
    app.workspace.getLeaf = () => ({ openFile: async (file: TFile) => { opened.push(file); } }) as never;
    transcript.renderStoredMessage({ role: "assistant", content: "A useful summary" });
    const save = list.querySelectorAll("button").find((button) => button.getAttribute("aria-label") === "Save as note")!;
    save.dispatchEvent({ type: "click" });
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    save.dispatchEvent({ type: "click" });
    await vi.waitFor(() => expect(opened).toHaveLength(2));
    expect(opened[1]!.path).not.toBe(opened[0]!.path);
    expect(await app.vault.read(opened[1]!)).toContain("A useful summary");
  });

  it("reports a failed save without opening a note or leaving Save disabled", async () => {
    clearNotices();
    const { app, transcript, list } = harness();
    const opened: TFile[] = [];
    app.workspace.getLeaf = () => ({ openFile: async (file: TFile) => { opened.push(file); } }) as never;
    app.vault.create = async () => { throw new Error("Disk is full"); };
    transcript.renderStoredMessage({ role: "assistant", content: "A useful summary" });
    const save = list.querySelectorAll("button").find((button) => button.getAttribute("aria-label") === "Save as note")!;
    save.dispatchEvent({ type: "click" });
    await vi.waitFor(() => expect(getNoticeMessages().some((message) => message.includes("Disk is full"))).toBe(true));
    expect(opened).toEqual([]);
    expect(save.disabled).toBe(false);
  });
});
