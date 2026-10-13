import { App } from "obsidian";
import type { ToolRecord } from "../toolRecord";
import type { VaultToolsOptions } from "../vaultTools";
import { describeOntology } from "../../ontology/describe";
import { validateProposal } from "../../ontology/propose";
import { PROPERTY_TYPE_VALUES } from "../../ontology/types";
import { buildCanvas, serializeCanvas, type ProposedCanvasNode, type ProposedCanvasEdge } from "../../canvas/jsonCanvas";
import { buildBaseFile, type ProposedBase } from "../../bases/baseFile";
import { assertVaultPath, ensureFolder, optStr, read, str, uniquePath, write } from "./context";

const ONTOLOGY_OFF_MESSAGE = "The ontology is disabled in Companion for Claude settings.";

export class StructureTools {
  constructor(
    private app: App,
    private opts: VaultToolsOptions,
  ) {}

  records(): ToolRecord[] {
    const ontologyOff = this.opts.ontology ? undefined : ONTOLOGY_OFF_MESSAGE;
    return [
      read({
        name: "ontology_get",
        description: "Read the vault ontology: every type with its lineage, properties and relations, or one type and its ancestors. Call this before creating typed notes or proposing a type.",
        inputSchema: { type: "object", properties: { type: { type: "string", description: "Optional type name to describe." } } },
      }, async (args) => this.ontologyGet(optStr(args.type)), ontologyOff),
      write(
        {
          name: "base_create",
          description:
            "Create an Obsidian Base (.base) — a database view over notes, driven by their frontmatter properties. Use frontmatter_query/vault_tags first to discover real property names. Filters accept a statement like 'file.hasTag(\"book\")', an array of statements (AND-ed), or a recursive {and|or|not: [...]} group. Great for reading trackers, project dashboards, and review queues.",
          inputSchema: {
            type: "object",
            properties: {
              title: { type: "string", description: "Base title (also the filename)." },
              filters: { description: "Global filters: a statement string, an array of statements (AND-ed), or one recursive {and|or|not: [...]} group." },
              views: {
                type: "array",
                description: "Views: {name, type? (table|cards|list|map|companion-similar), order? (property list like 'file.name'/'note.status'), groupBy? {property, direction}, limit?, filters?, summaries? (property → built-in aggregate like Sum/Average/Median or a custom summaries key)}.",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    type: { type: "string", enum: ["table", "cards", "list", "map", "companion-similar"] },
                    order: { type: "array", items: { type: "string" } },
                    groupBy: {
                      type: "object",
                      properties: { property: { type: "string" }, direction: { type: "string", enum: ["ASC", "DESC"] } },
                      required: ["property"],
                    },
                    limit: { type: "number" },
                    filters: { description: "View filters: a statement string, an array of statements (AND-ed), or one recursive {and|or|not: [...]} group." },
                    summaries: { type: "object", description: "property id → summary name (built-ins: Average, Min, Max, Sum, Range, Median, Stddev, Earliest, Latest, Checked, Unchecked, Empty, Filled, Unique)." },
                  },
                  required: ["name"],
                },
              },
              formulas: { type: "object", description: "formula name → expression (e.g. {ppu: '(price / age).toFixed(2)'})." },
              properties: { type: "object", description: "property id → display name (e.g. {status: 'Status'})." },
              summaries: { type: "object", description: "Custom summary name → expression (e.g. {p90: 'values.percentile(90)'})." },
              folder: { type: "string", description: "Target folder (defaults to the configured folder)." },
            },
            required: ["title", "views"],
          },
        },
        async (args) => this.createBase(str(args.title), args, optStr(args.folder)),
      ),
      write(
        {
          name: "canvas_create",
          description:
            "Create an Obsidian Canvas (.canvas) — a visual mind map / board of nodes and edges. Nodes: text (idea cards), file (embed a vault note by path), link (url), or group (labeled container; put nodes inside via their group field). Omit x/y to auto-layout left-to-right by edge depth; grouped nodes grid inside their auto-sized group. Use for mind maps, project boards, and argument maps wired to real notes.",
          inputSchema: {
            type: "object",
            properties: {
              title: { type: "string", description: "Canvas title (also the filename)." },
              nodes: {
                type: "array",
                description: "Nodes: {id?, text?} for idea cards, {id?, file?} to embed a note, {id?, url?} for links, {id, type: 'group', label?} for containers. Set group: <groupId> on a node to place it inside that group. Optional x/y/width/height/color.",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    type: { type: "string", enum: ["text", "file", "link", "group"] },
                    text: { type: "string" },
                    file: { type: "string" },
                    url: { type: "string" },
                    label: { type: "string", description: "Group label (group nodes only)." },
                    group: { type: "string", description: "Id of the group node this node belongs to." },
                    x: { type: "number" },
                    y: { type: "number" },
                    width: { type: "number" },
                    height: { type: "number" },
                    color: { type: "string" },
                  },
                },
              },
              edges: {
                type: "array",
                description: "Directed edges between node ids, with optional labels.",
                items: {
                  type: "object",
                  properties: {
                    from: { type: "string" },
                    to: { type: "string" },
                    label: { type: "string" },
                  },
                  required: ["from", "to"],
                },
              },
              folder: { type: "string", description: "Target folder (defaults to the configured folder)." },
            },
            required: ["title", "nodes"],
          },
        },
        async (args) => this.createCanvas(str(args.title), args.nodes, args.edges, optStr(args.folder)),
      ),
      write({
          name: "ontology_propose",
          description: "Propose a new note type as a schema note in the ontology folder. Validated against the existing types; rule violations are returned and nothing is written.",
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string", description: "Type name, lowercase kebab-case." },
              parent: { type: "string", description: "Parent type (default: entity)." },
              properties: { type: "array", items: { type: "object", properties: { key: { type: "string" }, type: { type: "string", enum: [...PROPERTY_TYPE_VALUES] }, required: { type: "boolean" }, description: { type: "string" } }, required: ["key", "type"] } },
              relations: { type: "array", items: { type: "object", properties: { key: { type: "string" }, targets: { type: "array", items: { type: "string" } }, description: { type: "string" } }, required: ["key", "targets"] } },
            },
            required: ["name"],
          },
        }, async (args) => this.ontologyPropose(args), this.opts.ontology && this.opts.ontologyFolder ? undefined : ONTOLOGY_OFF_MESSAGE),
    ];
  }

  private ontologyGet(type: string | undefined): string {
    const registry = this.opts.ontology?.() ?? null;
    return JSON.stringify(describeOntology(registry?.resolved() ?? new Map(), type), null, 2);
  }

  private async ontologyPropose(args: Record<string, unknown>): Promise<string> {
    const registry = this.opts.ontology?.();
    const folder = this.opts.ontologyFolder?.();
    if (!registry || !folder) throw new Error(ONTOLOGY_OFF_MESSAGE);
    const outcome = validateProposal(new Set(registry.resolved().keys()), args);
    if (!outcome.ok) throw new Error(`The proposal was not written:\n- ${outcome.errors.join("\n- ")}`);
    const path = assertVaultPath(`${folder}/${outcome.fileName}`);
    if (this.app.vault.getAbstractFileByPath(path)) throw new Error(`A schema note already exists at ${path}.`);
    await ensureFolder(this.app, folder);
    const file = await this.app.vault.create(path, outcome.content);
    await registry.load();
    return `Created ${file.path} — type '${outcome.def.name}' extends '${outcome.def.extendsType ?? "entity"}'.`;
  }

  private async createBase(title: string, args: Record<string, unknown>, folder: string | undefined): Promise<string> {
    const yaml = buildBaseFile({
      ...(args.filters !== undefined ? { filters: args.filters as Exclude<ProposedBase["filters"], undefined> } : {}),
      views: Array.isArray(args.views) ? (args.views as ProposedBase["views"]) : [],
      ...(args.formulas && typeof args.formulas === "object" ? { formulas: args.formulas as Record<string, string> } : {}),
      ...(args.properties && typeof args.properties === "object" ? { properties: args.properties as Record<string, string> } : {}),
      ...(args.summaries && typeof args.summaries === "object" ? { summaries: args.summaries as Record<string, string> } : {}),
    });
    const dir = assertVaultPath((folder ?? this.opts.defaultFolder).trim());
    await ensureFolder(this.app, dir);
    const path = await uniquePath(this.app, dir, title, ".base");
    const file = await this.app.vault.create(path, yaml);
    return `Created base: ${file.path}`;
  }

  private async createCanvas(title: string, nodes: unknown, edges: unknown, folder: string | undefined): Promise<string> {
    const data = buildCanvas(
      Array.isArray(nodes) ? (nodes as ProposedCanvasNode[]) : [],
      Array.isArray(edges) ? (edges as ProposedCanvasEdge[]) : [],
    );
    const dir = assertVaultPath((folder ?? this.opts.defaultFolder).trim());
    await ensureFolder(this.app, dir);
    const path = await uniquePath(this.app, dir, title, ".canvas");
    const file = await this.app.vault.create(path, serializeCanvas(data));
    return `Created canvas: ${file.path} (${data.nodes.length} nodes, ${data.edges.length} edges)`;
  }
}
