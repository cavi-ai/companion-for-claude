import { App, TFile } from "obsidian";
import type { ToolRecord } from "../toolRecord";
import type { VaultToolsOptions } from "../vaultTools";
import { ensureVaultFolder } from "../../vault/vaultFiles";
import { appendRecord, type RecordResult } from "../../memory/record";
import { assertVaultPath, optStr, str } from "./context";

export const MEMORY_RECORD_OFF_MESSAGE = "Memory recording is off in Companion settings.";

export class MemoryTools {
  constructor(
    private app: App,
    private opts: VaultToolsOptions,
  ) {}

  records(): ToolRecord[] {
    const opts = this.opts;
    return [
      {
        def: {
          name: "memory_record",
          description: "Record one durable, still-true fact about the user's work (a decision, preference, or project state) in the vault's 'What Claude Knows' memory note. Not for transient chatter. Pass `source` as your agent name (e.g. 'claude-code', 'codex').",
          inputSchema: {
            type: "object",
            properties: {
              fact: { type: "string", description: "The fact, one sentence, at most 500 characters." },
              topic: { type: "string", description: "Optional short topic label (e.g. 'preferences', a project name)." },
              source: { type: "string", description: "Your agent name." },
            },
            required: ["fact"],
          },
        },
        writes: true,
        get unavailable() { return opts.memoryRecord?.enabled() ? undefined : MEMORY_RECORD_OFF_MESSAGE; },
        run: async (args) => this.memoryRecord(args),
      },
    ];
  }

  private async memoryRecord(args: Record<string, unknown>): Promise<string> {
    const m = this.opts.memoryRecord;
    if (!m?.enabled()) throw new Error(MEMORY_RECORD_OFF_MESSAGE);
    const path = assertVaultPath(m.path());
    const input = { fact: str(args.fact), topic: optStr(args.topic), source: m.source ?? optStr(args.source), date: m.today() };
    const vault = this.app.vault;
    let result: RecordResult | undefined;
    for (let attempt = 0; attempt < 3 && !result; attempt++) {
      const file = vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        await vault.process(file, (content) => {
          result = appendRecord(content, input, m.newNote);
          return result.kind === "added" ? result.content : content;
        });
        continue;
      }
      const created = appendRecord(null, input, m.newNote);
      if (created.kind !== "added") { result = created; break; }
      try {
        await ensureVaultFolder(this.app, path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
        await vault.create(path, created.content);
        result = created;
      } catch {
        // created concurrently: retry through the atomic process path
      }
    }
    if (!result) throw new Error("Could not record the fact; try again.");
    if (result.kind === "error") throw new Error(result.message);
    return result.kind === "duplicate" ? "Already recorded." : "Recorded.";
  }
}
