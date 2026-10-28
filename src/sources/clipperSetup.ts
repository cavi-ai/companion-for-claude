import {
  clipperFingerprint,
  clipperTemplateFor,
  clipperTemplateFileName,
  serializeClipperTemplate,
  serializeClipperPropertyTypes,
} from "./clipperTemplate";
import type { ClipperJsonFile } from "./clipperJsonFile";
import type { SourceType, SourceTypeSchema } from "./types";

export interface ClipperSetupSettings {
  inboxFolder: string;
  baseTags: string[];
  savedFingerprint: string;
  verification?: { state: string; fingerprint: string };
}

export interface ClipperSetupViewModel {
  type: SourceType;
  status: "not-set-up" | "current" | "update-available" | "verified";
  templateName: string;
  destination: string;
  baseTags: string[];
  schemaVersion: number;
  pageKnownFields: string[];
  companionFields: string[];
  fingerprint: string;
  json: string;
  fileName: string;
  mimeType: "application/json";
  templateFingerprint: string;
  propertyTypesFile: ClipperJsonFile;
  instructions: string;
}

const templateMetadata = new Set(["type", "source", "schema_version", "clipped", "tags", "clipper_template"]);

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
  const status = settings.verification?.state === "verified" && settings.verification.fingerprint === fingerprint
    ? "verified" as const
    : !settings.savedFingerprint
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
    fileName: clipperTemplateFileName(template),
    mimeType: "application/json",
    templateFingerprint: template.properties.find(({ name }) => name === "clipper_template")!.value,
    propertyTypesFile: {
      fileName: `companion-${type}-properties.json`,
      mimeType: "application/json",
      json: serializeClipperPropertyTypes(template),
    },
    instructions: [
      "1. Save JSON file to your device (on mobile, choose Save to Files in the share sheet), or copy template JSON.",
      "2. Open Web Clipper → Settings → Templates → Import (not Properties → Import). Choose the .json file, or choose JSON and paste the copied template into the import dialog, not into a template field. Drag-and-drop of the .json file works too.",
      template.triggers
        ? "3. Nothing else to order — this template triggers itself on YouTube URLs."
        : type === "dataset"
          ? "3. In Web Clipper, select Companion: dataset when clipping a dataset page."
          : `3. Drag “${template.name}” to the top of the template list to make it the fallback for pages without a matching trigger.`,
      `4. Return to a matching ${type} page and create one test clip into ${settings.inboxFolder}.`,
      "5. Return to Companion. It will verify the arriving note before marking this setup verified.",
    ].join("\n"),
  };
}
