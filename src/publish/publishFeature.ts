// Publishing and cloud dispatch: the Gist publish controller, the published-note
// registry persisted in data.json, and the cloud session controller.

import { MarkdownView, normalizePath, Notice, requestUrl, TFile, type App } from "obsidian";
import type { ActivityStore } from "../activity/store";
import { CloudController } from "../cloud/controller";
import type { PluginSettings } from "../types";
import { ensureVaultFolder } from "../vault/vaultFiles";
import { ChoiceModal } from "../view/ChoiceModal";
import { CloudDispatchModal } from "../view/CloudDispatchModal";
import { PublishController, publishConfirmMessage } from "./controller";
import { normalizePublished, type PublishedItem } from "./registry";

export interface PublishFeatureDeps {
  app: App;
  settings: () => PluginSettings;
  activity: () => ActivityStore;
  persist: () => Promise<void>;
}

export class PublishFeature {
  private published: PublishedItem[] = [];
  private _publish?: PublishController;
  private _cloud?: CloudController;

  constructor(private deps: PublishFeatureDeps) {}

  private get app(): App {
    return this.deps.app;
  }

  private get settings(): PluginSettings {
    return this.deps.settings();
  }

  /** Loads the persisted published-note registry. */
  restore(published: unknown): void {
    this.published = normalizePublished(published);
  }

  /** The fields data.json stores for this module. */
  serializeState(): { published: PublishedItem[] } {
    return { published: this.published };
  }

  publish(): PublishController {
    return (this._publish ??= new PublishController({
      token: () => this.settings.publishGithubToken,
      apiBase: () => this.settings.publishApiBase,
      request: async (req) => {
        const res = await requestUrl({ url: req.url, method: req.method, headers: req.headers, ...(req.body ? { body: req.body } : {}), throw: false });
        let json: unknown = null;
        try {
          json = res.json;
        } catch {
          // an empty or non-JSON body parses as null
        }
        return { status: res.status, json };
      },
      readNote: async (path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error(`${path} is not in the vault`);
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        return view?.file?.path === path ? view.editor.getValue() : this.app.vault.read(file);
      },
      confirm: (kind, title) => new Promise<boolean>((resolve) => {
        new ChoiceModal<"publish" | "cancel">(this.app, {
          title: `Publish ${title} to GitHub Gist?`,
          message: publishConfirmMessage(kind),
          buttons: [{ label: "Publish", value: "publish", cta: true }, { label: "Cancel", value: "cancel" }],
          fallback: "cancel",
          onChoice: (choice) => resolve(choice === "publish"),
        }).open();
      }),
      copy: (text) => navigator.clipboard.writeText(text),
      notice: (text) => { new Notice(text, 8000); },
      getItems: () => this.published,
      setItems: async (items) => {
        this.published = items;
        await this.deps.persist();
      },
      now: () => Date.now(),
    }));
  }

  publishedItems(): readonly PublishedItem[] {
    return this.published;
  }

  unpublishItem(key: string): Promise<void> {
    return this.publish().unpublish(key);
  }

  testPublishToken(): Promise<{ ok: boolean; message: string }> {
    return this.publish().testToken();
  }

  cloud(): CloudController {
    return (this._cloud ??= new CloudController({
      settings: () => this.settings,
      activity: () => this.deps.activity(),
      http: async (req) => {
        const res = await requestUrl({ url: req.url, method: req.method, headers: req.headers, ...(req.body ? { body: req.body } : {}), throw: false });
        return { status: res.status, text: res.text };
      },
      vault: {
        fileExists: (path) => !!this.app.vault.getAbstractFileByPath(path),
        create: async (path, content) => { await this.app.vault.create(path, content); },
        ensureFolder: (folder) => ensureVaultFolder(this.app, folder),
        normalizePath,
      },
      ui: {
        notice: (msg, timeout) => new Notice(msg, timeout),
        clipboard: (text) => navigator.clipboard.writeText(text),
        activeSelection: () => {
          const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
          return { path: mdView?.file?.path, selection: mdView?.editor.getSelection().trim() || undefined };
        },
        promptInstruction: (context, onSubmit) => new CloudDispatchModal(this.app, context, onSubmit).open(),
      },
    }));
  }

  async dispatchCloudSession(): Promise<void> {
    return this.cloud().dispatchSession();
  }

  async testCloudReplies(): Promise<{ ok: boolean; message: string }> {
    return this.cloud().testReplies();
  }

  async pullCloudReplies(): Promise<void> {
    return this.cloud().pullReplies();
  }
}
