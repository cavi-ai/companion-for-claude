// Optimize brain's plugin wiring: the tag-merge, link-weave, and type-weave
// controllers over the live vault, the classifier they share, and the review
// flows the commands and the System page open. One home for the optimize
// state they all persist.

import { Notice, normalizePath, type App } from "obsidian";
import type { ActivityStore } from "../activity/store";
import { beginActivity } from "../activity/progress";
import type { OntologyRegistry } from "../ontology/registry";
import type { ProviderRouter, ProviderSelection } from "../providers/router";
import type { SemanticIndexer } from "../semantic/indexer";
import { vaultTagEntries } from "../tags/vaultTags";
import type { PluginSettings } from "../types";
import { LinkWeaveModal } from "../view/LinkWeaveModal";
import { OptimizeBrainModal } from "../view/OptimizeBrainModal";
import { TypeWeaveModal } from "../view/TypeWeaveModal";
import { createClassifier } from "./classifierGlue";
import { formatApplyNotice, OptimizeController } from "./controller";
import { formatLinkApplyNotice, formatLinkScanEmptyNotice, LinkWeaveController } from "./linkController";
import { MAX_PROPOSALS_PER_KIND, scanOrphans, type LinkScanReport } from "./linkScan";
import { openTagMergeReview } from "./review";
import type { OptimizeState } from "./state";
import { formatTypeApplyNotice, formatTypeScanNotice, TypeWeaveController } from "./typeController";
import { addRelatedLinks, applyNoteMerge, linkScanNotes, loadedOntology, noteTagInput, processNoteBody, setNoteType, typeScanNotes, writeOptimizeRunNote } from "./vaultGlue";

export interface OptimizeFeatureDeps {
  app: App;
  settings: () => PluginSettings;
  activity: () => ActivityStore;
  indexer: () => SemanticIndexer | null;
  ontology: () => OntologyRegistry | null;
  orderTagTriggers: () => Array<{ path: string; tag: string }>;
  router: () => ProviderRouter;
  isMobile: boolean;
  /** The utility selection a passive (background) classifier may use; throws when none may run. */
  passiveUtilitySelection: () => ProviderSelection;
  /** Throws once the plugin has unloaded, so no further content is sent. */
  assertActive: () => void;
  getState: () => OptimizeState;
  setState: (next: OptimizeState) => Promise<void>;
}

export class OptimizeFeature {
  private _tags?: OptimizeController;
  private _links?: LinkWeaveController;
  private _types?: TypeWeaveController;
  private _classifier?: ReturnType<typeof createClassifier>;

  constructor(private deps: OptimizeFeatureDeps) {}

  private get app(): App {
    return this.deps.app;
  }

  private now(): string {
    return new Date().toISOString();
  }

  private classifier(): ReturnType<typeof createClassifier> {
    return (this._classifier ??= createClassifier({
      router: () => this.deps.router(),
      backend: () => this.deps.settings().classifierBackend,
      isMobile: this.deps.isMobile,
      passiveUtilitySelection: () => this.deps.passiveUtilitySelection(),
      assertActive: () => this.deps.assertActive(),
    }));
  }

  /** Tag merges. */
  tags(): OptimizeController {
    return (this._tags ??= new OptimizeController({
      tagEntries: () => vaultTagEntries(this.app),
      noteVectors: async () => (await this.deps.indexer()?.noteVectors()) ?? null,
      noteTags: (path) => noteTagInput(this.app, path),
      rewriteNote: (plan, map) => applyNoteMerge(this.app, plan, map),
      orderTagTriggers: () => this.deps.orderTagTriggers(),
      writeRunNote: (content, now) => writeOptimizeRunNote(this.app, content, now),
      getState: () => this.deps.getState(),
      setState: (next) => this.deps.setState(next),
      now: () => this.now(),
      classifier: this.classifier(),
    }));
  }

  /** Orphan links. */
  links(): LinkWeaveController {
    return (this._links ??= new LinkWeaveController({
      scan: async (dismissed, onProgress) => {
        const indexer = this.deps.indexer();
        const registry = await loadedOntology(this.deps.ontology());
        return scanOrphans({
          ...(onProgress ? { onProgress } : {}),
          notes: linkScanNotes(this.app, registry),
          edges: this.app.metadataCache.resolvedLinks,
          ontologyFolder: normalizePath(this.deps.settings().ontologyFolder),
          dismissed,
          read: async (path) => {
            const file = this.app.vault.getFileByPath(path);
            return file ? this.app.vault.cachedRead(file) : "";
          },
          neighbours: async (path, accept) => (indexer ? indexer.relatedStored(path, MAX_PROPOSALS_PER_KIND, accept) : []),
          yieldEvery: () => new Promise((resolve) => window.setTimeout(resolve, 0)),
        });
      },
      processBody: (path, transform) => processNoteBody(this.app, path, transform),
      addRelated: (path, entries) => addRelatedLinks(this.app, path, entries),
      writeRunNote: (content, now) => writeOptimizeRunNote(this.app, content, now, "Link weave"),
      getState: () => this.deps.getState(),
      setState: (next) => this.deps.setState(next),
      now: () => this.now(),
    }));
  }

  /** Untyped notes. */
  types(): TypeWeaveController {
    return (this._types ??= new TypeWeaveController({
      notes: () => typeScanNotes(this.app),
      registry: () => loadedOntology(this.deps.ontology()),
      ontologyFolder: () => normalizePath(this.deps.settings().ontologyFolder),
      read: async (path) => {
        const file = this.app.vault.getFileByPath(path);
        if (!file) throw new Error(`Note not found: ${path}`);
        return this.app.vault.cachedRead(file);
      },
      setNoteType: (path, type) => setNoteType(this.app, path, type),
      writeRunNote: (content, now) => writeOptimizeRunNote(this.app, content, now, "Type weave"),
      getState: () => this.deps.getState(),
      setState: (next) => this.deps.setState(next),
      now: () => this.now(),
      classifier: this.classifier(),
    }));
  }

  /** After source enrichment goes idle: judge tag pairs quietly and say so only when merges were proposed. */
  async checkTagMergesInBackground(): Promise<void> {
    try {
      const result = await this.tags().classify({ background: true });
      if (result.merge > 0) {
        new Notice(`Tag check: ${result.merge} ${result.merge === 1 ? "merge" : "merges"} proposed. Run "Optimize brain: review tag merges".`);
      }
    } catch (error) {
      console.debug("Claude Companion: background tag check failed", error);
    }
  }

  reviewTagMerges(done: () => void): Promise<void> {
    const controller = this.tags();
    return openTagMergeReview({
      scan: () => controller.scan(),
      open: (candidates) =>
        new OptimizeBrainModal(this.app, candidates, {
          apply: (merges) => controller.apply(merges),
          dismiss: (id) => controller.dismiss(id),
          classify: (signal) => controller.classify({ signal }),
          rescan: async () => (await controller.scan()).candidates,
          classifierInfo: () => controller.classifierInfo(),
        }, (result) => {
          if (result) new Notice(formatApplyNotice(result));
          done();
        }).open(),
      notice: (text) => void new Notice(text),
      done,
    });
  }

  async reviewUntypedNotes(done: () => void): Promise<void> {
    const controller = this.types();
    try {
      const report = await controller.scan();
      const notice = formatTypeScanNotice(report);
      if (notice) {
        new Notice(notice);
        done();
        return;
      }
      new TypeWeaveModal(this.app, report, {
        apply: (rows) => controller.apply(rows),
        dismiss: (path) => controller.dismiss(path),
        classify: (signal) => controller.classify({ signal }),
        rescan: () => controller.scan(),
        classifierInfo: () => controller.classifierInfo(),
      }, (result) => {
        if (result) new Notice(formatTypeApplyNotice(result));
        done();
      }).open();
    } catch (error) {
      new Notice(`Type scan failed: ${error instanceof Error ? error.message : String(error)}`);
      done();
    }
  }

  async reviewOrphanLinks(done: () => void): Promise<void> {
    const controller = this.links();
    const progress = beginActivity(this.deps.activity(), "Scanning for orphan notes…");
    try {
      let report: LinkScanReport;
      try {
        report = await controller.scan((read, total) => progress.setMessage("Scanning notes", read, total));
      } catch (error) {
        progress.fail(error);
        throw error;
      } finally {
        progress.finish();
      }
      if (report.groups.length === 0) {
        new Notice(formatLinkScanEmptyNotice(report));
        done();
        return;
      }
      new LinkWeaveModal(this.app, report, {
        apply: (selected) => controller.apply(selected, report.contents),
        dismiss: (proposal) => controller.dismiss(proposal),
      }, (result) => {
        if (result) new Notice(formatLinkApplyNotice(result));
        done();
      }).open();
    } catch (error) {
      new Notice(`Orphan scan failed: ${error instanceof Error ? error.message : String(error)}`);
      done();
    }
  }
}
