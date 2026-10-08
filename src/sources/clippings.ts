// The clippings workflows behind the Inbox and the folder menu: organize the
// inbox into domain folders, organize any folder into subfolders, and find
// research themes in a folder. Each enriches what it needs through the source
// pipeline, asks the model once per batch, and shows a review before writing.

import { Notice, TFile, TFolder, normalizePath, type App } from "obsidian";
import type { ActivityStore } from "../activity/store";
import { beginActivity } from "../activity/progress";
import { noteExcerpt } from "../markdown/excerpt";
import { stripFrontmatter } from "../markdown/frontmatter";
import type { ProviderRouter } from "../providers/router";
import { UtilityUnavailableError } from "../providers/endpointPolicy";
import type { ProviderId } from "../providers/types";
import {
  TRIAGE_SYSTEM,
  buildTriageUser,
  parseTriageResponse,
  partitionEnrichOutcomes,
  renderTriageNote,
  themeTagSlug,
  triageFolderChoices,
  type EnrichOutcomeLike,
  type TriageFolderChoice,
  type TriageNote,
} from "../research/triage";
import type { PluginSettings } from "../types";
import { OrganizeReviewModal } from "../view/OrganizeReviewModal";
import { TriageFolderModal } from "../view/TriageFolderModal";
import type { SourceEnrichmentController } from "./controller";
import type { EnrichDiagnostics } from "./enrichDiagnostics";
import { typedInboxItems, type InboxFileEntry } from "./inbox";
import {
  buildFolderOrganizePrompt,
  currentDomainOf,
  inferDomains,
  planOrganizeMoves,
  relativeFolders,
  resolveUnresolvedWithCurrentFolder,
  type OrganizeCandidate,
} from "./organize";
import { applyOrganizeMoves } from "./organizeApply";
import { isSourceEnriched } from "./watcher";

export interface ClippingsDeps {
  app: App;
  settings: () => PluginSettings;
  activity: () => ActivityStore;
  enrichment: () => SourceEnrichmentController;
  router: () => ProviderRouter;
  diagnostics: () => EnrichDiagnostics;
  providerErrorHint: (message: string, provider: ProviderId) => string | null;
}

export class ClippingsController {
  constructor(private deps: ClippingsDeps) {}

  private get app(): App {
    return this.deps.app;
  }

  /**
   * Infer a folder per candidate with the utility model. A denied or
   * fail-closed utility comes back as `utilityError` instead of a partial plan.
   */
  private async inferFolders(candidates: OrganizeCandidate[], existingFolders: string[], promptBuilder?: typeof buildFolderOrganizePrompt) {
    let utilityError: UtilityUnavailableError | undefined;
    const result = await inferDomains(candidates, {
      existingFolders,
      ...(promptBuilder ? { promptBuilder } : {}),
      complete: async (system, user, maxTokens) => {
        try {
          return (await this.deps.router().complete("utility", { system, user, maxTokens, responseFormat: "json", thinking: { type: "disabled" } })).text;
        } catch (e) {
          if (e instanceof UtilityUnavailableError) utilityError = e;
          throw e;
        }
      },
    });
    this.deps.diagnostics().log("organize-batch", {
      chunks: result.chunks,
      resolved: result.proposals.length,
      unresolved: result.unresolved.length,
      truncated: result.truncated ? "true" : "false",
    });
    return { result, utilityError };
  }

  /**
   * Clipping organizer: enrich every unenriched inbox clip (meaningful title,
   * tags, summary via the existing pipeline), batch-infer a domain folder per
   * clip, review the proposed rename+move plan, then apply the accepted subset.
   */
  async organizeClippings(): Promise<void> {
    const settings = this.deps.settings();
    const inbox = settings.sourceInboxFolder.replace(/\/+$/, "");
    const base = settings.clipOrganizedFolder.replace(/\/+$/, "");
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((f) => (f.path === inbox || f.path.startsWith(`${inbox}/`)) && !(base && (f.path === base || f.path.startsWith(`${base}/`))));
    if (files.length === 0) {
      new Notice(`No clippings found in ${inbox}/.`);
      return;
    }

    const pending = beginActivity(this.deps.activity(), `Organizing ${files.length} clipping${files.length === 1 ? "" : "s"}…`);
    try {
      // 1) Enrich anything not yet enriched. A failed/denied item aborts the
      // organizer so it cannot be sent through another provider or defaulted
      // into a misleading misc move.
      for (const file of files) {
        pending.setMessage(file.path);
        const content = await this.app.vault.cachedRead(file);
        if (!isSourceEnriched(content)) {
          const outcome = await this.deps.enrichment().enrichFile(file);
          if (outcome.status !== "enriched") {
            const detail = outcome.status === "failed" ? outcome.error.message : outcome.reason;
            pending.fail(detail);
            new Notice(`Organizing stopped — ${detail}`);
            return;
          }
        }
      }

      // 2) Candidates are the clips the Inbox view lists as enriched — the
      // same selection recurses into inbox subfolders, so a clip already
      // filed under Clippings/<topic>/ carries that folder as currentDomain
      // instead of being reclassified from scratch.
      const entries: InboxFileEntry[] = this.app.vault.getMarkdownFiles().map((f) => ({
        path: f.path,
        basename: f.basename,
        ext: f.extension,
        frontmatter: this.app.metadataCache.getFileCache(f)?.frontmatter,
        mtime: f.stat?.mtime,
      }));
      const typedPaths = new Set(typedInboxItems(entries, inbox, base).map((i) => i.path));
      const candidateFiles = files.filter((f) => typedPaths.has(f.path));
      const candidates: OrganizeCandidate[] = [];
      const titles = new Map<string, string>();
      const currentDomains = new Map<string, string>();
      for (const file of candidateFiles) {
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
        const title = typeof fm?.title === "string" && fm.title.trim() ? fm.title.trim() : file.basename;
        const summary = typeof fm?.summary === "string" ? fm.summary.trim() : "";
        const currentDomain = currentDomainOf(file.path, inbox);
        titles.set(file.path, title);
        if (currentDomain) currentDomains.set(file.path, currentDomain);
        candidates.push({ path: file.path, title, summary, ...(currentDomain ? { currentDomain } : {}) });
      }

      // 3) Chunked batch inference for the whole set; Clippings/* subfolders
      // count as existing folders too so the model can keep clips in place.
      const parentPaths = this.app.vault.getMarkdownFiles().map((f) => f.parent?.path ?? "");
      const existingFolders = [...new Set([...relativeFolders(parentPaths, base), ...relativeFolders(parentPaths, inbox)])];
      pending.setMessage("Inferring folders");
      const { result: inferResult, utilityError } = await this.inferFolders(candidates, existingFolders);
      if (utilityError) {
        pending.fail(utilityError);
        new Notice(`Organizing stopped — ${utilityError.message}`);
        return;
      }

      // 4) A candidate already filed in a subfolder keeps that folder when
      // inference leaves it unresolved; a root-level unresolved candidate is
      // skipped from the plan.
      const fallback = resolveUnresolvedWithCurrentFolder(inferResult.unresolved, currentDomains);
      const proposals = [...inferResult.proposals, ...fallback.proposals];
      const skipped = fallback.skipped;

      if (candidates.length > 0 && skipped.length === candidates.length) {
        const detail = inferResult.truncated ? "reply truncated" : (inferResult.lastError ?? "reply did not match the clips");
        pending.fail(detail);
        new Notice(`Organizing stopped — ${detail}`);
        return;
      }

      // 5) Review, then apply the accepted subset.
      const moves = planOrganizeMoves(proposals, titles, {
        baseFolder: base,
        taken: (p) => this.app.vault.getAbstractFileByPath(p) !== null,
        existingFolders,
      });
      pending.finish();
      if (moves.length === 0) {
        new Notice("Everything is already named and filed.");
        return;
      }
      new OrganizeReviewModal(this.app, moves, skipped.length, (accepted) => {
        if (!accepted || accepted.length === 0) return;
        void (async () => {
          const { moved, failed } = await applyOrganizeMoves(this.app, accepted);
          const failedNote = failed.length > 0 ? ` ${failed.length} failed — ${failed[0]!.error}` : "";
          new Notice(`Organized ${moved} clipping${moved === 1 ? "" : "s"} into ${base}/.${failedNote}`);
        })();
      }).open();
    } catch (error) {
      pending.fail(error);
      throw error;
    } finally {
      pending.finish();
    }
  }

  /**
   * Folder right-click "Organize notes into subfolders": batch-infer a
   * subfolder per note from titles/summaries, review the proposed move plan,
   * then execute the accepted subset.
   */
  async organizeFolder(folder: TFolder): Promise<void> {
    const files = folder.children.filter((c): c is TFile => c instanceof TFile && c.extension === "md");
    if (files.length === 0) {
      new Notice(`No notes directly in ${folder.path}/.`);
      return;
    }
    const progress = beginActivity(this.deps.activity(), `Proposing a layout for ${files.length} note${files.length === 1 ? "" : "s"}…`);
    try {
      const candidates: OrganizeCandidate[] = [];
      const titles = new Map<string, string>();
      for (const file of files) {
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
        const title = typeof fm?.title === "string" && fm.title.trim() ? fm.title.trim() : file.basename;
        let summary = typeof fm?.summary === "string" ? fm.summary.trim() : "";
        if (!summary) {
          const body = stripFrontmatter(await this.app.vault.cachedRead(file)).trim();
          summary = body.slice(0, 200);
        }
        titles.set(file.path, title);
        candidates.push({ path: file.path, title, summary });
      }

      const existingFolders = folder.children
        .filter((c): c is TFolder => c instanceof TFolder)
        .map((c) => c.name)
        .sort();
      progress.setMessage("Inferring folders");
      const { result: inferResult, utilityError } = await this.inferFolders(candidates, existingFolders, buildFolderOrganizePrompt);
      if (utilityError) throw utilityError;

      if (candidates.length > 0 && inferResult.unresolved.length === candidates.length) {
        const detail = inferResult.truncated ? "reply truncated" : (inferResult.lastError ?? "reply did not match the notes");
        progress.fail(detail);
        new Notice(`Organize stopped — ${detail}`);
        return;
      }

      const moves = planOrganizeMoves(inferResult.proposals, titles, {
        baseFolder: folder.path,
        taken: (p) => this.app.vault.getAbstractFileByPath(p) !== null,
        existingFolders,
      });
      if (moves.length === 0) {
        new Notice("Everything is already named and filed.");
        return;
      }
      progress.finish();
      new OrganizeReviewModal(this.app, moves, inferResult.unresolved.length, (accepted) => {
        if (!accepted || accepted.length === 0) return;
        void (async () => {
          const { moved, failed } = await applyOrganizeMoves(this.app, accepted);
          const failedNote = failed.length > 0 ? ` ${failed.length} failed — ${failed[0]!.error}` : "";
          new Notice(`Organized ${moved} note${moved === 1 ? "" : "s"} into ${folder.path}/ subfolders.${failedNote}`);
        })();
      }).open();
    } catch (e) {
      progress.fail(e);
      new Notice(`Organize failed — ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      progress.finish();
    }
  }

  /**
   * One-click clippings triage (Research Desk): enrich any un-typed clips in
   * the chosen folder, group them into research themes with one chat call, tag
   * each note with its theme, and write a `Triage.md` board with links and a
   * potential project per theme. Manual action — no consent gate.
   */
  async triage(folderOverride?: string): Promise<void> {
    const folder = (folderOverride ?? this.deps.settings().sourceInboxFolder).replace(/\/+$/, "");
    if (!folder) {
      new Notice("Set a clippings inbox folder in Companion settings first.");
      return;
    }
    const files = this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(`${folder}/`) && f.name !== "Triage.md");
    if (files.length === 0) {
      new Notice(`No clippings in ${folder}/ yet — clip something first.`);
      return;
    }
    const progress = beginActivity(this.deps.activity(), `Finding themes in ${files.length} clipping${files.length === 1 ? "" : "s"}…`);
    try {
      const results: Array<{ path: string; outcome: EnrichOutcomeLike | null }> = [];
      for (const file of files) {
        progress.setMessage(file.path);
        const content = await this.app.vault.cachedRead(file);
        if (isSourceEnriched(content)) {
          results.push({ path: file.path, outcome: null });
          continue;
        }
        const raw = await this.deps.enrichment().runEnrich(file, false);
        // A denied or fail-closed utility is systemic: nothing may reach the chat model after it.
        const outcome: EnrichOutcomeLike = raw.status === "failed" && raw.error instanceof UtilityUnavailableError
          ? { status: "skipped", reason: raw.error.message }
          : raw;
        results.push({ path: file.path, outcome });
        if (outcome.status === "skipped") break;
      }
      const partition = partitionEnrichOutcomes(results);
      if (partition.stopReason) {
        progress.fail(partition.stopReason);
        new Notice(`Finding themes stopped — ${partition.stopReason}`);
        return;
      }
      const included = new Set(partition.include);

      const notes: TriageNote[] = [];
      for (const file of files.filter((f) => included.has(f.path))) {
        const content = await this.app.vault.cachedRead(file);
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
        const tags = Array.isArray(fm?.tags) ? fm.tags.map(String) : typeof fm?.tags === "string" ? [fm.tags] : [];
        notes.push({
          path: file.path,
          title: typeof fm?.title === "string" ? fm.title : file.basename,
          type: typeof fm?.type === "string" ? fm.type : "note",
          ...(typeof fm?.url === "string" ? { url: fm.url } : {}),
          tags,
          excerpt: noteExcerpt(content, 400),
        });
      }

      progress.setMessage("Grouping research themes");
      const { text: raw } = await this.deps.router().complete("chat", {
        system: TRIAGE_SYSTEM,
        user: buildTriageUser(notes),
        maxTokens: 4000,
        temperature: 0.2,
      });
      const groups = parseTriageResponse(raw, new Set(notes.map((n) => n.path)));
      if (groups.length === 0) throw new Error("The model returned no usable groups — try again.");

      for (const group of groups) {
        const tag = themeTagSlug(group.theme);
        for (const path of group.paths) {
          const file = this.app.vault.getAbstractFileByPath(path);
          if (!(file instanceof TFile)) continue;
          await this.app.fileManager.processFrontMatter(file, (fm) => {
            const record = fm as Record<string, unknown>;
            const raw = record.tags;
            const existing: string[] = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? [raw] : [];
            record.tags = [...new Set([...existing, tag])];
          });
        }
      }

      const triagePath = normalizePath(`${folder}/Triage.md`);
      const board = renderTriageNote(groups, new Map(notes.map((n) => [n.path, n])), new Date().toISOString());
      this.deps.enrichment().markEnrichRecentlyWritten(triagePath);
      const existing = this.app.vault.getAbstractFileByPath(triagePath);
      if (existing instanceof TFile) await this.app.vault.modify(existing, board);
      else await this.app.vault.create(triagePath, board);
      const skippedNote = partition.failed > 0 ? ` (${partition.failed} skipped: could not enrich)` : "";
      new Notice(`Themes: ${groups.length} theme${groups.length === 1 ? "" : "s"} across ${notes.length} clipping${notes.length === 1 ? "" : "s"} → ${triagePath}${skippedNote}`);
      const boardFile = this.app.vault.getAbstractFileByPath(triagePath);
      if (boardFile instanceof TFile) await this.app.workspace.getLeaf(false).openFile(boardFile);
    } catch (e) {
      progress.fail(e);
      const { provider } = this.deps.router().resolve("chat");
      const hint = this.deps.providerErrorHint(e instanceof Error ? e.message : String(e), provider.id);
      new Notice(`Finding themes failed${hint ? ` — ${hint}` : ` — ${e instanceof Error ? e.message : String(e)}`}`);
    } finally {
      progress.finish();
    }
  }

  /** Every vault folder holding at least one markdown file, minus the given paths. */
  private triageableFolders(exclude: ReadonlySet<string>): TriageFolderChoice[] {
    const folders = new Set<string>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      let dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
      while (dir) {
        folders.add(dir);
        const parent = dir.lastIndexOf("/");
        dir = parent > 0 ? dir.slice(0, parent) : "";
      }
    }
    return [...folders]
      .filter((folder) => !exclude.has(folder))
      .sort((a, b) => a.localeCompare(b))
      .map((folder) => ({ folder, label: folder }));
  }

  /** Command-palette entry: pick the folder first so moved/organized notes can be triaged too. */
  async triageWithPicker(): Promise<void> {
    const known = triageFolderChoices(this.deps.settings());
    const choices = [...known, ...this.triageableFolders(new Set(known.map((choice) => choice.folder)))];
    const folder = await new Promise<string | undefined>((resolve) => new TriageFolderModal(this.app, choices, resolve).open());
    if (folder) await this.triage(folder);
  }
}
