import { afterEach, describe, expect, it, vi } from "vitest";
import { createInboxRefreshController } from "../src/view/inboxRefresh";

afterEach(() => vi.useRealTimers());

describe("createInboxRefreshController", () => {
  it("catches a regression that renders once for every burst of vault events", () => {
    vi.useFakeTimers();
    let renders = 0;
    const refresh = createInboxRefreshController(
      () => { renders++; },
      { setTimeout, clearTimeout },
      100,
    );

    refresh.request();
    refresh.request();
    refresh.request();
    vi.advanceTimersByTime(99);
    expect(renders).toBe(0);

    vi.advanceTimersByTime(1);
    expect(renders).toBe(1);
  });

  it("catches a regression that lets a closed Inbox view run its queued render", () => {
    vi.useFakeTimers();
    let renders = 0;
    const refresh = createInboxRefreshController(
      () => { renders++; },
      { setTimeout, clearTimeout },
      100,
    );

    refresh.request();
    refresh.dispose();
    vi.runAllTimers();

    expect(renders).toBe(0);
  });

  it("catches a regression that lets an older async scan publish after a newer render", () => {
    const refresh = createInboxRefreshController(
      () => undefined,
      { setTimeout, clearTimeout },
      100,
    );
    let painted = "";
    const publish = (generation: number, value: string) => {
      if (refresh.isCurrent(generation)) painted = value;
    };

    const stale = refresh.nextGeneration();
    const current = refresh.nextGeneration();
    publish(stale, "stale scan");
    publish(current, "current scan");

    expect(painted).toBe("current scan");
  });
});
