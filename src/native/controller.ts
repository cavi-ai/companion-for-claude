import { Notice, Platform, Plugin } from "obsidian";
import { ensureVaultFolder } from "../vault/vaultFiles";
import { NATIVE_JOB_FOLDER, NATIVE_MAX_FILE_BYTES, NATIVE_MODEL, validNativeID,
  validateNativeRequest, validateNativeResult } from "./handoff";

/** Finish requests from older installs without offering an outbound app switch. */
export function registerNativeResultImport(plugin: Plugin): void {
  if (!Platform.isIosApp) return;
  const controller = new NativeHandoffController(plugin);
  plugin.registerObsidianProtocolHandler("claude-companion-native-result", (params) => {
    void controller.receive(params.id ?? "").catch((e: unknown) => new Notice(e instanceof Error ? e.message : String(e)));
  });
}

export class NativeHandoffController {
  private imports = new Map<string, Promise<void>>();
  constructor(private plugin: Plugin) {}
  private folder(): string { return `${this.plugin.app.vault.configDir}/plugins/claude-companion/${NATIVE_JOB_FOLDER}`; }

  receive(id: string): Promise<void> {
    if (!validNativeID(id)) return Promise.reject(new Error("Invalid native result identifier."));
    const existing = this.imports.get(id);
    if (existing) return existing;
    const operation = this.importResult(id).finally(() => this.imports.delete(id));
    this.imports.set(id, operation);
    return operation;
  }

  private async read(path: string): Promise<unknown> {
    const adapter = this.plugin.app.vault.adapter;
    const stat = await adapter.stat(path);
    if (!stat || stat.type !== "file" || stat.size > NATIVE_MAX_FILE_BYTES) throw new Error("Native handoff is missing or exceeds the supported size.");
    const body = await adapter.read(path);
    if (new TextEncoder().encode(body).length > NATIVE_MAX_FILE_BYTES) throw new Error("Native handoff exceeds the supported size.");
    return JSON.parse(body) as unknown;
  }

  private async importResult(id: string): Promise<void> {
    const now = Date.now() / 1000;
    const requestPath = `${this.folder()}/${id}.request.json`;
    const resultPath = `${this.folder()}/${id}.result.json`;
    const request = validateNativeRequest(await this.read(requestPath), now);
    if (request.id !== id || request.vaultName !== this.plugin.app.vault.getName()) throw new Error("Native result belongs to another vault or request.");
    const raw = await this.read(resultPath);
    const output = validateNativeResult(raw, request, now);
    const result = raw as { instruction: string };
    const body = ["# On-device MLX result", "", `Source: [[${request.sourcePath.replace(/\]/g, "")}]]`, "",
      `Model: ${NATIVE_MODEL.repo}`, "", "## Instruction", "", result.instruction, "", "## Result", "", output, ""].join("\n");
    const folder = "Claude/MLX";
    const path = `${folder}/MLX ${id}.md`;
    await ensureVaultFolder(this.plugin.app, folder);
    let file = this.plugin.app.vault.getFileByPath(path);
    if (file) {
      if (await this.plugin.app.vault.read(file) !== body) throw new Error("The existing native result note was edited; it will not be overwritten.");
    } else { file = await this.plugin.app.vault.create(path, body); }
    await this.plugin.app.workspace.getLeaf(false).openFile(file);
    // Keep request/result through the atomic note creation so retries can recover;
    // delete the transient passage copy after a successful idempotent import.
    await this.plugin.app.vault.adapter.remove(resultPath);
    await this.plugin.app.vault.adapter.remove(requestPath);
    new Notice("Native MLX result imported. The source note was preserved.");
  }
}
