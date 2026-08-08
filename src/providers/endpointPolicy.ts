export type UtilityBackend = "claude" | "ollama" | "custom";
export type UtilityFallbackApproval = "allow" | "deny";

export interface UtilityRuntimePolicy {
  backend: UtilityBackend;
  endpoint?: string;
  claudeEndpoint?: string;
  isMobile: boolean;
  claudeAvailable: boolean;
  fallbackApproval?: UtilityFallbackApproval;
}

export type EndpointClassification = "loopback" | "wildcard-local" | "lan" | "remote" | "invalid";

export type UtilityRuntimeResolution =
  | { state: "configured-provider"; backend: UtilityBackend }
  | { state: "unavailable-loopback"; backend: Exclude<UtilityBackend, "claude">; endpoint: string }
  | {
      state: "approved-Claude-fallback";
      backend: "claude";
      configuredBackend: Exclude<UtilityBackend, "claude">;
      endpoint: string;
    }
  | {
      state: "unavailable-without-Claude";
      backend: UtilityBackend;
      endpoint: string;
      reason: "claude-unavailable" | "fallback-denied" | "invalid-endpoint" | "mobile-local-endpoint";
    };

export type UnavailableUtilityResolution = Exclude<
  UtilityRuntimeResolution,
  { state: "configured-provider" | "approved-Claude-fallback" }
>;

const INVALID_ENDPOINT_DISPLAY = "(invalid endpoint)";

export class UtilityUnavailableError extends Error {
  constructor(
    message: string,
    readonly resolution: UnavailableUtilityResolution,
  ) {
    super(message);
    this.name = "UtilityUnavailableError";
  }
}

function validEndpoint(url: string): URL | null {
  try {
    const raw = url.trim();
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const authorityStart = raw.indexOf("://") + 3;
    const authorityEndMatch = raw.slice(authorityStart).search(/[/?#]/);
    const authorityEnd = authorityEndMatch < 0 ? raw.length : authorityStart + authorityEndMatch;
    const authority = raw.slice(authorityStart, authorityEnd);
    // URL normalizes empty userinfo/query/fragment markers away, so inspect the
    // literal input too: all of them are forbidden even when their value is empty.
    if (!parsed.hostname || authority.includes("@") || raw.includes("?") || raw.includes("#")) return null;
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (!hostname.includes(":")) {
      const labels = hostname.split(".");
      if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function sanitizeEndpointForDisplay(endpoint: string): string {
  const raw = endpoint.trim();
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return INVALID_ENDPOINT_DISPLAY;
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
    const sanitized = `${parsed.protocol}//${parsed.host}${path}`;
    return validEndpoint(sanitized) ? sanitized : INVALID_ENDPOINT_DISPLAY;
  } catch {
    return INVALID_ENDPOINT_DISPLAY;
  }
}

function embeddedIpv4Class(hostname: string): "loopback" | "wildcard-local" | null {
  if (!hostname.includes(":")) return null;
  const split = hostname.split("::");
  if (split.length > 2) return null;
  const left = split[0] ? split[0].split(":") : [];
  const right = split.length === 2 && split[1] ? split[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (split.length === 1 && missing !== 0)) return null;
  const parts = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return null;
  const values = parts.map((part) => Number.parseInt(part, 16));
  const compatible = values.slice(0, 6).every((part) => part === 0);
  const mapped = values.slice(0, 5).every((part) => part === 0) && values[5] === 0xffff;
  if (!compatible && !mapped) return null;
  const high = values[6] ?? 0;
  const low = values[7] ?? 0;
  const first = high >> 8;
  const second = high & 0xff;
  const third = low >> 8;
  const fourth = low & 0xff;
  if (first === 127) return "loopback";
  if (first === 0 && second === 0 && third === 0 && fourth === 0) return "wildcard-local";
  return null;
}

export function classifyEndpoint(url: string): EndpointClassification {
  const parsed = validEndpoint(url);
  if (!parsed) return "invalid";
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  // This is intentionally lexical: an Obsidian mobile WebView cannot prove
  // arbitrary DNS resolution or rebinding synchronously. Keep ordinary LAN
  // hostnames usable, while covering the standard/common local aliases.
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "localhost.localdomain" ||
    hostname === "ip6-localhost" ||
    hostname === "ip6-loopback" ||
    hostname === "::1" ||
    /^127(?:\.|$)/.test(hostname)
  ) {
    return "loopback";
  }
  if (hostname === "0.0.0.0" || hostname === "::" || hostname === "::0") return "wildcard-local";
  const embedded = embeddedIpv4Class(hostname);
  if (embedded) return embedded;

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((part) => part > 255)) return "invalid";
    const [first = 0, second = 0] = octets;
    if (
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254)
    ) {
      return "lan";
    }
  }
  return "remote";
}

export function resolveUtilityForRuntime(policy: UtilityRuntimePolicy): UtilityRuntimeResolution {
  const rawEndpoint = policy.endpoint ?? (policy.backend === "claude" ? "https://api.anthropic.com" : "");
  const endpoint = sanitizeEndpointForDisplay(rawEndpoint);
  const classification = classifyEndpoint(rawEndpoint);
  if (classification === "invalid") {
    return { state: "unavailable-without-Claude", backend: policy.backend, endpoint, reason: "invalid-endpoint" };
  }
  if (policy.backend === "claude") {
    if (!policy.claudeAvailable) {
      return { state: "unavailable-without-Claude", backend: policy.backend, endpoint, reason: "claude-unavailable" };
    }
    if (policy.isMobile && (classification === "loopback" || classification === "wildcard-local")) {
      return { state: "unavailable-without-Claude", backend: policy.backend, endpoint, reason: "mobile-local-endpoint" };
    }
    return { state: "configured-provider", backend: policy.backend };
  }
  if (!policy.isMobile) return { state: "configured-provider", backend: policy.backend };
  if (classification === "lan" || classification === "remote") {
    return { state: "configured-provider", backend: policy.backend };
  }
  if (!policy.claudeAvailable) {
    return { state: "unavailable-without-Claude", backend: policy.backend, endpoint, reason: "claude-unavailable" };
  }
  const rawClaudeEndpoint = policy.claudeEndpoint ?? "https://api.anthropic.com";
  const claudeEndpoint = sanitizeEndpointForDisplay(rawClaudeEndpoint);
  const claudeClassification = classifyEndpoint(rawClaudeEndpoint);
  if (claudeClassification === "invalid") {
    return { state: "unavailable-without-Claude", backend: "claude", endpoint: claudeEndpoint, reason: "invalid-endpoint" };
  }
  if (claudeClassification === "loopback" || claudeClassification === "wildcard-local") {
    return { state: "unavailable-without-Claude", backend: "claude", endpoint: claudeEndpoint, reason: "mobile-local-endpoint" };
  }
  if (policy.fallbackApproval === "allow") {
    return {
      state: "approved-Claude-fallback",
      backend: "claude",
      configuredBackend: policy.backend,
      endpoint,
    };
  }
  if (policy.fallbackApproval === "deny") {
    return { state: "unavailable-without-Claude", backend: policy.backend, endpoint, reason: "fallback-denied" };
  }
  return { state: "unavailable-loopback", backend: policy.backend, endpoint };
}
