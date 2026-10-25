// Wires the knowledge cluster: semantic index, source enrichment, session memory and clippings.

import { htmlToMarkdown, Notice, Platform, requestUrl, TFile, normalizePath } from "obsidian";
import { cliSessionIds } from "../conversations/store";
import type ClaudeCompanionPlugin from "../main";
import { MemoryController } from "../memory/controller";
import { captureWebSource } from "../research/webCapture";
import { SemanticController } from "../semantic/controller";
import { ClippingsController } from "../sources/clippings";
import { SourceEnrichmentController } from "../sources/controller";
import { resolveTags } from "../tags/resolve";
import { vaultVocabulary } from "../tags/vaultTags";
import { ChoiceModal } from "../view/ChoiceModal";
import { SessionPicker } from "../view/SessionPicker";
import { requestUrlCaptureIo } from "../web/requestFetch";

/**
 * Mobile's native vault bridge expands a full-file read/write into several
 * Java and JS copies. A larger note can exceed Android's renderer heap even
 * though extraction sends only the first 8,000 characters to the model.
 */
const MOBILE_SOURCE_NOTE_MAX_BYTES = 5 * 1024 * 1024;
/** PDFs expand substantially during parsing; reject large mobile semantic
 * inputs before the native vault bridge creates its first binary copy. */
const MOBILE_SEMANTIC_PDF_MAX_BYTES = 10 * 1024 * 1024;

export type SemanticHost = Pick<
  ClaudeCompanionPlugin,
  "activity" | "app" | "deviceChatBusy" | "enrichDiagnostics" | "manifest" | "router" | "saveSettings" | "settings"
>;

export function buildSemantic(host: SemanticHost): SemanticController {
  return new SemanticController({
    settings: () => host.settings,
    saveSettings: () => host.saveSettings(),
    manifestDir: host.manifest.dir ?? `.obsidian/plugins/${host.manifest.id}`,
    manifestId: host.manifest.id,
    activity: () => host.activity,
    enrichDiagnostics: () => host.enrichDiagnostics,
    router: () => host.router(),
    isMobile: Platform.isMobile,
    deviceChatBusy: () => host.deviceChatBusy(),
    vault: {
      adapterSize: async (p) => (await host.app.vault.adapter.stat(p))?.size,
      adapterExists: (p) => host.app.vault.adapter.exists(p),
      adapterRead: (p) => host.app.vault.adapter.read(p),
      adapterWrite: (p, d) => host.app.vault.adapter.write(p, d),
      getMarkdownFiles: () => host.app.vault.getMarkdownFiles().map((f) => ({ path: f.path, mtime: f.stat.mtime, size: f.stat.size })),
      getPdfFiles: () => host.app.vault.getFiles().filter((f) => f.extension === "pdf").map((f) => ({ path: f.path, mtime: f.stat.mtime, size: f.stat.size })),
      getAbstractFileByPath: (p) => {
        const f = host.app.vault.getAbstractFileByPath(p);
        return f instanceof TFile ? { path: f.path, stat: { mtime: f.stat.mtime, size: f.stat.size } } : null;
      },
      cachedRead: (p) => {
        const f = host.app.vault.getAbstractFileByPath(p);
        return f instanceof TFile ? host.app.vault.cachedRead(f) : Promise.resolve("");
      },
      readBinary: (p) => {
        const f = host.app.vault.getAbstractFileByPath(p);
        if (!(f instanceof TFile)) return Promise.reject(new Error(`Not a file: ${p}`));
        return host.app.vault.readBinary(f);
      },
    },
    notice: (msg, timeout) => new Notice(msg, timeout),
    openChoiceModal: (opts) => new ChoiceModal(host.app, opts).open(),
    mobileSourceNoteMaxBytes: MOBILE_SOURCE_NOTE_MAX_BYTES,
    mobilePdfMaxBytes: MOBILE_SEMANTIC_PDF_MAX_BYTES,
  });
}

export type EnrichmentHost = Pick<
  ClaudeCompanionPlugin,
  "activity" | "app" | "enrichDiagnostics" | "optimize" | "router" | "saveSettings" | "semantic" | "settings" | "utilityRouting"
>;

export function buildEnrichment(host: EnrichmentHost): SourceEnrichmentController {
  return new SourceEnrichmentController({
    settings: () => host.settings,
    saveSettings: () => host.saveSettings(),
    isMobile: Platform.isMobile,
    mobileSourceNoteMaxBytes: MOBILE_SOURCE_NOTE_MAX_BYTES,
    enrichApp: host.app,
    ...(typeof DOMParser === "undefined" ? {} : { captureWeb: (url: string) => captureWebSource(url, requestUrlCaptureIo(requestUrl, htmlToMarkdown)) }),
    vault: {
      cachedRead: (path) => {
        const f = host.app.vault.getAbstractFileByPath(path);
        return f instanceof TFile ? host.app.vault.cachedRead(f) : Promise.resolve("");
      },
    },
    activity: () => host.activity,
    enrichDiagnostics: () => host.enrichDiagnostics,
    router: () => host.router(),
    resolveTags: (tags) => resolveTags(tags, vaultVocabulary(host.app)).map((r) => r.tag),
    suspendReindex: () => host.semantic().suspendReindex(),
    isUtilityLifecycleActive: (g) => host.utilityRouting().isLifecycleActive(g),
    assertUtilityLifecycleActive: (g) => host.utilityRouting().assertLifecycleActive(g),
    utilityLifecycleEnded: () => host.utilityRouting().isEnded(),
    utilityLifecycleGeneration: () => host.utilityRouting().lifecycleGeneration(),
    onEnrichQueueIdle: () => void host.optimize().checkTagMergesInBackground(),
    notice: (msg, timeout) => new Notice(msg, timeout),
    openChoiceModal: (opts) => { const m = new ChoiceModal(host.app, opts); m.open(); return m; },
  });
}

export type MemoryHost = Pick<ClaudeCompanionPlugin, "app" | "conversations" | "router" | "settings" | "vaultBasePath" | "views">;

export function buildMemory(host: MemoryHost): MemoryController {
  return new MemoryController({
    settings: () => host.settings,
    isMobile: Platform.isMobile,
    ingestApp: host.app,
    vaultBasePath: () => host.vaultBasePath(),
    vault: {
      markdownFilesUnder: (prefix) => host.app.vault.getMarkdownFiles()
        .filter((f) => f.path.startsWith(`${prefix}/`))
        .map((f) => ({ path: f.path, mtime: f.stat.mtime })),
      readContent: async (path) => {
        const f = host.app.vault.getAbstractFileByPath(path);
        return f instanceof TFile ? host.app.vault.cachedRead(f) : null;
      },
      writeContent: async (path, content) => {
        const f = host.app.vault.getAbstractFileByPath(path);
        if (f instanceof TFile) await host.app.vault.modify(f, content);
        else await host.app.vault.create(path, content);
      },
    },
    router: () => host.router(),
    excludedSessionIds: () => host.conversations().list().flatMap(cliSessionIds),
    getActiveConversation: () => host.conversations().getActive(),
    nodeSessionReader: async () => {
      const { nodeSessionReader, defaultProjectsRoot } = await import("../memory/nodeReader");
      return { reader: nodeSessionReader, defaultProjectsRoot };
    },
    notice: (msg, timeout) => new Notice(msg, timeout),
    refreshMemoryView: () => host.views().refreshMemoryView(),
    openFile: async (path) => {
      const f = host.app.vault.getAbstractFileByPath(path);
      if (f instanceof TFile) await host.app.workspace.getLeaf(false).openFile(f);
    },
    openSessionPicker: (sessions, onPick) => new SessionPicker(host.app, sessions, onPick).open(),
    normalizePath,
  });
}

export type ClippingsHost = Pick<
  ClaudeCompanionPlugin,
  "activity" | "app" | "enrichDiagnostics" | "enrichment" | "router" | "settings" | "utilityRouting"
>;

export function buildClippings(host: ClippingsHost): ClippingsController {
  return new ClippingsController({
    app: host.app,
    settings: () => host.settings,
    activity: () => host.activity,
    enrichment: () => host.enrichment(),
    router: () => host.router(),
    diagnostics: () => host.enrichDiagnostics,
    providerErrorHint: (message, provider) => host.utilityRouting().providerErrorHint(message, provider),
  });
}
