import type { ActivityRecoveryAction } from "../activity/store";
import { classifyEndpoint, sanitizeEndpointForDisplay } from "../providers/endpointPolicy";

export type EmbeddingFailureCategory =
  | "builtin-model-missing"
  | "ollama-unreachable"
  | "model-missing"
  | "custom-endpoint-unreachable"
  | "mobile-local-endpoint"
  | "index-storage-failure"
  | "unknown";

export interface EmbeddingFailureContext {
  engine: "builtin" | "ollama" | "custom";
  endpoint?: string;
  isMobile: boolean;
}

export interface EmbeddingRecovery {
  category: EmbeddingFailureCategory;
  message: string;
  technicalDetails: string;
  actions: ActivityRecoveryAction[];
}

const action = (id: string, label: string, kind: ActivityRecoveryAction["kind"]): ActivityRecoveryAction => ({ id, label, kind });

function safeDetails(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s?#]*@/gi, "$1")
    .replace(/\bBearer\s+\S+/gi, "[redacted]")
    .replace(/\b(?:api[_-]?key|token|password)\s*[=:]\s*\S+/gi, "[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

export function classifyEmbeddingFailure(error: unknown, context: EmbeddingFailureContext): EmbeddingRecovery {
  const technicalDetails = safeDetails(error);
  const lower = technicalDetails.toLowerCase();
  const endpoint = context.endpoint ? sanitizeEndpointForDisplay(context.endpoint) : "";
  const endpointClass = context.endpoint ? classifyEndpoint(context.endpoint) : "invalid";

  if (context.engine === "builtin" && (lower.includes("not downloaded") || lower.includes("model file was not found"))) {
    return {
      category: "builtin-model-missing",
      message: "The built-in embedding model is not downloaded yet.",
      technicalDetails,
      actions: [
        action("download-builtin", "Download built-in model", "download"),
        action("embedding-settings", "Open embedding settings", "settings"),
      ],
    };
  }
  if (/\b(eacces|eperm|enospc|read-only|semantic-index\.json|storage|persist|write failed)\b/i.test(technicalDetails)) {
    return {
      category: "index-storage-failure",
      message: "Companion could not read or save the semantic index.",
      technicalDetails,
      actions: [
        action("retry-index", "Retry index", "retry"),
        action("copy-details", "Copy technical details", "copy-details"),
      ],
    };
  }
  if (context.isMobile && (endpointClass === "loopback" || endpointClass === "wildcard-local")) {
    return {
      category: "mobile-local-endpoint",
      message: `This device cannot reach the local embedding endpoint${endpoint ? ` at ${endpoint}` : ""}.`,
      technicalDetails,
      actions: [
        action("use-builtin-embeddings", "Use built-in embeddings", "degrade"),
        action("embedding-settings", "Open embedding settings", "settings"),
      ],
    };
  }
  if (lower.includes("404") || lower.includes("not_found") || /model.*(?:missing|not found|unknown|invalid)/i.test(lower)) {
    return {
      category: "model-missing",
      message: "The configured embedding model is not available on this endpoint.",
      technicalDetails,
      actions: [
        action("embedding-settings", "Choose another model", "settings"),
        action("use-builtin-embeddings", "Use built-in embeddings", "degrade"),
      ],
    };
  }
  if (context.engine === "ollama" && /(?:econnrefused|fetch failed|failed to fetch|network|ollama|11434)/i.test(lower)) {
    return {
      category: "ollama-unreachable",
      message: `Companion cannot reach Ollama${endpoint ? ` at ${endpoint}` : ""}. Start Ollama, then retry.`,
      technicalDetails,
      actions: [
        action("retry-index", "Retry connection and index", "retry"),
        action("use-builtin-embeddings", "Use built-in embeddings", "degrade"),
        action("embedding-settings", "Open embedding settings", "settings"),
      ],
    };
  }
  if (context.engine === "custom" && /(?:econnrefused|fetch failed|failed to fetch|network|invalid endpoint)/i.test(lower)) {
    return {
      category: "custom-endpoint-unreachable",
      message: `Companion cannot reach the custom embedding endpoint${endpoint ? ` at ${endpoint}` : ""}.`,
      technicalDetails,
      actions: [
        action("retry-index", "Retry index", "retry"),
        action("embedding-settings", "Open embedding settings", "settings"),
      ],
    };
  }
  return {
    category: "unknown",
    message: "Companion could not complete the embedding operation.",
    technicalDetails,
    actions: [
      action("retry-index", "Retry index", "retry"),
      action("embedding-settings", "Open embedding settings", "settings"),
      action("copy-details", "Copy technical details", "copy-details"),
    ],
  };
}
