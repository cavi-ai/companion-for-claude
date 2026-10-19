// Wires the System page: the health scan and the actions its rows trigger.

import { Platform, normalizePath } from "obsidian";
import { HealthController } from "../health/controller";
import type ClaudeCompanionPlugin from "../main";
import { findOrphans } from "../optimize/linkScan";
import { linkScanNotes } from "../optimize/vaultGlue";
import { needsCredentialSetup } from "../providers/setupState";
import { auditProject } from "../research/audit";
import type { ResearchRepository } from "../research/repository";
import { lookupRelationTargetType } from "../vault/vaultFiles";
import { SafeFixModal } from "../view/SafeFixModal";
import type { SystemViewDeps } from "../view/SystemView";

export type HealthHost = Pick<
  ClaudeCompanionPlugin,
  | "activity" | "app" | "clipperSetup" | "mcpRunning" | "onboarding" | "ontology" | "optimize" | "research"
  | "router" | "semantic" | "settings" | "standingOrders" | "views"
>;

export type SystemHost = HealthHost & Pick<ClaudeCompanionPlugin, "shell">;

export function buildHealthController(host: HealthHost): HealthController {
  const repo = (): ResearchRepository => host.research().researchRepository();
  return new HealthController({
    markdownFiles: () => host.app.vault.getMarkdownFiles().map((f) => ({ path: f.path, frontmatter: host.app.metadataCache.getFileCache(f)?.frontmatter })),
    unresolvedLinks: () => host.app.metadataCache.unresolvedLinks,
    ontology: () => host.ontology(),
    lookupTargetType: (target) => { const registry = host.ontology(); return registry ? lookupRelationTargetType(host.app, registry, target) : undefined; },
    listProjects: () => repo().listProjects(),
    auditProject: async (path) => auditProject(await repo().loadProject(path)),
    index: async () => {
      const indexer = host.semantic().indexer();
      const failed = host.activity.snapshot().records
        .filter((r) => r.kind === "semantic-index" && r.state === "needs-attention")
        .sort((a, b) => b.updatedAt - a.updatedAt)[0]?.details ?? [];
      return {
        enabled: host.settings.semanticEnabled,
        built: indexer ? (await indexer.stats()).notes > 0 : false,
        failed: failed.map((d) => ({ path: d.label, message: d.message })),
      };
    },
    tags: async () => {
      const report = await host.optimize().tags().scan({ semantic: false });
      return { total: report.totalTags, singleUse: report.singleUse, candidates: report.candidates.length };
    },
    untypedCount: async () => {
      const report = await host.optimize().types().scan();
      return report.status === "ok" ? report.candidates : null;
    },
    orphanCount: () => findOrphans(linkScanNotes(host.app, host.ontology()), host.app.metadataCache.resolvedLinks, normalizePath(host.settings.ontologyFolder)).length,
    inboxPending: () => host.views().inboxPendingCount(),
    companion: () => ({
      connection: { backend: host.router().chatBackend, needsCredential: needsCredentialSetup(host.onboarding().credentialSetupInputs()) },
      activity: host.activity.snapshot().records
        .filter((r) => r.state === "needs-attention")
        .map((r) => ({ id: r.id, title: r.title, failed: r.failed, recovery: r.recovery.map(({ id, label }) => ({ id, label })) })),
      bridge: { applicable: !Platform.isMobile, enabled: host.settings.mcpEnabled, running: host.mcpRunning(), port: host.settings.mcpPort },
      clipper: { applicable: host.settings.sourceCaptureEnabled, status: host.clipperSetup().status() },
      orders: { invalid: host.standingOrders().invalidOrders() },
    }),
    now: () => new Date().toISOString(),
  });
}

export function buildSystemDeps(host: SystemHost): SystemViewDeps {
  const controller = buildHealthController(host);
  return {
    scan: () => controller.scan(),
    safeFixes: () => controller.safeFixes(),
    openNote: (path) => void host.app.workspace.openLinkText(path, ""),
    openResearchDesk: (path) => host.research().activateResearchDesk(path),
    buildIndex: () => host.semantic().rebuildSemanticIndex(),
    catchUpIndex: () => host.semantic().catchUpIndex(),
    openInbox: () => host.views().activateInboxView(),
    openSetupWizard: () => host.onboarding().openSetupWizard(),
    openSettings: () => host.shell().openCompanionSettings(),
    openClipperSetup: () => host.clipperSetup().openSetup(),
    runActivityRecovery: (activityId, id) => {
      const chrome = host.shell().companionChrome();
      return chrome.runActivityRecovery ? chrome.runActivityRecovery(activityId, id) : chrome.run({ id, page: "system", activityId });
    },
    reviewTagMerges: (done) => void host.optimize().reviewTagMerges(done),
    connectOrphans: (done) => void host.optimize().reviewOrphanLinks(done),
    typeUntypedNotes: (done) => void host.optimize().reviewUntypedNotes(done),
    reviewSafeFixes: (fixes, done) => new SafeFixModal(host.app, fixes, async (fix) => {
      const file = host.app.vault.getFileByPath(fix.path);
      if (!file) throw new Error("This note no longer exists.");
      await host.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
        if (fm.type !== fix.fixed.type || fix.changes.some(({ key, from }) => JSON.stringify(fm[key]) !== JSON.stringify(from))) {
          throw new Error("This note changed since review. Review safe fixes again.");
        }
        Object.assign(fm, Object.fromEntries(fix.changes.map(({ key, to }) => [key, to])));
      });
    }, () => done()).open(),
  };
}
