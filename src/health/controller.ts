import { conform } from "../ontology/conform";
import type { ResolvedType } from "../ontology/types";
import type { AuditFinding } from "../research/audit";
import { scanVaultHealth, type CompanionStatus, type HealthInput, type HealthReport } from "./scan";

export interface HealthDeps {
  markdownFiles(): Array<{ path: string; frontmatter?: Record<string, unknown> | undefined }>;
  unresolvedLinks(): Record<string, Record<string, number>>;
  ontology(): { resolve(name: string): ResolvedType | undefined; resolved(): ReadonlyMap<string, ResolvedType> } | null;
  lookupTargetType(target: string): ResolvedType | undefined;
  listProjects(): Promise<Array<{ path: string }>>;
  auditProject(path: string): Promise<AuditFinding[]>;
  index(): Promise<{ enabled: boolean; built: boolean; failed: Array<{ path: string; message: string }> }>;
  inboxPending(): number;
  companion(): CompanionStatus;
  now(): string;
}

export interface SafeFix { path: string; changes: Array<{ key: string; from: unknown; to: unknown }>; fixed: Record<string, unknown> }

export class HealthController {
  constructor(private readonly deps: HealthDeps) {}

  async scan(): Promise<HealthReport> {
    const research: HealthInput["research"] = [];
    for (const project of await this.deps.listProjects()) {
      try {
        research.push({ project: project.path, findings: await this.deps.auditProject(project.path) });
      } catch (e) {
        research.push({ project: project.path, findings: [{ severity: "error", path: project.path, explanation: `Could not audit: ${e instanceof Error ? e.message : String(e)}` }] });
      }
    }
    return scanVaultHealth({
      typedNotes: this.typedNotes(),
      unresolved: this.deps.unresolvedLinks(),
      research,
      index: await this.deps.index(),
      inboxPending: this.deps.inboxPending(),
      companion: this.deps.companion(),
      now: this.deps.now(),
    });
  }

  safeFixes(): SafeFix[] {
    return this.checked().flatMap(({ path, frontmatter, fixed }) => {
      const changes = changedKeys(frontmatter, fixed);
      return changes.length > 0 ? [{ path, changes, fixed }] : [];
    });
  }

  private typedNotes(): HealthInput["typedNotes"] {
    const registry = this.deps.ontology();
    if (!registry || registry.resolved().size === 0) return null;
    return this.checked().map(({ path, issues, frontmatter, fixed }) => ({ path, issues, fixChanges: changedKeys(frontmatter, fixed).length }));
  }

  private checked() {
    const registry = this.deps.ontology();
    if (!registry || registry.resolved().size === 0) return [];
    return this.deps.markdownFiles()
      // The triage board is plugin-generated, not an ontology note.
      .filter((f): f is { path: string; frontmatter: Record<string, unknown> } => typeof f.frontmatter?.type === "string" && f.frontmatter.type !== "triage")
      .map(({ path, frontmatter }) => {
        const r = conform(frontmatter, registry.resolve(frontmatter.type as string), (t) => this.deps.lookupTargetType(t));
        return { path, frontmatter, issues: r.issues, fixed: r.fixed };
      });
  }
}

function changedKeys(before: Record<string, unknown>, after: Record<string, unknown>): Array<{ key: string; from: unknown; to: unknown }> {
  return Object.keys(after)
    .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
    .map((k) => ({ key: k, from: before[k], to: after[k] }));
}
