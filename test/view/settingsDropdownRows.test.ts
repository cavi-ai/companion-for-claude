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
});
