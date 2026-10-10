import { describe, expect, it, vi } from "vitest";
import { ChatModeState } from "../../src/view/chat/chatMode";

function state(writes = false, save: () => Promise<void> = async () => undefined) {
  const setting = { writes };
  const notices: string[] = [];
  const saves = vi.fn(save);
  const mode = new ChatModeState({ writes: () => setting.writes, setWrites: (on) => { setting.writes = on; }, save: saves, notify: (m) => notices.push(m) });
  const changes = vi.fn();
  mode.onChange(changes);
  return { mode, setting, notices, saves, changes };
}

describe("ChatModeState", () => {
  it("reads Ask or Act from the writes setting, and Plan from this chat", async () => {
    const s = state(true);
    expect(s.mode.mode).toBe("act");
    await s.mode.change("plan");
    expect(s.mode.mode).toBe("plan");
    expect(s.mode.writes).toBe(true);
  });

  it("saves the writes setting on Ask and Act, never on Plan, and announces each mode", async () => {
    const s = state(false);
    await s.mode.change("act");
    expect(s.setting.writes).toBe(true);
    await s.mode.change("plan");
    await s.mode.change("ask");
    expect(s.setting.writes).toBe(false);
    expect(s.saves).toHaveBeenCalledTimes(2);
    expect(s.notices).toEqual([
      "Act on vault: on — I'll create and edit notes (each change asks first).",
      "Plan Mode: on — I'll explore read-only and propose a plan, no writes.",
      "Act on vault: off — chat only, I won't change your vault.",
    ]);
  });

  it("restores the mode and the setting when the save fails", async () => {
    const s = state(false, async () => { throw new Error("disk full"); });
    await s.mode.change("act");
    expect(s.mode.mode).toBe("ask");
    expect(s.setting.writes).toBe(false);
    expect(s.notices.at(-1)).toBe("Couldn't save the mode: disk full");
    expect(s.changes).toHaveBeenCalledTimes(2);
  });

  it("toggles writes and Plan Mode the way the desktop menu offers them", async () => {
    const s = state(true);
    await s.mode.togglePlan();
    expect(s.mode.mode).toBe("plan");
    await s.mode.togglePlan();
    expect(s.mode.mode).toBe("act");
    await s.mode.toggleWrites();
    expect(s.mode.mode).toBe("ask");
    expect(s.saves).toHaveBeenCalledTimes(1);
  });

  it("gives the next turn no tools until the backend can run them, then reads or chat by mode", async () => {
    const s = state(true);
    expect(s.mode.run).toBe("off");
    s.mode.setCapable(true);
    expect(s.mode.capable).toBe(true);
    expect(s.mode.run).toBe("chat");
    await s.mode.change("plan");
    expect(s.mode.run).toBe("plan");
  });

  it("starts a fresh chat outside Plan Mode, telling listeners only when it was in Plan Mode", async () => {
    const s = state(false);
    s.mode.reset();
    expect(s.changes).not.toHaveBeenCalled();
    await s.mode.change("plan");
    s.mode.reset();
    expect(s.mode.mode).toBe("ask");
    expect(s.changes).toHaveBeenCalledTimes(2);
  });

  it("re-notifies on every capability refresh, so a writes setting changed elsewhere shows", () => {
    const s = state(false);
    s.mode.setCapable(true);
    s.setting.writes = true;
    s.mode.setCapable(true);
    expect(s.changes).toHaveBeenCalledTimes(2);
    expect(s.mode.mode).toBe("act");
  });
});
