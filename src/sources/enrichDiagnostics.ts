// Opt-in phase log for batch enrichment; paths, counts, and phases only — never content.
export type EnrichPhase =
  | "batch-start" | "item-start" | "response-received" | "write-done"
  | "reindex-flush-start" | "reindex-flush-rejected" | "embed-start" | "embed-done"
  | "serialize-start" | "save-start" | "save-done" | "batch-end";

export interface EnrichDiagnosticsDeps {
  append(path: string, text: string): Promise<void>;
  now(): number;
  isMobile: boolean;
  path: string;
}

export class EnrichDiagnostics {
  constructor(private deps: EnrichDiagnosticsDeps, private enabled: () => boolean) {}

  log(phase: EnrichPhase, fields: Record<string, string | number> = {}): void {
    if (!this.enabled()) return;
    const tail = Object.entries(fields).map(([k, v]) => ` ${k}=${String(v).replace(/\s+/g, "_")}`).join("");
    const line = `${new Date(this.deps.now()).toISOString()} ${this.deps.isMobile ? "mobile" : "desktop"} ${phase}${tail}\n`;
    void this.deps.append(this.deps.path, line).catch(() => {});
  }
}
