// Consent to send utility work to Claude when the configured endpoint is unreachable on mobile, for one
// plugin session. A decision covers one exact source and destination; a denial is never replaced by a
// racing allow; concurrent callers share one open dialog; nothing is approved once the session ends.
// Pure; the dialog is injected.

import type { UtilityFallbackApproval } from "./endpointPolicy";
import type { UtilityFallbackConsentContext } from "./router";

export type ConsentKey = Pick<UtilityFallbackConsentContext, "identity" | "destinationFingerprint">;

export function sameConsentKey(left: ConsentKey, right: ConsentKey | null | undefined): boolean {
  return !!right && left.identity === right.identity && left.destinationFingerprint === right.destinationFingerprint;
}

/** One open disclosure: resolves with the user's choice (deny when dismissed or closed). */
export interface ConsentDialog {
  decision: Promise<UtilityFallbackApproval>;
  close(): void;
}

export class UtilityFallbackConsent {
  private approval: (ConsentKey & { decision: UtilityFallbackApproval }) | undefined;
  private inFlight: (ConsentKey & { promise: Promise<UtilityFallbackApproval> }) | null = null;
  private dialog: ConsentDialog | null = null;
  private ended = false;
  private generation = 0;

  constructor(private readonly ask: (context: UtilityFallbackConsentContext) => ConsentDialog) {}

  /** The decision already made for this exact context; one made for another context is dropped. */
  current(context: ConsentKey | null): UtilityFallbackApproval | undefined {
    if (this.approval && !sameConsentKey(this.approval, context)) this.approval = undefined;
    return this.approval?.decision;
  }

  /** The cached decision, the open dialog's, or a new dialog's; deny once the session has ended. */
  decide(context: UtilityFallbackConsentContext): Promise<UtilityFallbackApproval> {
    if (this.ended) return Promise.resolve("deny");
    const generation = this.generation;
    const cached = this.current(context);
    if (cached) return Promise.resolve(cached);
    if (this.inFlight && sameConsentKey(context, this.inFlight)) return this.inFlight.promise;
    // A different destination appeared while the old disclosure was open: close it fail-safe.
    if (this.inFlight) this.dialog?.close();
    const dialog = this.ask(context);
    this.dialog = dialog;
    const pending = dialog.decision.then((decision): UtilityFallbackApproval => {
      if (this.dialog === dialog) this.dialog = null;
      if (this.ended || this.generation !== generation) return "deny";
      const existing = this.approval;
      if (sameConsentKey(context, existing) && existing?.decision === "deny") return "deny";
      this.approval = { identity: context.identity, destinationFingerprint: context.destinationFingerprint, decision };
      return decision;
    });
    const shared = pending.finally(() => {
      if (this.inFlight?.promise === shared) this.inFlight = null;
    });
    this.inFlight = { identity: context.identity, destinationFingerprint: context.destinationFingerprint, promise: shared };
    return shared;
  }

  /** Drop a decision made for this context (its destination changed while the dialog was open). */
  forget(context: ConsentKey): void {
    if (sameConsentKey(context, this.approval)) this.approval = undefined;
  }

  /** A fresh plugin session: no decisions and no dialogs. */
  start(): void {
    this.generation += 1;
    this.ended = false;
    this.approval = undefined;
    this.inFlight = null;
    this.dialog = null;
  }

  /** End the session: close the open dialog; pending and later decisions resolve deny. */
  end(): void {
    this.ended = true;
    this.generation += 1;
    this.approval = undefined;
    this.dialog?.close();
    this.dialog = null;
    this.inFlight = null;
  }
}
