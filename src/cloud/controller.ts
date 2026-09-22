import { type CloudDispatchConfig, buildFireRequest, parseFireResponse, composeDispatchText, configError } from "./routines";
import { type RepliesConfig, buildContentsRequest, parseDirListing, parseFileResponse, isMarkdown, configError as repliesConfigError } from "./replies";
import type { CloudBuildHttpRequest } from "../build/cloudExecutor";
import type { PluginSettings } from "../types";
import { errorHint } from "../providers/errorHints";

export interface CloudControllerDeps {
  settings: () => PluginSettings;
  http: (req: { url: string; method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; text: string }>;
  vault: {
    fileExists: (path: string) => boolean;
    create: (path: string, content: string) => Promise<void>;
    ensureFolder: (folder: string) => Promise<void>;
    normalizePath: (path: string) => string;
  };
  ui: {
    notice: (message: string, timeout?: number) => { hide: () => void };
    clipboard: (text: string) => Promise<void>;
    activeSelection: () => { path: string | undefined; selection: string | undefined };
    promptInstruction: (context: string | undefined, onSubmit: (instruction: string) => void) => void;
  };
}

export class CloudController {
  constructor(private deps: CloudControllerDeps) {}

  dispatchConfig(): CloudDispatchConfig {
    const s = this.deps.settings();
    return {
      fireUrl: s.cloudRoutineFireUrl,
      token: s.cloudRoutineToken,
      betaHeader: s.cloudRoutineBetaHeader,
    };
  }

  repliesConfig(): RepliesConfig {
    const s = this.deps.settings();
    return {
      repo: s.cloudReplyRepo,
      branch: s.cloudReplyBranch,
      folder: s.cloudReplyFolder,
      token: s.cloudReplyToken,
    };
  }

  async httpRequest(request: CloudBuildHttpRequest): Promise<{ status: number; text: string }> {
    return this.deps.http(request);
  }

  async dispatchSession(): Promise<void> {
    if (!this.deps.settings().cloudDispatchEnabled) {
      this.deps.ui.notice("Cloud session dispatch is off. Enable it in Companion settings → Cloud session.", 7000);
      return;
    }
    const cfgErr = configError(this.dispatchConfig());
    if (cfgErr) {
      this.deps.ui.notice(`Cloud session not configured: ${cfgErr}`, 9000);
      return;
    }
    const { path, selection } = this.deps.ui.activeSelection();
    const parts: string[] = [];
    if (path) parts.push(`Active note: ${path}`);
    if (selection) parts.push(`Selected text:\n${selection}`);
    const context = parts.length ? parts.join("\n\n") : undefined;

    this.deps.ui.promptInstruction(context, (instruction) => void this.fireSession(instruction, context));
  }

  private async fireSession(instruction: string, context?: string): Promise<void> {
    const pending = this.deps.ui.notice("Dispatching cloud session…", 0);
    try {
      const req = buildFireRequest(this.dispatchConfig(), composeDispatchText(instruction, context));
      const res = await this.deps.http({ url: req.url, method: req.method, headers: req.headers, body: req.body });
      const result = parseFireResponse(res.status, res.text);
      pending.hide();
      if (result.sessionUrl) {
        await this.deps.ui.clipboard(result.sessionUrl).catch(() => {});
        this.deps.ui.notice(`Cloud session started — link copied to clipboard:\n${result.sessionUrl}`, 12000);
      } else {
        this.deps.ui.notice("Cloud session fired. (No session link was returned.)", 8000);
      }
    } catch (e) {
      pending.hide();
      const msg = e instanceof Error ? e.message : String(e);
      const hint = errorHint(msg, "anthropic");
      this.deps.ui.notice(`Cloud dispatch failed: ${msg}${hint ? ` — ${hint}` : ""}`, 10000);
    }
  }

  async testReplies(): Promise<{ ok: boolean; message: string }> {
    const cfg = this.repliesConfig();
    const cfgErr = repliesConfigError(cfg);
    if (cfgErr) return { ok: false, message: cfgErr };
    try {
      const req = buildContentsRequest(cfg, cfg.folder);
      const res = await this.deps.http({ url: req.url, method: req.method, headers: req.headers });
      const files = parseDirListing(res.status, res.text);
      return { ok: true, message: `Connected — ${files.length} file${files.length === 1 ? "" : "s"} in "${cfg.folder}" on ${cfg.branch}.` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const hint = errorHint(msg, "anthropic");
      return { ok: false, message: `${msg}${hint ? ` — ${hint}` : ""}` };
    }
  }

  async pullReplies(): Promise<void> {
    const cfg = this.repliesConfig();
    const cfgErr = repliesConfigError(cfg);
    if (cfgErr) {
      this.deps.ui.notice(`Cloud replies not configured: ${cfgErr}`, 9000);
      return;
    }
    const pending = this.deps.ui.notice("Checking for cloud replies…", 0);
    try {
      const list = buildContentsRequest(cfg, cfg.folder);
      const listRes = await this.deps.http({ url: list.url, method: list.method, headers: list.headers });
      const files = parseDirListing(listRes.status, listRes.text).filter((f) => isMarkdown(f.name));
      let pulled = 0;
      let failed = 0;
      for (const f of files) {
        if (this.deps.vault.fileExists(this.deps.vault.normalizePath(f.path))) continue;
        try {
          const fileReq = buildContentsRequest(cfg, f.path);
          const fileRes = await this.deps.http({ url: fileReq.url, method: fileReq.method, headers: fileReq.headers });
          const got = parseFileResponse(fileRes.status, fileRes.text);
          const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
          if (dir) await this.deps.vault.ensureFolder(this.deps.vault.normalizePath(dir));
          await this.deps.vault.create(this.deps.vault.normalizePath(f.path), got.text);
          pulled++;
        } catch (error) {
          failed++;
          console.warn("[companion] cloud reply skipped", f.path, error);
        }
      }
      pending.hide();
      const pulledMsg = pulled > 0 ? `Pulled ${pulled} cloud repl${pulled === 1 ? "y" : "ies"} into the vault.` : "No new cloud replies.";
      const failedMsg = failed > 0 ? ` ${failed} couldn't be pulled (see console).` : "";
      this.deps.ui.notice(pulledMsg + failedMsg, 7000);
    } catch (e) {
      pending.hide();
      const msg = e instanceof Error ? e.message : String(e);
      const hint = errorHint(msg, "anthropic");
      this.deps.ui.notice(`Couldn't pull cloud replies: ${msg}${hint ? ` — ${hint}` : ""}`, 10000);
    }
  }
}
