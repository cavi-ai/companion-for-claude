import { UtilityUnavailableError } from "../providers/endpointPolicy";
// Per-note vault flows: link suggestions, "Tidy with Claude", and frontmatter suggestions.
// Every flow proposes first and writes only what the user accepts.

import { TFile, TFolder, parseYaml, type App } from "obsidian";
import { CompanionNotice as Notice } from "../notice";
import type { ActivityStore } from "../activity/store";
import { beginActivity } from "../activity/progress";
import { sanitizeFileName } from "../artifacts/parse";
import { applyPlan, diffToEdits, planEdits } from "../edit/diff";
import { normalizeTags } from "../indexing/frontmatter";
import { frontmatterSuggestSystem, parseFrontmatterSuggestion } from "../indexing/frontmatterSuggest";
import { summarizeAndTag } from "../indexing/autoTagger";
import type { BatchLinkApplyResult } from "../links/batch";
import { reviewInboxBatchLinks } from "../links/inboxBatchReview";
import { mentionEdits } from "../links/suggest";
import { findUnlinkedMentions, linkMention, withLinktext, type LinkCandidate } from "../links/unlinkedMentions";
import type { OntologyRegistry } from "../ontology/registry";
import type { ProviderRouter } from "../providers/router";
import { resolveTags } from "../tags/resolve";
import { selectPromptTags } from "../tags/vocabulary";
import { vaultVocabulary } from "../tags/vaultTags";
import type { PluginSettings } from "../types";
import { BatchDiffModal } from "../view/BatchDiffModal";
import { createBatchDiffState } from "../view/batchDiffState";
import { DiffModal } from "../view/DiffModal";
import { EnrichOptionsModal, EnrichReviewModal, type EnrichDecision, type EnrichOptions, type EnrichProposal } from "../view/EnrichModal";
import { FrontmatterModal } from "../view/FrontmatterModal";
import { stripFrontmatter } from "../markdown/frontmatter";
import { LINT_SYSTEM, buildLintUser, lintMaxTokens, parseLintResponse } from "./noteEnrich";
import { TIDY_HASH_KEY, TIDY_STEPS, TIDY_STEPS_KEY, planTidy, tidyBodyHash, type TidyStep } from "./tidyMarker";

export interface NoteFlowsDeps {
  app: App;
  settings: () => PluginSettings;
  activity: () => ActivityStore;
  router: () => ProviderRouter;
  ontology: () => OntologyRegistry | null;
}

function frontmatterTags(value: unknown): string[] {
  return normalizeTags(Array.isArray(value) ? value.map(String) : typeof value === "string" ? [value] : []);
}

/** The decision the review starts with: every proposed item accepted. */
function acceptAll(proposal: EnrichProposal): EnrichDecision {
  return { rename: !!proposal.rename, frontmatter: !!proposal.frontmatter, accepted: (proposal.plan?.hunks ?? []).map(() => true) };
}

export class NoteFlows {
  private disposed = false;
  private pending = new Map<string, AbortController>();
  private reviews = new Set<{ close(): void }>();
  dispose(): void { this.disposed = true; for (const abort of this.pending.values()) abort.abort(); for (const modal of this.reviews) modal.close(); }
  cancel(id: string): void { this.pending.get(id)?.abort(); }
  private assertActive(signal?: AbortSignal): void {
    if (this.disposed || signal?.aborted) throw new DOMException("Tidy stopped. The remaining changes were not applied.", "AbortError");
  }
  private choose<T>(build: (resolve: (value: T | null) => void) => { open(): void; close(): void }): Promise<T | null> {
    if (this.disposed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const modal = build((value) => { this.reviews.delete(modal); resolve(value); });
      this.reviews.add(modal); modal.open();
    });
  }
  constructor(private deps: NoteFlowsDeps) {}

  private get app(): App {
    return this.deps.app;
  }

  private get settings(): PluginSettings {
    return this.deps.settings();
  }

  private get activity(): ActivityStore {
    return this.deps.activity();
  }

  /** Every markdown note as a link-candidate (basename + frontmatter aliases). */
  linkCandidates(): LinkCandidate[] {
    return withLinktext(
      this.app.vault.getMarkdownFiles().map((f) => {
        const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined;
        const raw = fm?.aliases;
        const aliases = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" && raw.trim() ? [raw] : [];
        return { path: f.path, basename: f.basename, aliases };
      }),
    );
  }

  /** Paths the given note already links to (its outgoing resolved links). */
  linkedTargets(file: TFile): Set<string> {
    const resolved = (this.app.metadataCache as unknown as { resolvedLinks?: Record<string, Record<string, number>> }).resolvedLinks ?? {};
    return new Set(Object.keys(resolved[file.path] ?? {}));
  }

  /**
   * Bulk-link the unlinked mentions of a note through the diff review flow
   * (spec 2026-07-05 link intelligence): every proposed [[link]] is a hunk the
   * user can accept or reject before anything is written.
   */
  async reviewLinkSuggestions(target?: TFile): Promise<void> {
    const file = target ?? this.app.workspace.getActiveFile();
    if (!(file instanceof TFile) || file.extension !== "md") {
      new Notice("Open a note first.");
      return;
    }
    const content = await this.app.vault.cachedRead(file);
    const mentions = findUnlinkedMentions(content, this.linkCandidates(), file.path);
    if (mentions.length === 0) {
      new Notice("No unlinked mentions found.");
      return;
    }
    const edits = mentionEdits(content, mentions);
    if (edits.length === 0) {
      new Notice("Mentions found, but none could be linked unambiguously.");
      return;
    }
    // Planning validates the edits; a rejected plan is a notice, never an unhandled rejection.
    let plan;
    try {
      plan = planEdits(content, edits);
    } catch (e) {
      new Notice(e instanceof Error ? e.message : String(e));
      return;
    }
    const accepted = await new Promise<boolean[] | null>((resolve) => {
      new DiffModal(this.app, { path: file.path, description: `Link ${plan.hunks.length} unlinked mention${plan.hunks.length === 1 ? "" : "s"}`, plan }, resolve).open();
    });
    if (!accepted) return;
    try {
      await this.app.vault.process(file, (current) => applyPlan(current, plan, accepted));
      new Notice(`Linked ${accepted.filter(Boolean).length} mention${accepted.filter(Boolean).length === 1 ? "" : "s"} in ${file.basename}.`);
    } catch (e) {
      new Notice(e instanceof Error ? e.message : String(e));
    }
  }

  /** Review and apply link proposals for the supplied enriched Inbox notes. */
  async reviewInboxLinkSuggestions(files: TFile[]): Promise<BatchLinkApplyResult | null> {
    return reviewInboxBatchLinks(files, this.linkCandidates(), {
      read: (file) => this.app.vault.cachedRead(file),
      getFile: (path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        return file instanceof TFile ? file : null;
      },
      process: async (file, transform) => { await this.app.vault.process(file, transform); },
      select: (plans) => this.settings.enrichAutoApply
        ? Promise.resolve(createBatchDiffState(plans).selected)
        : new Promise((resolve) => {
          new BatchDiffModal(this.app, plans, resolve).open();
        }),
    });
  }

  /**
   * Enrich one note end to end (file-explorer right-click / command): pick the
   * steps (all on by default), then summarize → propose rename + tags/summary,
   * wikilink unlinked mentions, and copyedit — presented for review as
   * per-item checkboxes + diff hunks before anything is written, or applied
   * whole when auto-apply is on. Steps a previous Tidy finished on the same
   * body are skipped.
   */
  async enrichNoteFlow(file: TFile, presetOptions?: EnrichOptions): Promise<void> {
    const options =
      presetOptions ?? (await this.choose<EnrichOptions>((resolve) => new EnrichOptionsModal(this.app, 1, resolve, this.settings.tidyAutoApply)));
    if (!options || this.disposed) return;

    const progress = beginActivity(this.activity, `Tidying ${file.basename}…`);
    const abort = new AbortController();
    this.pending.set(progress.id, abort);
    this.activity.update(progress.id, { recovery: [{ id: "stop-tidy", label: "Stop", kind: "stop" }] });
    try {
      this.assertActive(abort.signal);
      const content = await this.app.vault.cachedRead(file);
      if (!stripFrontmatter(content).trim()) {
        new Notice(`${file.basename} is empty.`);
        return;
      }
      const tidy = planTidy(content, options, parseYaml);
      if (tidy.done) {
        new Notice(`${file.basename} is already tidied.`);
        return;
      }
      const { proposal, failed } = await this.buildEnrichProposal(file, content, tidy.pending, abort.signal);
      this.assertActive(abort.signal);
      const failures = proposal.failures?.map(({ step, message }) => `${step}: ${message}`).join("\n");
      if (failures) progress.fail(failures);
      const finished = TIDY_STEPS.filter((step) => tidy.finished.includes(step) || (tidy.pending[step] && !failed.has(step)));
      if (!proposal.rename && !proposal.frontmatter && !proposal.plan) {
        if (finished.length > tidy.finished.length) await this.recordTidy(file, finished, content, abort.signal);
        new Notice(failures ? `Tidy couldn't finish ${file.basename}.\n${failures}\nRun Tidy again to retry.` : `${file.basename} is already in good shape.`, failures ? 12000 : 6000);
        return;
      }
      progress.setMessage(options.autoApply ? "Applying changes" : "Review proposed changes");
      const decision = options.autoApply
        ? acceptAll(proposal)
        : await this.choose<EnrichDecision>((resolve) => new EnrichReviewModal(this.app, proposal, resolve));
      if (!decision) return;
      this.assertActive(abort.signal);
      await this.applyEnrichDecision(file, content, proposal, decision, finished, abort.signal);
      new Notice(failures ? `Applied selected changes to ${file.basename}. Some Tidy steps failed; run Tidy again to retry.` : `Tidied ${file.basename}.`, failures ? 12000 : 6000);
    } catch (e) {
      if (abort.signal.aborted || this.disposed) { progress.cancel(); return; }
      progress.fail(e);
      new Notice(`Tidy failed — ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.pending.delete(progress.id);
      progress.finish();
    }
  }

  /** Batch variant for a folder: one step picker, then per-note runs; empty notes and notes already tidied are skipped unread by the model. */
  async enrichFolderFlow(folder: TFolder): Promise<void> {
    const files: TFile[] = [];
    const walk = (f: TFolder): void => {
      for (const child of f.children) {
        if (child instanceof TFile && child.extension === "md") files.push(child);
        else if (child instanceof TFolder) walk(child);
      }
    };
    walk(folder);
    if (files.length === 0) {
      new Notice(`No notes found in ${folder.path}/.`);
      return;
    }
    const options = await new Promise<EnrichOptions | null>((resolve) => new EnrichOptionsModal(this.app, files.length, resolve, this.settings.tidyAutoApply).open());
    if (!options) return;
    let skipped = 0;
    let empty = 0;
    for (const file of files) {
      const content = await this.app.vault.cachedRead(file).catch(() => null);
      if (content !== null && !stripFrontmatter(content).trim()) {
        empty++;
        continue;
      }
      if (content !== null && planTidy(content, options, parseYaml).done) {
        skipped++;
        continue;
      }
      await this.enrichNoteFlow(file, options);
    }
    if (skipped > 0) new Notice(`Skipped ${skipped} note${skipped === 1 ? "" : "s"} already tidied.`);
    if (empty > 0) new Notice(`Skipped ${empty} empty note${empty === 1 ? "" : "s"}.`);
  }

  /** Compute everything an enrich pass can propose for one note (no writes), and the steps that failed. */
  private async buildEnrichProposal(
    file: TFile,
    content: string,
    options: EnrichOptions,
    signal?: AbortSignal,
  ): Promise<{ proposal: EnrichProposal; failed: Set<TidyStep> }> {
    this.assertActive(signal);
    const proposal: EnrichProposal = { path: file.path };
    const failed = new Set<TidyStep>();

    let tagResult: { title: string; tags: string[]; newTags: string[]; summary: string } | null = null;
    if (options.rename || options.frontmatter) {
      try {
        tagResult = await summarizeAndTag(this.deps.router(), content, vaultVocabulary(this.app), signal);
      } catch (e) {
        this.assertActive(signal);
        if (e instanceof UtilityUnavailableError && e.resolution.state === "unavailable-without-Claude" && e.resolution.reason === "fallback-denied") throw e;
        const step = [options.rename ? "Rename note" : "", options.frontmatter ? "Tags & summary" : ""].filter(Boolean).join(" / ");
        (proposal.failures ??= []).push({ step, message: e instanceof Error ? e.message : String(e) });
        failed.add("rename").add("frontmatter");
      }
    }

    // Compose body transforms: links first, then lint the linked text, so the
    // final old→new diff is one consistent set of non-overlapping hunks.
    let body = content;
    if (options.links) {
      const mentions = findUnlinkedMentions(content, this.linkCandidates(), file.path);
      for (const m of [...mentions].sort((a, b) => b.start - a.start)) {
        body = linkMention(body, m);
      }
    }
    if (options.lint && body.trim().length > 0) {
      try {
        const { text } = await this.deps.router().complete("chat", {
          system: LINT_SYSTEM,
          user: buildLintUser(body),
          maxTokens: lintMaxTokens(body),
          temperature: 0.2,
          responseFormat: "json",
          ...(signal ? { signal } : {}),
        });
        this.assertActive(signal);
        body = parseLintResponse(text, body) ?? body;
      } catch (e) {
        (proposal.failures ??= []).push({ step: "Lint note", message: e instanceof Error ? e.message : String(e) });
        failed.add("lint");
      }
    }
    this.assertActive(signal);
    const edits = diffToEdits(content, body);
    if (edits.length > 0) proposal.plan = planEdits(content, edits);

    if (options.rename && tagResult?.title) {
      const stem = sanitizeFileName(tagResult.title);
      if (stem && stem !== file.basename) {
        const dir = file.parent && file.parent.path !== "/" ? file.parent.path : "";
        let candidate = stem;
        for (let n = 2; this.app.vault.getAbstractFileByPath(dir ? `${dir}/${candidate}.md` : `${candidate}.md`); n++) candidate = `${stem} ${n}`;
        proposal.rename = { from: file.path, to: dir ? `${dir}/${candidate}.md` : `${candidate}.md` };
      }
    }

    if (options.frontmatter && tagResult) {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
      const existing = frontmatterTags(fm?.tags);
      const merged = normalizeTags([...existing, ...tagResult.tags]);
      const addedTags = merged.filter((t) => !existing.includes(t));
      const newTags = addedTags.filter((t) => tagResult.newTags.includes(t));
      const summary = typeof fm?.summary === "string" && fm.summary.trim() ? "" : tagResult.summary;
      if (addedTags.length > 0 || summary) proposal.frontmatter = { tags: merged, summary, addedTags, newTags };
    }

    return { proposal, failed };
  }

  /** Apply the reviewed subset: content hunks, frontmatter, the finished-steps record, then the rename last. */
  private async applyEnrichDecision(
    file: TFile,
    content: string,
    proposal: EnrichProposal,
    decision: EnrichDecision,
    finished: TidyStep[],
    signal?: AbortSignal,
  ): Promise<void> {
    this.assertActive(signal);
    this.ensureCurrentNote(file);
    let reviewed = content;
    if (proposal.plan && decision.accepted.some(Boolean)) {
      const plan = proposal.plan;
      reviewed = applyPlan(content, plan, decision.accepted);
      await this.app.vault.process(file, (current) => { this.assertActive(signal); return applyPlan(current, plan, decision.accepted); });
    }
    if (proposal.frontmatter && decision.frontmatter) {
      const { addedTags, summary } = proposal.frontmatter;
      this.assertActive(signal);
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        this.assertActive(signal);
        const current = fm as Record<string, unknown>;
        current.tags = normalizeTags([...frontmatterTags(current.tags), ...addedTags]);
        if (summary && !current.summary) current.summary = summary;
      });
    }
    if (finished.length > 0) await this.recordTidy(file, finished, reviewed, signal);
    if (proposal.rename && decision.rename) {
      this.assertActive(signal);
      await this.app.fileManager.renameFile(file, proposal.rename.to);
    }
  }

  /**
   * Record the finished steps against the body Tidy reviewed, with the accepted
   * edits applied; text the user changed meanwhile keeps the note eligible.
   */
  private async recordTidy(file: TFile, finished: TidyStep[], reviewed: string, signal?: AbortSignal): Promise<void> {
    this.assertActive(signal);
    this.ensureCurrentNote(file);
    const hash = tidyBodyHash(reviewed);
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      const current = fm as Record<string, unknown>;
      current[TIDY_STEPS_KEY] = [...finished];
      current[TIDY_HASH_KEY] = hash;
    });
  }

  private ensureCurrentNote(file: TFile): void {
    if (this.app.vault.getAbstractFileByPath(file.path) !== file) {
      throw new Error("This note is no longer available. Reopen the note and try again.");
    }
  }

  /**
   * "/frontmatter": propose type / tags / summary for the ACTIVE note using the
   * utility model (reusing the vault's existing tags), preview it, and apply it
   * additively via processFrontMatter. Never clobbers fields the user already set
   * — tags union, scalar fields only filled when absent.
   */
  async suggestFrontmatterForActiveNote(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile) || file.extension !== "md") {
      new Notice("Open a note to suggest frontmatter for.");
      return;
    }
    const content = await this.app.vault.cachedRead(file);
    if (content.trim().length === 0) {
      new Notice("This note is empty — nothing to describe.");
      return;
    }

    const vocab = vaultVocabulary(this.app);
    const existingTags = selectPromptTags(vocab, content);
    const typeOptions = this.settings.ontologyEnabled ? [...(this.deps.ontology()?.resolved().keys() ?? [])] : [];
    const notice = beginActivity(this.activity, "Suggesting frontmatter…");
    let applying = false;
    try {
      const existingLine = existingTags.length > 0 ? `Existing tags (prefer these when relevant): ${existingTags.join(", ")}\n\n` : "";
      const body = content.length > 8000 ? content.slice(0, 8000) + "\n…[truncated]" : content;
      const { text: raw, provider } = await this.deps.router().complete("utility", {
        system: frontmatterSuggestSystem(typeOptions),
        user: `${existingLine}Document:\n\n${body}`,
        maxTokens: 200,
      });
      const suggestion = parseFrontmatterSuggestion(raw);

      // Merge additively against what's already in the note's frontmatter.
      const fm = (this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, unknown>;
      const currentTags = frontmatterTags(fm.tags);
      const resolved = resolveTags(suggestion.tags, vocab);
      const tags = normalizeTags([...currentTags, ...resolved.map((r) => r.tag)]);
      const addedTags = tags.filter((tag) => !currentTags.includes(tag));
      const proposal = {
        ...(suggestion.type && !fm.type ? { type: suggestion.type } : {}),
        tags,
        newTags: resolved.filter((r) => r.match === "new" && !currentTags.includes(r.tag)).map((r) => r.tag),
        ...(suggestion.summary && !fm.summary ? { summary: suggestion.summary } : {}),
      };
      notice.setMessage("Review suggested frontmatter");

      const apply = await new Promise<boolean>((resolve) => {
        new FrontmatterModal(this.app, file.basename, proposal, provider.label, resolve).open();
      });
      if (!apply) return;
      applying = true;
      this.ensureCurrentNote(file);
      await this.app.fileManager.processFrontMatter(file, (f) => {
        const rec = f as Record<string, unknown>;
        if (proposal.type && !rec.type) rec.type = proposal.type;
        rec.tags = normalizeTags([...frontmatterTags(rec.tags), ...addedTags]);
        if (proposal.summary && !rec.summary) rec.summary = proposal.summary;
      });
      new Notice(`Frontmatter updated: ${file.basename}`);
    } catch (e) {
      notice.fail(e);
      new Notice(`Couldn't ${applying ? "apply" : "suggest"} frontmatter: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      notice.finish();
    }
  }
}
