// JSON Canvas (.canvas) generation (spec 2026-07-06): validate and normalize a
// model-proposed node/edge graph into Obsidian's JSON Canvas 1.0 format, with
// deterministic auto-layout for nodes without coordinates. Group nodes follow
// the 1.0 spec (cross-checked against kepano/obsidian-skills json-canvas,
// pinned at upstream/obsidian-skills). Pure.

export interface ProposedCanvasNode {
  id?: string;
  /** Inferred when omitted: file → "file", url → "link", else "text". "group" must be explicit. */
  type?: "text" | "file" | "link" | "group";
  text?: string;
  /** Vault path for file nodes (e.g. "Projects/Foo.md"). */
  file?: string;
  url?: string;
  /** Group label (group nodes only). */
  label?: string;
  /** Id of the group node this node belongs to (auto-layout places it inside). */
  group?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** Canvas preset color "1".."6" or hex. */
  color?: string;
}

export interface ProposedCanvasEdge {
  from: string;
  to: string;
  label?: string;
}

export interface CanvasNode {
  id: string;
  type: "text" | "file" | "link" | "group";
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  file?: string;
  url?: string;
  label?: string;
  color?: string;
}

export interface CanvasEdge {
  id: string;
  fromNode: string;
  fromSide: "right";
  toNode: string;
  toSide: "left";
  label?: string;
}

export interface CanvasData {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

const MAX_NODES = 60;
const NODE_W = 380;
const NODE_H = 180;
const COL_GAP = 480;
const ROW_GAP = 240;
const GROUP_PAD = 40;
const GROUP_LABEL_PAD = 60; // extra headroom so the label doesn't overlap members

/**
 * Validate the proposal and produce canvas data. Nodes without coordinates get
 * a deterministic layered layout (columns = BFS depth from the roots, rows =
 * arrival order), so the model can think purely in graph terms. Members of a
 * group are laid out in a compact grid inside it, and auto-sized groups wrap
 * their members below the main graph.
 */
export function buildCanvas(nodes: ProposedCanvasNode[], edges: ProposedCanvasEdge[]): CanvasData {
  if (nodes.length === 0) throw new Error("A canvas needs at least one node.");
  if (nodes.length > MAX_NODES) throw new Error(`Too many nodes (${nodes.length}); at most ${MAX_NODES}.`);

  const ids = new Set<string>();
  const normalized: CanvasNode[] = nodes.map((n, i) => {
    const id = n.id?.trim() || `node-${i + 1}`;
    if (ids.has(id)) throw new Error(`Duplicate node id: ${id}`);
    ids.add(id);
    const type = n.type ?? (n.file ? "file" : n.url ? "link" : "text");
    if (type === "text" && !n.text?.trim()) throw new Error(`Text node "${id}" needs non-empty text.`);
    if (type === "file" && !n.file?.trim()) throw new Error(`File node "${id}" needs a vault path.`);
    if (type === "link" && !n.url?.trim()) throw new Error(`Link node "${id}" needs a url.`);
    return {
      id,
      type,
      x: n.x ?? Number.NaN, // resolved by layout below
      y: n.y ?? Number.NaN,
      // Auto-sized groups get their box from their members in layout.
      width: n.width ?? (type === "group" ? Number.NaN : NODE_W),
      height: n.height ?? (type === "group" ? Number.NaN : NODE_H),
      ...(type === "text" ? { text: n.text!.trim() } : {}),
      ...(type === "file" ? { file: n.file!.trim() } : {}),
      ...(type === "link" ? { url: n.url!.trim() } : {}),
      ...(type === "group" && n.label?.trim() ? { label: n.label.trim() } : {}),
      ...(n.color ? { color: n.color } : {}),
    };
  });

  const byId = new Map(normalized.map((n) => [n.id, n]));
  const memberOf = new Map<string, string>();
  for (const [i, n] of nodes.entries()) {
    if (!n.group) continue;
    const member = normalized[i]!;
    const target = byId.get(n.group);
    if (!target) throw new Error(`Node "${member.id}" references unknown group "${n.group}".`);
    if (target.type !== "group") throw new Error(`Node "${member.id}": "${n.group}" is not a group node.`);
    if (member.type === "group") throw new Error(`Group "${member.id}" cannot join "${n.group}" — nested groups are not supported.`);
    memberOf.set(member.id, n.group);
  }

  const normalizedEdges: CanvasEdge[] = edges.map((e, i) => {
    if (!ids.has(e.from)) throw new Error(`Edge ${i + 1} references unknown node "${e.from}".`);
    if (!ids.has(e.to)) throw new Error(`Edge ${i + 1} references unknown node "${e.to}".`);
    return {
      id: `edge-${i + 1}`,
      fromNode: e.from,
      fromSide: "right",
      toNode: e.to,
      toSide: "left",
      ...(e.label?.trim() ? { label: e.label.trim() } : {}),
    };
  });

  layoutMissing(normalized, normalizedEdges, memberOf);
  return { nodes: normalized, edges: normalizedEdges };
}

/** Serialize to the .canvas file format (pretty-printed JSON Canvas 1.0). */
export function serializeCanvas(data: CanvasData): string {
  return `${JSON.stringify(data, null, "\t")}\n`;
}

/** Layered auto-layout for nodes the model left unplaced. Deterministic. */
function layoutMissing(nodes: CanvasNode[], edges: CanvasEdge[], memberOf: Map<string, string>): void {
  const depth = new Map<string, number>();
  const incoming = new Map<string, number>();
  for (const n of nodes) incoming.set(n.id, 0);
  for (const e of edges) incoming.set(e.toNode, (incoming.get(e.toNode) ?? 0) + 1);

  // BFS from the roots (no incoming edges); cycles and orphans fall back to depth 0.
  const queue = nodes.filter((n) => (incoming.get(n.id) ?? 0) === 0).map((n) => n.id);
  for (const id of queue) depth.set(id, 0);
  while (queue.length > 0) {
    const id = queue.shift()!;
    const d = depth.get(id) ?? 0;
    for (const e of edges) {
      if (e.fromNode !== id) continue;
      if (!depth.has(e.toNode)) {
        depth.set(e.toNode, d + 1);
        queue.push(e.toNode);
      }
    }
  }

  // Main pass: ungrouped, non-group nodes get the layered layout.
  const rowByCol = new Map<number, number>();
  for (const n of nodes) {
    if (n.type === "group" || memberOf.has(n.id)) continue;
    if (!Number.isNaN(n.x) && !Number.isNaN(n.y)) continue;
    const col = depth.get(n.id) ?? 0;
    const row = rowByCol.get(col) ?? 0;
    rowByCol.set(col, row + 1);
    n.x = col * COL_GAP;
    n.y = row * ROW_GAP;
  }

  // Groups stack below the main graph; members grid inside, box wraps them.
  let cursorY = 0;
  for (const n of nodes) {
    if (n.type === "group" || memberOf.has(n.id) || Number.isNaN(n.y)) continue;
    cursorY = Math.max(cursorY, n.y + n.height + ROW_GAP);
  }
  for (const g of nodes) {
    if (g.type !== "group") continue;
    const members = nodes.filter((n) => memberOf.get(n.id) === g.id);
    const placedBox = !Number.isNaN(g.x) && !Number.isNaN(g.y);
    const originX = (placedBox ? g.x : 0) + GROUP_PAD;
    const originY = (placedBox ? g.y : cursorY) + GROUP_LABEL_PAD;
    let gridIndex = 0;
    for (const m of members) {
      if (!Number.isNaN(m.x) && !Number.isNaN(m.y)) continue;
      m.x = originX + (gridIndex % 2) * COL_GAP;
      m.y = originY + Math.floor(gridIndex / 2) * ROW_GAP;
      gridIndex += 1;
    }
    if (Number.isNaN(g.x) || Number.isNaN(g.y) || Number.isNaN(g.width) || Number.isNaN(g.height)) {
      if (members.length > 0) {
        const minX = Math.min(...members.map((m) => m.x));
        const minY = Math.min(...members.map((m) => m.y));
        const maxX = Math.max(...members.map((m) => m.x + m.width));
        const maxY = Math.max(...members.map((m) => m.y + m.height));
        if (Number.isNaN(g.x)) g.x = minX - GROUP_PAD;
        if (Number.isNaN(g.y)) g.y = minY - GROUP_LABEL_PAD;
        if (Number.isNaN(g.width)) g.width = maxX - g.x + GROUP_PAD;
        if (Number.isNaN(g.height)) g.height = maxY - g.y + GROUP_PAD;
      } else {
        if (Number.isNaN(g.x)) g.x = 0;
        if (Number.isNaN(g.y)) g.y = cursorY;
        if (Number.isNaN(g.width)) g.width = NODE_W * 2;
        if (Number.isNaN(g.height)) g.height = NODE_H * 2;
      }
    }
    cursorY = Math.max(cursorY, g.y + g.height + ROW_GAP);
  }
}
