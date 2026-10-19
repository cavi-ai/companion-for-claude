// Per-note vault flows: link suggestions, "Tidy with Claude", and frontmatter suggestions.
// Every flow proposes first and writes only what the user accepts.

import { Notice, TFile, TFolder, type App } from "obsidian";
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
import { UtilityUnavailableError } from "../providers/endpointPolicy";
import type { ProviderRouter } from "../providers/router";
import { resolveTags } from "../tags/resolve";
import { selectPromptTags } from "../tags/vocabulary";
import { vaultVocabulary } from "../tags/vaultTags";
import type { PluginSettings } from "../types";
import { BatchDiffModal } from "../view/BatchDiffModal";
import { DiffModal } from "../view/DiffModal";
import { EnrichOptionsModal, EnrichReviewModal, type EnrichDecision, type EnrichOptions, type EnrichProposal } from "../view/EnrichModal";
import { FrontmatterModal } from "../view/FrontmatterModal";
import { LINT_SYSTEM, buildLintUser, lintMaxTokens, parseLintResponse } from "./noteEnrich";

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

export class NoteFlows {
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
      select: (plans) => new Promise((resolve) => {
        new BatchDiffModal(this.app, plans, resolve).open();
      }),
    });
  }

  /**
   * Enrich one note end to end (file-explorer right-click / command): pick the
   * steps (all on by default), then summarize → propose rename + tags/summary,
   * wikilink unlinked mentions, and copyedit — all presented for review as
   * per-item checkboxes + diff hunks before anything is written.
   */
  async enrichNoteFlow(file: TFile, presetOptions?: EnrichOptions): Promise<void> {
    const options =
      presetOptions ?? (await new Promise<EnrichOptions | null>((resolve) => new EnrichOptionsModal(this.app, 1, resolve).open()));
    if (!options) return;

    const progress = beginActivity(this.activity, `Tidying ${file.basename}…`);
    try {
      const proposal = await this.buildEnrichProposal(file, options);
      const failures = proposal.failures?.map(({ step, message }) => `${step}: ${message}`).join("\n");
      if (failures) progress.fail(failures);
      if (!proposal.rename && !proposal.frontmatter && !proposal.plan) {
        new Notice(failures ? `Tidy couldn't finish ${file.basename}.\n${failures}\nRun Tidy again to retry.` : `${file.basename} is already in good shape.`, failures ? 12000 : 6000);
        return;
      }
      progress.setMessage("Review proposed changes");
      const decision = await new Promise<EnrichDecision | null>((resolve) =>
        new EnrichReviewModal(this.app, proposal, resolve).open(),
      );
      if (!decision) return;
      await this.applyEnrichDecision(file, proposal, decision);
      new Notice(failures ? `Applied selected changes to ${file.basename}. Some Tidy steps failed; run Tidy again to retry.` : `Tidied ${file.basename}.`, failures ? 12000 : 6000);
    } catch (e) {
      progress.fail(e);
      new Notice(`Tidy failed — ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      progress.finish();
    }
  }

  /** Batch variant for a folder: one step picker, then per-note review modals. */
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
    const options = await new Promise<EnrichOptions | null>((resolve) => new EnrichOptionsModal(this.app, files.length, resolve).open());
    if (!options) return;
    for (const file of files) {
      await this.enrichNoteFlow(file, options);
    }
  }

  /** Compute everything an enrich pass can propose for one note (no writes). */
  private async buildEnrichProposal(file: TFile, options: EnrichOptions): Promise<EnrichProposal> {
    const content = await this.app.vault.cachedRead(file);
    const proposal: EnrichProposal = { path: file.path };

    let tagResult: { title: string; tags: string[]; newTags: string[]; summary: string } | null = null;
    if (options.rename || options.frontmatter) {
      try {
        tagResult = await summarizeAndTag(this.deps.router(), content, vaultVocabulary(this.app));
      } catch (e) {
        if (e instanceof UtilityUnavailableError) throw e;
        const step = [options.rename ? "Rename note" : "", options.frontmatter ? "Tags & summary" : ""].filter(Boolean).join(" / ");
        (proposal.failures ??= []).push({ step, message: e instanceof Error ? e.message : String(e) });
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
        });
        body = parseLintResponse(text, body) ?? body;
      } catch (e) {
        (proposal.failures ??= []).push({ step: "Lint note", message: e instanceof Error ? e.message : String(e) });
      }
    }
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

    return proposal;
  }

  /** Apply the reviewed subset: content hunks, frontmatter, then the rename last. */
  private async applyEnrichDecision(
    file: TFile,
    proposal: EnrichProposal,
    decision: EnrichDecision,
  ): Promise<void> {
    this.ensureCurrentNote(file);
    if (proposal.plan && decision.accepted.some(Boolean)) {
      const plan = proposal.plan;
      await this.app.vault.process(file, (current) => applyPlan(current, plan, decision.accepted));
    }
    if (proposal.frontmatter && decision.frontmatter) {
      const { addedTags, summary } = proposal.frontmatter;
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        const current = fm as Record<string, unknown>;
        current.tags = normalizeTags([...frontmatterTags(current.tags), ...addedTags]);
        if (summary && !current.summary) current.summary = summary;
      });
    }
    if (proposal.rename && decision.rename) {
      await this.app.fileManager.renameFile(file, proposal.rename.to);
    }
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
