// Top-level check of tools/call arguments against a tool's input schema: required names, declared types, enums, and forbidden extras. Pure.

type Schema = Record<string, unknown>;

const NOUNS: Record<string, string> = {
  string: "a string",
  number: "a number",
  integer: "an integer",
  boolean: "a boolean",
  array: "an array",
  object: "an object",
  null: "null",
};

/** Why `args` violate the top level of `schema`, or null when they conform. */
export function argumentError(schema: Schema, args: Record<string, unknown>): string | null {
  const properties = (isObject(schema.properties) ? schema.properties : {}) as Record<string, Schema>;
  const required = Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : [];
  for (const name of required) {
    if (args[name] === undefined) return `${name} is required`;
  }
  for (const [name, value] of Object.entries(args)) {
    const property = properties[name];
    if (!isObject(property)) {
      if (schema.additionalProperties === false) return `${name} is not a known argument`;
      continue;
    }
    const types = typeof property.type === "string" ? [property.type] : Array.isArray(property.type) ? property.type.filter((type): type is string => typeof type === "string") : [];
    if (types.length > 0 && !types.some((type) => matches(type, value))) return `${name} must be ${types.map((type) => NOUNS[type] ?? type).join(" or ")}`;
    if (Array.isArray(property.enum) && !property.enum.includes(value)) return `${name} must be one of ${property.enum.map((option) => JSON.stringify(option)).join(", ")}`;
  }
  return null;
}

function matches(type: string, value: unknown): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
    case "object": return isObject(value);
    case "null": return value === null;
    default: return true;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
