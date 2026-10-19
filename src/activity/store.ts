export type ActivityState = "running" | "succeeded" | "needs-attention" | "paused" | "cancelled";

export type ActivityKind =
  | "chat-turn"
  | "source-enrichment"
  | "semantic-index"
  | "embedding-download"
  | "link-review"
  | "clipper-verification"
  | "standing-order"
  | "vault-task"
  | "cloud-task";

export interface ActivityRecoveryAction {
  id: string;
  label: string;
  kind: "retry" | "settings" | "download" | "degrade" | "copy-details" | "open" | "stop" | "resume";
}

export interface ActivityDetail {
  /** Stable item identity, independent of the shortened display label. */
  key?: string;
  label: string;
  message: string;
  state: "success" | "error";
}

export interface ActivityRecord {
  id: string;
  kind: ActivityKind;
  title: string;
  currentItem?: string;
  completed: number;
  total?: number;
  percent?: number;
  state: ActivityState;
  succeeded: number;
  failed: number;
  createdAt: number;
  updatedAt: number;
  details: ActivityDetail[];
  recovery: ActivityRecoveryAction[];
  technicalDetails?: string;
}

export interface ActivitySnapshot {
  records: ActivityRecord[];
  disposed: boolean;
}

export interface ActivityUpdate {
  title?: string;
  currentItem?: string;
  completed?: number;
  total?: number;
  state?: ActivityState;
  succeeded?: number;
  failed?: number;
  details?: ActivityDetail[];
  recovery?: ActivityRecoveryAction[];
  technicalDetails?: string;
}

interface ActivityStoreOptions {
  maxRecords?: number;
  maxDetails?: number;
  maxMessageLength?: number;
  successRetentionMs?: number;
  now?: () => number;
}

interface InternalRecord extends ActivityRecord {
  order: number;
  unresolvedFailures: Set<string>;
}

const positiveInteger = (value: number, fallback: number): number =>
  Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;

const count = (value: number | undefined, fallback = 0): number =>
  value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.floor(value));

export class ActivityStore {
  private readonly records = new Map<string, InternalRecord>();
  private readonly listeners = new Set<(snapshot: ActivitySnapshot) => void>();
  private readonly maxRecords: number;
  private readonly maxDetails: number;
  private readonly maxMessageLength: number;
  private readonly successRetentionMs: number;
  private readonly now: () => number;
  private readonly successTimers = new Map<string, number>();
  private nextId = 1;
  private order = 0;
  private disposed = false;

  constructor(options: ActivityStoreOptions = {}) {
    this.maxRecords = positiveInteger(options.maxRecords ?? 20, 20);
    this.maxDetails = positiveInteger(options.maxDetails ?? 20, 20);
    this.maxMessageLength = positiveInteger(options.maxMessageLength ?? 500, 500);
    this.successRetentionMs = positiveInteger(options.successRetentionMs ?? 4_000, 4_000);
    this.now = options.now ?? Date.now;
  }

  start(input: { id?: string; kind: ActivityKind; title: string; total?: number }): string {
    const id = input.id ?? `activity-${this.nextId++}`;
    if (this.disposed) return id;
    this.cancelSuccessCleanup(id);
    const timestamp = this.now();
    const total = input.total !== undefined && input.total > 0 ? count(input.total) : undefined;
    const record: InternalRecord = {
      id,
      kind: input.kind,
      title: this.text(input.title),
      completed: 0,
      ...(total === undefined ? {} : { total, percent: 0 }),
      state: "running",
      succeeded: 0,
      failed: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      details: [],
      recovery: [],
      order: ++this.order,
      unresolvedFailures: new Set(),
    };
    this.records.set(id, record);
    this.trimRecords();
    this.notify();
    return id;
  }

  update(id: string, update: ActivityUpdate): void {
    if (this.disposed) return;
    const current = this.records.get(id);
    if (!current) return;
    this.cancelSuccessCleanup(id);
    const total = update.total === undefined
      ? current.total
      : update.total > 0
        ? count(update.total)
        : undefined;
    const completed = count(update.completed, current.completed);
    for (const detail of update.details ?? []) {
      if (!detail.key) continue;
      if (detail.state === "error") current.unresolvedFailures.add(detail.key);
      else current.unresolvedFailures.delete(detail.key);
    }
    const details = update.details === undefined
      ? current.details
      : [...current.details, ...update.details.map((detail) => ({
          label: this.text(detail.label),
          ...(detail.key === undefined ? {} : { key: detail.key }),
          message: this.text(detail.message),
          state: detail.state,
        }))].slice(-this.maxDetails);
    const recovery = update.recovery === undefined
      ? current.recovery
      : update.recovery.map((action) => ({ ...action, label: this.text(action.label) }));
    const next: InternalRecord = {
      ...current,
      ...(update.title === undefined ? {} : { title: this.text(update.title) }),
      ...(update.currentItem === undefined ? {} : { currentItem: this.text(update.currentItem) }),
      completed,
      ...(total === undefined ? {} : { total }),
      state: update.state ?? current.state,
      succeeded: count(update.succeeded, current.succeeded),
      failed: count(update.failed, current.failed),
      details,
      recovery,
      ...(update.technicalDetails === undefined ? {} : { technicalDetails: this.text(update.technicalDetails) }),
      updatedAt: this.now(),
      order: ++this.order,
    };
    if (total === undefined) {
      delete next.total;
      delete next.percent;
    } else {
      next.percent = Math.max(0, Math.min(100, Math.round((completed / total) * 100)));
    }
    this.records.set(id, next);
    if (next.state === "succeeded") this.scheduleSuccessCleanup(next);
    this.notify();
  }

  finish(id: string, update: ActivityUpdate = {}): void {
    this.update(id, { ...update, state: "succeeded" });
  }

  fail(id: string, update: ActivityUpdate): void {
    this.update(id, { ...update, state: "needs-attention" });
  }

  /** Resolve one recorded failure without erasing other failures or unattempted work. */
  resolveFailure(id: string, key: string, message = "Resolved"): boolean {
    const current = this.records.get(id);
    if (!current || current.state !== "needs-attention" || current.failed === 0 || !current.unresolvedFailures.delete(key)) return false;
    const label = current.details.find((detail) => detail.key === key)?.label ?? key;
    current.details = current.details.filter((detail) => detail.key !== key);
    const failed = current.failed - 1;
    const finished = failed === 0 && (current.total === undefined || current.completed >= current.total);
    this.update(id, {
      failed,
      succeeded: current.succeeded + 1,
      currentItem: key,
      details: [{ key, label, message, state: "success" }],
      ...(finished ? {
        state: "succeeded",
        technicalDetails: "",
        recovery: current.recovery.filter((action) => action.kind === "copy-details" || action.kind === "open"),
      } : {}),
    });
    return true;
  }

  dismiss(id: string): void {
    if (this.disposed) return;
    this.cancelSuccessCleanup(id);
    if (!this.records.delete(id)) return;
    this.notify();
  }

  subscribe(listener: (snapshot: ActivitySnapshot) => void): () => void {
    if (this.disposed) {
      listener(this.snapshot());
      return () => undefined;
    }
    this.listeners.add(listener);
    listener(this.snapshot());
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
    };
  }

  snapshot(): ActivitySnapshot {
    if (this.disposed) return { records: [], disposed: true };
    const records = [...this.records.values()]
      .sort((left, right) => right.order - left.order)
      .map(({ order: _order, unresolvedFailures: _unresolvedFailures, details, recovery, ...record }) => ({
        ...record,
        details: details.map((detail) => ({ ...detail })),
        recovery: recovery.map((action) => ({ ...action })),
      }));
    return { records, disposed: false };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const timer of this.successTimers.values()) window.clearTimeout(timer);
    this.successTimers.clear();
    this.records.clear();
    this.listeners.clear();
  }

  private trimRecords(): void {
    if (this.records.size <= this.maxRecords) return;
    const oldest = [...this.records.values()].sort((left, right) => left.order - right.order);
    for (const record of oldest.slice(0, this.records.size - this.maxRecords)) {
      this.cancelSuccessCleanup(record.id);
      this.records.delete(record.id);
    }
  }

  private scheduleSuccessCleanup(record: InternalRecord): void {
    const expectedOrder = record.order;
    const timer = window.setTimeout(() => {
      if (this.successTimers.get(record.id) !== timer) return;
      this.successTimers.delete(record.id);
      const current = this.records.get(record.id);
      if (!current || current.order !== expectedOrder || current.state !== "succeeded") return;
      this.records.delete(record.id);
      this.notify();
    }, this.successRetentionMs);
    this.successTimers.set(record.id, timer);
  }

  private cancelSuccessCleanup(id: string): void {
    const timer = this.successTimers.get(id);
    if (timer === undefined) return;
    window.clearTimeout(timer);
    this.successTimers.delete(id);
  }

  private text(value: string): string {
    return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, this.maxMessageLength);
  }

  private notify(): void {
    const snapshot = this.snapshot();
    for (const listener of [...this.listeners]) listener(snapshot);
  }
}
