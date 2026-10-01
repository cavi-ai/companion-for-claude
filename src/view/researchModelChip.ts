import { researchModelChip, type ResearchModelStatus } from "../research/researchModel";

export function renderResearchModelChip(parent: HTMLElement, status: ResearchModelStatus | undefined, open: (() => void) | undefined): void {
  if (!status) return;
  const chip = researchModelChip(status);
  const button = parent.createEl("button", { cls: "cc-research-model-chip", text: chip.text, attr: { "aria-label": `Research model: ${chip.text}. Open settings` } });
  if (!chip.available) button.addClass("is-unavailable");
  button.addEventListener("click", () => open?.());
}
