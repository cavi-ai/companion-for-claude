// When a scheduled order is due. Slots are local wall-clock times; a long gap yields one catch-up run, never one per missed slot. Pure.

import type { OrderSchedule, StandingOrder, Weekday } from "./order";
import type { OrdersState } from "./state";

const WEEKDAY_INDEX: Record<Weekday, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/** Epoch ms of the most recent slot at or before `now`. */
export function lastSlot(schedule: OrderSchedule, now: Date): number {
  const back = schedule.kind === "weekly" ? (now.getDay() - WEEKDAY_INDEX[schedule.day] + 7) % 7 : 0;
  const slot = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, schedule.hour, schedule.minute);
  if (slot.getTime() <= now.getTime()) return slot.getTime();
  const step = schedule.kind === "weekly" ? 7 : 1;
  return new Date(slot.getFullYear(), slot.getMonth(), slot.getDate() - step, schedule.hour, schedule.minute).getTime();
}

export function dueOrders(orders: StandingOrder[], state: OrdersState, now: Date): string[] {
  return orders
    .filter((order) => {
      const entry = state[order.id];
      return order.enabled && order.schedule !== undefined && entry !== undefined && lastSlot(order.schedule, now) > entry.lastRunAt;
    })
    .map((order) => order.id);
}
