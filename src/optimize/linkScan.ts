import { GENERATED_NOTE_TYPES } from "../health/controller";
import { findUnlinkedMentions, withLinktext, type LinkCandidate, type Mention } from "../links/unlinkedMentions";

export type LinkProposalKind = "inbound" | "outbound" | "related";

export interface LinkProposal {
  id: string;
  kind: LinkProposalKind;
  /** The orphan this proposal belongs to (inbound: the target; outbound and related: the source). */
  orphan: string;
  /** The note that is edited. */
  source: string;
  /** The note that gets linked. */
  target: string;
  /** What is written between the brackets for `target`. */
  linktext: string;
  mention?: Mention;
  score?: number;
  checked: boolean;
}

export interface OrphanReview {
  path: string;
  proposals: LinkProposal[];
}

export interface LinkScanNote {
  path: string;
  basename: string;
  aliases: string[];
  mtime: number;
  /** Frontmatter `type`, when it is a string. */
  type?: string;
  /** Untyped, or its resolved type declares a `related` relation. */
  acceptsRelated: boolean;
}

export interface NeighbourHit {
  path: string;
  score: number;
}

export interface LinkScanInput {
  notes: LinkScanNote[];
  /** `metadataCache.resolvedLinks`. */
  edges: Record<string, Record<string, number>>;
  /** Normalized, without a trailing slash; empty when there is none. */
  ontologyFolder: string;
  dismissed: ReadonlySet<string>;
  read(path: string): Promise<string>;
  /** Stored vectors only; `accept` filters candidate paths before the top-k cut. */
  neighbours(path: string, accept: (path: string) => boolean): Promise<NeighbourHit[]>;
  /** Awaited after every `YIELD_EVERY` notes read; defaults to a macrotask turn. */
  yieldEvery?: () => Promise<void>;
  /** Notes read so far of the notes to read at most. */
  onProgress?: (done: number, total: number) => void;
}

export interface LinkScanReport {
  orphanCount: number;
  groups: OrphanReview[];
  remaining: number;
  /** Scan-time content of every note that has a body proposal; the apply-time conflict baseline. */
  contents: ReadonlyMap<string, string>;
}

export const MAX_ORPHANS_PER_REVIEW = 50;
export const MAX_PROPOSALS_PER_KIND = 3;
export const RELATED_FLOOR = 0.5;
export const MAX_NEIGHBOUR_LOOKUPS = 200;
export const YIELD_EVERY = 50;
export const YIELD_EVERY_LOOKUPS = 10;

const NON_TARGET_NAME = [/^untitled\b/i, /^\d{4}-\d{2}-\d{2}/, /^\d+$/];

export const dismissalKey = (source: string, target: string): string => `${source}\u0000${target}`;

const isExcluded = (note: LinkScanNote, ontologyFolder: string): boolean =>
  (note.type !== undefined && GENERATED_NOTE_TYPES.has(note.type)) ||
  (ontologyFolder !== "" && note.path.startsWith(`${ontologyFolder}/`));

/** Markdown notes with no markdown link in or out; self-links ignored; generated and ontology notes never count. */
export function findOrphans(notes: LinkScanNote[], edges: Record<string, Record<string, number>>, ontologyFolder: string): string[] {
  const known = new Set(notes.map((n) => n.path));
  const linked = new Set<string>();
  for (const [from, targets] of Object.entries(edges)) {
    if (!known.has(from)) continue;
    for (const [to, count] of Object.entries(targets)) {
      if (count > 0 && to !== from && known.has(to)) {
        linked.add(from);
        linked.add(to);
      }
    }
  }
  return notes.filter((n) => !isExcluded(n, ontologyFolder) && !linked.has(n.path)).map((n) => n.path);
}

const proposalId = (kind: LinkProposalKind, source: string, target: string): string => `${kind}\u0000${source}\u0000${target}`;

export async function scanOrphans(input: LinkScanInput): Promise<LinkScanReport> {
  const { notes, ontologyFolder, dismissed } = input;
  const orphanPaths = new Set(findOrphans(notes, input.edges, ontologyFolder));
  const empty: LinkScanReport = { orphanCount: orphanPaths.size, groups: [], remaining: 0, contents: new Map() };
  if (orphanPaths.size === 0) return empty;

  const byPath = new Map(notes.map((n) => [n.path, n]));
  const linktexts = new Map(withLinktext(notes.map((n): LinkCandidate => ({ path: n.path, basename: n.basename, aliases: n.aliases }))).map((c) => [c.path, c]));
  const candidateFor = (note: LinkScanNote): LinkCandidate => ({ ...(linktexts.get(note.path) as LinkCandidate), aliases: note.aliases });
  const mentionable = (note: LinkScanNote): boolean => !isExcluded(note, ontologyFolder) && !NON_TARGET_NAME.some((re) => re.test(note.basename));

  const outboundCandidates = notes.filter(mentionable).map(candidateFor);
  const inboundPending = new Map<string, LinkCandidate>(
    notes.filter((n) => orphanPaths.has(n.path) && mentionable(n)).map((n) => [n.path, candidateFor(n)]),
  );
  const inboundCount = new Map<string, number>();
  const proposals = new Map<string, LinkProposal[]>();
  const contents = new Map<string, string>();
  const add = (orphan: string, proposal: LinkProposal): void => {
    const list = proposals.get(orphan);
    if (list) list.push(proposal);
    else proposals.set(orphan, [proposal]);
  };

  const sources = notes.filter((n) => !isExcluded(n, ontologyFolder)).sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
  const yieldTurn = input.yieldEvery ?? ((): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0)));
  let reads = 0;
  for (const note of sources) {
    const isOrphan = orphanPaths.has(note.path);
    const pool = isOrphan ? outboundCandidates : [...inboundPending.values()];
    if (pool.length === 0) continue;
    const content = await input.read(note.path);
    reads += 1;
    if (reads % YIELD_EVERY === 0) {
      input.onProgress?.(reads, sources.length);
      await yieldTurn();
    }
    const mentions = findUnlinkedMentions(content, pool, note.path).filter((m) => !dismissed.has(dismissalKey(note.path, m.path)));
    let kept = false;
    if (isOrphan) {
      for (const m of mentions.slice(0, MAX_PROPOSALS_PER_KIND)) {
        add(note.path, { id: proposalId("outbound", note.path, m.path), kind: "outbound", orphan: note.path, source: note.path, target: m.path, linktext: m.target, mention: m, checked: true });
        kept = true;
      }
    } else {
      for (const m of mentions) {
        const taken = inboundCount.get(m.path) ?? 0;
        if (taken >= MAX_PROPOSALS_PER_KIND) continue;
        inboundCount.set(m.path, taken + 1);
        if (taken + 1 === MAX_PROPOSALS_PER_KIND) inboundPending.delete(m.path);
        add(m.path, { id: proposalId("inbound", note.path, m.path), kind: "inbound", orphan: m.path, source: note.path, target: m.path, linktext: m.target, mention: m, checked: true });
        kept = true;
      }
    }
    if (kept) contents.set(note.path, content);
  }

  const mentionCount = (path: string): number => proposals.get(path)?.length ?? 0;
  const order = [...orphanPaths].sort((a, b) => mentionCount(b) - mentionCount(a) || (byPath.get(b)?.mtime ?? 0) - (byPath.get(a)?.mtime ?? 0) || a.localeCompare(b));
  const groups: OrphanReview[] = [];
  let lookups = 0;
  for (const path of order) {
    if (groups.length >= MAX_ORPHANS_PER_REVIEW) break;
    const orphan = byPath.get(path);
    if (orphan?.acceptsRelated && lookups < MAX_NEIGHBOUR_LOOKUPS) {
      lookups += 1;
      if (lookups % YIELD_EVERY_LOOKUPS === 0) await yieldTurn();
      const bodyLinked = new Set((proposals.get(path) ?? []).filter((p) => p.kind === "outbound").map((p) => p.target));
      const accept = (candidate: string): boolean => {
        const target = byPath.get(candidate);
        return !!target && candidate !== path && !bodyLinked.has(candidate) && !isExcluded(target, ontologyFolder) && !dismissed.has(dismissalKey(path, candidate));
      };
      const hits = (await input.neighbours(path, accept))
        .filter((h) => h.score >= RELATED_FLOOR && accept(h.path))
        .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
        .slice(0, MAX_PROPOSALS_PER_KIND);
      for (const h of hits) {
        add(path, {
          id: proposalId("related", path, h.path), kind: "related", orphan: path, source: path, target: h.path,
          linktext: linktexts.get(h.path)?.linktext ?? h.path, score: h.score, checked: false,
        });
      }
    }
    const list = proposals.get(path);
    if (list && list.length > 0) groups.push({ path, proposals: list });
  }

  const used = new Set(groups.flatMap((g) => g.proposals.filter((p) => p.mention).map((p) => p.source)));
  return {
    orphanCount: orphanPaths.size,
    groups,
    remaining: orphanPaths.size - groups.length,
    contents: new Map([...contents].filter(([path]) => used.has(path))),
  };
}
