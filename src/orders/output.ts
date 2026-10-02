// Where an order run's note lives and what it contains. Pure.

import { buildFrontmatter } from "../indexing/frontmatter";
import type { StandingOrder } from "./order";
import type { OrderRunResult, OrderTrigger } from "./runner";

export const ORDERS_OUTPUT_ROOT = "Claude/Orders";

const pad = (n: number) => String(n).padStart(2, "0");
const wikiTarget = (path: string) => path.replace(/\.md$/i, "");

export function orderRunPath(order: StandingOrder, now: Date): string {
  const safeName = order.name.replace(/[\\/:*?"<>|#^[\]]/g, "").trim() || "order";
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${ORDERS_OUTPUT_ROOT}/${safeName}/${stamp}.md`;
}

export function renderOrderRun(order: StandingOrder, trigger: OrderTrigger, result: OrderRunResult): string {
  const frontmatter = buildFrontmatter({
    type: "order-run",
    order: `[[${wikiTarget(order.path)}]]`,
    trigger: trigger.kind,
    ...(trigger.kind === "note" ? { source: `[[${wikiTarget(trigger.path)}]]` } : {}),
    proposed_edits: result.proposals.length,
  });
  const body = result.error ? `${result.text ? `${result.text}\n\n` : ""}Run failed: ${result.error.message}` : result.text.trim() || "No output.";
  const sections = [frontmatter, "", body];
  if (result.proposals.length > 0) {
    sections.push("", "## Proposed edits", "", ...result.proposals.map((p) => `- [[${wikiTarget(p.path)}]]${p.description ? ` — ${p.description}` : ""}`));
  }
  return `${sections.join("\n")}\n`;
}
