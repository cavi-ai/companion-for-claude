// Distills one saved conversation into a summary note. All IO is injected so the
// sequencing (empty guard, one repair retry, overwrite-in-place) is unit-tested.

import type { Conversation } from "./store";
import { DISTILL_SCHEMA, DISTILL_SYSTEM, distillInput, notesTouched, parseDistill, renderDistilledNote, type Distilled } from "./distill";
import { normalizeTags } from "../indexing/frontmatter";

export interface DistillRequest {
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
  responseFormat: "json";
  responseSchema: Record<string, unknown>;
  thinking: { type: "disabled" };
}

export interface DistillDeps {
  get(id: string): Conversation | undefined;
  complete(req: DistillRequest): Promise<string>;
  exists(path: string): boolean;
  /** A vault path or wikilink target to its vault path, or null when no such note exists. */
  resolveLink(linkOrPath: string): string | null;
  /** `existing` is the previously distilled note path that still exists, else null. */
  write(existing: string | null, folder: string, title: string, content: string, created: string): Promise<string>;
  setDistilledNote(id: string, path: string): void | Promise<void>;
  notice(text: string): void;
  settings(): { chatFolder: string; chatBaseTags: string[] };
  now?(): Date;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class DistillController {
  private readonly inflight = new Map<string, Promise<string | null>>();

  constructor(private readonly deps: DistillDeps) {}

  /** Returns the note path, or null when nothing was written. */
  distill(id: string): Promise<string | null> {
    const running = this.inflight.get(id);
    if (running) return running;
    const run = this.run(id).finally(() => this.inflight.delete(id));
    this.inflight.set(id, run);
    return run;
  }

  private async run(id: string): Promise<string | null> {
    const { deps } = this;
    const convo = deps.get(id);
    if (!convo) return null;
    const input = distillInput(convo.messages);
    if (input.text.length === 0) {
      deps.notice(`Nothing to distill in ${convo.title}.`);
      return null;
    }
    let distilled: Distilled;
    try {
      distilled = await this.model(input.text);
    } catch (error) {
      deps.notice(`Couldn't distill ${convo.title}: ${reasonOf(error)}`);
      return null;
    }
    const created = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
    const { chatFolder, chatBaseTags } = deps.settings();
    const content = renderDistilledNote(distilled, {
      conversationId: convo.id,
      created,
      notes: notesTouched(convo.messages, (link) => deps.resolveLink(link)),
      tags: normalizeTags(chatBaseTags),
    });
    const existing = convo.distilledNote !== undefined && deps.exists(convo.distilledNote) ? convo.distilledNote : null;
    let path: string;
    try {
      path = await deps.write(existing, chatFolder, distilled.title, content, created);
      await deps.setDistilledNote(convo.id, path);
    } catch (error) {
      deps.notice(`Couldn't distill ${convo.title}: ${reasonOf(error)}`);
      return null;
    }
    deps.notice(`Distilled → ${path}${input.redactions > 0 ? ` · ${input.redactions} ${input.redactions === 1 ? "secret" : "secrets"} redacted` : ""}`);
    return path;
  }

  private async model(text: string): Promise<Distilled> {
    const request: DistillRequest = {
      system: DISTILL_SYSTEM,
      user: text,
      maxTokens: 1200,
      temperature: 0,
      responseFormat: "json",
      responseSchema: DISTILL_SCHEMA,
      thinking: { type: "disabled" },
    };
    const raw = await this.deps.complete(request);
    try {
      return parseDistill(raw);
    } catch (error) {
      const retry = await this.deps.complete({
        ...request,
        user: `${text}\n\nYour previous reply was:\n${raw}\n\nIt was rejected: ${reasonOf(error)}. Return one complete corrected JSON object matching the schema.`,
      });
      return parseDistill(retry);
    }
  }
}
