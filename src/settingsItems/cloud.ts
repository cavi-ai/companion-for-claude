// The Cloud page: routine dispatch setup and the GitHub replies pull.

import type { SettingGroupItem } from "obsidian";
import type ClaudeCompanionPlugin from "../main";
import { dispatchSetupSteps, repliesSetupSteps } from "../cloud/setup";
import { setCredential } from "./actions";
import { PAGE_DESC } from "./pageDesc";

export interface CloudItemsContext {
  plugin: Pick<ClaudeCompanionPlugin, "publishing" | "saveSettings" | "settings">;
  /** Re-render the settings page. */
  update(): void;
  storageBlurb(): string;
}

export function cloudDesc(storageBlurb: string): string {
  return `${PAGE_DESC.cloudDispatch} ⚠️ Unlike the local bridge, this sends your prompt + attached note context to Anthropic's cloud and runs against your vault's Git repo. ${storageBlurb} Use a private repo. ${PAGE_DESC.cloudReplies}`;
}

function renderChecklist(el: HTMLElement, steps: { ok: boolean; label: string; detail?: string }[]): void {
  for (const item of steps) {
    const row = el.createDiv({ cls: `cc-setup-step ${item.ok ? "is-ok" : "is-err"}` });
    row.createSpan({ cls: "cc-setup-mark", text: item.ok ? "✓" : "✗" });
    row.createSpan({ text: item.detail && !item.ok ? `${item.label} — ${item.detail}` : item.label });
  }
}

export function cloudItems(ctx: CloudItemsContext): SettingGroupItem[] {
  const { plugin } = ctx;
  const s = plugin.settings;
  const dispatchOn = (): boolean => s.cloudDispatchEnabled;
  return [
    {
      name: "Cloud dispatch setup",
      aliases: ["checklist", "routine"],
      render: (setting) => {
        const el = setting.settingEl.createDiv({ cls: "cc-setup-checklist" });
        const steps = dispatchSetupSteps({ fireUrl: s.cloudRoutineFireUrl, token: s.cloudRoutineToken });
        renderChecklist(el, steps);
        if (steps.every((item) => item.ok)) {
          el.createDiv({ cls: "cc-setup-step is-ok", text: "✓ Ready — run “Send to cloud Claude session” from the command palette." });
        }
      },
    },
    { name: "Enable cloud dispatch", desc: "Adds a “Send to cloud Claude session” command.", control: { type: "toggle", key: "cloudDispatchEnabled" } },
    {
      name: "Routine fire URL",
      desc: "The routine's “fire” endpoint from the Claude Code web UI (…/v1/claude_code/routines/<id>/fire).",
      visible: dispatchOn,
      control: { type: "text", key: "cloudRoutineFireUrl", placeholder: "https://api.anthropic.com/v1/claude_code/routines/…/fire" },
    },
    {
      name: "Routine token",
      visible: dispatchOn,
      render: (setting) => {
        setting.setDesc(`Per-routine bearer token (sk-ant-oat…). It only fires this one routine — no account access. ${ctx.storageBlurb()}`);
        setting.addText((text) => {
          text.inputEl.type = "password";
          text.inputEl.setCssStyles({ width: "320px" });
          text
            .setPlaceholder("sk-ant-oat…")
            .setValue(s.cloudRoutineToken)
            .onChange(async (v) => {
              setCredential(s, "cloudRoutineToken", v);
              await plugin.saveSettings();
              ctx.update();
            });
        });
      },
    },
  ];
}

export function repliesItems(ctx: CloudItemsContext): SettingGroupItem[] {
  const { plugin } = ctx;
  const s = plugin.settings;
  return [
    {
      name: "Cloud replies setup",
      aliases: ["checklist", "github"],
      render: (setting) => {
        const el = setting.settingEl.createDiv({ cls: "cc-setup-checklist" });
        renderChecklist(el, repliesSetupSteps({ repo: s.cloudReplyRepo, branch: s.cloudReplyBranch, folder: s.cloudReplyFolder, token: s.cloudReplyToken }));
      },
    },
    { name: "Vault repo", desc: "owner/name of the GitHub repo backing your vault.", control: { type: "text", key: "cloudReplyRepo", placeholder: "owner/name" } },
    { name: "Replies branch", desc: "Branch the cloud session writes replies to.", control: { type: "text", key: "cloudReplyBranch", placeholder: "main" } },
    { name: "Replies folder", desc: "Folder in the repo where reply notes land.", control: { type: "text", key: "cloudReplyFolder", placeholder: "Claude/Replies" } },
    {
      name: "GitHub token",
      render: (setting) => {
        setting.setDesc(`Fine-grained token with Contents:read on the repo. ${ctx.storageBlurb()}`);
        setting.addText((text) => {
          text.inputEl.type = "password";
          text.inputEl.setCssStyles({ width: "min(320px, 100%)" });
          text
            .setPlaceholder("github_pat_… / ghp_…")
            .setValue(s.cloudReplyToken)
            .onChange(async (v) => {
              setCredential(s, "cloudReplyToken", v);
              await plugin.saveSettings();
              ctx.update();
            });
        });
      },
    },
    {
      name: "Test connection",
      desc: "Read the replies folder from GitHub with the current settings — verifies repo, branch, folder, and token in one shot.",
      render: (setting) => {
        const status = setting.settingEl.createDiv({ cls: "cc-conn-status" });
        setting.addButton((button) =>
          button.setButtonText("Test").onClick(async () => {
            button.setDisabled(true);
            status.toggleClass("is-ok", false);
            status.toggleClass("is-err", false);
            status.setText("Testing…");
            const result = await plugin.publishing().testCloudReplies();
            status.toggleClass("is-ok", result.ok);
            status.toggleClass("is-err", !result.ok);
            status.setText(`${result.ok ? "✓" : "✗"} ${result.message}`);
            button.setDisabled(false);
          }),
        );
      },
    },
  ];
}
