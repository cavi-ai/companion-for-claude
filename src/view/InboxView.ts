import { ItemView, WorkspaceLeaf, TFile, setIcon, Platform } from "obsidian";
import type ClaudeCompanionPlugin from "../main";
import { inboxItems, typedInboxItems, type InboxFileEntry, type InboxItem } from "../sources/inbox";
import { ExtractError } from "../sources/extract";
import { wireUpItems, type WireUpEntry } from "../links/wireUp";
import type { BatchLinkApplyResult } from "../links/batch";
import { createInboxRefreshController, type InboxRefreshController } from "./inboxRefresh";
import { renderCompanionChrome } from "./companionChrome";

export const INBOX_VIEW_TYPE = "claude-inbox-view";
const INBOX_REFRESH_DEBOUNCE_MS = 100;

type InboxFeedbackState = "idle" | "running" | "success" | "error";

interface InboxFeedback {
  state: InboxFeedbackState;
  message: string;
}

type InboxEnrichOutcome = Awaited<ReturnType<ClaudeCompanionPlugin["enrichInboxItem"]>>;

function safeActivityDetail(value: string): string {
  return value
    .replace(/\bBearer\s+\S+/gi, "[redacted]")
    .replace(/\b(?:api[_-]?key|token)\s*[=:]\s*\S+/gi, "[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

/**
 * Source-inbox triage: everything the clipper dropped that isn't typed yet,
 * with one-tap enrich — plus a "wire up" section for enriched notes that
 * still mention other notes unlinked, so ingestion ends wired into the graph.
 * Built touch-first — on a phone this is the home base.
 */
export class InboxView extends ItemView {
  private disposeChrome: ((remove?: boolean) => void) | null = null;
  private enriching = new Set<string>();
  private linking = new Set<string>();
  private readonly refresh: InboxRefreshController;
  /** A bulk enrichment or link review is active; do not start another batch. */
  private batchOperation: "enrich" | "link" | null = null;
  /** Last completed batch result, kept visible after its links leave the list. */
  private linkSummary: string | null = null;
  private linkResult: BatchLinkApplyResult | null = null;
  /** Per-file feedback persists for failures so users can retry the exact item. */
  private enrichmentFeedback = new Map<string, InboxFeedback>();
  /**
   * A large mobile note can take time to re-enter Obsidian's metadata cache
   * after its atomic rewrite. Keep successful paths typed in this view so a
   * stale cache cannot offer the same work again in the meantime.
   */
  private enrichedOptimistically = new Set<string>();
  /** One concise inline summary for the current or most recent Inbox operation. */
  private operationFeedback: InboxFeedback = { state: "idle", message: "Ready to enrich Inbox notes." };

  constructor(leaf: WorkspaceLeaf, private plugin: ClaudeCompanionPlugin) {
    super(leaf);
    this.refresh = createInboxRefreshController(
      () => void this.render(),
      {
        setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
        clearTimeout: (timer) => window.clearTimeout(timer),
      },
      INBOX_REFRESH_DEBOUNCE_MS,
    );
  }

  override getViewType(): string {
    return INBOX_VIEW_TYPE;
  }
  override getDisplayText(): string {
    return "Source inbox";
  }
  override getIcon(): string {
    return "inbox";
  }

  override async onOpen(): Promise<void> {
    this.registerEvent(this.app.vault.on("create", () => this.requestRefresh()));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      this.enrichedOptimistically.delete(file.path);
      this.requestRefresh();
    }));
    this.registerEvent(this.app.vault.on("rename", (_file, oldPath) => {
      this.enrichedOptimistically.delete(oldPath);
      this.requestRefresh();
    }));
    this.registerEvent(this.app.metadataCache.on("changed", () => this.requestRefresh()));
    await this.render();
  }

  override async onClose(): Promise<void> {
    this.disposeChrome?.(false);
    this.disposeChrome = null;
    this.refresh.dispose();
  }

  /** The batch's final render reconciles every event emitted while it runs. */
  private requestRefresh(): void {
    if (this.batchOperation !== null) return;
    this.refresh.request();
  }

  private entries(): InboxFileEntry[] {
    return this.app.vault.getFiles().map((f: TFile) => {
      const cached = this.app.metadataCache.getFileCache(f)?.frontmatter ?? undefined;
      if (cached?.source_enriched === true) this.enrichedOptimistically.delete(f.path);
      const frontmatter = this.enrichedOptimistically.has(f.path)
        ? { ...(cached ?? {}), source_enriched: true }
        : cached;
      return {
        path: f.path,
        basename: f.basename,
        ext: f.extension,
        frontmatter,
        mtime: f.stat?.mtime,
      };
    });
  }

  private pending(): InboxItem[] {
    return inboxItems(this.entries(), this.plugin.settings.sourceInboxFolder);
  }

  /** Auto-enrich types clips before they can be triaged; show them anyway. */
  private typed(): InboxItem[] {
    return typedInboxItems(this.entries(), this.plugin.settings.sourceInboxFolder);
  }

  async render(): Promise<void> {
    const generation = this.refresh.nextGeneration();
    if (!this.refresh.isCurrent(generation)) return;
    const root = this.contentEl;
    this.disposeChrome?.();
    this.disposeChrome = null;
    root.empty();
    root.addClass("cc-inbox-view");
    this.disposeChrome = renderCompanionChrome(root, "inbox", "Source Inbox", this.plugin.companionChrome());
    root.createDiv({ cls: "cc-eyebrow", text: "SOURCE INBOX" });

    if (!this.plugin.settings.sourceCaptureEnabled) {
      root.createEl("p", {
        cls: "setting-item-description",
        text: "Source capture is off. Turn it on in Companion settings → Source capture.",
      });
      return;
    }

    this.renderOperationFeedback(root);

    const items = this.pending();
    const typed = this.typed();
    if (items.length === 0) {
      root.createEl("p", {
        cls: "setting-item-description",
        text: typed.length > 0
          ? `Inbox zero — every clip in “${this.plugin.settings.sourceInboxFolder}” is typed already.`
          : `Inbox zero — nothing in “${this.plugin.settings.sourceInboxFolder}” needs typing. Clip something and it'll show up here.`,
      });
      const clipper = root.createEl("button", { cls: "cc-inbox-clipper-setup", text: "Set up Web Clipper" });
      clipper.addEventListener("click", () => this.plugin.openClipperSetup());
    } else {
      const bar = root.createDiv({ cls: "cc-inbox-bar" });
      bar.createSpan({
        cls: "cc-inbox-count",
        text: `${items.length} to type`,
        attr: { role: "status", "aria-live": "polite" },
      });
      bar.createSpan({ cls: "cc-inbox-backend", text: `Utility: ${this.plugin.sourceEnrichmentBackendLabel()}` });
      const all = bar.createEl("button", { cls: "cc-inbox-enrich-all", text: "Enrich all" });
      all.disabled = this.batchOperation !== null;
      all.addEventListener("click", () => void this.enrichAll(items));

      const list = root.createDiv({ cls: "cc-inbox-list" });
      for (const item of items) {
        const row = list.createDiv({ cls: "cc-inbox-row" });
        const open = row.createEl("button", { cls: "cc-inbox-open" });
        open.createSpan({ cls: "cc-inbox-name", text: item.basename });
        open.createSpan({ cls: `cc-inbox-type cc-inbox-type-${item.type}`, text: item.type });
        open.addEventListener("click", () => {
          const f = this.app.vault.getAbstractFileByPath(item.path);
          if (f instanceof TFile) void this.app.workspace.getLeaf(false).openFile(f);
        });

        const btn = row.createEl("button", {
          cls: "cc-inbox-enrich",
          attr: { "aria-label": `Enrich ${item.basename}` },
        });
        setIcon(btn, this.enriching.has(item.path) ? "loader" : "wand-sparkles");
        btn.disabled = this.enriching.has(item.path) || this.batchOperation !== null;
        btn.addEventListener("click", () => void this.enrichOne(item));
        this.renderFileFeedback(row, item.path);
      }
    }

    this.renderTyped(root, typed);

    // Wire-up section: enriched notes that mention other notes without linking
    // them. Async (mention scan reads bodies) — guarded against stale renders.
    void this.renderWireUp(root, generation);
  }

  /** Typed clips, newest first: without this the Inbox looks empty after every capture. */
  private renderTyped(root: HTMLElement, typed: InboxItem[]): void {
    if (typed.length === 0) return;
    const section = root.createDiv({ cls: "cc-inbox-typed" });
    const header = section.createDiv({ cls: "cc-inbox-typed-header" });
    header.createDiv({ cls: "cc-eyebrow", text: "TYPED" });
    header.createSpan({
      cls: "cc-inbox-typed-count",
      text: `${typed.length} typed`,
      attr: { role: "status", "aria-live": "polite" },
    });
    const list = section.createDiv({ cls: "cc-inbox-list" });
    for (const item of typed) {
      const row = list.createDiv({ cls: "cc-inbox-row" });
      const open = row.createEl("button", { cls: "cc-inbox-open" });
      open.createSpan({ cls: "cc-inbox-name", text: item.basename });
      open.createSpan({ cls: `cc-inbox-type cc-inbox-type-${item.type}`, text: item.type });
      open.addEventListener("click", () => {
        const f = this.app.vault.getAbstractFileByPath(item.path);
        if (f instanceof TFile) void this.app.workspace.getLeaf(false).openFile(f);
      });
    }
  }

  private enrichedInboxFiles(): TFile[] {
    const inbox = this.plugin.settings.sourceInboxFolder.replace(/\/+$/, "");
    if (!inbox) return [];
    const files: TFile[] = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (f.path === inbox || !f.path.startsWith(`${inbox}/`)) continue;
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      if (fm?.source_enriched !== true) continue;
      files.push(f);
    }
    return files;
  }

  private renderOperationFeedback(root: HTMLElement): void {
    root.createEl("p", {
      cls: `cc-inbox-operation-status cc-inbox-operation-${this.operationFeedback.state}`,
      text: this.operationFeedback.message,
      attr: { role: "status", "aria-live": "polite" },
    });
  }

  private renderFileFeedback(row: HTMLElement, path: string): void {
    const feedback = this.enrichmentFeedback.get(path) ?? { state: "idle" as const, message: "Ready" };
    row.createSpan({
      cls: `cc-inbox-enrichment-status cc-inbox-enrichment-${feedback.state}`,
      text: feedback.message,
      attr: { role: "status", "aria-live": "polite" },
    });
  }

  private setOperationFeedback(state: InboxFeedbackState, message: string): void {
    this.operationFeedback = { state, message };
  }

  /** Rendering must not strand an Inbox operation if the view is closing or repainting fails. */
  private async renderSafely(): Promise<void> {
    try {
      await this.render();
    } catch {
      // A transient render failure can leave stale disabled controls in place.
      // Retry once after operation state has changed, but never turn a click
      // handler into an unhandled rejection while this view is closing.
      try {
        await this.render();
      } catch {
        // A disposed view needs no further repaint; the operation's finally
        // path has still released its in-memory state for a future view.
      }
    }
  }

  private async renderWireUp(root: HTMLElement, generation: number): Promise<void> {
    const inbox = this.plugin.settings.sourceInboxFolder.replace(/\/+$/, "");
    if (!inbox) return;
    const files = this.enrichedInboxFiles();
    const entries: WireUpEntry[] = [];
    for (const f of files) {
      if (!this.refresh.isCurrent(generation)) return;
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      try {
        const content = await this.app.vault.cachedRead(f);
        if (!this.refresh.isCurrent(generation)) return;
        entries.push({
          path: f.path,
          basename: f.basename,
          ext: f.extension,
          frontmatter: fm,
          content,
        });
      } catch {
        if (!this.refresh.isCurrent(generation)) return;
        // A file can vanish or become unreadable while scanning; any stored
        // batch result keeps its actionable error details visible below.
      }
    }
    const items = wireUpItems(entries, this.plugin.linkCandidates(), inbox);
    if ((items.length === 0 && !this.linkSummary) || !this.refresh.isCurrent(generation)) return;

    const section = root.createDiv({ cls: "cc-inbox-wireup" });
    const header = section.createDiv({ cls: "cc-inbox-wireup-header" });
    header.createDiv({ cls: "cc-eyebrow", text: "WIRE INTO THE GRAPH" });
    if (items.length > 0 || this.linkSummary) {
      const mentions = items.reduce((total, item) => total + item.mentionCount, 0);
      header.createSpan({
        cls: "cc-inbox-wireup-count",
        text: `${items.length} note${items.length === 1 ? "" : "s"} · ${mentions} mention${mentions === 1 ? "" : "s"}`,
        attr: { role: "status", "aria-live": "polite" },
      });
      const reviewAll = header.createEl("button", { cls: "cc-inbox-review-all", text: "Review all links" });
      reviewAll.disabled = this.batchOperation !== null;
      reviewAll.addEventListener("click", () => void this.reviewAllLinks());
    }
    if (this.linkSummary) {
      section.createEl("p", {
        cls: "cc-inbox-link-summary",
        text: this.linkSummary,
        attr: { role: "status", "aria-live": "polite" },
      });
    }
    this.renderLinkResultDetails(section);
    if (items.length === 0) return;

    const list = section.createDiv({ cls: "cc-inbox-list" });
    for (const item of items) {
      const row = list.createDiv({ cls: "cc-inbox-row" });
      const open = row.createEl("button", { cls: "cc-inbox-open" });
      open.createSpan({ cls: "cc-inbox-name", text: item.basename });
      open.createSpan({ cls: "cc-inbox-mentions", text: `${item.mentionCount} mention${item.mentionCount === 1 ? "" : "s"}` });
      open.addEventListener("click", () => {
        const f = this.app.vault.getAbstractFileByPath(item.path);
        if (f instanceof TFile) void this.app.workspace.getLeaf(false).openFile(f);
      });

      const btn = row.createEl("button", {
        cls: "cc-inbox-enrich",
        attr: { "aria-label": `Review link suggestions for ${item.basename}` },
      });
      setIcon(btn, this.linking.has(item.path) ? "loader" : "link");
      btn.disabled = this.batchOperation !== null || this.linking.has(item.path);
      btn.addEventListener("click", () => void this.reviewOneLinks(item.path, item.basename));
    }
  }

  private async reviewOneLinks(path: string, basename: string): Promise<void> {
    if (this.batchOperation !== null || this.linking.has(path)) return;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    this.linking.add(path);
    this.setOperationFeedback("running", `Reviewing links for ${basename}…`);
    try {
      await this.renderSafely();
      await this.plugin.reviewLinkSuggestions(file);
      this.setOperationFeedback("success", `Reviewed links for ${basename}.`);
    } catch (error) {
      const detail = safeActivityDetail(error instanceof Error ? error.message : String(error));
      this.setOperationFeedback("error", `Couldn't review links for ${basename} — ${detail}`);
    } finally {
      this.linking.delete(path);
      await this.renderSafely();
    }
  }

  private async enrichOne(item: InboxItem, fromBatch = false): Promise<InboxEnrichOutcome> {
    if ((!fromBatch && this.batchOperation !== null) || this.enriching.has(item.path)) {
      return { status: "skipped", reason: `${item.basename} is already being enriched.` };
    }
    const f = this.app.vault.getAbstractFileByPath(item.path);
    if (!(f instanceof TFile)) return { status: "skipped", reason: `${item.basename} is no longer in the Inbox.` };
    this.enriching.add(item.path);
    this.enrichmentFeedback.set(item.path, { state: "running", message: "Enriching…" });
    if (!fromBatch) this.setOperationFeedback("running", `Enriching ${item.basename}…`);
    try {
      if (!fromBatch) await this.renderSafely();
      const outcome = await this.plugin.enrichInboxItem(f, { inline: true, refreshInboxViews: !fromBatch });
      if (outcome.status === "enriched") {
        this.enrichedOptimistically.add(item.path);
        this.enrichmentFeedback.delete(item.path);
        if (!fromBatch) this.setOperationFeedback("success", `Typed source note: ${item.basename}.`);
        return outcome;
      }
      const detail = outcome.status === "failed" ? outcome.error.message : outcome.reason;
      this.enrichmentFeedback.set(item.path, { state: "error", message: `Couldn't enrich — ${detail}` });
      if (!fromBatch) this.setOperationFeedback("error", `Couldn't enrich ${item.basename} — ${detail}`);
      return outcome;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.enrichmentFeedback.set(item.path, { state: "error", message: `Couldn't enrich — ${detail}` });
      if (!fromBatch) this.setOperationFeedback("error", `Couldn't enrich ${item.basename} — ${detail}`);
      return { status: "failed", error: error instanceof Error ? error : new Error(detail) };
    } finally {
      this.enriching.delete(item.path);
      if (!fromBatch) await this.renderSafely();
    }
  }

  private async enrichAll(items: InboxItem[]): Promise<void> {
    if (this.batchOperation !== null) return;
    this.batchOperation = "enrich";
    this.setOperationFeedback("running", `Enriching ${items.length} note${items.length === 1 ? "" : "s"}…`);
    const activityId = this.plugin.activity.start({
      id: "source-enrichment:inbox-batch",
      kind: "source-enrichment",
      title: "Enriching Inbox",
      total: items.length,
    });
    let enriched = 0;
    let failed = 0;
    let completed = 0;
    let notAttempted = 0;
    try {
      await this.renderSafely();
      for (const item of items) {
        this.plugin.activity.update(activityId, { currentItem: item.path });
        const outcome = await this.enrichOne(item, true);
        completed++;
        if (outcome.status === "enriched") {
          enriched++;
          this.plugin.activity.update(activityId, {
            completed,
            succeeded: enriched,
            failed,
            details: [{ label: item.path, message: "Enriched", state: "success" }],
          });
        } else {
          failed++;
          const detail = safeActivityDetail(outcome.status === "failed" ? outcome.error.message : outcome.reason);
          this.plugin.activity.update(activityId, {
            completed,
            succeeded: enriched,
            failed,
            details: [{ label: item.path, message: detail, state: "error" }],
          });
        }
        if (Platform.isMobile && outcome.status === "failed" && outcome.error instanceof ExtractError) {
          notAttempted = items.length - completed;
          break;
        }
      }
      this.setOperationFeedback(
        failed === 0 ? "success" : "error",
        notAttempted > 0
          ? `Inbox enrichment stopped after invalid model output; ${notAttempted} note${notAttempted === 1 ? " was" : "s were"} not attempted.`
          : failed === 0
          ? `Typed ${enriched} source note${enriched === 1 ? "" : "s"}.`
          : `Typed ${enriched} of ${items.length} source notes; ${failed} failed.`,
      );
      if (failed === 0) {
        this.plugin.activity.finish(activityId, { completed, succeeded: enriched, failed });
      } else {
        this.plugin.activity.fail(activityId, {
          completed,
          succeeded: enriched,
          failed,
          ...(notAttempted > 0 ? { technicalDetails: `${notAttempted} note${notAttempted === 1 ? " was" : "s were"} not attempted after repeated invalid model output.` } : {}),
          recovery: [
            { id: "review-inbox-failures", label: "Review failed notes", kind: "retry" },
            { id: "utility-settings", label: "Open utility settings", kind: "settings" },
          ],
        });
      }
    } catch (error) {
      const detail = safeActivityDetail(error instanceof Error ? error.message : String(error));
      this.plugin.activity.fail(activityId, {
        completed,
        succeeded: enriched,
        failed: Math.max(failed, 1),
        technicalDetails: detail,
        recovery: [{ id: "review-inbox-failures", label: "Review failed notes", kind: "retry" }],
      });
      this.setOperationFeedback("error", `Inbox enrichment stopped — ${detail}`);
    } finally {
      this.batchOperation = null;
      await this.renderSafely();
    }
  }

  private async reviewAllLinks(): Promise<void> {
    if (this.batchOperation !== null) return;
    this.batchOperation = "link";
    this.linkSummary = null;
    this.linkResult = null;
    this.setOperationFeedback("running", "Reviewing Inbox link suggestions…");
    try {
      await this.renderSafely();
      const result = await this.plugin.reviewInboxLinkSuggestions(this.enrichedInboxFiles());
      if (result) {
        this.linkSummary = this.describeLinkResult(result);
        this.linkResult = result;
        this.setOperationFeedback(result.conflicts.length > 0 || result.failures.length > 0 ? "error" : "success", this.linkSummary);
      } else {
        this.setOperationFeedback("success", "No Inbox link changes were applied.");
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.linkSummary = `Couldn't review links — ${detail}`;
      this.setOperationFeedback("error", this.linkSummary);
    } finally {
      this.batchOperation = null;
      await this.renderSafely();
    }
  }

  private describeLinkResult(result: BatchLinkApplyResult): string {
    const summary = result.appliedHunks > 0
      ? `Linked ${result.appliedHunks} mention${result.appliedHunks === 1 ? "" : "s"} in ${result.appliedFiles} note${result.appliedFiles === 1 ? "" : "s"}.`
      : "No link changes were applied.";
    const conflicts = result.conflicts.length > 0
      ? ` ${result.conflicts.length} note${result.conflicts.length === 1 ? " changed" : "s changed"} during review.`
      : "";
    const failures = result.failures.length > 0
      ? ` ${result.failures.length} note${result.failures.length === 1 ? " failed" : "s failed"}.`
      : "";
    return summary + conflicts + failures;
  }

  private renderLinkResultDetails(section: HTMLElement): void {
    if (!this.linkResult || (this.linkResult.conflicts.length === 0 && this.linkResult.failures.length === 0)) return;
    const details = section.createDiv({ cls: "cc-inbox-link-result-details" });
    if (this.linkResult.conflicts.length > 0) {
      details.createDiv({ cls: "cc-inbox-link-result-label", text: "Changed during review" });
      const list = details.createEl("ul", { cls: "cc-inbox-link-result-list" });
      for (const path of this.linkResult.conflicts) list.createEl("li", { text: path });
    }
    if (this.linkResult.failures.length > 0) {
      details.createDiv({ cls: "cc-inbox-link-result-label", text: "Could not complete" });
      const list = details.createEl("ul", { cls: "cc-inbox-link-result-list" });
      for (const failure of this.linkResult.failures) list.createEl("li", { text: `${failure.path}: ${failure.message}` });
    }
  }
}
