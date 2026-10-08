// The note types the plugin itself writes. One list, shared by the seed drift
// test, health checks, link weave, and type weave. Pure.

/** Run outputs: never linked to, never conformance-checked by vault health, never offered as a type. */
export const GENERATED_NOTE_TYPES: ReadonlySet<string> = new Set(["triage", "order-run", "optimize-run"]);

/** Every type the plugin writes; each is seeded, and none is offered as a type for the user's own notes. */
export const PLUGIN_NOTE_TYPES: ReadonlySet<string> = new Set([
  ...GENERATED_NOTE_TYPES,
  "chat",
  "artifact",
  "plan",
  "build-spec",
  "build-tracker",
  "research-project",
  "research-source",
  "evidence",
  "claim",
  "research-question",
  "research-document",
  "claude-memory",
  "chat-summary",
  "chat-project",
]);
