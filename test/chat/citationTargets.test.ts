import { expect, it } from "vitest";
import { ActivityStore } from "../../src/activity/store";
import { ConversationsController } from "../../src/conversations/controller";
import { emptyState, fromPersisted } from "../../src/conversations/store";
import { DEFAULT_SETTINGS, type ChatMessage } from "../../src/types";
import { invalidateCitationTargets } from "../../src/chat/provenance";

it.each(["complete", "cap", "interrupt"] as const)("retains resolved citation targets across %s, moves, and persistence", async outcome => {
  let state = emptyState();
  const controller = new ConversationsController({
    state: { get: () => state, set: value => { state = value; } },
    persist: async () => undefined,
    settings: () => DEFAULT_SETTINGS,
    activity: () => new ActivityStore(),
    resolveCitation: link => link === "Alpha" ? "Notes/Alpha.md" : null,
  });
  const messages: ChatMessage[] = [{ role: "user", content: "When?" }, { role: "assistant", content: "In March [[Alpha#Findings]], unlike [[Ghost]]." }];
  const turn = await controller.beginTurn(null, messages.slice(0, 1), { backend: "claude", model: "m", mode: "ask" });
  if (outcome === "complete") await controller.completeTurn(turn.conversationId, turn.turnId, messages);
  if (outcome === "cap") await controller.capTurn(turn.conversationId, turn.turnId, messages);
  if (outcome === "interrupt") await controller.interruptTurn(turn.conversationId, turn.turnId, messages);
  expect(controller.list()[0]?.messages[1]?.citationTargets).toEqual([
    { linkpath: "Alpha", heading: "Findings", path: "Notes/Alpha.md" },
    { linkpath: "Ghost", heading: null, path: null },
  ]);
  await controller.startNew();
  await controller.renameAttachments("Notes/Alpha.md", "Notes/Migration.md");
  await controller.renameAttachments("Notes", "Archive");
  expect(state.activeId).toBeNull();
  const reopened = fromPersisted(JSON.parse(JSON.stringify(state)));
  expect(reopened.conversations[0]?.messages[1]?.citationTargets?.[0]?.path).toBe("Archive/Migration.md");
  expect(reopened.conversations[0]?.messages[1]?.content).toBe(messages[1]!.content);
  const nextMessages: ChatMessage[] = [...messages, { role: "user", content: "Explain more" }];
  const next = await controller.beginTurn(turn.conversationId, nextMessages, { backend: "claude", model: "m", mode: "ask" });
  await controller.completeTurn(next.conversationId, next.turnId, [...nextMessages, { role: "assistant", content: "More details" }]);
  expect(controller.list()[0]?.messages[1]?.citationTargets?.[0]?.path).toBe("Archive/Migration.md");
});

it("invalidates deleted files and folder descendants without matching sibling paths", () => {
  const targets = [
    { linkpath: "Alpha", heading: null, path: "Notes/Alpha.md" },
    { linkpath: "Beta", heading: null, path: "Notes/Sub/Beta.md" },
    { linkpath: "Other", heading: null, path: "Notes-extra/Other.md" },
  ];
  expect(invalidateCitationTargets(targets, "Notes/Alpha.md")?.map(target => target.path)).toEqual([null, "Notes/Sub/Beta.md", "Notes-extra/Other.md"]);
  expect(invalidateCitationTargets(targets, "Notes")?.map(target => target.path)).toEqual([null, null, "Notes-extra/Other.md"]);
  expect(targets[0]?.path).toBe("Notes/Alpha.md");
});

it("leaves unrelated, already unavailable, and legacy citations unchanged", () => {
  const targets = [{ linkpath: "Alpha", heading: null, path: null }];
  expect(invalidateCitationTargets(targets, "Notes")).toBe(targets);
  expect(invalidateCitationTargets(undefined, "Notes")).toBeUndefined();
});

it.each(["Notes/Alpha.md", "Notes"])("retains deleted sources across persistence and later turns for %s", async deletedPath => {
  let state = emptyState();
  let saves = 0;
  const controller = new ConversationsController({
    state: { get: () => state, set: value => { state = value; } },
    persist: async () => { saves++; }, settings: () => DEFAULT_SETTINGS, activity: () => new ActivityStore(),
    resolveCitation: () => "Notes/Alpha.md",
  });
  const messages: ChatMessage[] = [{ role: "user", content: "When?" }, { role: "assistant", content: "In March [[Alpha#Findings]]." }];
  const turn = await controller.beginTurn(null, messages.slice(0, 1), { backend: "claude", model: "m", mode: "ask" });
  await controller.completeTurn(turn.conversationId, turn.turnId, messages);
  const stale = structuredClone(controller.list()[0]!.messages);
  await controller.startNew();
  const before = saves;
  await controller.invalidateCitations(deletedPath);
  expect(saves).toBe(before + 1);
  await controller.invalidateCitations(deletedPath);
  expect(saves).toBe(before + 1);
  expect(state.activeId).toBeNull();
  state = fromPersisted(JSON.parse(JSON.stringify(state)));
  expect(controller.list()[0]?.messages[1]?.citationTargets?.[0]?.path).toBeNull();
  const nextMessages: ChatMessage[] = [...stale, { role: "user", content: "Read the new source" }];
  const next = await controller.beginTurn(turn.conversationId, nextMessages, { backend: "claude", model: "m", mode: "ask" });
  await controller.completeTurn(next.conversationId, next.turnId, [...nextMessages, { role: "assistant", content: "New findings [[Alpha]]." }]);
  expect(controller.list()[0]?.messages[1]?.citationTargets?.[0]?.path).toBeNull();
  expect(controller.list()[0]?.messages[1]?.content).toBe(messages[1]?.content);
  expect(controller.list()[0]?.messages[3]?.citationTargets?.[0]?.path).toBe("Notes/Alpha.md");
});
