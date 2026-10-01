import { Notice, TFile, type App } from "obsidian";
import { buildClaimSuggestionRequest, claimSuggestionEvidence, parseClaimSuggestion } from "../../research/claimSuggestion";
import { buildExtractionRequest, fitSourceText, parseExtraction, type SourceText } from "../../research/evidenceExtraction";
import type { ResearchSourceRecord } from "../../research/types";
import type { ResearchDeskRun } from "../../research/deskViewModel";
import { isStaleEvidence, type ProjectSnapshot } from "../../research/graph";
import { passageContext, pickClaimForReview, pickEvidenceForReview } from "../../research/reviewTargets";
import type { ResearchRepository } from "../../research/repository";
import type { WebCapture } from "../../research/webCapture";
import { parseClipUrl } from "../../sources/detect";
import type { ResearchWorkbenchTab } from "../ResearchWorkbenchView";
import { ClaimCreateModal, ClaimReviewModal } from "./claimModals";
import { EvidenceExtractModal, type PassageLoad } from "./evidenceExtractModal";
import { EvidenceReviewModal } from "./evidenceReviewModal";
import { OutlineCreateModal } from "./outlineModal";
import { ProjectCreateModal } from "./projectCreateModal";
import type { ProjectCreateInput, RewriteTextFn } from "./shared";
import { NotePickModal, SourceCaptureModal } from "./sourceCaptureModal";

export const MAX_RESEARCH_SOURCE_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_RESEARCH_SOURCE_BATCH_BYTES = 100 * 1024 * 1024;
const MAX_SUGGESTION_PASSAGES = 12;

export interface ResearchActionsDeps {
  app: App;
  repository: ResearchRepository;
  rewriteText?: RewriteTextFn;
  completeResearch?: (input: { system: string; user: string; maxTokens?: number }) => Promise<string>;
  researchLabel?: () => string;
  sourceText?: (source: ResearchSourceRecord) => Promise<SourceText | null>;
  captureWeb?: WebCapture;
  saveAsset?: (projectPath: string, name: string, data: ArrayBuffer) => Promise<string>;
  suggestTags?: (content: string) => Promise<string[]>;
  openPath(path: string): Promise<void>;
  changed(): Promise<void>;
  openWorkbench(projectPath: string, tab: ResearchWorkbenchTab, path?: string): Promise<void>;
  selectProject(path: string): Promise<void>;
}

export class ResearchActions {
  constructor(private readonly deps: ResearchActionsDeps) {}

  createProject(initial?: Partial<ProjectCreateInput>): void {
    new ProjectCreateModal(this.deps.app, async (input) => {
      const record = await this.deps.repository.createProject(input);
      await this.deps.selectProject(record.path);
    }, this.deps.rewriteText, initial).open();
  }

  addSource(project: string): void {
    new SourceCaptureModal(this.deps.app, {
      captureUrl: async (url) => {
        const captureWeb = this.deps.captureWeb;
        if (!captureWeb) throw new Error("Web capture is unavailable in this environment.");
        const result = await captureWeb(url);
        if (!result) throw new Error("Couldn't extract readable content from that URL — paste the text into a note and import the note instead.");
        const title = result.title ?? new URL(url).hostname;
        const res = await this.deps.repository.importSource(project, { title, sourceKind: "web", url, capturedContent: result.markdown, ...(result.author ? { authors: [result.author] } : {}), ...(result.published ? { published: result.published } : {}) });
        if (res.kind === "duplicate") { await this.deps.changed(); return `Already in the library: ${title}`; }
        let tagNote = "";
        const suggest = this.deps.suggestTags;
        if (suggest) {
          try {
            const tags = await suggest(result.markdown);
            const file = this.deps.app.vault.getAbstractFileByPath(res.path);
            if (file instanceof TFile && tags.length) {
              await this.deps.app.fileManager.processFrontMatter(file, (fm) => {
                const record = fm as Record<string, unknown>;
                const raw = record.tags;
                const existing: string[] = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? [raw] : [];
                record.tags = [...new Set([...existing, ...tags])];
              });
              tagNote = ` · tags: ${tags.join(", ")}`;
            }
          } catch { /* tagging is best-effort */ }
        }
        await this.deps.changed();
        return `Clipped “${title}”${tagNote}`;
      },
      importFiles: async (files) => {
        const saveAsset = this.deps.saveAsset;
        if (!saveAsset) throw new Error("File import is unavailable in this environment.");
        const oversized = files.find(({ size }) => size > MAX_RESEARCH_SOURCE_FILE_BYTES);
        if (oversized) throw new Error(`${oversized.name} is too large. Research source files are limited to 25 MiB each.`);
        const batchBytes = files.reduce((total, { size }) => total + size, 0);
        if (batchBytes > MAX_RESEARCH_SOURCE_BATCH_BYTES) throw new Error("The selected files exceed the 100 MiB research import limit.");
        const imported: string[] = [];
        for (const file of files) {
          const ext = (file.name.split(".").pop() ?? "").toLowerCase();
          const base = file.name.replace(/\.[^.]+$/, "");
          const data = await file.read();
          if (ext === "md") {
            const text = new TextDecoder().decode(data);
            const clipUrl = parseClipUrl(text);
            const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
            const res = await this.deps.repository.importSource(project, { title: base, sourceKind: "vault", capturedContent: body.slice(0, 50000), ...(clipUrl ? { url: clipUrl } : {}) });
            if (res.kind === "created") imported.push(base);
            continue;
          }
          const asset = await saveAsset(project, file.name, data);
          const res = await this.deps.repository.importSource(project, { title: base, sourceKind: ext === "pdf" ? "pdf" : "vault", asset, capturedContent: new Uint8Array(data) });
          if (res.kind === "created") imported.push(base);
        }
        await this.deps.changed();
        return imported.length ? `Imported ${imported.map((n) => `“${n}”`).join(", ")}` : "Those files are already in the library.";
      },
      pickNote: () => new Promise<string | null>((resolve) => {
        new NotePickModal(this.deps.app, (file) => {
          void (async () => {
            try {
              const content = await this.deps.app.vault.cachedRead(file);
              const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
              const clipUrl = parseClipUrl(content);
              const res = await this.deps.repository.importSource(project, { title: file.basename, sourceKind: "vault", capturedContent: body.slice(0, 50000), ...(clipUrl ? { url: clipUrl } : {}) });
              await this.deps.changed();
              resolve(res.kind === "duplicate" ? `Already in the library: ${file.basename}` : `Imported note: ${file.basename}`);
            } catch (e) {
              // Resolve (not reject) so the capture modal leaves its busy state.
              resolve(`Couldn’t import ${file.basename}: ${e instanceof Error ? e.message : String(e)}`);
            }
          })();
        }, () => resolve(null)).open();
      }),
    }).open();
  }

  extractEvidence(snapshot: ProjectSnapshot, sourcePath?: string): void {
    if (!snapshot.sources.length) { this.addSource(snapshot.project.path); return; }
    const withEvidence = new Set(snapshot.evidence.map(({ source }) => source));
    const initial = snapshot.sources.find(({ path }) => path === sourcePath) ?? snapshot.sources.find(({ path }) => !withEvidence.has(path)) ?? snapshot.sources[0]!;
    const { completeResearch, sourceText } = this.deps;
    const label = this.deps.researchLabel?.();
    const load = async (path: string): Promise<PassageLoad> => {
      const source = snapshot.sources.find((candidate) => candidate.path === path);
      if (!source) return { kind: "none" };
      const text = sourceText ? await sourceText(source) : null;
      if (!text || !text.text.trim()) return { kind: "no-text" };
      if (!completeResearch) return { kind: "failed", reason: "Research AI is off." };
      const fitted = fitSourceText(text.text, snapshot.project.question);
      const request = buildExtractionRequest({ question: snapshot.project.question, sourceTitle: source.title, text: fitted.text, trimmed: fitted.trimmed });
      const raw = await completeResearch({ ...request, maxTokens: 2000 });
      const passages = parseExtraction(raw, text, snapshot.evidence.filter((item) => item.source === path).map(({ excerpt }) => excerpt));
      return passages.length ? { kind: "passages", passages } : { kind: "none" };
    };
    new EvidenceExtractModal(this.deps.app, {
      sources: snapshot.sources,
      initialSource: initial.path,
      ...(label ? { label } : {}),
      load,
      create: async (passage) => { await this.deps.repository.createEvidence({ project: snapshot.project.path, ...passage }); },
      changed: () => this.deps.changed(),
    }).open();
  }

  reviewEvidence(snapshot: ProjectSnapshot, path?: string): void {
    const evidence = pickEvidenceForReview(snapshot, path);
    if (!evidence) { new Notice("No passages need checking."); return; }
    const source = snapshot.sources.find((candidate) => candidate.path === evidence.source);
    const stale = isStaleEvidence(evidence, source);
    const label = this.deps.researchLabel?.();
    const context = stale ? passageContext(source, evidence.excerpt) : undefined;
    new EvidenceReviewModal(this.deps.app, {
      evidence,
      stale,
      ...(context !== undefined ? { context } : {}),
      submit: async ({ state, interpretation, locator }) => {
        if (locator) await this.deps.repository.updateEvidenceLocator(evidence.path, locator.kind, locator.value);
        if (interpretation) await this.deps.repository.updateEvidenceInterpretation(evidence.path, interpretation);
        await this.deps.repository.reviewEvidence(evidence.path, state);
        await this.deps.changed();
      },
      openNote: () => this.deps.openPath(evidence.path),
      ...(this.deps.rewriteText ? { rewriteText: this.deps.rewriteText } : {}),
      ...(label ? { label } : {}),
    }).open();
  }

  reviewClaim(snapshot: ProjectSnapshot, path?: string): void {
    const claim = pickClaimForReview(snapshot, path);
    if (!claim) { new Notice("No claims need checking."); return; }
    const linked = new Set([...claim.supporting, ...claim.challenging, ...claim.contextual]);
    const label = this.deps.researchLabel?.();
    new ClaimReviewModal(this.deps.app, {
      claim,
      evidence: snapshot.evidence,
      linkable: snapshot.evidence.filter((item) => item.reviewState === "reviewed" && !linked.has(item.path)),
      submit: async ({ state, limitation, link }) => {
        for (const evidencePath of link) await this.deps.repository.linkClaimEvidence(snapshot.project.path, claim.path, evidencePath, "supports");
        await this.deps.repository.reviewClaim(claim.path, state, limitation);
        await this.deps.changed();
      },
      openNote: () => this.deps.openPath(claim.path),
      ...(this.deps.rewriteText ? { rewriteText: this.deps.rewriteText } : {}),
      ...(label ? { label } : {}),
    }).open();
  }

  createClaim(snapshot: ProjectSnapshot): void {
    const reviewed = snapshot.evidence.filter(({ reviewState }) => reviewState === "reviewed");
    if (!reviewed.length) { new Notice("Check at least one passage before creating a claim."); return; }
    const first = claimSuggestionEvidence(snapshot);
    const ordered = [...first, ...reviewed.filter((item) => !first.includes(item))];
    const offered = ordered.slice(0, MAX_SUGGESTION_PASSAGES);
    const complete = this.deps.completeResearch;
    const label = this.deps.researchLabel?.();
    new ClaimCreateModal(this.deps.app, {
      evidence: ordered,
      submit: async (input) => { await this.deps.repository.createClaim({ project: snapshot.project.path, ...input, reviewState: "reviewed" }); await this.deps.changed(); },
      ...(this.deps.rewriteText ? { rewriteText: this.deps.rewriteText } : {}),
      ...(complete ? {
        suggest: async () => {
          const request = buildClaimSuggestionRequest(snapshot.project.question, offered.map(({ path, title, excerpt, interpretation }) => ({ path, title, excerpt, ...(interpretation ? { interpretation } : {}) })));
          return parseClaimSuggestion(await complete({ ...request, maxTokens: 800 }), new Set(offered.map(({ path }) => path)));
        },
      } : {}),
      ...(label ? { label } : {}),
    }).open();
  }

  buildOutline(snapshot: ProjectSnapshot): void {
    const existing = snapshot.documents.find(({ documentKind }) => documentKind === "outline");
    if (existing) { void this.deps.openPath(existing.path); return; }
    const eligible = snapshot.claims.filter(({ reviewState, supporting }) => reviewState === "reviewed" && supporting.length > 0);
    if (!eligible.length) { new Notice("Check a claim that has support before building an outline."); return; }
    new OutlineCreateModal(this.deps.app, eligible, async (claimPaths) => {
      const outline = await this.deps.repository.createOutline(snapshot.project.path, claimPaths);
      await this.deps.changed();
      await this.deps.openPath(outline.path);
    }).open();
  }

  async run(action: { run: ResearchDeskRun; path?: string }, snapshot: ProjectSnapshot): Promise<void> {
    const project = snapshot.project.path;
    switch (action.run) {
      case "add-source": this.addSource(project); return;
      case "extract-evidence": this.extractEvidence(snapshot, action.path !== project ? action.path : undefined); return;
      case "review-evidence": this.reviewEvidence(snapshot, action.path); return;
      case "review-claim": this.reviewClaim(snapshot, action.path); return;
      case "create-claim": this.createClaim(snapshot); return;
      case "build-outline": this.buildOutline(snapshot); return;
      case "continue-draft": await this.deps.openWorkbench(project, "Draft", action.path); return;
      case "audit": await this.deps.openWorkbench(project, "Audit"); return;
      case "open-record": if (action.path) await this.deps.openPath(action.path); return;
    }
  }
}
