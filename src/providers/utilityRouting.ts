// Utility-model routing at runtime: which backend a background call may use,
// the mobile Claude-fallback consent it needs, and the unload lifecycle that
// discards in-flight utility work.

import type { App } from "obsidian";
import type { PluginSettings } from "../types";
import { ChoiceModal } from "../view/ChoiceModal";
import { ANTHROPIC_DEFAULT_BASE_URL } from "./auth";
import { sanitizeEndpointForDisplay, UtilityUnavailableError, type UtilityFallbackApproval } from "./endpointPolicy";
import { errorHint } from "./errorHints";
import type { ProviderRouter, ProviderSelection, RuntimeUtilitySelection, UtilityFallbackConsentContext } from "./router";
import type { ProviderId } from "./types";
import { sameConsentKey, UtilityFallbackConsent, type ConsentDialog } from "./utilityConsent";

export interface UtilityRoutingDeps {
  app: App;
  settings: () => PluginSettings;
  router: () => ProviderRouter;
  isMobile: () => boolean;
}

export class UtilityRouting {
  private ended = false;
  private generation = 0;
  /** Mobile loopback → Claude consent for this plugin session. */
  private readonly consent = new UtilityFallbackConsent((context) => this.askMobileUtilityFallback(context));

  constructor(private deps: UtilityRoutingDeps) {}

  /** Begins a plugin session: new lifecycle generation, consent reopened. */
  start(): void {
    this.generation += 1;
    this.ended = false;
    this.consent.start();
  }

  /** Ends the session: pending approvals close and in-flight utility work is discarded. */
  end(): void {
    this.ended = true;
    this.generation += 1;
    this.consent.end();
  }

  isEnded(): boolean {
    return this.ended;
  }

  lifecycleGeneration(): number {
    return this.generation;
  }

  isLifecycleActive(generation: number): boolean {
    return !this.ended && this.generation === generation;
  }

  assertLifecycleActive(generation: number): void {
    if (!this.isLifecycleActive(generation)) {
      throw new Error("Companion unloaded while utility work was in flight; the result was discarded without writing.");
    }
  }

  /** Plugin-owned runtime/privacy hook used by every router utility completion. */
  async resolveSession(): Promise<ProviderSelection> {
    if (this.ended) throw new Error("Companion unloaded before utility approval completed; no content was sent.");
    let selection = this.runtimeSelection();
    if (selection.state === "unavailable-loopback") {
      const promptedContext = this.deps.router().utilityFallbackConsentContext(this.deps.isMobile());
      if (!promptedContext) throw new UtilityUnavailableError(this.unavailableMessage(selection), selection);
      const approval = await this.consent.decide(promptedContext);
      if (this.ended) throw new Error("Companion unloaded before utility approval completed; no content was sent.");

      // Settings may rebuild the router while the modal is open. Reacquire it,
      // inspect the full current source + destination identity, and never apply
      // consent obtained for a different gateway or auth context.
      const currentRouter = this.deps.router();
      const current = currentRouter.resolveUtilityForRuntime({ isMobile: this.deps.isMobile() });
      const currentContext = currentRouter.utilityFallbackConsentContext(this.deps.isMobile());
      if (!sameConsentKey(promptedContext, currentContext)) {
        this.consent.forget(promptedContext);
        if (current.state === "unavailable-loopback" || current.state === "unavailable-without-Claude") {
          if (current.state === "unavailable-loopback" && currentContext) {
            throw new Error(
              `The utility destination changed while fallback approval was open. ` +
              `The current Anthropic fallback endpoint is ${currentContext.fallbackEndpoint}. Retry the utility action to review the current destination.`,
            );
          }
          throw new UtilityUnavailableError(this.unavailableMessage(current), current);
        }
        throw new Error(
          `Utility settings changed while Claude fallback approval was open. ` +
          `The current ${current.backend} utility backend is ${current.endpoint ?? current.provider.label}. Retry the utility action to use the current settings.`,
        );
      }
      selection = currentRouter.resolveUtilityForRuntime({
        isMobile: this.deps.isMobile(),
        fallbackApproval: approval,
      });
    }
    if (selection.state === "configured-provider" || selection.state === "approved-Claude-fallback") {
      return selection;
    }
    throw new UtilityUnavailableError(this.unavailableMessage(selection), selection);
  }

  runtimeSelection(): RuntimeUtilitySelection {
    const router = this.deps.router();
    const decision = this.consent.current(router.utilityFallbackConsentContext(this.deps.isMobile()));
    return router.resolveUtilityForRuntime({ isMobile: this.deps.isMobile(), ...(decision ? { fallbackApproval: decision } : {}) });
  }

  /** Runtime-selected utility backend shown alongside Inbox batch controls. */
  backendLabel(): string {
    const selection = this.runtimeSelection();
    if (selection.state === "unavailable-loopback") return "Unavailable on mobile · Claude approval required";
    if (selection.state === "unavailable-without-Claude") {
      return selection.reason === "invalid-endpoint" ? "Unavailable · invalid utility endpoint" : "Unavailable on mobile";
    }
    if (selection.provider.id === "anthropic") return `Claude (Anthropic API) · ${selection.model}`;
    if (selection.provider.id === "ollama") return `Ollama · ${selection.model}`;
    return `OpenAI-compatible endpoint · ${selection.model}`;
  }

  private providerEndpoint(provider: ProviderId): string | undefined {
    const settings = this.deps.settings();
    if (provider === "ollama") return sanitizeEndpointForDisplay(settings.ollamaHost);
    if (provider === "openai-compat") return sanitizeEndpointForDisplay(settings.openaiCompatHost);
    return settings.baseUrl.trim() ? sanitizeEndpointForDisplay(settings.baseUrl) : undefined;
  }

  providerErrorHint(message: string, provider: ProviderId): string | null {
    return errorHint(message, provider, this.providerEndpoint(provider));
  }

  enrichmentErrorHint(message: string): string | null {
    const selection = this.runtimeSelection();
    const provider: ProviderId =
      selection.state === "configured-provider" || selection.state === "approved-Claude-fallback"
        ? selection.provider.id
        : selection.backend === "ollama"
          ? "ollama"
          : "openai-compat";
    return this.providerErrorHint(message, provider);
  }

  private askMobileUtilityFallback(context: UtilityFallbackConsentContext): ConsentDialog {
    let modal!: ChoiceModal<UtilityFallbackApproval>;
    const decision = new Promise<UtilityFallbackApproval>((resolve) => {
      let settled = false;
      const finish = (choice: UtilityFallbackApproval): void => {
        if (settled) return;
        settled = true;
        resolve(choice);
      };
      modal = new ChoiceModal<UtilityFallbackApproval>(this.deps.app, {
        title: "Use Claude for mobile enrichment?",
        message:
          `The utility model at ${context.configuredEndpoint} is local to your desktop and cannot be reached from this mobile device. ` +
          `If you continue, ${this.mobileFallbackDestinationLabel(context.fallbackEndpoint)} may receive content for source enrichment, tagging and organization, ` +
          "summaries and frontmatter, and memory consolidation including session content. " +
          "Allow this fallback for the current plugin session?",
        buttons: [
          { label: "Use Claude this session", value: "allow", cta: true },
          { label: "Don't send", value: "deny" },
        ],
        fallback: "deny",
        onChoice: finish,
      });
      modal.open();
    });
    return { decision, close: () => modal.close() };
  }

  private mobileFallbackDestinationLabel(endpoint: string): string {
    return endpoint === ANTHROPIC_DEFAULT_BASE_URL
      ? `Claude (Anthropic API at ${endpoint})`
      : `an Anthropic-compatible gateway at ${endpoint}`;
  }

  unavailableMessage(selection: Exclude<RuntimeUtilitySelection, { state: "configured-provider" | "approved-Claude-fallback" }>): string {
    const endpoint = selection.endpoint || "(empty endpoint)";
    if (selection.state === "unavailable-loopback") {
      return `The configured ${selection.backend} utility endpoint ${endpoint} is unavailable on mobile until Claude fallback is approved.`;
    }
    if (selection.reason === "invalid-endpoint") {
      return `The configured ${selection.backend} utility endpoint “${endpoint}” is invalid. Configure a valid LAN or remote endpoint in Companion settings.`;
    }
    if (selection.reason === "mobile-local-endpoint") {
      return `The configured ${selection.backend} utility endpoint ${endpoint} is local to this device and unavailable for mobile utility calls. Configure a LAN or remote endpoint.`;
    }
    if (selection.reason === "claude-unavailable") {
      if (selection.backend === "claude") {
        return `The Claude utility backend is unavailable because no Anthropic credential is configured. Add a credential in Companion settings.`;
      }
      return `The configured ${selection.backend} utility endpoint ${endpoint} is unavailable on mobile, and no Anthropic credential is configured for Claude fallback. Add a credential or configure a LAN or remote endpoint in Companion settings.`;
    }
    return `The configured ${selection.backend} utility endpoint ${endpoint} is unavailable on mobile, and sending note content to Claude was not approved for this session. Configure a LAN or remote endpoint, or restart Obsidian to choose again.`;
  }
}
