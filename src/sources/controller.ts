import type { PluginSettings } from "../types";
import type { EnrichDeps } from "./enrich";
import { enrichCapture } from "./enrich";
import { shouldEnrich } from "./watcher";
import { parseClipUrl } from "./detect";
import { KeyedSerialQueue } from "./keyedSerialQueue";
import { errorHint, type ErrorHintProvider } from "../providers/errorHints";
import { UtilityUnavailableError } from "../providers/endpointPolicy";
import type { EnrichDiagnostics } from "./enrichDiagnostics";

export interface FileRef {
  path: string;
  basename: string;
  extension: string;
  stat: { size: number };
}

export type EnrichRunOutcome =
  | { status: "enriched" }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: Error };

interface ProviderSelection {
  provider: { id: ErrorHintProvider };
  endpoint?: string;
}

export function sourceActivityDetail(value: string): string {
  return value
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s?#]*@/gi, "$1")
    .replace(/\bBearer\s+\S+/gi, "[redacted]")
    .replace(/\b(?:api[_-]?key|token|password)\s*[=:]\s*\S+/gi, "[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

export interface SourceEnrichmentControllerDeps {
  settings: () => PluginSettings;
  saveSettings: () => Promise<void>;
  isMobile: boolean;
  mobileSourceNoteMaxBytes: number;

  enrichApp: EnrichDeps["app"];
  vault: {
    cachedRead: (path: string) => Promise<string>;
  };
  activity: () => {
    start(opts: Record<string, unknown>): string;
    finish(id: string, data: Record<string, unknown>): void;
    fail(id: string, data: Record<string, unknown>): void;
  };
  enrichDiagnostics: () => EnrichDiagnostics;
  router: () => {
    utilitySelection(): Promise<ProviderSelection>;
    completeResolved(
      selection: ProviderSelection,
      opts: Record<string, unknown>,
    ): Promise<{ text: string }>;
  };

  suspendReindex: () => () => void;
  isUtilityLifecycleActive: (generation: number) => boolean;
  assertUtilityLifecycleActive: (generation: number) => void;
  utilityLifecycleEnded: () => boolean;
  utilityLifecycleGeneration: () => number;

  notice: (msg: string, timeout?: number) => void;
  openChoiceModal: (opts: {
    title: string;
    message: string;
    buttons: Array<{ label: string; value: "allow" | "deny"; cta?: boolean }>;
    fallback: "allow" | "deny";
    onChoice: (choice: "allow" | "deny") => void;
  }) => { close(): void };
}

export class SourceEnrichmentController {
  private enrichTimers = new Map<string, number>();
  private enrichPending = new Map<string, FileRef>();
  private enrichQueueRunning = false;
  private _coordinator: KeyedSerialQueue<string, EnrichRunOutcome> | undefined;
  private enrichRecentlyWritten = new Set<string>();
  private enrichRecentlyWrittenExpiryTimers = new Map<string, number>();
  private sourceCaptureConsentModal: { close(): void } | null = null;
  private sourceCaptureConsentInFlight: Promise<boolean> | null = null;

  constructor(private readonly deps: SourceEnrichmentControllerDeps) {}

  resetLifecycle(): void {
    this._coordinator = new KeyedSerialQueue<string, EnrichRunOutcome>();
    this.sourceCaptureConsentModal = null;
    this.sourceCaptureConsentInFlight = null;
  }

  destroy(): void {
    this.sourceCaptureConsentModal?.close();
    this.sourceCaptureConsentModal = null;
    for (const timer of this.enrichTimers.values()) window.clearTimeout(timer);
    this.enrichTimers.clear();
    this.enrichPending.clear();
    this._coordinator = undefined;
    for (const timer of this.enrichRecentlyWrittenExpiryTimers.values()) window.clearTimeout(timer);
    this.enrichRecentlyWrittenExpiryTimers.clear();
    this.enrichRecentlyWritten.clear();
  }

  get recentlyWritten(): ReadonlySet<string> {
    return this.enrichRecentlyWritten;
  }

  queueEnrich(file: FileRef): void {
    if (this.deps.utilityLifecycleEnded()) return;
    const path = file.path;
    const prev = this.enrichTimers.get(path);
    if (prev) window.clearTimeout(prev);
    this.enrichTimers.set(
      path,
      window.setTimeout(() => {
        this.enrichTimers.delete(path);
        if (this.deps.utilityLifecycleEnded()) return;
        this.enrichPending.set(path, file);
        void this.drainEnrichQueue();
      }, 1500),
    );
  }

  private async drainEnrichQueue(): Promise<void> {
    if (this.enrichQueueRunning || this.deps.utilityLifecycleEnded()) return;
    this.enrichQueueRunning = true;
    const release = this.deps.suspendReindex();
    try {
      while (!this.deps.utilityLifecycleEnded()) {
        const next = this.enrichPending.entries().next().value;
        if (!next) break;
        const [path, file] = next;
        this.enrichPending.delete(path);
        try {
          await this.enrichFile(file);
        } catch (error) {
          if (!this.deps.isUtilityLifecycleActive(this.deps.utilityLifecycleGeneration())) continue;
          const detail = sourceActivityDetail(error instanceof Error ? error.message : String(error));
          console.warn("[companion] automatic source enrichment failed", error);
          const activityId = this.deps.activity().start({
            id: `source-enrichment:auto:${path}`,
            kind: "source-enrichment",
            title: `Enriching ${file.basename}`,
            total: 1,
          });
          this.deps.activity().fail(activityId, {
            completed: 1,
            failed: 1,
            technicalDetails: detail,
            details: [{ label: path, message: detail, state: "error" }],
            recovery: [
              { id: "review-inbox-failures", label: "Open Source Inbox", kind: "retry" },
              { id: "utility-settings", label: "Open utility settings", kind: "settings" },
            ],
          });
        }
      }
    } finally {
      release();
      this.enrichQueueRunning = false;
      if (!this.deps.utilityLifecycleEnded() && this.enrichPending.size > 0) void this.drainEnrichQueue();
    }
  }

  enrichFile(file: FileRef, notify = true): Promise<EnrichRunOutcome> {
    const lifecycleGeneration = this.deps.utilityLifecycleGeneration();
    const coordinator = this._coordinator ??= new KeyedSerialQueue<string, EnrichRunOutcome>();
    return coordinator.run(file.path, async () => {
      if (!this.deps.isUtilityLifecycleActive(lifecycleGeneration)) {
        return {
          status: "failed",
          error: new Error("Companion unloaded before source enrichment started; no content was sent."),
        };
      }
      return this.performEnrichFile(file, notify);
    });
  }

  private async performEnrichFile(file: FileRef, notify = true): Promise<EnrichRunOutcome> {
    const sizeFailure = this.mobileSourceSizeFailure(file);
    if (sizeFailure) return sizeFailure;
    const content = file.extension === "md" ? await this.deps.vault.cachedRead(file.path) : "";
    if (!shouldEnrich({ path: file.path, ext: file.extension, content, inboxFolder: this.deps.settings().sourceInboxFolder, recentlyWritten: this.enrichRecentlyWritten })) {
      return { status: "skipped", reason: `${file.basename} is not eligible for source enrichment.` };
    }
    if (this.deps.settings().sourceCaptureConsent === "deny") {
      return { status: "skipped", reason: "automatic source enrichment is set to manual only." };
    }
    if (this.deps.settings().sourceCaptureConsent !== "allow" && !(await this.askSourceCaptureConsent())) {
      return { status: "skipped", reason: "automatic source enrichment was not approved." };
    }
    return this.runEnrich(file, notify, file.extension === "md" ? content : undefined);
  }

  mobileSourceSizeFailure(file: FileRef): Extract<EnrichRunOutcome, { status: "failed" }> | null {
    if (!this.deps.isMobile || file.stat.size <= this.deps.mobileSourceNoteMaxBytes) return null;
    return {
      status: "failed",
      error: new Error(
        `${file.basename} exceeds the 5 MiB mobile enrichment limit. Reduce the clip before enriching it.`,
      ),
    };
  }

  private async askSourceCaptureConsent(): Promise<boolean> {
    if (this.deps.settings().sourceCaptureConsent === "allow") return true;
    if (this.deps.settings().sourceCaptureConsent === "deny" || this.deps.utilityLifecycleEnded()) return false;
    if (this.sourceCaptureConsentInFlight) return this.sourceCaptureConsentInFlight;
    const lifecycleGeneration = this.deps.utilityLifecycleGeneration();
    const consent = new Promise<boolean>((resolve, reject) => {
      const modal = this.deps.openChoiceModal({
        title: "Enrich clips automatically?",
        message:
          `Source capture can type each new file in ${this.deps.settings().sourceInboxFolder}/ into a schema-validated source note. ` +
          "This sends the file's content to your utility model (Claude, unless you enable the local model in settings).",
        buttons: [
          { label: "Enrich automatically", value: "allow", cta: true },
          { label: "Manual only", value: "deny" },
        ],
        fallback: "deny",
        onChoice: (c) => {
          this.sourceCaptureConsentModal = null;
          if (!this.deps.isUtilityLifecycleActive(lifecycleGeneration)) { resolve(false); return; }
          const previousConsent = this.deps.settings().sourceCaptureConsent;
          const previousAutoEnrich = this.deps.settings().sourceEnrichOnCreate;
          this.deps.settings().sourceCaptureConsent = c;
          if (c === "deny") this.deps.settings().sourceEnrichOnCreate = false;
          void this.deps.saveSettings().then(
            () => resolve(this.deps.isUtilityLifecycleActive(lifecycleGeneration) && c === "allow"),
            (error: unknown) => {
              this.deps.settings().sourceCaptureConsent = previousConsent;
              this.deps.settings().sourceEnrichOnCreate = previousAutoEnrich;
              reject(error instanceof Error ? error : new Error(String(error)));
            },
          );
        },
      });
      this.sourceCaptureConsentModal = modal;
    });
    this.sourceCaptureConsentInFlight = consent;
    void consent.then(
      () => { if (this.sourceCaptureConsentInFlight === consent) this.sourceCaptureConsentInFlight = null; },
      () => { if (this.sourceCaptureConsentInFlight === consent) this.sourceCaptureConsentInFlight = null; },
    );
    return consent;
  }

  async runEnrich(file: FileRef, notify = true, prefetchedContent?: string): Promise<EnrichRunOutcome> {
    const sizeFailure = this.mobileSourceSizeFailure(file);
    if (sizeFailure) return sizeFailure;
    let selection: ProviderSelection | undefined;
    const lifecycleGeneration = this.deps.utilityLifecycleGeneration();
    const activityId = notify
      ? this.deps.activity().start({
          id: `source-enrichment:${file.path}`,
          kind: "source-enrichment",
          title: `Enriching ${file.basename}`,
          total: 1,
        })
      : undefined;
    try {
      const raw = prefetchedContent ?? await this.deps.vault.cachedRead(file.path);
      this.deps.enrichDiagnostics().log("item-start", { path: file.path, bytes: raw.length });
      const capture =
        file.extension === "md"
          ? { kind: "markdown" as const, path: file.path, basename: file.basename, content: raw, url: parseClipUrl(raw) }
          : { kind: "datafile" as const, path: file.path, basename: file.basename, ext: file.extension, content: raw };
      selection = await this.deps.router().utilitySelection();
      const enrichDeps = this.buildEnrichDeps(selection, lifecycleGeneration);
      const res = await enrichCapture(enrichDeps, capture);
      this.deps.enrichDiagnostics().log("write-done", { path: res.file.path });
      this.deps.assertUtilityLifecycleActive(lifecycleGeneration);
      this.markEnrichRecentlyWritten(res.file.path, lifecycleGeneration);
      if (activityId) {
        this.deps.activity().finish(activityId, {
          completed: 1,
          total: 1,
          succeeded: 1,
          details: [{ label: res.file.path, message: `Typed as ${res.type}`, state: "success" }],
        });
      }
      return { status: "enriched" };
    } catch (e) {
      if (!this.deps.isUtilityLifecycleActive(lifecycleGeneration)) {
        return { status: "failed", error: e instanceof Error ? e : new Error(String(e)) };
      }
      if (!(e instanceof UtilityUnavailableError)) console.warn("[companion] source enrichment failed", e);
      const message = e instanceof Error ? e.message : String(e);
      const detail = e instanceof UtilityUnavailableError
        ? message
        : selection
          ? errorHint(message, selection.provider.id, selection.endpoint) ?? message
          : message;
      if (activityId) {
        const safeDetail = sourceActivityDetail(detail);
        this.deps.activity().fail(activityId, {
          completed: 1,
          total: 1,
          failed: 1,
          technicalDetails: safeDetail,
          details: [{ label: file.path, message: safeDetail, state: "error" }],
          recovery: [
            { id: "review-inbox-failures", label: "Open Source Inbox", kind: "retry" },
            { id: "utility-settings", label: "Open utility settings", kind: "settings" },
          ],
        });
      }
      return { status: "failed", error: e instanceof Error ? e : new Error(String(e)) };
    }
  }

  markEnrichRecentlyWritten(path: string, lifecycleGeneration = this.deps.utilityLifecycleGeneration()): void {
    if (!this.deps.isUtilityLifecycleActive(lifecycleGeneration)) return;
    this.enrichRecentlyWritten.add(path);
    const previous = this.enrichRecentlyWrittenExpiryTimers.get(path);
    if (previous !== undefined) window.clearTimeout(previous);
    const timer = window.setTimeout(() => {
      this.enrichRecentlyWrittenExpiryTimers.delete(path);
      this.enrichRecentlyWritten.delete(path);
    }, 5000);
    this.enrichRecentlyWrittenExpiryTimers.set(path, timer);
  }

  buildEnrichDeps(
    selection: ProviderSelection,
    lifecycleGeneration = this.deps.utilityLifecycleGeneration(),
  ): EnrichDeps {
    const router = this.deps.router();
    return {
      app: this.deps.enrichApp,
      complete: async (system, user, opts) => {
        this.deps.assertUtilityLifecycleActive(lifecycleGeneration);
        const text = (
          await router.completeResolved(selection, {
            system,
            user,
            ...(opts?.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
            ...(opts?.responseSchema ? { responseFormat: "json" as const, responseSchema: opts.responseSchema } : {}),
            ...(opts?.disableThinking ? { thinking: { type: "disabled" as const } } : {}),
          })
        ).text;
        this.deps.enrichDiagnostics().log("response-received", { chars: text.length });
        return text;
      },
      overrides: this.deps.settings().sourceSchemaOverrides,
      baseTags: this.deps.settings().sourceBaseTags,
      enrichedBy: selection.provider.id === "anthropic" ? "claude" : "local",
      now: () => new Date().toISOString(),
      assertActive: () => this.deps.assertUtilityLifecycleActive(lifecycleGeneration),
    };
  }
}
