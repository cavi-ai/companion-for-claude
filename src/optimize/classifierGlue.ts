import type { CompletionRequest } from "../providers/types";
import { completeJsonWithRepair } from "../providers/jsonRepair";
import type { ProviderRouter, ProviderSelection } from "../providers/router";
import type { Verdict } from "./classify";

export class ClassifierStoppedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClassifierStoppedError";
  }
}

export interface ClassifierGlueDeps {
  /** Identity changes when settings are saved. */
  router(): Pick<ProviderRouter, "classifierSelection" | "selectionRunsLocally" | "providerLabel">;
  backend(): "utility" | "ollama" | "custom";
  isMobile: boolean;
  /** Never prompts; throws UtilityUnavailableError. */
  passiveUtilitySelection(): ProviderSelection;
  /** Throws when the plugin has unloaded. */
  assertActive(): void;
}

export interface ClassifierHandle {
  local: boolean;
  label: string;
  model: string;
  complete(req: { system: string; user: string; schema: Record<string, unknown> }, parse: (raw: string) => Verdict[]): Promise<Verdict[]>;
}

export function createClassifier(deps: ClassifierGlueDeps): (opts: { interactive: boolean }) => Promise<ClassifierHandle> {
  return async ({ interactive }) => {
    const router = deps.router();
    const selection =
      deps.backend() === "utility" && !interactive
        ? deps.passiveUtilitySelection()
        : await router.classifierSelection({ isMobile: deps.isMobile });
    const guard = (): void => {
      try {
        deps.assertActive();
      } catch (error) {
        throw new ClassifierStoppedError(error instanceof Error ? error.message : "Classifier stopped");
      }
    };
    return {
      local: router.selectionRunsLocally(selection),
      label: router.providerLabel(selection.provider),
      model: selection.model,
      complete: async (req, parse) => {
        guard();
        if (deps.router() !== router) throw new ClassifierStoppedError("Classifier settings changed");
        const completion: CompletionRequest = {
          system: req.system,
          messages: [{ role: "user", content: req.user }],
          model: selection.model,
          maxTokens: 900,
          temperature: 0,
          responseFormat: "json",
          responseSchema: req.schema,
          thinking: { type: "disabled" },
        };
        const { response } = await completeJsonWithRepair(selection.provider, completion, parse);
        guard();
        return response;
      },
    };
  };
}
