// The command palette surface as data. Every entry reaches the plugin through
// `CommandActions`, so the ids, names, and availability rules are testable
// without an Obsidian app and main.ts keeps only the wiring.

import { MarkdownView, type Command, type Editor, type MarkdownFileInfo, type TFile } from "obsidian";

/** What the command set needs from the plugin. */
export interface CommandActions {
  /** The markdown file a file-scoped command would act on, if any. */
  activeMarkdownFile(): TFile | null;
  /** The last markdown file seen, used where a command survives losing focus. */
  lastMarkdownFile(): TFile | null;
  hasActiveConversation(): boolean;
  sourceCaptureEnabled(): boolean;
  ontologyEnabled(): boolean;
  /** Session capture reads Claude Code's CLI transcripts off disk — desktop only. */
  desktop: boolean;

  openChat(): void;
  newChat(): void;
  generatePlanFromNote(): void;
  generateArtifactFromContext(): void;
  rewriteSelection(editor: Editor, view: MarkdownView): void;
  enrichNote(file: TFile): void;
  enableVaultSearch(): void;
  rebuildSemanticIndex(): void;
  openRelatedNotes(): void;
  openResearchDesk(): void;
  openResearchWorkbench(): void;
  triageClippings(): void;
  startResearchFromActiveNote(): void;
  showSemanticIndexStatus(): void;
  browseConversations(): void;
  deleteActiveConversation(): void;
  handoffToBuild(): void;
  markNoteAsPlan(file: TFile): void;
  organizeClippings(): void;
  dispatchCloudSession(): void;
  pullCloudReplies(): void;
  reviewLinkSuggestions(): void;
  openWorkflowPicker(): void;
  createPromptTemplate(): void;
  openSessionPicker(): void;
  openMemoryView(): void;
  consolidateMemory(): void;
  enrichNoteAsSource(file: TFile): void;
  openSourceInbox(): void;
  exportClipperTemplates(): void;
  seedOntology(): void;
}

/** A command that only applies to the note in front of the user. */
function onActiveFile(id: string, name: string, actions: CommandActions, run: (file: TFile) => void): Command {
  return {
    id,
    name,
    checkCallback: (checking) => {
      const file = actions.activeMarkdownFile();
      if (checking) return !!file;
      if (file) run(file);
      return true;
    },
  };
}

/** A command gated on a setting rather than on the active note. */
function whenEnabled(id: string, name: string, enabled: () => boolean, run: () => void): Command {
  return {
    id,
    name,
    checkCallback: (checking) => {
      if (checking) return enabled();
      run();
      return true;
    },
  };
}

/** Every command Companion registers, in palette-registration order. */
export function companionCommands(actions: CommandActions): Command[] {
  const commands: Command[] = [
    { id: "open-chat", name: "Open chat panel", callback: () => actions.openChat() },
    { id: "new-chat", name: "New chat", callback: () => actions.newChat() },
    onActiveFile("plan-from-note", "Generate implementation plan from current note", actions, () => actions.generatePlanFromNote()),
    { id: "artifact-from-selection", name: "Turn selection / note into a beautiful artifact", callback: () => actions.generateArtifactFromContext() },
    {
      id: "rewrite-selection",
      name: "Rewrite selection with Claude…",
      editorCheckCallback: (checking: boolean, editor: Editor, view: MarkdownView | MarkdownFileInfo) => {
        const has = editor.getSelection().trim().length > 0 && view instanceof MarkdownView && !!view.file;
        if (checking) return has;
        actions.rewriteSelection(editor, view as MarkdownView);
        return true;
      },
    },
    onActiveFile("enrich-note", "Enrich current note with Claude… (rename, tags, links, lint)", actions, (file) => actions.enrichNote(file)),
    { id: "ask-vault", name: "Ask Claude about my vault (search-augmented)", callback: () => actions.enableVaultSearch() },
    { id: "rebuild-semantic-index", name: "Rebuild semantic index (local embeddings)", callback: () => actions.rebuildSemanticIndex() },
    { id: "open-related-notes", name: "Open related notes panel", callback: () => actions.openRelatedNotes() },
    { id: "open-research-desk", name: "Open research desk", callback: () => actions.openResearchDesk() },
    { id: "open-research-workbench", name: "Open advanced research workbench", callback: () => actions.openResearchWorkbench() },
    { id: "triage-clippings", name: "Triage clippings folder into research themes", callback: () => actions.triageClippings() },
    {
      id: "research-from-active-note",
      name: "Start research project from active note",
      // Survives losing focus to the desk itself, so it falls back to the last note.
      checkCallback: (checking) => {
        const file = actions.activeMarkdownFile() ?? actions.lastMarkdownFile();
        if (checking) return !!file;
        actions.startResearchFromActiveNote();
        return true;
      },
    },
    { id: "semantic-index-status", name: "Semantic index status", callback: () => actions.showSemanticIndexStatus() },
    { id: "browse-conversations", name: "Resume a past conversation", callback: () => actions.browseConversations() },
    whenEnabled("delete-active-conversation", "Delete the current conversation", () => actions.hasActiveConversation(), () => actions.deleteActiveConversation()),
    onActiveFile("build-from-plan", "Build current plan with Claude", actions, () => actions.handoffToBuild()),
    onActiveFile("mark-note-as-plan", "Mark current note as a plan (adds type: plan + Build icon)", actions, (file) => actions.markNoteAsPlan(file)),
    { id: "organize-clippings", name: "Organize clippings (rename, tag, sort into folders)", callback: () => actions.organizeClippings() },
    { id: "dispatch-cloud-session", name: "Send to cloud Claude session (mobile-friendly)", callback: () => actions.dispatchCloudSession() },
    { id: "pull-cloud-replies", name: "Pull cloud session replies into the vault", callback: () => actions.pullCloudReplies() },
    { id: "review-link-suggestions", name: "Review link suggestions for current note", callback: () => actions.reviewLinkSuggestions() },
    { id: "open-workflows", name: "Run a vault workflow… (manifests, rollup, MOC, digest)", callback: () => actions.openWorkflowPicker() },
    { id: "create-prompt-template", name: "Create prompt template", callback: () => actions.createPromptTemplate() },
  ];

  if (actions.desktop) {
    commands.push({ id: "capture-session-memory", name: "Capture session memory…", callback: () => actions.openSessionPicker() });
  }

  commands.push(
    { id: "open-memory-view", name: "Open session memory", callback: () => actions.openMemoryView() },
    { id: "consolidate-memory", name: "Consolidate session memory into knowledge note", callback: () => actions.consolidateMemory() },
    {
      id: "enrich-note-as-source",
      name: "Enrich note as source (typed frontmatter)",
      checkCallback: (checking) => {
        const file = actions.activeMarkdownFile();
        if (checking) return actions.sourceCaptureEnabled() && !!file;
        if (file) actions.enrichNoteAsSource(file);
        return true;
      },
    },
    { id: "open-source-inbox", name: "Open source inbox (clip triage)", callback: () => actions.openSourceInbox() },
    whenEnabled("export-clipper-templates", "Export Web Clipper templates (typed clipping)", () => actions.sourceCaptureEnabled(), () => actions.exportClipperTemplates()),
    whenEnabled("seed-ontology", "Seed ontology (default type schemas)", () => actions.ontologyEnabled(), () => actions.seedOntology()),
  );

  return commands;
}
