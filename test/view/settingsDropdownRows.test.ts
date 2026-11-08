import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { markDropdownRows } from "../../src/view/SettingsNavigation";

function list(html: string): HTMLElement {
  const { document } = parseHTML(`<div id="list">${html}</div>`);
  return document.getElementById("list") as unknown as HTMLElement;
}

describe("settings dropdown rows", () => {
  it("tags only direct rows whose control holds a real dropdown", () => {
    const el = list(`
      <div class="setting-item" id="dropdown"><div class="setting-item-control"><select></select></div></div>
      <div class="setting-item" id="toggle"><div class="setting-item-control"><input type="checkbox"></div></div>
      <div class="setting-item" id="measuring"><div class="setting-item-control"><select class="is-measuring"></select></div></div>
      <div class="setting-item cc-settings-header" id="header"><select></select></div>
      <div id="other"><div class="setting-item-control"><select></select></div></div>`);
    markDropdownRows(el);
    const tagged = Array.from(el.querySelectorAll(".cc-dropdown-row")).map((row) => row.id);
    expect(tagged).toEqual(["dropdown"]);
  });

  it("untags a row whose dropdown was removed on re-render", () => {
    const el = list(`<div class="setting-item cc-dropdown-row" id="row"><div class="setting-item-control"><input></div></div>`);
    markDropdownRows(el);
    expect(el.querySelector(".cc-dropdown-row")).toBeNull();
  });

  it("gives multiline editors and rich results a full-width detail slot", () => {
    const el = list(`
      <div class="setting-item" id="prompt"><div class="setting-item-info"></div><div class="setting-item-control"><textarea></textarea></div></div>
      <div class="setting-item" id="status"><div class="setting-item-info"></div><div class="setting-item-control"><button>Check</button></div><div class="cc-setting-detail cc-conn-status">Ready</div></div>
      <div class="setting-item" id="scalar"><div class="setting-item-control"><input></div></div>`);
    markDropdownRows(el);
    expect(el.querySelector("#prompt .setting-item-control")?.classList.contains("cc-setting-detail")).toBe(true);
    expect(el.querySelector("#prompt")?.classList.contains("cc-setting-editor-row")).toBe(true);
    expect(Array.from(el.querySelectorAll(".cc-setting-detail-row")).map((row) => row.id)).toEqual(["prompt", "status"]);
    expect(el.querySelector("#scalar .setting-item-control")?.classList.contains("cc-setting-detail")).toBe(false);
  });

  it("removes editor layout when an in-place row becomes a scalar", () => {
    const el = list(`<div class="setting-item cc-setting-editor-row cc-setting-detail-row" id="row"><div class="setting-item-control cc-setting-detail"><input></div></div>`);
    markDropdownRows(el);
    expect(el.querySelector(".cc-setting-editor-row")).toBeNull();
    expect(el.querySelector(".cc-setting-detail")).toBeNull();
    expect(el.querySelector(".cc-setting-detail-row")).toBeNull();
  });

  it("names the native prompt editor from its visible label on initial render and replacement", () => {
    const el = list(`<div class="setting-item" id="prompt"><div class="setting-item-info"><div class="setting-item-name">System prompt</div></div><div class="setting-item-control"><textarea>Keep the source and claim together.</textarea></div></div>`);
    markDropdownRows(el);
    const prompt = el.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(prompt.getAttribute("aria-label")).toBe("System prompt");
    expect(prompt.value).toBe("Keep the source and claim together.");
    el.querySelector(".setting-item-control")!.innerHTML = "<textarea>Current draft.</textarea>";
    markDropdownRows(el);
    expect(el.querySelector<HTMLTextAreaElement>("textarea")!.getAttribute("aria-label")).toBe("System prompt");
    expect(el.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("Current draft.");
  });
});
