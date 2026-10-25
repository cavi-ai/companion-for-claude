import { parseYaml, stringifyYaml } from "obsidian";
import { Lexer } from "yaml";
import { frontmatterBlock } from "../markdown/frontmatter";

export class SourcePropertiesError extends Error {
  constructor(detail: string) {
    super(`Invalid YAML properties: ${detail}. Open the note and fix its opening YAML properties block, then retry. The note was not changed.`);
    this.name = "SourcePropertiesError";
  }
}

function yamlTokens(yaml: string): Array<{ source: string; offset: number; column: number }> {
  let offset = 0;
  let column = 0;
  return [...new Lexer().lex(yaml)].filter((source) => !["\x02", "\x1f", "\x18"].includes(source)).map((source) => {
    const token = { source, offset, column };
    offset += source.length;
    column = source.includes("\n") ? source.length - source.lastIndexOf("\n") - 1 : column + source.length;
    return token;
  });
}

function fields(yaml: string): Array<{ key: string; offset: number }> {
  const tokens = yamlTokens(yaml);
  const result: Array<{ key: string; offset: number }> = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.column !== 0 || !token.source.trim() || /^[#\s]/.test(token.source)) continue;
    let next = index + 1;
    while (tokens[next]?.source === " ") next++;
    if (tokens[next]?.source !== ":") continue;
    const key: unknown = parseYaml(token.source);
    if (typeof key === "string") {
      if (result.some((field) => field.key === key)) throw new SourcePropertiesError(`duplicate property ${key}`);
      result.push({ key, offset: token.offset });
    }
  }
  return result;
}

/** Update root fields using YAML token boundaries; nested values and unchanged text remain intact. */
class SourceYamlDocument {
  private readonly updates = new Map<string, unknown>();
  constructor(private readonly yaml: string, private readonly original: Record<string, unknown>) {}
  set(key: string, value: unknown): void {
    if (stringifyYaml({ value: this.original[key] }) === stringifyYaml({ value })) this.updates.delete(key);
    else this.updates.set(key, value);
  }
  private canonical(): string {
    const retained = yamlTokens(this.yaml).filter(({ source }) => source.startsWith("#")).map(({ source }) => `${source}\n`).join("");
    return retained + stringifyYaml({ ...this.original, ...Object.fromEntries(this.updates) });
  }
  toString(): string {
    if (this.updates.size === 0) return this.yaml;
    const slots = fields(this.yaml);
    const pending = new Map(this.updates);
    if (slots.length !== Object.keys(this.original).length) {
      return this.canonical();
    }
    let rendered = this.yaml.slice(0, slots[0]?.offset ?? this.yaml.length);
    for (let index = 0; index < slots.length; index++) {
      const { key, offset } = slots[index]!;
      const raw = this.yaml.slice(offset, slots[index + 1]?.offset ?? this.yaml.length);
      if (!pending.has(key)) { rendered += raw; continue; }
      const retained = yamlTokens(raw).filter(({ source }) => source.startsWith("#")).map(({ source }) => `${source}\n`).join("");
      rendered += retained + stringifyYaml({ [key]: pending.get(key) });
      pending.delete(key);
    }
    const output = rendered + (rendered && !rendered.endsWith("\n") ? "\n" : "") + (pending.size ? stringifyYaml(Object.fromEntries(pending)) : "");
    // Replacing an anchored field must not leave another property's alias dangling.
    try { parseYaml(output); return output; }
    catch { return this.canonical(); }
  }
}

export interface PreparedSourceMarkdown {
  properties: Record<string, unknown>;
  body: string;
  eol: "\n" | "\r\n";
  bom: string;
  document: SourceYamlDocument;
  content: string;
}

const STRING_FIELDS = new Set(["title", "summary", "description", "author", "site", "publication", "channel"]);

/** Only repair scalar punctuation and list indentation whose meaning is unambiguous. */
function repairYaml(yaml: string): string {
  return yaml.replace(/^\t+(?=- )/gm, (tabs) => "  ".repeat(tabs.length)).replace(
    /^(\w+):[ \t]+([^\n\r]+)$/gm,
    (line: string, key: string, value: string) => STRING_FIELDS.has(key)
      && !['"', "'", "[", "]", "{", "|", ">", "!", "&", "*"].includes(value[0] ?? "") && !value.includes("#") && /:\s/.test(value)
      ? `${key}: ${JSON.stringify(value)}` : line,
  );
}

/** A leading thematic break followed by an article is body, not an empty properties header. */
function startsArticle(text: string): boolean {
  const lines = text.trimStart().split(/\r?\n/);
  if (!/^#{1,6}\s+\S/.test(lines[0] ?? "") || lines[1]?.trim()) return false;
  const firstText = lines.find((line) => line.trim() && !/^\s*#/.test(line));
  return firstText !== undefined && fields(firstText).length === 0;
}

export function renderSourceMarkdown(prepared: Omit<PreparedSourceMarkdown, "content">): string {
  const yaml = prepared.document.toString().replace(/\r?\n$/, "").replace(/\r?\n/g, prepared.eol);
  return `${prepared.bom}---${prepared.eol}${yaml}${yaml ? prepared.eol : ""}---${prepared.eol}${prepared.body}`;
}

/** One interpretation for classification, extraction, and the final live-content merge. */
export function prepareSourceMarkdown(content: string): PreparedSourceMarkdown {
  const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  const text = content.slice(bom.length);
  const eol: "\n" | "\r\n" = text.includes("\r\n") ? "\r\n" : "\n";
  const block = frontmatterBlock(text);
  let yaml = "";
  let body = text;
  let properties: Record<string, unknown> = {};
  if (block) {
    yaml = repairYaml(block.yaml);
    let parsed: unknown;
    let failure: unknown;
    try { parsed = parseYaml(yaml); } catch (error) { failure = error; }
    if (!failure && (parsed === null || (typeof parsed === "object" && !Array.isArray(parsed)))) {
      properties = (parsed ?? {}) as Record<string, unknown>;
      fields(yaml);
      body = text.slice(block.end);
    } else if (startsArticle(block.yaml)) {
      yaml = "";
    } else {
      throw new SourcePropertiesError(failure instanceof Error ? failure.message.split("\n")[0]! : "the properties must be a mapping");
    }
  } else if (!block && /^---[ \t]*(?:\r?\n|$)/.test(text)) {
    if (!startsArticle(text.slice(text.indexOf("\n") + 1))) {
      throw new SourcePropertiesError("the opening block has no closing --- delimiter");
    }
  }
  const prepared = { properties, body, eol, bom, document: new SourceYamlDocument(yaml, { ...properties }) };
  return { ...prepared, content: renderSourceMarkdown(prepared) };
}
