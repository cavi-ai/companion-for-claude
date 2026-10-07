import type { ActivityKind, ActivityStore } from "./store";

/** Task progress lives in the shared activity drawer, never in a sticky toast. */
export function beginActivity(store: ActivityStore, title: string, kind: ActivityKind = "vault-task") {
  const id = store.start({ kind, title });
  let ended = false;
  return {
    id,
    setMessage(message: string, completed?: number, total?: number): void {
      if (!ended) store.update(id, { currentItem: message, ...(completed === undefined ? {} : { completed }), ...(total === undefined ? {} : { total }) });
    },
    finish(): void {
      if (ended) return;
      ended = true;
      store.finish(id);
    },
    fail(error: unknown): void {
      if (ended) return;
      ended = true;
      const message = error instanceof Error ? error.message : String(error);
      store.fail(id, { technicalDetails: message, details: [{ label: "Task stopped", message, state: "error" }] });
    },
  };
}
