export type RewriteTextFn = (input: { text: string; instruction: string; context?: string }) => Promise<string>;

export const QUESTION_INSTRUCTION = "Turn this research topic into one sharp, answerable research question: specific in scope, neutral in stance, a single sentence ending in a question mark.";

export interface ProjectCreateInput {
  title: string;
  question: string;
  folder: string;
  audience?: string;
}

export function sanitizeLoadError(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Unknown project load error";
  return raw.replace(/\b(?:sk-ant-[A-Za-z0-9_-]+|Bearer\s+\S+|api[_-]?key\s*[=:]\s*\S+)/gi, "[redacted]").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) || "Unknown project load error";
}
