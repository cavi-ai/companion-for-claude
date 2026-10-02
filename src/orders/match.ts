// Which armed orders a new note triggers. Pure.

import type { StandingOrder } from "./order";
import type { OrdersState } from "./state";

/** tags: lowercase, no '#'. */
export interface NoteFacts { path: string; ctime: number; tags: string[] }

const under = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);

export function matchingOrders(orders: StandingOrder[], note: NoteFacts, state: OrdersState, excludedRoots: string[]): string[] {
  if (excludedRoots.some((root) => under(note.path, root))) return [];
  return orders
    .filter((order) => {
      const entry = state[order.id];
      const trigger = order.onNote;
      if (!order.enabled || !trigger || !entry) return false;
      if (note.ctime <= entry.enabledAt || entry.fired.includes(note.path)) return false;
      if (trigger.folder && !note.path.startsWith(`${trigger.folder}/`)) return false;
      if (trigger.tag && !note.tags.includes(trigger.tag)) return false;
      return true;
    })
    .map((order) => order.id);
}
