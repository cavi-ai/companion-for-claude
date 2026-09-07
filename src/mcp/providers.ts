// Vault notes as MCP resources; the workflow catalog and user templates as MCP prompts.

import { TFile, type App } from "obsidian";
import type { McpPrompt, McpPromptMessage, PromptProvider, ResourceProvider } from "./protocol";
import { assertVaultPath } from "./vaultTools";
import { WORKFLOWS } from "../workflows/catalog";
import { substitutePlaceholders, type PromptTemplate } from "../templates/promptTemplates";

const SCHEME = "obsidian://vault/";
const PAGE = 200;
const TEMPLATE_PREFIX = "template:";

export function resourceUri(path: string): string {
  return SCHEME + path.split("/").map(encodeURIComponent).join("/");
}

export function resourcePath(uri: string): string | null {
  if (!uri.startsWith(SCHEME)) return null;
  try {
    return uri.slice(SCHEME.length).split("/").map(decodeURIComponent).join("/");
  } catch {
    return null;
  }
}

export function vaultResourceProvider(app: App): ResourceProvider {
  const title = (file: TFile): string | undefined => {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
    return typeof fm?.title === "string" && fm.title.trim() ? fm.title : undefined;
  };
  return {
    async list(cursor) {
      const paths = app.vault.getMarkdownFiles().map((f) => f.path).sort();
      const after = cursor ? Buffer.from(cursor, "base64").toString("utf8") : "";
      const start = after ? paths.findIndex((p) => p > after) : 0;
      const slice = start === -1 ? [] : paths.slice(start, start + PAGE);
      const resources = slice.map((path) => {
        const file = app.vault.getAbstractFileByPath(path);
        const t = file instanceof TFile ? title(file) : undefined;
        return { uri: resourceUri(path), name: path.replace(/\.md$/, "").split("/").pop() ?? path, ...(t !== undefined ? { title: t } : {}), mimeType: "text/markdown" };
      });
      const last = slice[slice.length - 1];
      const more = last !== undefined && start !== -1 && start + PAGE < paths.length;
      return { resources, ...(more ? { nextCursor: Buffer.from(last, "utf8").toString("base64") } : {}) };
    },
    templates: () => [{ uriTemplate: "obsidian://vault/{path}", name: "note", description: "A Markdown note by vault path", mimeType: "text/markdown" }],
    async read(uri) {
      const raw = resourcePath(uri);
      if (raw === null) return null;
      let path: string;
      try {
        path = assertVaultPath(raw);
      } catch {
        return null;
      }
      const file = app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile) || file.extension !== "md") return null;
      return { uri, mimeType: "text/markdown", text: await app.vault.cachedRead(file) };
    },
  };
}

export function catalogPromptProvider(templates: () => Promise<PromptTemplate[]>): PromptProvider {
  const message = (text: string): McpPromptMessage => ({ role: "user", content: { type: "text", text } });
  return {
    async list() {
      const workflows: McpPrompt[] = WORKFLOWS.map((w) => ({ name: w.id, title: w.name, description: w.description, arguments: [{ name: "focus", description: "Optional focus for the workflow", required: false }] }));
      const user: McpPrompt[] = (await templates()).map((t) => ({
        name: `${TEMPLATE_PREFIX}${t.name}`,
        title: t.name,
        description: t.description,
        arguments: [{ name: "selection", required: false }, { name: "active_note", required: false }],
      }));
      return [...workflows, ...user];
    },
    async get(name, args) {
      const workflow = WORKFLOWS.find((w) => w.id === name);
      if (workflow) {
        const focus = args.focus?.trim();
        return { description: workflow.description, messages: [message(focus ? `${workflow.prompt}\n\nFocus: ${focus}` : workflow.prompt)] };
      }
      if (!name.startsWith(TEMPLATE_PREFIX)) return null;
      const template = (await templates()).find((t) => t.name === name.slice(TEMPLATE_PREFIX.length));
      if (!template) return null;
      const values = { ...(args.selection !== undefined ? { selection: args.selection } : {}), ...(args.active_note !== undefined ? { activeNote: args.active_note } : {}) };
      return { description: template.description, messages: [message(substitutePlaceholders(template.prompt, values))] };
    },
  };
}
