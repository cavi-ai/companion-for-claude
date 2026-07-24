export interface ActiveCompanionNote {
  path: string;
  title: string;
}

export interface ActiveResearchWorkspace {
  projectPath: string;
  title: string;
  stage: string;
  nextAction?: string;
  nextReason?: string;
}

export interface CompanionWorkspaceInput {
  activeNote?: ActiveCompanionNote;
  research?: ActiveResearchWorkspace;
}

export interface CompanionWorkspaceCard {
  kind: "research" | "note";
  eyebrow: string;
  title: string;
  description: string;
  meta: string;
  primaryAction: string;
  secondaryAction: string;
  contextPath: string;
}

function titleCase(value: string): string {
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;
}

/** Resolve the one workspace that is relevant to the note the user is viewing. */
export function resolveCompanionWorkspace(input: CompanionWorkspaceInput): CompanionWorkspaceCard | null {
  if (!input.activeNote) return null;
  if (input.research) {
    const next = input.research.nextAction;
    return {
      kind: "research",
      eyebrow: "CURRENT WORKSPACE · RESEARCH",
      title: `Continue ${input.research.title}`,
      description: input.research.nextReason ?? "Continue the project without losing the thread between sources, evidence, claims, and writing.",
      meta: `${titleCase(input.research.stage)}${next ? ` · ${next}` : ""}`,
      primaryAction: "Open Research Desk",
      secondaryAction: "Ask Companion",
      contextPath: input.research.projectPath,
    };
  }
  return {
    kind: "note",
    eyebrow: "CURRENT WORKSPACE · NOTE",
    title: `Continue with ${input.activeNote.title}`,
    description: "Bring this note into the conversation or rediscover related material without leaving your train of thought.",
    meta: input.activeNote.path,
    primaryAction: "Ask about this note",
    secondaryAction: "Find related notes",
    contextPath: input.activeNote.path,
  };
}
