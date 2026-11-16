// Test-only members of the in-memory obsidian fake, visible when tests import "obsidian".
import type * as Fake from "./obsidian";

declare module "obsidian" {
  export type FakeElement = Fake.FakeElement;
  export const FakeElement: typeof Fake.FakeElement;
  export const fakeDocument: typeof Fake.fakeDocument;
  export const clearNotices: typeof Fake.clearNotices;
  export const getNoticeMessages: typeof Fake.getNoticeMessages;
  export const getNotices: typeof Fake.getNotices;
  export const getLastOpenedModal: typeof Fake.getLastOpenedModal;
  export const getMenus: typeof Fake.getMenus;
  export const getLastMenu: typeof Fake.getLastMenu;
  export const clearMenus: typeof Fake.clearMenus;
  export const openSettingTab: typeof Fake.openSettingTab;
  export const setApiVersion: typeof Fake.setApiVersion;

  interface Vault {
    seed(path: string, content: string, opts?: Parameters<Fake.App["vault"]["seed"]>[2]): TFile;
    frontmatters: Fake.App["vault"]["frontmatters"];
  }
  interface TFile {
    _content: string;
  }
}
