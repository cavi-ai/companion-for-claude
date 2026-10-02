// Per-order persisted bookkeeping: arming, run recency, fired-note memory and the hourly cap. Pure, never mutates.

import type { StandingOrder } from "./order";

export interface OrderState { enabledAt: number; lastRunAt: number; fired: string[]; hourStart: number; hourCount: number }
export type OrdersState = Record<string, OrderState>;

export const ORDER_FIRED_CAP = 500;
export const ORDER_NOTE_RUNS_PER_HOUR = 10;
const HOUR_MS = 3_600_000;

export function normalizeOrdersState(raw: unknown): OrdersState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: OrdersState = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    const numbers = [v.enabledAt, v.lastRunAt, v.hourStart, v.hourCount];
    if (!numbers.every((n) => typeof n === "number" && Number.isFinite(n))) continue;
    const fired = Array.isArray(v.fired) ? v.fired.filter((p): p is string => typeof p === "string").slice(-ORDER_FIRED_CAP) : [];
    out[id] = { enabledAt: v.enabledAt as number, lastRunAt: v.lastRunAt as number, fired, hourStart: v.hourStart as number, hourCount: v.hourCount as number };
  }
  return out;
}

export function armOrders(state: OrdersState, orders: StandingOrder[], now: number): OrdersState {
  const next: OrdersState = {};
  for (const order of orders) {
    if (!order.enabled) continue;
    next[order.id] = state[order.id] ?? { enabledAt: now, lastRunAt: now, fired: [], hourStart: 0, hourCount: 0 };
  }
  return next;
}

function update(state: OrdersState, id: string, change: (entry: OrderState) => OrderState): OrdersState {
  const entry = state[id];
  return entry ? { ...state, [id]: change(entry) } : state;
}

export function recordFired(state: OrdersState, id: string, path: string): OrdersState {
  return update(state, id, (entry) => (entry.fired.includes(path) ? entry : { ...entry, fired: [...entry.fired, path].slice(-ORDER_FIRED_CAP) }));
}

export function recordRun(state: OrdersState, id: string, at: number): OrdersState {
  return update(state, id, (entry) => ({ ...entry, lastRunAt: at }));
}

export function takeHourSlot(state: OrdersState, id: string, now: number): { state: OrdersState; allowed: boolean } {
  const entry = state[id];
  if (!entry) return { state, allowed: false };
  const hour = Math.floor(now / HOUR_MS);
  const count = entry.hourStart === hour ? entry.hourCount : 0;
  if (count >= ORDER_NOTE_RUNS_PER_HOUR) return { state: { ...state, [id]: { ...entry, hourStart: hour, hourCount: count } }, allowed: false };
  return { state: { ...state, [id]: { ...entry, hourStart: hour, hourCount: count + 1 } }, allowed: true };
}
