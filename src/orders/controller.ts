// Runs standing orders: schedule ticks and new-note events feed one serial queue. All IO is injected.

import type { ActivityStore } from "../activity/store";
import { stripFrontmatter } from "../semantic/chunk";
import { enqueueEdit, type QueuedEdit } from "./editQueue";
import { matchingOrders, type NoteFacts } from "./match";
import type { StandingOrder } from "./order";
import { orderRunPath, renderOrderRun } from "./output";
import type { OrderRunResult, OrderTrigger } from "./runner";
import { dueOrders } from "./schedule";
import { armOrders, recordFired, recordRun, takeHourSlot, type OrdersState } from "./state";

export interface OrdersControllerDeps {
  enabled(): boolean;
  now(): Date;
  loadOrders(): Promise<{ orders: StandingOrder[]; invalid: Array<{ path: string; reason: string }> }>;
  /** [templatesFolder, ORDERS_OUTPUT_ROOT] */
  excludedRoots(): string[];
  /** null when the path is not a markdown file. */
  noteFacts(path: string): NoteFacts | null;
  readNote(path: string): Promise<string>;
  /** Creates folders and a unique path; returns the final path. */
  writeRunNote(path: string, content: string): Promise<string>;
  run(order: StandingOrder, trigger: OrderTrigger, now: Date): Promise<OrderRunResult>;
  getState(): OrdersState;
  setState(state: OrdersState): Promise<void>;
  getQueue(): QueuedEdit[];
  setQueue(queue: QueuedEdit[]): Promise<void>;
  activity: Pick<ActivityStore, "start" | "update" | "finish" | "fail">;
  /** Inbox badge and Inbox refresh. */
  onQueueChanged(): void;
}

export const ORDER_NOTE_SETTLE_MS = 60_000;
const MAX_RETRYABLE = 50;

type Source = { kind: "schedule" } | { kind: "note"; path: string };
/** `manual` jobs (run now, retry) skip the still-enabled re-check. */
interface Job { order: StandingOrder; source: Source; activityId?: string; manual?: boolean }

export class OrdersController {
  private orders: StandingOrder[] = [];
  private invalid: Array<{ path: string; reason: string }> = [];
  private chain: Promise<void> = Promise.resolve();
  private held: Array<{ orderId: string; path: string }> = [];
  private pending = new Map<string, number>();
  private failed = new Map<string, Job>();
  private lastStamp = 0;

  constructor(private readonly deps: OrdersControllerDeps) {}

  invalidOrders(): Array<{ path: string; reason: string }> { return this.invalid; }
  validOrders(): StandingOrder[] { return this.orders; }
  tagTriggers(): Array<{ path: string; tag: string }> {
    return this.orders.flatMap((order) => (order.onNote?.tag ? [{ path: order.path, tag: order.onNote.tag }] : []));
  }

  async refresh(): Promise<void> {
    const { orders, invalid } = await this.deps.loadOrders();
    this.orders = orders;
    this.invalid = invalid;
    const enabledIds = new Set(orders.filter((order) => order.enabled).map((order) => order.id));
    this.held = this.held.filter((item) => enabledIds.has(item.orderId));
    await this.deps.setState(armOrders(this.deps.getState(), orders, this.deps.now().getTime()));
  }

  async tick(): Promise<void> {
    if (!this.deps.enabled()) return;
    const now = this.deps.now();
    const settled = [...this.pending].filter(([, lastEventAt]) => now.getTime() - lastEventAt >= ORDER_NOTE_SETTLE_MS).map(([path]) => path);
    for (const path of settled) this.pending.delete(path);
    const bodies = new Map<string, string>();
    for (const path of settled) {
      try {
        const body = stripFrontmatter(await this.deps.readNote(path));
        if (body.trim()) bodies.set(path, body);
      } catch {
        // note vanished before it settled
      }
    }

    const jobs: Job[] = [];
    let state = this.deps.getState();
    for (const id of dueOrders(this.orders, state, now)) {
      const order = this.orders.find((o) => o.id === id);
      if (!order) continue;
      state = recordRun(state, id, now.getTime());
      jobs.push({ order, source: { kind: "schedule" } });
    }
    const stillHeld: typeof this.held = [];
    for (const item of this.held) {
      const order = this.orders.find((o) => o.id === item.orderId);
      if (!order || !order.enabled || !state[order.id]) continue;
      const taken = takeHourSlot(state, order.id, now.getTime());
      state = taken.state;
      if (taken.allowed) jobs.push({ order, source: { kind: "note", path: item.path } });
      else stillHeld.push(item);
    }
    this.held = stillHeld;
    for (const path of bodies.keys()) {
      const facts = this.deps.noteFacts(path);
      if (!facts) continue;
      for (const id of matchingOrders(this.orders, facts, state, this.deps.excludedRoots())) {
        const order = this.orders.find((o) => o.id === id);
        if (!order) continue;
        state = recordFired(state, id, path);
        const taken = takeHourSlot(state, id, now.getTime());
        state = taken.state;
        if (taken.allowed) jobs.push({ order, source: { kind: "note", path } });
        else this.held.push({ orderId: id, path });
      }
    }
    await this.deps.setState(state);
    await Promise.all(jobs.map((job) => this.enqueue(job)));
  }

  /** Records the change only; tick() fires the order once the note has been quiet for ORDER_NOTE_SETTLE_MS. */
  async noteEvent(path: string): Promise<void> {
    if (!this.deps.enabled()) return;
    const facts = this.deps.noteFacts(path);
    if (!facts) return;
    if (matchingOrders(this.orders, facts, this.deps.getState(), this.deps.excludedRoots()).length === 0) return;
    this.pending.set(path, this.deps.now().getTime());
  }

  async runNow(orderId: string): Promise<void> {
    const order = this.orders.find((o) => o.id === orderId);
    if (!order) throw new Error(`Standing order not found: ${orderId}`);
    await this.enqueue({ order, source: { kind: "schedule" }, manual: true });
  }

  async retry(activityId: string): Promise<void> {
    const job = this.failed.get(activityId);
    if (!job) throw new Error("That run can no longer be retried.");
    this.failed.delete(activityId);
    await this.enqueue({ ...job, manual: true });
  }

  private enqueue(job: Job): Promise<void> {
    const run = this.chain.then(() => this.execute(job));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async execute(job: Job): Promise<void> {
    const { source } = job;
    const live = this.orders.find((o) => o.id === job.order.id);
    if (!job.manual && !live?.enabled) return;
    const order = job.manual ? job.order : live ?? job.order;
    const now = this.deps.now();
    const activity = this.deps.activity;
    this.lastStamp = Math.max(now.getTime(), this.lastStamp + 1);
    const activityId = job.activityId ?? `order:${order.id}:${this.lastStamp}`;
    activity.start({ id: activityId, kind: "standing-order", title: order.name });
    if (source.kind === "note") activity.update(activityId, { currentItem: source.path });

    let result: OrderRunResult;
    let trigger: OrderTrigger = { kind: "schedule" };
    try {
      trigger = source.kind === "note" ? { kind: "note", path: source.path, content: await this.deps.readNote(source.path) } : trigger;
      result = await this.deps.run(order, trigger, now);
    } catch (error) {
      result = { text: "", proposals: [], error: error instanceof Error ? error : new Error(String(error)) };
    }

    let runPath = orderRunPath(order, now);
    try {
      runPath = await this.deps.writeRunNote(runPath, renderOrderRun(order, trigger, result));
    } catch (error) {
      result = { ...result, error: result.error ?? (error instanceof Error ? error : new Error(String(error))) };
    }

    if (result.proposals.length > 0) {
      let queue = this.deps.getQueue();
      result.proposals.forEach((proposal, index) => {
        queue = enqueueEdit(queue, {
          id: `${runPath}#${index}`,
          orderId: order.id,
          orderName: order.name,
          runPath,
          path: proposal.path,
          edits: proposal.edits,
          ...(proposal.description ? { description: proposal.description } : {}),
          createdAt: now.getTime(),
        });
      });
      await this.deps.setQueue(queue);
      this.deps.onQueueChanged();
    }

    if (result.error) {
      this.failed.set(activityId, { order, source, activityId });
      if (this.failed.size > MAX_RETRYABLE) this.failed.delete(this.failed.keys().next().value as string);
      activity.fail(activityId, {
        completed: 1,
        total: 1,
        failed: 1,
        details: [{ label: order.name, message: result.error.message, state: "error" }],
        recovery: [{ id: "retry", label: "Retry", kind: "retry" }, { id: "open", label: "Open order note", kind: "open" }],
      });
    } else {
      activity.finish(activityId, { completed: 1, total: 1, succeeded: 1 });
    }
  }
}
