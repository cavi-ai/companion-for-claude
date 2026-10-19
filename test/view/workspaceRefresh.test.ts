import { App, FakeElement } from "obsidian";
import { describe, expect, it } from "vitest";
import { Transcript, type TranscriptDeps } from "../../src/view/chat/Transcript";
import { ChatSession } from "../../src/view/chat/chatSession";
import type { TranscriptHost } from "../../src/view/chat/hosts";
import { resolveCompanionWorkspace, type CompanionWorkspaceCard } from "../../src/view/companionWorkspace";

describe("empty chat workspace refresh", () => {
  it("keeps the latest resolution and its action when navigation resolves out of order", async () => {
    const pending: Array<(card: CompanionWorkspaceCard | null) => void> = [];
    const plugin = { views: () => ({ companionWorkspaceContext: () => new Promise((resolve) => pending.push(resolve)) }) } as unknown as TranscriptHost;
    let attached = "";
    const deps = { prepareWorkspaceQuestion: (card: CompanionWorkspaceCard) => { attached = card.contextPath; } } as unknown as TranscriptDeps;
    const session = new ChatSession({ writes: () => false, setWrites: () => undefined, save: async () => undefined, notify: () => undefined });
    const transcript = new Transcript(new App(), plugin, session, deps);
    const mount = Object.assign(new FakeElement(), { isConnected: true });
    const render = (transcript as unknown as { renderContextualWorkspace(el: HTMLElement): Promise<void> }).renderContextualWorkspace.bind(transcript);
    const first = render(mount as unknown as HTMLElement);
    const second = render(mount as unknown as HTMLElement);
    pending[1]!(resolveCompanionWorkspace({ activeNote: { path: "B.md", title: "B" } }));
    await second;
    pending[0]!(resolveCompanionWorkspace({ activeNote: { path: "A.md", title: "A" } }));
    await first;
    expect(mount.querySelector("h3")?.textContent).toBe("Continue with B");
    mount.querySelector("button")!.dispatchEvent({ type: "click" });
    expect(attached).toBe("B.md");
  });
});
