import { describe, expect, it } from "vitest";
import { syncModelSelection } from "../../src/view/chat/cliModelOptions";
import { DEFAULT_SETTINGS } from "../../src/types";

describe("composer model selection", () => {
  it.each(["codex", "opencode"] as const)("reflects a %s model changed through the header", (backend) => {
    const select = { value: "old-model" };
    const controls = { querySelector: () => select } as unknown as HTMLElement;
    const settings = { ...DEFAULT_SETTINGS, chatBackend: `${backend}-cli`, codexModel: "account-model", opencodeModel: "provider/model" } as typeof DEFAULT_SETTINGS;
    syncModelSelection(controls, settings, "claude-model");
    expect(select.value).toBe(`${backend}-cli:${settings[`${backend}Model`]}`);
    settings[`${backend}Model`] = "";
    syncModelSelection(controls, settings, "claude-model");
    expect(select.value).toBe(`${backend}-cli:`);
  });
});
