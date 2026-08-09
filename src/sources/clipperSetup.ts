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
      "1. Open the official Obsidian Web Clipper → Settings → Templates.",
      "2. Open any template, choose Import, paste the JSON, and confirm.",
      `3. Return to a matching ${type} page and create one test clip into ${settings.inboxFolder}.`,
      "4. Return to Companion. It will verify the arriving note before marking this setup verified.",
    ].join("\n"),
  };
}
