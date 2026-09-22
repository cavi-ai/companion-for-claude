import type { PluginSettings, ChatMessage } from "../types";
import type { SessionMeta, SessionReader } from "./sessions";
import { listSessionsForVault, excludeSessions } from "./sessions";
import { ingestSession, ingestConversation, type PersistDeps } from "./ingest";
import { selectDigests, buildConsolidationPrompt, parseConsolidation, renderMemoryNote, MEMORY_NOTE_BASENAME, type DigestSource } from "./consolidate";

export interface MemoryControllerDeps {
  settings: () => PluginSettings;
  isMobile: boolean;

  ingestApp: PersistDeps["app"];
  vaultBasePath: () => string | null;

  vault: {
    markdownFilesUnder(prefix: string): Array<{ path: string; mtime: number }>;
    readContent(path: string): Promise<string | null>;
    writeContent(path: string, content: string): Promise<void>;
  };

  router: () => {
    complete(role: string, opts: Record<string, unknown>): Promise<{ text: string; provider: { label: string } }>;
  };

  excludedSessionIds: () => string[];
  getActiveConversation: () => { id?: string; createdAt: number; updatedAt: number } | null;

  nodeSessionReader: () => Promise<{
    reader: SessionReader;
    defaultProjectsRoot: () => string;
  }>;

  notice: (msg: string, timeout?: number) => void;
  refreshMemoryView: () => Promise<void>;
  openFile: (path: string) => Promise<void>;
  openSessionPicker: (sessions: SessionMeta[], onPick: (s: SessionMeta) => void) => void;

  normalizePath: (path: string) => string;
}

export class MemoryController {
  constructor(private readonly deps: MemoryControllerDeps) {}

  async listVaultSessions(): Promise<SessionMeta[]> {
    const base = this.deps.vaultBasePath();
    if (!base || this.deps.isMobile) return [];
    const { reader, defaultProjectsRoot } = await this.deps.nodeSessionReader();
    return excludeSessions(
      await listSessionsForVault(reader, base, defaultProjectsRoot()),
      this.deps.excludedSessionIds(),
    );
  }

  async openSessionPicker(): Promise<void> {
    if (!this.deps.settings().memoryEnabled) {
      this.deps.notice("Session memory is disabled in settings.");
      return;
    }
    const sessions = await this.listVaultSessions();
    if (sessions.length === 0) {
      this.deps.notice(
        "No Claude Code sessions found for this vault. Run the `claude` CLI from this vault's folder, then capture.",
        8000,
      );
      return;
    }
    this.deps.openSessionPicker(sessions, (session) => {
      void this.captureSession(session);
    });
  }

  async captureSession(session: SessionMeta): Promise<void> {
    try {
      const res = await ingestSession(this.ingestDeps(), { id: session.id, path: session.path });
      this.deps.notice(`Captured session · ${res.redactions} secret${res.redactions === 1 ? "" : "s"} redacted`);
      await this.deps.refreshMemoryView();
      await this.deps.openFile(res.file.path);
      if (this.deps.settings().memoryAutoConsolidate) void this.consolidateMemory({ quiet: true });
    } catch (e) {
      console.error("[Claude Companion] session capture failed", e);
      this.deps.notice("Session capture failed — see console.");
    }
  }

  async consolidateMemory(opts?: { quiet?: boolean }): Promise<void> {
    const s = this.deps.settings();
    if (!s.memoryEnabled) {
      this.deps.notice("Turn on session memory in Companion settings first.");
      return;
    }
    const folder = this.deps.normalizePath(s.memoryFolder);
    const files = this.deps.vault.markdownFilesUnder(folder);
    const sources: DigestSource[] = [];
    for (const f of files) {
      const content = await this.deps.vault.readContent(f.path);
      if (content !== null) sources.push({ path: f.path, mtime: f.mtime, content });
    }
    const digests = selectDigests(sources);
    if (digests.length === 0) {
      if (!opts?.quiet) this.deps.notice("No session digests to consolidate yet — capture a session first.");
      return;
    }

    const memoryPath = this.deps.normalizePath(`${folder}/${MEMORY_NOTE_BASENAME}.md`);
    const existing = await this.deps.vault.readContent(memoryPath);

    if (!opts?.quiet) this.deps.notice(`Consolidating ${digests.length} session digest${digests.length === 1 ? "" : "s"}…`);
    try {
      const { text: raw, provider } = await this.deps.router().complete("utility", {
        system: "You maintain concise, factual memory notes. Output markdown only.",
        user: buildConsolidationPrompt(existing, digests.map((d) => d.content)),
        maxTokens: 4000,
        temperature: 0.2,
      });
      const body = parseConsolidation(raw);
      const note = renderMemoryNote(body, {
        updated: new Date().toISOString().slice(0, 10),
        digestCount: digests.length,
        baseTags: [...s.memoryBaseTags, "memory"],
      });
      await this.deps.vault.writeContent(memoryPath, note);
      this.deps.notice(`Memory consolidated → ${MEMORY_NOTE_BASENAME} (via ${provider.label}).`);
    } catch (e) {
      console.error("[Claude Companion] memory consolidation failed", e);
      if (!opts?.quiet) this.deps.notice(`Memory consolidation failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async captureLatestSession(): Promise<void> {
    const sessions = await this.listVaultSessions();
    if (sessions.length === 0) {
      this.deps.notice("No Claude Code session found for this vault to ingest.");
      return;
    }
    const latest = sessions[0];
    if (!latest) return;
    await this.captureSession(latest);
  }

  async captureConversation(messages: ChatMessage[]): Promise<void> {
    if (!this.deps.settings().memoryEnabled || messages.length === 0) return;
    const conv = this.deps.getActiveConversation();
    try {
      const meta = {
        ...(conv?.id !== undefined ? { sessionId: String(conv.id) } : {}),
        model: this.deps.settings().model,
        ...(conv ? { startedAt: new Date(conv.createdAt).toISOString(), endedAt: new Date(conv.updatedAt).toISOString() } : {}),
      };
      const res = await ingestConversation(
        { app: this.deps.ingestApp, folder: this.deps.settings().memoryFolder, baseTags: this.deps.settings().memoryBaseTags },
        messages,
        meta,
      );
      this.deps.notice(`Conversation captured to memory · ${res.redactions} secret${res.redactions === 1 ? "" : "s"} redacted`);
      await this.deps.refreshMemoryView();
    } catch (e) {
      console.error("[Claude Companion] conversation capture failed", e);
      this.deps.notice("Couldn't capture this conversation to memory — see console.");
    }
  }

  async reingestSession(sessionId: string): Promise<void> {
    const sessions = await this.listVaultSessions();
    const match = sessions.find((s) => (s.sessionId ?? s.id) === sessionId);
    if (!match) {
      this.deps.notice("Original session transcript not found on disk.");
      return;
    }
    await this.captureSession(match);
  }

  private ingestDeps() {
    const loader = this.deps.nodeSessionReader;
    return {
      app: this.deps.ingestApp,
      read: async (path: string) => {
        const { reader } = await loader();
        return reader.read(path);
      },
      folder: this.deps.settings().memoryFolder,
      baseTags: this.deps.settings().memoryBaseTags,
    };
  }
}
