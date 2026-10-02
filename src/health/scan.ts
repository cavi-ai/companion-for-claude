import type { ConformanceIssue } from "../ontology/conform";

export type HealthSeverity = "ok" | "info" | "warning" | "error";
export type HealthGroup = "companion" | "vault";
export type HealthSectionId = "connection" | "activity" | "index" | "bridge" | "clipper" | "ontology" | "links" | "research" | "inbox" | "orders";
export interface HealthItem { path: string; message: string; project?: string }
export interface HealthAction { id: string; label: string; activityId?: string; path?: string }
export interface HealthSection { id: HealthSectionId; group: HealthGroup; title: string; count: number; severity: HealthSeverity; items: HealthItem[]; fixable?: number; actions?: HealthAction[] }
export interface CompanionStatus {
  connection: { backend: string; needsCredential: boolean };
  activity: Array<{ id: string; title: string; failed: number; recovery: Array<{ id: string; label: string }> }>;
  bridge: { applicable: boolean; enabled: boolean; running: boolean; port: number };
  clipper: { applicable: boolean; status: "not-set-up" | "current" | "update-available" };
  orders: { invalid: Array<{ path: string; reason: string }> };
}
export interface HealthReport { sections: HealthSection[]; scannedAt: string }
export interface HealthInput {
  typedNotes: Array<{ path: string; issues: ConformanceIssue[]; fixChanges: number }> | null;
  unresolved: Record<string, Record<string, number>>;
  research: Array<{ project: string; findings: Array<{ severity: "error" | "warning" | "info"; path: string; explanation: string }> }>;
  index: { enabled: boolean; built: boolean; failed: Array<{ path: string; message: string }> };
  inboxPending: number;
  companion: CompanionStatus;
  now: string;
}

export const HEALTH_ITEM_CAP = 50;
const RANK: Record<HealthSeverity, number> = { error: 0, warning: 1, info: 2, ok: 3 };
const ORDER: HealthSectionId[] = ["connection", "activity", "index", "bridge", "clipper", "orders", "ontology", "links", "research", "inbox"];
const GROUP_RANK: Record<HealthGroup, number> = { companion: 0, vault: 1 };
const OPEN_SETTINGS: HealthAction = { id: "open-settings", label: "Open settings · Agent → Agent bridge" };
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

export function scanVaultHealth(input: HealthInput): HealthReport {
  const sections: HealthSection[] = [];

  if (input.typedNotes) {
    const bad = input.typedNotes.filter((n) => n.issues.length > 0);
    sections.push({
      id: "ontology", group: "vault", title: "Ontology", count: bad.length, severity: bad.length > 0 ? "warning" : "ok",
      items: bad.slice(0, HEALTH_ITEM_CAP).map((n) => ({ path: n.path, message: n.issues.map((i) => i.message).join("; ") })),
      fixable: input.typedNotes.filter((n) => n.fixChanges > 0).length,
    });
  }

  const linkRows = Object.entries(input.unresolved)
    .map(([path, targets]) => ({ path, targets: Object.keys(targets), total: Object.values(targets).reduce((a, b) => a + b, 0) }))
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total || a.path.localeCompare(b.path));
  const linkCount = linkRows.reduce((a, r) => a + r.total, 0);
  sections.push({
    id: "links", group: "vault", title: "Broken links", count: linkCount, severity: linkCount > 0 ? "warning" : "ok",
    items: linkRows.slice(0, HEALTH_ITEM_CAP).map((r) => ({ path: r.path, message: `${plural(r.total, "broken link")}: ${r.targets.slice(0, 3).join(", ")}` })),
  });

  const findings = input.research.flatMap((p) => p.findings.map((f) => ({ ...f, project: p.project }))).filter((f) => f.severity !== "info")
    .sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.path.localeCompare(b.path));
  sections.push({
    id: "research", group: "vault", title: "Research", count: findings.length,
    severity: findings[0]?.severity ?? "ok",
    items: findings.slice(0, HEALTH_ITEM_CAP).map((f) => ({ path: f.path, message: f.explanation, project: f.project })),
  });

  if (input.index.enabled) {
    const items: HealthItem[] = [
      ...(input.index.built ? [] : [{ path: "", message: "Semantic index not built yet" }]),
      ...input.index.failed,
    ];
    sections.push({
      id: "index", group: "companion", title: "Semantic index", count: items.length,
      severity: input.index.failed.length > 0 ? "warning" : input.index.built ? "ok" : "info",
      items: items.slice(0, HEALTH_ITEM_CAP),
    });
  }

  sections.push({
    id: "inbox", group: "vault", title: "Inbox", count: input.inboxPending, severity: input.inboxPending > 0 ? "info" : "ok",
    items: input.inboxPending > 0 ? [{ path: "", message: `${plural(input.inboxPending, "clip")} waiting to be enriched` }] : [],
  });

  sections.push(...companionSections(input.companion));

  sections.sort((a, b) => GROUP_RANK[a.group] - GROUP_RANK[b.group] || RANK[a.severity] - RANK[b.severity] || ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
  return { sections, scannedAt: input.now };
}

function companionSections(c: CompanionStatus): HealthSection[] {
  const out: HealthSection[] = [];

  out.push(c.connection.needsCredential
    ? {
      id: "connection", group: "companion", title: "Connection", count: 1, severity: "error",
      items: [{ path: "", message: `${c.connection.backend} has no credential — chat cannot send` }],
      actions: [{ id: "open-setup-wizard", label: "Open setup wizard" }],
    }
    : { id: "connection", group: "companion", title: "Connection", count: 0, severity: "ok", items: [] });

  out.push({
    id: "activity", group: "companion", title: "Background work", count: c.activity.length, severity: c.activity.length > 0 ? "warning" : "ok",
    items: c.activity.map((r) => ({ path: "", message: `${r.title} — ${r.failed} failed` })),
    actions: c.activity.flatMap((r) => r.recovery.map((a) => ({ ...a, activityId: r.id }))),
  });

  if (c.bridge.applicable) {
    const down = c.bridge.enabled && !c.bridge.running;
    out.push({
      id: "bridge", group: "companion", title: "MCP bridge", count: down ? 1 : 0, severity: down ? "error" : "ok",
      items: down ? [{ path: "", message: `Bridge is on but not running on port ${c.bridge.port}` }] : [],
      actions: down ? [OPEN_SETTINGS] : [],
    });
  }

  if (c.clipper.applicable) {
    const stale = c.clipper.status === "update-available";
    const unset = c.clipper.status === "not-set-up";
    out.push({
      id: "clipper", group: "companion", title: "Web Clipper", count: stale || unset ? 1 : 0, severity: stale ? "warning" : unset ? "info" : "ok",
      items: stale ? [{ path: "", message: "Web Clipper schemas have an update" }] : unset ? [{ path: "", message: "Web Clipper is not set up" }] : [],
      actions: stale || unset ? [{ id: "clipper-schemas", label: stale ? "Update schemas" : "Set up Web Clipper" }] : [],
    });
  }

  const invalid = c.orders.invalid;
  out.push({
    id: "orders", group: "companion", title: "Standing orders", count: invalid.length, severity: invalid.length > 0 ? "warning" : "ok",
    items: invalid.slice(0, HEALTH_ITEM_CAP).map((o) => ({ path: o.path, message: `${o.path} — ${o.reason}` })),
    actions: invalid.slice(0, HEALTH_ITEM_CAP).map((o) => ({ id: "open-note", label: `Open ${(o.path.split("/").pop() ?? o.path).replace(/\.md$/i, "")}`, path: o.path })),
  });

  return out;
}
