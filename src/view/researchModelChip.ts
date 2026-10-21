import { researchModelChip, type ResearchModelStatus } from "../research/researchModel";
import { CLAUDE_MODELS } from "../claude/models";

export function renderResearchModelChip(parent: HTMLElement, status: ResearchModelStatus | undefined, open: (() => void) | undefined): void {
  if (!status) return;
  const chip = researchModelChip(status);
  const label = status.available && status.model !== "off" ? CLAUDE_MODELS.find(model => model.id === status.modelId)?.label ?? chip.text : chip.text;
  const button = parent.createEl("button", { cls: "cc-research-model-chip", text: label, attr: { title: chip.text, "aria-label": `Research model: ${label}. Open settings` } });
  if (!chip.available) button.addClass("is-unavailable");
  button.addEventListener("click", () => open?.());
}
