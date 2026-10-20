import { App, TFile, normalizePath } from "obsidian";
import type { McpToolDef, ToolResult } from "../protocol";
import type { ToolRecord } from "../toolRecord";
import { ensureVaultFolder } from "../../vault/vaultFiles";
import { hasPathTraversal } from "../../paths";

type Run = (args: Record<string, unknown>) => Promise<ToolResult>;

export const read = (def: McpToolDef, run: Run, unavailable?: string): ToolRecord => ({ def, writes: false, run, ...(unavailable ? { unavailable } : {}) });
export const write = (def: McpToolDef, run: Run, unavailable?: string): ToolRecord => ({ def, writes: true, run, ...(unavailable ? { unavailable } : {}) });

/**
 * Normalize a caller-supplied vault path and reject anything that escapes the
 * vault root. `normalizePath` collapses slashes but keeps `..` segments, so
 * writes (`note_create`, `note_append`, `note_move`, folder creation) must be
 * checked explicitly — otherwise `folder: "../../.."` would write outside the
 * vault even though writes are only meant to be vault-scoped.
 */
export function assertVaultPath(p: string): string {
  const norm = normalizePath(p);
  if (hasPathTraversal(norm)) {
    throw new Error(`Path escapes the vault: ${p}`);
  }
  return norm;
}

export function resolveFile(app: App, path: string): TFile {
  const f = app.vault.getAbstractFileByPath(normalizePath(path));
  if (f instanceof TFile) return f;
  throw new Error(`Note not found: ${path}`);
}

export async function ensureFolder(app: App, folder: string): Promise<void> {
  await ensureVaultFolder(app, assertVaultPath(folder));
}

export async function uniquePath(app: App, folder: string, title: string, ext = ".md"): Promise<string> {
  const safe = title.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Untitled";
  let path = normalizePath(folder ? `${folder}/${safe}${ext}` : `${safe}${ext}`);
  let i = 2;
  while (app.vault.getAbstractFileByPath(path)) {
    path = normalizePath(folder ? `${folder}/${safe} ${i}${ext}` : `${safe} ${i}${ext}`);
    i++;
  }
  return path;
}

export function str(v: unknown): string {
  if (typeof v !== "string" || v.length === 0) throw new Error("Expected a non-empty string argument.");
  return v;
}
export function optStr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
export function num(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}
