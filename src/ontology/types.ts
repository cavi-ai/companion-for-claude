// The vault ontology's shared vocabulary (spec 2026-07-08). Pure data — no
// obsidian imports. Schema notes in the vault parse into TypeDef; inheritance
// resolution produces ResolvedType, which everything downstream consumes.

/** Superset of sources' FieldType (adds boolean), kept independent to avoid coupling. */
export const PROPERTY_TYPE_VALUES = ["string", "number", "boolean", "date", "duration", "string[]"] as const;

export type PropertyType = (typeof PROPERTY_TYPE_VALUES)[number];

export interface PropertyDef {
  key: string;
  type: PropertyType;
  required: boolean;
  description?: string | undefined;
}

export interface RelationDef {
  key: string;
  /** Type names the relation may point to; "entity" (the root) means any typed note. */
  targets: string[];
  description?: string | undefined;
}

export interface TypeDef {
  name: string;
  version: number;
  /** Parent type name (single inheritance). `extends` is reserved in TS. */
  extendsType?: string | undefined;
  properties: PropertyDef[];
  relations: RelationDef[];
}

export interface ResolvedType {
  name: string;
  version: number;
  /** Inheritance chain, self first, root last. */
  lineage: string[];
  /** Own + inherited; child overrides parent by key. */
  properties: PropertyDef[];
  relations: RelationDef[];
}

export interface SchemaError {
  /** Vault path of the schema note, when known. */
  path?: string | undefined;
  message: string;
}

export const PROPERTY_TYPES: ReadonlySet<string> = new Set<string>(PROPERTY_TYPE_VALUES);

/** The root type every type ultimately extends. */
export const ROOT_TYPE = "entity";
