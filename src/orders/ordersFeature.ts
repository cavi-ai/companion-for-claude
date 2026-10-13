// Standing orders and the edits they queue: controller wiring, persisted state,
// run and review entry points, and the vault watchers that arm them.

import { getAllTags, normalizePath, Notice, TFile, type App, type EventRef } from "obsidian";
import type { ActivityStore } from "../activity/store";
import { executeTool } from "../agent/tools";
import { toolAccess, type ToolRunKind } from "../agent/toolAccess";
import { providerTurnRunner, type AgentTurnRunner } from "../agent/loop";
import type { InteractiveToolDeps } from "../cli/bridgeTools";
import { stripFrontmatter } from "../markdown/frontmatter";
import type { VaultTools } from "../mcp/vaultTools";
import type { ProviderRouter } from "../providers/router";
import type { CompletionRequest } from "../providers/types";
import { parseTemplateNote } from "../templates/promptTemplates";
import type { PluginSettings } from "../types";
import { ensureVaultFolder, uniqueNotePath } from "../vault/vaultFiles";
import { InboxView, INBOX_VIEW_TYPE } from "../view/InboxView";
import { OrderPicker } from "../view/OrderPicker";
import { OrdersController } from "./controller";
import { normalizeEditQueue, type QueuedEdit } from "./editQueue";
import { ORDER_SCAFFOLD, parseOrder, type StandingOrder } from "./order";
import { ORDERS_OUTPUT_ROOT } from "./output";
import { discardQueuedEdit as discardQueuedOrderEdit, reviewQueuedEdit as reviewQueuedOrderEdit, type QueueReviewDeps } from "./queueReview";
import { runOrder, type OrderRunResult, type OrderTrigger } from "./runner";
import { normalizeOrdersState, type OrdersState } from "./state";

export interface OrdersFeatureDeps {
  app: App;
  settings: () => PluginSettings;
  activity: () => ActivityStore;
  persist: () => Promise<void>;
  router: () => ProviderRouter;
  composeSystemPrompt: (opts: { agent: boolean; plan: boolean }) => string;
  agentTools: () => VaultTools;
  cliTurnRunner: (opts: { conversationId: string; run: ToolRunKind; model: string; deps: InteractiveToolDeps; transcript: string }) => Promise<AgentTurnRunner>;
  closeCliSession: (conversationId: string) => Promise<void>;
  syncInboxBadge: () => void;
  registerEvent: (ref: EventRef) => void;
  registerInterval: (id: number) => number;
}

export class OrdersFeature {
  private ordersState: OrdersState = {};
  private orderEditQueue: QueuedEdit[] = [];
  private ordersRefreshTimer: number | null = null;
  private controller?: OrdersController;

  constructor(private deps: OrdersFeatureDeps) {}

  private get app(): App {
    return this.deps.app;
  }

  private get settings(): PluginSettings {
    return this.deps.settings();
  }

  /** Cancels a pending order refresh. */
  dispose(): void {
    if (this.ordersRefreshTimer !== null) window.clearTimeout(this.ordersRefreshTimer);
  }

  /** Loads the persisted order arming state and edit queue. */
  restore(standingOrders: unknown, orderEditQueue: unknown): void {
    this.ordersState = normalizeOrdersState(standingOrders);
    this.orderEditQueue = normalizeEditQueue(orderEditQueue);
  }

  /** The fields data.json stores for this module. */
  serializeState(): { standingOrders: OrdersState; orderEditQueue: QueuedEdit[] } {
    return { standingOrders: this.ordersState, orderEditQueue: this.orderEditQueue };
  }

  state(): OrdersState {
    return this.ordersState;
  }

  private templatesRoot(): string {
    return normalizePath(this.settings.templatesFolder).replace(/\/+$/, "");
  }

  standingOrders(): OrdersController {
    return (this.controller ??= new OrdersController({
      enabled: () => this.settings.standingOrdersEnabled,
      now: () => new Date(),
      loadOrders: () => this.loadStandingOrders(),
      excludedRoots: () => [this.templatesRoot(), ORDERS_OUTPUT_ROOT].filter(Boolean),
      noteFacts: (path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile) || file.extension !== "md") return null;
        const cache = this.app.metadataCache.getFileCache(file);
        const tags = (cache ? getAllTags(cache) ?? [] : []).map((tag) => tag.replace(/^#/, "").toLowerCase());
        return { path, ctime: file.stat.ctime, tags };
      },
      readNote: (path) => this.readVaultNote(path),
      writeRunNote: async (path, content) => {
        const slash = path.lastIndexOf("/");
        await ensureVaultFolder(this.app, path.slice(0, slash));
        const unique = await uniqueNotePath(this.app, path.slice(0, slash), path.slice(slash + 1).replace(/\.md$/, ""), "md");
        await this.app.vault.create(unique, content);
        return unique;
      },
      run: (order, trigger, now) => this.runStandingOrder(order, trigger, now),
      getState: () => this.ordersState,
      setState: async (next) => {
        if (JSON.stringify(next) === JSON.stringify(this.ordersState)) return;
        this.ordersState = next;
        await this.deps.persist();
      },
      getQueue: () => this.orderEditQueue,
      setQueue: async (next) => {
        this.orderEditQueue = next;
        await this.deps.persist();
      },
      activity: this.deps.activity(),
      onQueueChanged: () => this.onOrderQueueChanged(),
    }));
  }

  private async readVaultNote(path: string): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`Note not found: ${path}`);
    return this.app.vault.cachedRead(file);
  }

  private async loadStandingOrders(): Promise<{ orders: StandingOrder[]; invalid: Array<{ path: string; reason: string }> }> {
    const orders: StandingOrder[] = [];
    const invalid: Array<{ path: string; reason: string }> = [];
    const folder = this.templatesRoot();
    if (!folder) return { orders, invalid };
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!f.path.startsWith(`${folder}/`)) continue;
      try {
        const fm = (this.app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined) ?? {};
        const template = parseTemplateNote(f.path, f.basename, fm, stripFrontmatter(await this.app.vault.cachedRead(f)));
        if (!template) continue;
        const parsed = parseOrder(template, fm);
        if (parsed.kind === "order") orders.push(parsed.order);
        else if (parsed.kind === "invalid") invalid.push({ path: parsed.path, reason: parsed.reason });
      } catch (e) {
        console.debug("Claude Companion: skipping unreadable order", f.path, e);
      }
    }
    orders.sort((a, b) => a.name.localeCompare(b.name));
    return { orders, invalid };
  }

  /** Runs under the turn's propose-only access: reads plus propose_note_edit; writes are refused. */
  private async runStandingOrder(order: StandingOrder, trigger: OrderTrigger, now: Date): Promise<OrderRunResult> {
    const router = this.deps.router();
    const caps = router.chatCapabilities();
    const toolsSupported = await router.chatToolCapable();
    const { provider, model: providerModel } = router.chatProvider();
    return runOrder(order, trigger, now, {
      vaultTools: this.deps.agentTools().definitions(),
      toolsSupported,
      readNote: (path) => this.readVaultNote(path),
      runTurn: async (turn, proposeEdit) => {
        const model = caps.local ? providerModel : turn.model ?? providerModel;
        const request: CompletionRequest = {
          system: this.deps.composeSystemPrompt({ agent: true, plan: false }),
          messages: [{ role: "user", content: turn.prompt }],
          model,
          maxTokens: this.settings.maxTokens,
          ...(turn.tools.length > 0 ? { tools: turn.tools } : {}),
        };
        const handlers = { onText: () => undefined };
        if (!caps.cli) {
          return providerTurnRunner({
            stream: (req, h) => provider.stream(req, h),
            execute: (block, signal) => executeTool({ access: toolAccess(turn.run, this.deps.agentTools().definitions()), unavailable: (name) => this.deps.agentTools().unavailable(name), ...(signal ? { signal } : {}), call: (name, args) => this.deps.agentTools().call(name, args), proposeEdit }, block),
            maxIterations: this.settings.agentMaxIterations,
          }).run(request, handlers);
        }
        const conversationId = `order:${order.id}`;
        try {
          const runner = await this.deps.cliTurnRunner({ conversationId, run: turn.run, model, deps: { confirmWrite: async () => false, proposeEdit }, transcript: "" });
          return await runner.run(request, handlers);
        } finally {
          await this.deps.closeCliSession(conversationId);
        }
      },
    });
  }

  listQueuedEdits(): QueuedEdit[] {
    return this.orderEditQueue;
  }

  private queueReviewDeps(): QueueReviewDeps {
    return {
      app: this.app,
      getQueue: () => this.orderEditQueue,
      setQueue: async (next) => { this.orderEditQueue = next; await this.deps.persist(); },
      inlineEnabled: () => this.settings.inlineDiffEnabled,
      onChanged: () => this.onOrderQueueChanged(),
    };
  }

  reviewQueuedEdit(id: string): Promise<void> {
    return reviewQueuedOrderEdit(this.queueReviewDeps(), id);
  }

  discardQueuedEdit(id: string): Promise<void> {
    return discardQueuedOrderEdit(this.queueReviewDeps(), id);
  }

  private onOrderQueueChanged(): void {
    this.deps.syncInboxBadge();
    for (const leaf of this.app.workspace.getLeavesOfType(INBOX_VIEW_TYPE)) {
      if (leaf.view instanceof InboxView) void leaf.view.render();
    }
  }

  private scheduleOrdersRefresh(): void {
    if (this.ordersRefreshTimer !== null) window.clearTimeout(this.ordersRefreshTimer);
    this.ordersRefreshTimer = window.setTimeout(() => {
      this.ordersRefreshTimer = null;
      void this.standingOrders().refresh();
    }, 1000);
  }

  /** Registered after layout-ready so Obsidian's initial scan does not look like new notes. */
  start(): void {
    const controller = this.standingOrders();
    void controller.refresh().then(() => controller.tick()).catch((error: unknown) => console.error("[Claude Companion] standing orders failed to start", error));
    this.deps.registerInterval(window.setInterval(() => void controller.tick(), 60_000));
    this.deps.registerEvent(this.app.vault.on("create", (f) => { if (f instanceof TFile) void controller.noteEvent(f.path); }));
    const inTemplates = (path: string): boolean => path.startsWith(`${this.templatesRoot()}/`);
    this.deps.registerEvent(this.app.metadataCache.on("changed", (f) => {
      void controller.noteEvent(f.path);
      if (inTemplates(f.path)) this.scheduleOrdersRefresh();
    }));
    this.deps.registerEvent(this.app.vault.on("create", (f) => { if (inTemplates(f.path)) this.scheduleOrdersRefresh(); }));
    this.deps.registerEvent(this.app.vault.on("modify", (f) => { if (inTemplates(f.path)) this.scheduleOrdersRefresh(); }));
    this.deps.registerEvent(this.app.vault.on("delete", (f) => { if (inTemplates(f.path)) this.scheduleOrdersRefresh(); }));
    this.deps.registerEvent(this.app.vault.on("rename", (f, oldPath) => { if (inTemplates(f.path) || inTemplates(oldPath)) this.scheduleOrdersRefresh(); }));
  }

  async createStandingOrder(): Promise<void> {
    const folder = this.templatesRoot();
    await ensureVaultFolder(this.app, folder);
    const path = await uniqueNotePath(this.app, folder, "My standing order", "md");
    const file = await this.app.vault.create(path, ORDER_SCAFFOLD);
    await this.app.workspace.getLeaf(false).openFile(file);
    new Notice("Standing order created — edit the trigger and prompt, then set enabled: true.");
  }

  pickStandingOrder(): void {
    const orders = this.standingOrders().validOrders();
    if (orders.length === 0) {
      new Notice("No standing orders yet — run “New standing order” first.");
      return;
    }
    new OrderPicker(this.app, orders, (order) => {
      void this.standingOrders().runNow(order.id).catch((error: unknown) => new Notice(`Standing order failed: ${error instanceof Error ? error.message : String(error)}`));
    }).open();
  }
}
