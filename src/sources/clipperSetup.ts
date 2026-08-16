import {
  clipperFingerprint,
  clipperTemplateFor,
  serializeClipperTemplate,
} from "./clipperTemplate";
import type { SourceType, SourceTypeSchema } from "./types";

export interface ClipperSetupSettings {
  inboxFolder: string;
  baseTags: string[];
  savedFingerprint: string;
}

export interface ClipperSetupViewModel {
  type: SourceType;
  status: "not-set-up" | "current" | "update-available";
  templateName: string;
  destination: string;
  baseTags: string[];
  schemaVersion: number;
  pageKnownFields: string[];
  companionFields: string[];
  fingerprint: string;
  json: string;
  instructions: string;
}

const templateMetadata = new Set(["type", "source", "schema_version", "clipped", "tags"]);

export function clipperSetupFor(
  type: SourceType,
  schemas: SourceTypeSchema[],
  settings: ClipperSetupSettings,
): ClipperSetupViewModel {
  const schema = schemas.find((candidate) => candidate.type === type);
  if (!schema) throw new Error(`Missing ${type} source schema.`);
  const options = { path: settings.inboxFolder, tags: settings.baseTags };
  const template = clipperTemplateFor(schema, options);
  const fingerprint = clipperFingerprint(schemas, options);
  const pageKnownFields = template.properties
    .map(({ name }) => name)
    .filter((name) => !templateMetadata.has(name));
  const pageKnown = new Set(pageKnownFields);
  const companionFields = schema.fields
    .map(({ key }) => key)
    .filter((key) => !pageKnown.has(key));
  const status = !settings.savedFingerprint
    ? "not-set-up" as const
    : settings.savedFingerprint === fingerprint
      ? "current" as const
      : "update-available" as const;
  return {
    type,
    status,
    templateName: template.name,
    destination: settings.inboxFolder,
    baseTags: [...settings.baseTags],
    schemaVersion: schema.version,
    pageKnownFields,
    companionFields,
    fingerprint,
    json: serializeClipperTemplate(template),
    instructions: [
      "1. Save this template as a .json file (button below), or copy it to a file yourself.",
      "2. Open the official Obsidian Web Clipper → Settings → Templates → Import (top right) and pick that .json file — drag-and-drop onto the template list works too. Import the file; never paste it into a template's fields, which turns the JSON into clip content.",
      template.triggers
        ? "3. Nothing else to order — this template triggers itself on YouTube URLs."
        : `3. Drag “${template.name}” to the top of the template list. Web Clipper uses the first template whose triggers match, and this one has none, so it only applies while it is first.`,
      `4. Return to a matching ${type} page and create one test clip into ${settings.inboxFolder}.`,
      "5. Return to Companion. It will verify the arriving note before marking this setup verified.",
    ].join("\n"),
  };
}
