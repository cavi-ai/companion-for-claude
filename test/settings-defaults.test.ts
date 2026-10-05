import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS } from "../src/types";
import { DISCOVERY_CACHE_HOURS, DISCOVERY_EXPANSION_LIMIT, DISCOVERY_MAX_RESULTS } from "../src/discovery/limits";
import { ARTIFACT_HEIGHT } from "../src/artifacts/renderInline";
import { CLOUD_ROUTINE_BETA_HEADER } from "../src/cloud/routines";

describe("source-capture defaults", () => {
  it("ships on with first-run consent and a default inbox", () => {
    expect(DEFAULT_SETTINGS.sourceCaptureEnabled).toBe(true);
    expect(DEFAULT_SETTINGS.sourceEnrichOnCreate).toBe(true);
    expect(DEFAULT_SETTINGS.sourceCaptureConsent).toBe("ask");
    expect(DEFAULT_SETTINGS.sourceInboxFolder).toBe("Clippings");
    expect(DEFAULT_SETTINGS.sourceBaseTags).toEqual(["source"]);
    expect(DEFAULT_SETTINGS.sourceSchemaOverrides).toEqual({});
  });
});

describe("memory settings defaults", () => {
  it("ships sane defaults", () => {
    expect(DEFAULT_SETTINGS.memoryEnabled).toBe(true);
    expect(DEFAULT_SETTINGS.memoryFolder).toBe("Claude/Sessions");
    expect(DEFAULT_SETTINGS.memoryIngestOnSave).toBe(false);
    expect(DEFAULT_SETTINGS.memoryBaseTags).toEqual(["claude", "session"]);
  });
  it("has a plans folder default", () => {
    expect(DEFAULT_SETTINGS.planFolder).toBe("Claude/Plans");
  });
  it("defaults max tokens to 20k for headroom", () => {
    expect(DEFAULT_SETTINGS.maxTokens).toBe(20000);
  });
  it("opens artifacts in Obsidian by default", () => {
    expect(DEFAULT_SETTINGS.artifactOpenTarget).toBe("obsidian");
  });
});

describe("agent mode defaults", () => {
  it("agent mode ships on, writes on (each write still confirms), 10 iterations", () => {
    expect(DEFAULT_SETTINGS.agentModeEnabled).toBe(true);
    // Writes on by default so chat can act on the vault, not just narrate it;
    // the per-write confirmation modal is the safety gate.
    expect(DEFAULT_SETTINGS.agentAllowWrites).toBe(true);
    expect(DEFAULT_SETTINGS.agentMaxIterations).toBe(10);
  });
});

describe("standing orders defaults", () => {
  it("ships on", () => {
    expect(DEFAULT_SETTINGS.standingOrdersEnabled).toBe(true);
  });
});

describe("memory consolidation defaults", () => {
  it("auto-consolidate ships off (utility-model cost is opt-in)", () => {
    expect(DEFAULT_SETTINGS.memoryAutoConsolidate).toBe(false);
  });
});

describe("memory record defaults", () => {
  it("agents may record memory by default", () => {
    expect(DEFAULT_SETTINGS.memoryRecordEnabled).toBe(true);
  });
});

describe("ontology defaults", () => {
  it("ships on with the Ontology folder and an unshown seed prompt", () => {
    expect(DEFAULT_SETTINGS.ontologyEnabled).toBe(true);
    expect(DEFAULT_SETTINGS.ontologyFolder).toBe("Ontology");
    expect(DEFAULT_SETTINGS.ontologySeedPrompted).toBe(false);
  });
});

describe("embedding engine defaults", () => {
  it("built-in engine, semantic search on with a one-time download prompt", () => {
    expect(DEFAULT_SETTINGS.embeddingEngine).toBe("builtin");
    expect(DEFAULT_SETTINGS.semanticEnabled).toBe(true);
    expect(DEFAULT_SETTINGS.semanticModelPrompted).toBe(false);
    expect(DEFAULT_SETTINGS.embeddingModel).toBe("nomic-embed-text"); // still the Ollama model
  });
});

describe("research intelligence defaults", () => {
  it("defaults the research model to the chat backend", () => {
    expect(DEFAULT_SETTINGS.researchModel).toBe("chat");
  });
});

describe("scholarly discovery settings", () => {
  it("ships the exact discovery defaults", () => {
    expect(DEFAULT_SETTINGS).toEqual(expect.objectContaining({
      discoveryEnabled: true,
      openAlexContactEmail: "",
    }));
  });

  it("tuning knobs are constants at their former defaults", () => {
    expect(DISCOVERY_MAX_RESULTS).toBe(20);
    expect(DISCOVERY_EXPANSION_LIMIT).toBe(20);
    expect(DISCOVERY_CACHE_HOURS).toBe(24);
    expect(ARTIFACT_HEIGHT).toBe(640);
    expect(CLOUD_ROUTINE_BETA_HEADER).toBe("experimental-cc-routine-2026-04-01");
    for (const key of ["discoveryMaxResults", "discoveryExpansionLimit", "discoveryCacheHours", "artifactHeight", "cloudRoutineBetaHeader"]) {
      expect(DEFAULT_SETTINGS).not.toHaveProperty(key);
    }
  });
});

describe("tag classifier defaults", () => {
  it("defaults to the utility model with no override", () => {
    expect(DEFAULT_SETTINGS.classifierBackend).toBe("utility");
    expect(DEFAULT_SETTINGS.classifierModel).toBe("");
  });
});
