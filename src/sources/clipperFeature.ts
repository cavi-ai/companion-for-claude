// Web Clipper setup: template export, the setup modal, and verification of
// arriving clips against the schemas the templates were exported from.

import { normalizePath, Notice, type App, type TFile } from "obsidian";
import type { ActivityStore } from "../activity/store";
import type { PluginSettings } from "../types";
import { ensureVaultFolder, writeOrReplaceFile } from "../vault/vaultFiles";
import { ClipperSetupModal } from "../view/ClipperSetupModal";
import { clipperFingerprint } from "./clipperTemplate";
import { clipperSetupFor, type ClipperSetupViewModel } from "./clipperSetup";
import { verifyClipperNote } from "./clipperVerification";
import { getSchema } from "./registry";
import type { SourceType } from "./types";
import { saveClipperJson, type ClipperJsonFile } from "./clipperJsonFile";

export interface ClipperFeatureDeps {
  app: App;
  settings: () => PluginSettings;
  saveSettings: () => Promise<void>;
  persist: () => Promise<void>;
  activity: () => ActivityStore;
  exportJson?: (artifact: ClipperJsonFile) => Promise<boolean>;
}

export class ClipperFeature {
  private verificationTimers = new Map<string, number>();

  constructor(private deps: ClipperFeatureDeps) {}

  private get app(): App {
    return this.deps.app;
  }

  private get settings(): PluginSettings {
    return this.deps.settings();
  }

  /** Cancels pending clip verifications. */
  dispose(): void {
    for (const timer of this.verificationTimers.values()) window.clearTimeout(timer);
    this.verificationTimers.clear();
  }

  /**
   * Write one Web Clipper template per source type into the vault so clips land
   * pre-typed (schema keys + page-known values) instead of clip-then-convert.
   * The user imports the JSON files in the clipper's template settings.
   */
  async exportTemplates(): Promise<{ folder: string; count: number }> {
    const folder = "Claude/Clipper templates";
    const opts = { path: this.settings.sourceInboxFolder, tags: this.settings.sourceBaseTags };
    const types: SourceType[] = ["article", "video", "dataset"];
    const schemas = types.map((t) => getSchema(t, this.settings.sourceSchemaOverrides));
    await ensureVaultFolder(this.app, folder);
    for (const setup of this.setups()) await this.writeTemplate(folder, setup);
    this.settings.clipperTemplateFingerprint = clipperFingerprint(schemas, opts);
    await this.deps.saveSettings();
    new Notice(
      `Wrote ${types.length} clipper templates to “${folder}”. In the Web Clipper extension: Settings → Templates → Import each file — clips will then arrive already typed for Companion.`,
      10000,
    );
    return { folder, count: types.length };
  }

  private async writeTemplate(folder: string, artifact: ClipperJsonFile): Promise<void> {
    const path = normalizePath(`${folder}/${artifact.fileName}`);
    const file = await writeOrReplaceFile(this.app, path, artifact.json);
    if (file.path !== path || file.extension !== "json" || await this.app.vault.read(file) !== artifact.json) {
      throw new Error("The template was not saved as an intact .json file. Copy template JSON and use Web Clipper → Import → JSON.");
    }
  }

  private setups(): ClipperSetupViewModel[] {
    const schemas = (["article", "video", "dataset"] as SourceType[]).map((type) => getSchema(type, this.settings.sourceSchemaOverrides));
    return (["article", "video", "dataset"] as SourceType[]).map((type) => clipperSetupFor(type, schemas, {
      inboxFolder: this.settings.sourceInboxFolder,
      baseTags: this.settings.sourceBaseTags,
      savedFingerprint: this.settings.clipperVerification[type]?.fingerprint ?? this.settings.clipperTemplateFingerprint,
      ...(this.settings.clipperVerification[type] ? { verification: this.settings.clipperVerification[type] } : {}),
    }));
  }

  /** False once any Web Clipper template is verified against the current schemas. */
  setupNeeded(): boolean {
    return !this.setups().some((setup) => setup.status === "verified");
  }

  status(): "not-set-up" | "current" | "update-available" {
    const statuses = this.setups().map(({ status }) => status);
    return statuses.includes("update-available") ? "update-available" : statuses.some((status) => status === "verified") || statuses.every((status) => status === "current") ? "current" : "not-set-up";
  }

  openSetup(): void {
    new ClipperSetupModal(this.app, {
      setups: () => this.setups(),
      copyText: async (text) => {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable on this device.");
        await navigator.clipboard.writeText(text);
      },
      onCopied: async (type, fingerprint) => {
        this.settings.clipperVerification[type] = {
          fingerprint,
          state: "waiting",
          startedAt: Date.now(),
          mismatches: [],
        };
        await this.deps.persist();
        this.deps.activity().start({
          id: `clipper-verification:${type}`,
          kind: "clipper-verification",
          title: `Waiting for a ${type} test clip`,
        });
      },
      saveJson: (setup) => (this.deps.exportJson ?? saveClipperJson)(setup),
    }).open();
  }

  queueVerification(file: TFile, attempt = 0): void {
    const waiting = Object.entries(this.settings.clipperVerification)
      .filter((entry): entry is [SourceType, NonNullable<typeof entry[1]>] => entry[1]?.state === "waiting")
      .sort((left, right) => right[1].startedAt - left[1].startedAt)[0];
    const inbox = this.settings.sourceInboxFolder.replace(/\/+$/, "");
    if (!waiting && !(inbox && file.path.startsWith(`${inbox}/`))) return;
    const previous = this.verificationTimers.get(file.path);
    if (previous !== undefined) window.clearTimeout(previous);
    const timer = window.setTimeout(() => {
      this.verificationTimers.delete(file.path);
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
      if (!frontmatter && attempt < 4) {
        this.queueVerification(file, attempt + 1);
        return;
      }
      if (!waiting) {
        if (frontmatter) void this.verifyStampedClip(file, frontmatter);
        return;
      }
      // A clip that lands in the inbox carrying nothing is proof the template
      // never applied — report it instead of waiting for a note that can't come.
      if (!frontmatter) {
        if (inbox && file.path.startsWith(`${inbox}/`)) void this.verifyArrivingClip(file, waiting[0], {});
        return;
      }
      const observedType = frontmatter.type;
      const typedWaiting = (observedType === "article" || observedType === "video" || observedType === "dataset")
        && this.settings.clipperVerification[observedType]?.state === "waiting"
        ? observedType
        : undefined;
      const resemblesClip = frontmatter.source !== undefined || frontmatter.url !== undefined || frontmatter.schema_version !== undefined;
      const expectedType = typedWaiting ?? (resemblesClip ? waiting[0] : undefined);
      if (!expectedType) return;
      void this.verifyArrivingClip(file, expectedType, frontmatter);
    }, 600);
    this.verificationTimers.set(file.path, timer);
  }

  /** Templates imported without the setup modal still verify from a matching stamped clip; mismatches stay silent. */
  private async verifyStampedClip(file: TFile, frontmatter: Record<string, unknown>): Promise<void> {
    const type = frontmatter.type;
    if ((type !== "article" && type !== "video" && type !== "dataset") || frontmatter.schema_version === undefined) return;
    const setup = this.setups().find((candidate) => candidate.type === type);
    if (!setup || setup.status === "verified") return;
    const result = verifyClipperNote({ path: file.path, frontmatter }, {
      type,
      schemaVersion: setup.schemaVersion,
      destination: this.settings.sourceInboxFolder,
      fingerprint: setup.fingerprint,
      baseTags: this.settings.sourceBaseTags,
      templateFingerprint: setup.templateFingerprint,
    });
    if (result.state !== "verified") return;
    const now = Date.now();
    this.settings.clipperVerification[type] = { fingerprint: setup.fingerprint, state: "verified", startedAt: now, verifiedAt: now, path: result.path, mismatches: [] };
    await this.deps.persist();
  }

  private async verifyArrivingClip(file: TFile, type: SourceType, frontmatter: Record<string, unknown>): Promise<void> {
    const metadata = this.settings.clipperVerification[type];
    if (!metadata || metadata.state !== "waiting") return;
    const schema = getSchema(type, this.settings.sourceSchemaOverrides);
    const result = verifyClipperNote({ path: file.path, frontmatter }, {
      type,
      schemaVersion: schema.version,
      destination: this.settings.sourceInboxFolder,
      fingerprint: metadata.fingerprint,
      baseTags: this.settings.sourceBaseTags,
      templateFingerprint: this.setups().find((setup) => setup.type === type)!.templateFingerprint,
    });
    this.settings.clipperVerification[type] = {
      fingerprint: metadata.fingerprint,
      state: result.state,
      startedAt: metadata.startedAt,
      ...(result.state === "verified" ? { verifiedAt: Date.now() } : {}),
      path: result.path,
      mismatches: result.mismatches.slice(0, 12),
    };
    await this.deps.persist();
    const activity = this.deps.activity();
    const activityId = `clipper-verification:${type}`;
    if (!activity.snapshot().records.some(({ id }) => id === activityId)) {
      activity.start({ id: activityId, kind: "clipper-verification", title: `Verifying ${type} Web Clipper template`, total: 1 });
    }
    if (result.state === "verified") {
      activity.finish(activityId, {
        completed: 1,
        total: 1,
        succeeded: 1,
        details: [{ label: result.path, message: "Template verified from an arriving clip", state: "success" }],
      });
    } else {
      activity.fail(activityId, {
        completed: 1,
        total: 1,
        failed: 1,
        details: result.mismatches.map(({ field, expected, observed }) => ({
          label: field,
          message: `Expected ${expected}; observed ${observed}`,
          state: "error" as const,
        })),
        recovery: [{ id: "clipper-schemas", label: "Copy updated JSON", kind: "retry" }],
      });
    }
  }

  /** True when schemas/inbox/tags moved on since the last template export. */
  templatesStale(): boolean {
    const saved = this.settings.clipperTemplateFingerprint;
    if (!saved) return false; // never exported → nothing to be stale
    const opts = { path: this.settings.sourceInboxFolder, tags: this.settings.sourceBaseTags };
    const schemas = (["article", "video", "dataset"] as SourceType[]).map((t) => getSchema(t, this.settings.sourceSchemaOverrides));
    return clipperFingerprint(schemas, opts) !== saved;
  }
}
