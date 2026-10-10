// Ask / Plan / Act for one chat: the persisted writes setting, this chat's Plan Mode, whether the backend
// can run tools, and the tool access a turn gets. Pure; settings persistence and notices are injected.

import type { ToolRunKind } from "../../agent/toolAccess";

export type ChatMode = "ask" | "plan" | "act";

export interface ChatModeDeps {
  /** The persisted "act on vault" setting, shared by every chat. */
  writes(): boolean;
  setWrites(on: boolean): void;
  save(): Promise<void>;
  notify(message: string): void;
}

const NOTICES: Record<ChatMode, string> = {
  act: "Act on vault: on — I'll create and edit notes (each change asks first).",
  plan: "Plan Mode: on — I'll explore read-only and propose a plan, no writes.",
  ask: "Act on vault: off — chat only, I won't change your vault.",
};

export class ChatModeState {
  private plan = false;
  private toolCapable = false;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: ChatModeDeps) {}

  get mode(): ChatMode {
    return this.plan ? "plan" : this.deps.writes() ? "act" : "ask";
  }

  /** The persisted writes setting; Plan Mode leaves it as it was. */
  get writes(): boolean {
    return this.deps.writes();
  }

  /** Whether the chat backend can run vault tools; the mode switch only shows while it can. */
  get capable(): boolean {
    return this.toolCapable;
  }

  /** The tool access for this chat's next turn: none without tools, reads in Plan Mode, otherwise chat. */
  get run(): ToolRunKind {
    if (!this.toolCapable) return "off";
    return this.plan ? "plan" : "chat";
  }

  /** Called when a listener should re-read the mode; returns the unsubscribe. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Called per turn and on backend change; always re-notifies, since the writes setting may have changed elsewhere. */
  setCapable(capable: boolean): void {
    this.toolCapable = capable;
    this.emit();
  }

  /** A fresh chat starts outside Plan Mode. */
  reset(): void {
    if (!this.plan) return;
    this.plan = false;
    this.emit();
  }

  /** Switch modes: Ask and Act set the writes setting and save it, Plan keeps it; a failed save restores both. */
  async change(mode: ChatMode): Promise<void> {
    const previousWrites = this.deps.writes();
    const previousPlan = this.plan;
    const writes = mode === "plan" ? previousWrites : mode === "act";
    this.deps.setWrites(writes);
    this.plan = mode === "plan";
    this.emit();
    this.deps.notify(NOTICES[mode]);
    if (writes === previousWrites) return;
    try {
      await this.deps.save();
    } catch (error) {
      this.deps.setWrites(previousWrites);
      this.plan = previousPlan;
      this.emit();
      this.deps.notify(`Couldn't save the mode: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  toggleWrites(): Promise<void> {
    return this.change(this.writes ? "ask" : "act");
  }

  togglePlan(): Promise<void> {
    return this.change(this.plan ? (this.writes ? "act" : "ask") : "plan");
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
