// Publish orchestration with every side effect injected.

import { artifactPageHtml } from "./artifactPage";
import {
  createGistRequest,
  deleteGistRequest,
  githackUrl,
  parseGistResponse,
  testTokenRequest,
  updateGistRequest,
  type GistOp,
  type GistOutcome,
  type GistRequest,
} from "./gist";
import { transformNoteForPublish } from "./noteTransform";
import { artifactKey, removePublished, renamePublished, upsertPublished, type PublishedItem } from "./registry";

export interface PublishDeps {
  token(): string;
  apiBase(): string;
  request(req: GistRequest): Promise<{ status: number; json: unknown }>;
  readNote(path: string): Promise<string>;
  confirm(kind: PublishedItem["kind"], title: string): Promise<boolean>;
  copy(text: string): Promise<void>;
  notice(text: string): void;
  getItems(): PublishedItem[];
  setItems(items: PublishedItem[]): Promise<void>;
  now(): number;
}

const NOTE_FILE = "note.md";
const ARTIFACT_FILE = "index.html";
const NO_TOKEN = "Add a GitHub token with Gists: read and write under Publishing in Companion settings first.";

export function publishConfirmMessage(kind: PublishedItem["kind"]): string {
  const base = "Anyone with the link can read this. Frontmatter, %%comments%%, and vault embeds and images are not uploaded.";
  return kind === "artifact" ? `${base} The link opens through gist.githack.com, a third-party host that shows a confirmation page first.` : base;
}

const titleOf = (path: string): string => (path.split("/").pop() ?? path).replace(/\.md$/i, "");

export class PublishController {
  private inFlight = new Set<string>();

  constructor(private deps: PublishDeps) {}

  async publishNote(path: string): Promise<void> {
    const token = this.deps.token();
    if (!token) return this.deps.notice(NO_TOKEN);
    await this.guarded(path, async () => {
      const title = titleOf(path);
      const content = transformNoteForPublish(await this.deps.readNote(path));
      if (content === "") return this.deps.notice(`Nothing to publish in ${title}.`);
      const existing = this.deps.getItems().find((i) => i.key === path);
      if (!existing && !(await this.deps.confirm("note", title))) return;
      const files = { [NOTE_FILE]: content };
      const base = this.deps.apiBase();
      let outcome: GistOutcome | null;
      let publishedAt = existing?.publishedAt;
      if (existing) {
        outcome = await this.send(updateGistRequest(base, token, existing.gistId, files), "update");
        if (outcome?.kind === "gone") {
          publishedAt = undefined;
          outcome = await this.send(createGistRequest(base, token, files, title), "create");
        }
      } else {
        outcome = await this.send(createGistRequest(base, token, files, title), "create");
      }
      if (outcome?.kind !== "ok") return;
      const now = this.deps.now();
      const item: PublishedItem = { key: path, kind: "note", title, gistId: outcome.id, url: outcome.url, owner: outcome.owner, publishedAt: publishedAt ?? now, updatedAt: now };
      await this.deps.setItems(upsertPublished(this.deps.getItems(), item));
      await this.share(item.url, `Published ${title}`);
    });
  }

  async publishArtifact(html: string, title: string): Promise<void> {
    const token = this.deps.token();
    if (!token) return this.deps.notice(NO_TOKEN);
    await this.guarded(`artifact-pending:${title}`, async () => {
      if (!(await this.deps.confirm("artifact", title))) return;
      const files = { [ARTIFACT_FILE]: artifactPageHtml(html, title) };
      const outcome = await this.send(createGistRequest(this.deps.apiBase(), token, files, title), "create");
      if (outcome?.kind !== "ok") return;
      const now = this.deps.now();
      const url = githackUrl(outcome.owner, outcome.id, ARTIFACT_FILE);
      const item: PublishedItem = { key: artifactKey(outcome.id), kind: "artifact", title, gistId: outcome.id, url, owner: outcome.owner, publishedAt: now, updatedAt: now };
      await this.deps.setItems(upsertPublished(this.deps.getItems(), item));
      await this.share(url, `Published ${title}`);
    });
  }

  async unpublish(key: string): Promise<void> {
    const item = this.deps.getItems().find((i) => i.key === key);
    if (!item) return;
    const token = this.deps.token();
    if (!token) return this.deps.notice(NO_TOKEN);
    await this.guarded(key, async () => {
      const outcome = await this.send(deleteGistRequest(this.deps.apiBase(), token, item.gistId), "delete");
      if (outcome?.kind !== "ok" && outcome?.kind !== "gone") return;
      await this.deps.setItems(removePublished(this.deps.getItems(), key));
      this.deps.notice(`Unpublished ${item.title}.`);
    });
  }

  async testToken(): Promise<{ ok: boolean; message: string }> {
    const token = this.deps.token();
    if (!token) return { ok: false, message: "No token set." };
    try {
      const res = await this.deps.request(testTokenRequest(this.deps.apiBase(), token));
      const outcome = parseGistResponse(res.status, res.json, "test");
      return outcome.kind === "ok" ? { ok: true, message: "GitHub accepted the token." } : { ok: false, message: outcome.kind === "error" ? outcome.message : "GitHub could not be reached." };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  async copyLink(key: string): Promise<void> {
    const item = this.deps.getItems().find((i) => i.key === key);
    if (item) await this.share(item.url, "Link copied");
  }

  async renameNote(oldPath: string, newPath: string): Promise<void> {
    const items = this.deps.getItems();
    if (!items.some((i) => i.key === oldPath)) return;
    await this.deps.setItems(renamePublished(items, oldPath, newPath));
  }

  /** Runs one request; a refusal or failure raises its notice and yields null. */
  private async send(req: GistRequest, op: GistOp): Promise<GistOutcome | null> {
    try {
      const res = await this.deps.request(req);
      const outcome = parseGistResponse(res.status, res.json, op);
      if (outcome.kind === "error") this.deps.notice(outcome.message);
      return outcome.kind === "error" ? null : outcome;
    } catch (e) {
      this.deps.notice(`Publish failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  private async share(url: string, lead: string): Promise<void> {
    await this.deps.copy(url).catch(() => {});
    this.deps.notice(`${lead} — link copied:\n${url}`);
  }

  private async guarded(key: string, run: () => Promise<void>): Promise<void> {
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    try {
      await run();
    } finally {
      this.inFlight.delete(key);
    }
  }
}
