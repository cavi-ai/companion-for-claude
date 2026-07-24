// Pure placement of Anthropic prompt-cache breakpoints (`cache_control`).
// One breakpoint each on: the last system block, the last tool definition, and
// the last content block of the latest user message — ≤3 of the API's limit of
// 4. Prefix matching means every agent iteration / follow-up turn re-reads the
// previous cache (0.1× input rate) and extends it (1.25× on the new suffix).

import type { SystemBlock } from "../providers/auth";
import type { AnthropicToolDef, ApiMessage, ContentBlock, TextBlock } from "../providers/types";

const EPHEMERAL = { type: "ephemeral" } as const;

type Cacheable<T> = T & { cache_control?: typeof EPHEMERAL };

export interface CachedRequestParts {
  system: Cacheable<SystemBlock>[] | undefined;
  tools?: Cacheable<AnthropicToolDef>[];
  messages: Array<{ role: ApiMessage["role"]; content: string | Cacheable<ContentBlock>[] }>;
}

export interface RequestParts {
  system: string | SystemBlock[] | undefined;
  tools?: AnthropicToolDef[];
  messages: ApiMessage[];
}

/**
 * Return copies of the request parts with cache breakpoints placed. Inputs are
 * never mutated. Prompts under the model's minimum cacheable length are simply
 * not cached by the API — no special-casing needed here.
 */
export function withCacheControl(parts: RequestParts): CachedRequestParts {
  return {
    system: markSystem(parts.system),
    ...(parts.tools ? { tools: markLast(parts.tools) } : {}),
    messages: markLatestUserMessage(parts.messages),
  };
}

function markSystem(system: string | SystemBlock[] | undefined): Cacheable<SystemBlock>[] | undefined {
  if (system === undefined) return undefined;
  const blocks: SystemBlock[] = typeof system === "string" ? [{ type: "text", text: system }] : system;
  return markLast(blocks);
}

/** Copy the array, adding a breakpoint to the final element. */
function markLast<T extends object>(items: T[]): Cacheable<T>[] {
  return items.map((item, i) => (i === items.length - 1 ? { ...item, cache_control: EPHEMERAL } : item));
}

function markLatestUserMessage(messages: ApiMessage[]): CachedRequestParts["messages"] {
  let target = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      target = i;
      break;
    }
  }
  return messages.map((m, i) => {
    if (i !== target) return m;
    if (typeof m.content === "string") {
      if (m.content.trim().length === 0) return m; // empty text blocks are rejected by the API
      const block: Cacheable<TextBlock> = { type: "text", text: m.content, cache_control: EPHEMERAL };
      return { role: m.role, content: [block] };
    }
    if (m.content.length === 0) return m;
    return { role: m.role, content: markLast(m.content) };
  });
}

/** Count placed breakpoints (API allows at most 4 per request). */
export function countBreakpoints(parts: CachedRequestParts): number {
  let n = 0;
  for (const b of parts.system ?? []) if (b.cache_control) n++;
  for (const t of parts.tools ?? []) if (t.cache_control) n++;
  for (const m of parts.messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) if (b.cache_control) n++;
  }
  return n;
}
