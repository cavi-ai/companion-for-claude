import { describe, expect, it, vi } from "vitest";
import { ChatTurnLifecycle } from "../src/chat/turnLifecycle";

describe("ChatTurnLifecycle", () => {
  it("stops the exact registered turn once", () => {
    const lifecycle = new ChatTurnLifecycle();
    const stop = vi.fn();
    lifecycle.register("c1", "t1", stop);

    expect(lifecycle.stop("c1", "t1")).toBe(true);
    expect(lifecycle.stop("c1", "t1")).toBe(false);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("does not let stale cleanup remove a newer turn", () => {
    const lifecycle = new ChatTurnLifecycle();
    const oldStop = vi.fn();
    const newStop = vi.fn();
    const unregisterOld = lifecycle.register("c1", "old", oldStop);
    lifecycle.register("c1", "new", newStop);

    unregisterOld();

    expect(lifecycle.stop("c1", "new")).toBe(true);
    expect(newStop).toHaveBeenCalledOnce();
    expect(oldStop).not.toHaveBeenCalled();
  });

  it("refuses a stop for a stale turn id", () => {
    const lifecycle = new ChatTurnLifecycle();
    const stop = vi.fn();
    lifecycle.register("c1", "new", stop);

    expect(lifecycle.stop("c1", "old")).toBe(false);
    expect(stop).not.toHaveBeenCalled();
  });
});
