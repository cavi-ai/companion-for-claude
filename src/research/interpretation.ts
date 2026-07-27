// Upsert the "Interpretation:" block of an evidence note body. The block is
// the human-readable reading of the excerpt (parsed back by
// interpretationFromBody in parse.ts); everything else in the note is left
// byte-identical. Pure and dependency-free.

const INTERPRETATION_PATTERN = /Interpretation:[^\n]*(?:\n(?!\s*#)[^\n]*)*/i;

export function upsertInterpretation(content: string, interpretation: string): string {
  const trimmed = interpretation.trim();
  if (!trimmed) throw new Error("Interpretation must not be empty");
  const block = `Interpretation: ${trimmed}`;
  if (INTERPRETATION_PATTERN.test(content)) return content.replace(INTERPRETATION_PATTERN, block);
  return `${content.replace(/\s+$/, "")}\n\n${block}\n`;
}
