import { App, TFile, clearNotices, getNoticeMessages } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityStore } from "../../src/activity/store";
import type { StandingOrder } from "../../src/orders/order";
import { OrdersFeature, type OrdersFeatureDeps } from "../../src/orders/ordersFeature";
import { DEFAULT_SETTINGS } from "../../src/types";

const pickers = vi.hoisted(() => [] as Array<{ orders: StandingOrder[]; onPick: (order: StandingOrder) => void }>);
vi.mock("../../src/view/OrderPicker", () => ({
  OrderPicker: class {
    constructor(_app: unknown, orders: StandingOrder[], onPick: (order: StandingOrder) => void) { pickers.push({ orders, onPick }); }
    open(): void {}
  },
}));

const ORDER_PATH = "Claude/Templates/Follow ups.md";
const ORDER_FM = { name: "Follow ups", description: "Mark shipped items", on_note: { folder: "Meetings" }, enabled: true };
const QUEUED = { id: "r#0", orderId: ORDER_PATH, orderName: "Follow ups", runPath: "r", path: "a.md", edits: [{ old_str: "a", new_str: "b" }], createdAt: 5 };

interface Rig {
  app: App;
  feature: OrdersFeature;
  deps: OrdersFeatureDeps;
  refs: unknown[];
  intervals: number[];
  persist: ReturnType<typeof vi.fn>;
  syncInboxBadge: ReturnType<typeof vi.fn>;
  cliTurnRunner: ReturnType<typeof vi.fn>;
  closeCliSession: ReturnType<typeof vi.fn>;
}

function rig(over: { cli?: boolean; runnerError?: Error } = {}): Rig {
  const app = new App();
  app.vault.seed(ORDER_PATH, "---\nname: Follow ups\n---\nReview {note}", { frontmatter: ORDER_FM });
  app.vault.seed("Notes/Other.md", "plain");
  const refs: unknown[] = [];
  const intervals: number[] = [];
  const persist = vi.fn(async () => undefined);
  const syncInboxBadge = vi.fn();
  const runner = { run: vi.fn(async () => { if (over.runnerError) throw over.runnerError; return { text: "done", trace: [] }; }) };
  const cliTurnRunner = vi.fn(async () => runner);
  const closeCliSession = vi.fn(async () => undefined);
  const deps: OrdersFeatureDeps = {
    app,
    settings: () => DEFAULT_SETTINGS,
    activity: () => new ActivityStore(),
    persist,
    router: () => ({
      chatCapabilities: () => ({ cli: over.cli ?? false, local: false }),
      chatToolCapable: async () => true,
      chatProvider: () => ({ provider: {}, model: "model-x" }),
    }) as never,
    composeSystemPrompt: () => "system",
    agentTools: () => ({ definitions: () => [] }) as never,
    cliTurnRunner: cliTurnRunner as never,
    closeCliSession,
    syncInboxBadge,
    registerEvent: (ref) => { refs.push(ref); },
    registerInterval: (id) => { intervals.push(id); return id; },
  };
  return { app, feature: new OrdersFeature(deps), deps, refs, intervals, persist, syncInboxBadge, cliTurnRunner, closeCliSession };
}

beforeEach(() => { clearNotices(); pickers.length = 0; });
afterEach(() => { vi.useRealTimers(); });

describe("OrdersFeature state", () => {
  it("restores persisted order state and the edit queue, and serializes them back", () => {
    const { feature } = rig();
    const state = { [ORDER_PATH]: { enabledAt: 1, lastRunAt: 2, fired: ["a.md"], hourStart: 3, hourCount: 4 } };
    feature.restore(state, [QUEUED]);
    expect(feature.state()).toEqual(state);
    expect(feature.listQueuedEdits()).toEqual([QUEUED]);
    expect(feature.serializeState()).toEqual({ standingOrders: state, orderEditQueue: [QUEUED] });
  });

  it("falls back to empty state and queue for malformed data", () => {
    const { feature } = rig();
    feature.restore("junk", { not: "a list" });
    expect(feature.state()).toEqual({});
    expect(feature.listQueuedEdits()).toEqual([]);
  });

  it("returns the same controller on every call", () => {
    const { feature } = rig();
    expect(feature.standingOrders()).toBe(feature.standingOrders());
  });
});

describe("OrdersFeature orders", () => {
  it("loads orders only from the templates folder and persists newly armed state once", async () => {
    const { feature, persist } = rig();
    const controller = feature.standingOrders();
    await controller.refresh();
    expect(controller.validOrders().map((o) => o.name)).toEqual(["Follow ups"]);
    expect(Object.keys(feature.state())).toEqual([ORDER_PATH]);
    expect(persist).toHaveBeenCalledTimes(1);
    await controller.refresh();
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("creates a scaffold order note in the templates folder", async () => {
    const { app, feature } = rig();
    await feature.createStandingOrder();
    expect(app.vault.getAbstractFileByPath("Claude/Templates/My standing order.md")).toBeInstanceOf(TFile);
    expect(getNoticeMessages()).toEqual(["Standing order created — edit the trigger and prompt, then set enabled: true."]);
  });

  it("tells the user when there is no order to run", () => {
    const { feature } = rig();
    feature.pickStandingOrder();
    expect(getNoticeMessages()).toEqual(["No standing orders yet — run “New standing order” first."]);
  });

  it("runs the picked order and reports a failed run", async () => {
    const { feature } = rig();
    const controller = feature.standingOrders();
    await controller.refresh();
    feature.pickStandingOrder();
    expect(getNoticeMessages()).toEqual([]);
    expect(pickers).toHaveLength(1);
    expect(pickers[0]!.orders.map((o) => o.id)).toEqual([ORDER_PATH]);
    const runNow = vi.spyOn(controller, "runNow").mockRejectedValue(new Error("no model"));
    pickers[0]!.onPick(pickers[0]!.orders[0]!);
    await vi.waitFor(() => expect(getNoticeMessages()).toEqual(["Standing order failed: no model"]));
    expect(runNow).toHaveBeenCalledWith(ORDER_PATH);
  });
});

describe("OrdersFeature queue", () => {
  it("discarding a queued edit persists the queue and refreshes the inbox badge", async () => {
    const { feature, persist, syncInboxBadge } = rig();
    feature.restore({}, [QUEUED]);
    await feature.discardQueuedEdit("r#0");
    expect(feature.listQueuedEdits()).toEqual([]);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(syncInboxBadge).toHaveBeenCalledTimes(1);
  });
});

describe("OrdersFeature start", () => {
  it("registers the minute tick and the vault and metadata watchers", () => {
    const { feature, refs, intervals } = rig();
    feature.start();
    expect(intervals).toHaveLength(1);
    expect(refs).toHaveLength(6);
  });

  it("forwards created notes and metadata changes to the standing orders", () => {
    const { app, feature } = rig();
    const noteEvent = vi.spyOn(feature.standingOrders(), "noteEvent").mockResolvedValue(undefined);
    feature.start();
    const file = app.vault.getAbstractFileByPath("Notes/Other.md");
    const fire = (source: unknown, name: string, ...args: unknown[]): void => (source as { trigger(n: string, ...a: unknown[]): void }).trigger(name, ...args);
    fire(app.vault, "create", file);
    expect(noteEvent).toHaveBeenCalledTimes(1);
    expect(noteEvent).toHaveBeenLastCalledWith("Notes/Other.md");
    fire(app.metadataCache, "changed", file);
    expect(noteEvent).toHaveBeenCalledTimes(2);
    expect(noteEvent).toHaveBeenLastCalledWith("Notes/Other.md");
  });

  it("refreshes once, a second after the last change in the templates folder", async () => {
    vi.useFakeTimers();
    const { app, feature } = rig();
    const controller = feature.standingOrders();
    const refresh = vi.spyOn(controller, "refresh");
    feature.start();
    await vi.advanceTimersByTimeAsync(0);
    refresh.mockClear();
    const template = app.vault.getAbstractFileByPath(ORDER_PATH);
    (app.vault as unknown as { trigger(name: string, ...args: unknown[]): void }).trigger("modify", template);
    await vi.advanceTimersByTimeAsync(500);
    (app.vault as unknown as { trigger(name: string, ...args: unknown[]): void }).trigger("modify", template);
    await vi.advanceTimersByTimeAsync(999);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("ignores changes outside the templates folder", async () => {
    vi.useFakeTimers();
    const { app, feature } = rig();
    const refresh = vi.spyOn(feature.standingOrders(), "refresh");
    feature.start();
    await vi.advanceTimersByTimeAsync(0);
    refresh.mockClear();
    (app.vault as unknown as { trigger(name: string, ...args: unknown[]): void }).trigger("modify", app.vault.getAbstractFileByPath("Notes/Other.md"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("dispose cancels a pending refresh", async () => {
    vi.useFakeTimers();
    const { app, feature } = rig();
    const refresh = vi.spyOn(feature.standingOrders(), "refresh");
    feature.start();
    await vi.advanceTimersByTimeAsync(0);
    refresh.mockClear();
    (app.vault as unknown as { trigger(name: string, ...args: unknown[]): void }).trigger("modify", app.vault.getAbstractFileByPath(ORDER_PATH));
    feature.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("OrdersFeature runs", () => {
  it("runs a CLI turn under propose-only access and always closes its session", async () => {
    const { feature, cliTurnRunner, closeCliSession } = rig({ cli: true, runnerError: new Error("boom") });
    const controller = feature.standingOrders();
    await controller.refresh();
    await controller.runNow(ORDER_PATH);
    expect(cliTurnRunner).toHaveBeenCalledTimes(1);
    expect(cliTurnRunner.mock.calls[0]![0]).toMatchObject({ conversationId: `order:${ORDER_PATH}`, run: "propose", model: "model-x", transcript: "" });
    expect(closeCliSession).toHaveBeenCalledWith(`order:${ORDER_PATH}`);
  });
});
