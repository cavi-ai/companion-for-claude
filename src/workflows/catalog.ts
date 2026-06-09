// Companion-native adaptations of the claude-obsidian Claude Code workflows, so
// Obsidian users get the same portfolio (manifest personas, rollups, MOCs, digests)
// without the CLI. Each is a self-contained prompt that produces a `claude-html`
// artifact or grounded Markdown over the Companion's vault context. Pure data.

export interface Workflow {
  id: string;
  /** Display name shown in the picker and as the chat label. */
  name: string;
  /** One-line description for the picker. */
  description: string;
  group: "Manifest" | "Knowledge & synthesis";
  /** Turn on vault search so the prompt is grounded across the whole vault. */
  vaultSearch: boolean;
  /** Self-contained instruction sent to Claude. */
  prompt: string;
}

const ARTIFACT = "as a single self-contained `claude-html` artifact using the design system";

export const WORKFLOWS: Workflow[] = [
  {
    id: "manifest-pm",
    name: "Manifest: Product roadmap",
    description: "Prioritized, client-facing product roadmap from your project notes",
    group: "Manifest",
    vaultSearch: true,
    prompt: `Act as a shipping-minded product manager over my project notes. Produce a prioritized product roadmap ${ARTIFACT}: lead with the single best next move, then a ranked backlog (each with a one-line rationale), then key risks. Bias toward client-facing, high-value deliverables. Ground every item in my notes and cite the note titles.`,
  },
  {
    id: "manifest-vault",
    name: "Manifest: Vault audit",
    description: "Diagnose orphans, tag sprawl, missing links, and stale notes",
    group: "Manifest",
    vaultSearch: true,
    prompt: `Audit my Obsidian vault and produce a diagnosis ${ARTIFACT}: orphan notes (no links), tag sprawl / inconsistency, missing links, and stale notes. Rank findings by impact and give a concrete, low-effort remediation for each. Ground it in what you can see of my vault.`,
  },
  {
    id: "manifest-content",
    name: "Manifest: Content plan",
    description: "Evidence-backed content plan + the best piece to write next",
    group: "Manifest",
    vaultSearch: true,
    prompt: `Act as a content strategist over my vault. Produce a prioritized, evidence-backed content plan ${ARTIFACT}: the single best piece to write next, a ranked backlog of ideas, and the angle/audience for each. Ground every idea in supporting notes and cite them.`,
  },
  {
    id: "manifest-research",
    name: "Manifest: Research agenda",
    description: "Map coverage, surface gaps, and a prioritized research agenda",
    group: "Manifest",
    vaultSearch: true,
    prompt: `Map what my vault covers and where the gaps are. Produce a ${ARTIFACT}: a coverage map of my knowledge areas, the specific gaps / open questions, and a prioritized research agenda (what to learn next and why). Ground it in my notes.`,
  },
  {
    id: "manifest-risk",
    name: "Manifest: Risk register",
    description: "Ranked blockers, contradictions, SPOFs + mitigations",
    group: "Manifest",
    vaultSearch: true,
    prompt: `Build a grounded, ranked risk register from my project notes ${ARTIFACT}: blockers, contradictions, single points of failure, and unknowns — each with severity, the source note, and a concrete mitigation. Lead with the highest-priority risk.`,
  },
  {
    id: "manifest-feature",
    name: "Manifest: Feature backlog",
    description: "Prioritized feature backlog from your idea/feedback notes",
    group: "Manifest",
    vaultSearch: true,
    prompt: `Act as a product lead over my idea and feedback notes. Produce a prioritized feature backlog ${ARTIFACT}: top recommendation, ranked features with rationale and supporting evidence from my notes, and rough effort for each. Ground each in my notes.`,
  },
  {
    id: "manifest-infra",
    name: "Manifest: Infra design",
    description: "Grounded system designs as a diagrammed artifact",
    group: "Manifest",
    vaultSearch: true,
    prompt: `Propose grounded infrastructure / system designs from my architecture notes. Produce a ${ARTIFACT} with at least one clear system diagram, the proposed design, key trade-offs, and risks. Ground it in my notes.`,
  },
  {
    id: "daily-rollup",
    name: "Daily rollup",
    description: "Skimmable review of recent vault activity (decisions, changes, tasks)",
    group: "Knowledge & synthesis",
    vaultSearch: true,
    prompt: `Produce a periodic review of my recent vault activity as Markdown. Lead with the top developments, then sections **Decisions**, **Changed / shipped**, and **Open tasks** — each item linked to its source note with a [[wikilink]]. Use my recent notes and current context.`,
  },
  {
    id: "moc-builder",
    name: "Map of Content",
    description: "Build a MOC hub note grouping/annotating notes on a topic",
    group: "Knowledge & synthesis",
    vaultSearch: true,
    prompt: `Build a Map of Content (MOC) hub for the topic of my active note (or the topic I describe). Produce a Markdown note: a short intro framing the topic, then the related notes grouped into sections with a one-line annotation each, as [[wikilinks]]. Ground it in my vault.`,
  },
  {
    id: "source-digest",
    name: "Source digest",
    description: "Cited evidence/comparison table across your source notes",
    group: "Knowledge & synthesis",
    vaultSearch: true,
    prompt: `Digest my research / source notes into a ${ARTIFACT}: a cited evidence and comparison table across the sources (columns: claim, source, stance), and call out conflicts and gaps. Ground every row in my notes.`,
  },
  {
    id: "task-harvester",
    name: "Harvest open tasks",
    description: "Consolidate scattered open tasks into one prioritized, linked list",
    group: "Knowledge & synthesis",
    vaultSearch: true,
    prompt: `Collect the open tasks scattered across my notes into one consolidated action list (Markdown). Group by theme, link each task to its source note with a [[wikilink]], and order by priority. Include only genuine open / actionable items.`,
  },
  {
    id: "vault-synthesis",
    name: "Vault synthesis",
    description: "Grounded, cited synthesis of what your vault says on a topic",
    group: "Knowledge & synthesis",
    vaultSearch: true,
    prompt: `Synthesize what my vault says about the topic of my active note (or the topic I describe): the consensus, the open questions, and the strongest supporting notes (as [[wikilinks]]). Stay strictly grounded in my notes — explicitly flag anything you are unsure about or that isn't supported.`,
  },
];
