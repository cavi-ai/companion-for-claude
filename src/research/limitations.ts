const LIMITATIONS_BLOCK = /\n*> \[!warning\]- Limitations\n(?:>[^\n]*(?:\n|$))*/;

export function renderLimitationsBlock(limitations: readonly string[]): string {
  return `> [!warning]- Limitations\n${limitations.map((l) => `> - ${l}`).join("\n")}`;
}

/** Rewrites the claim note's Limitations callout; inserts it after the Proposition section when absent. */
export function upsertLimitations(content: string, limitations: readonly string[]): string {
  if (!limitations.length) return content;
  const block = renderLimitationsBlock(limitations);
  if (LIMITATIONS_BLOCK.test(content)) return content.replace(LIMITATIONS_BLOCK, `\n\n${block}\n`);
  const heading = /^## Proposition[^\n]*\n/m.exec(content);
  if (!heading) return `${content.replace(/\s+$/, "")}\n\n${block}\n`;
  const start = heading.index + heading[0].length;
  const next = /^## /m.exec(content.slice(start));
  const end = next ? start + next.index : content.length;
  return `${content.slice(0, end).replace(/\s+$/, "")}\n\n${block}\n${next ? `\n${content.slice(end)}` : ""}`;
}
