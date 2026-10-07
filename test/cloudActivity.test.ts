import { clearNotices, getNotices, Notice } from "obsidian";
import { beforeEach, describe, expect, it } from "vitest";
import { ActivityStore } from "../src/activity/store";
import { CloudController } from "../src/cloud/controller";
import { DEFAULT_SETTINGS } from "../src/types";

beforeEach(clearNotices);

describe("cloud task feedback", () => {
  it.each([false, true])("keeps pending replies out of toasts and preserves the outcome (failure=%s)", async (fails) => {
    const activity = new ActivityStore();
    let resolve!: (result: { status: number; text: string }) => void;
    let reject!: (error: Error) => void;
    const response = new Promise<{ status: number; text: string }>((yes, no) => { resolve = yes; reject = no; });
    const deps = {
      settings: () => ({ ...DEFAULT_SETTINGS, cloudReplyRepo: "owner/vault", cloudReplyToken: "test-token", cloudReplyBranch: "main", cloudReplyFolder: "Replies" }),
      activity: () => activity,
      http: () => response,
      vault: { fileExists: () => false, create: async () => {}, ensureFolder: async () => {}, normalizePath: (path: string) => path },
      ui: { notice: (text: string, timeout?: number) => new Notice(text, timeout), clipboard: async () => {}, activeSelection: () => ({ path: undefined, selection: undefined }), promptInstruction: () => {} },
    };
    const controller = new CloudController(deps);
    const pending = controller.pullReplies();
    try {
      expect(getNotices()).toHaveLength(0);
      expect(activity.snapshot().records[0]?.state).toBe("running");
    } finally {
      if (fails) reject(new Error("Offline")); else resolve({ status: 200, text: "[]" });
      await pending;
    }
    expect(activity.snapshot().records[0]?.state).toBe(fails ? "needs-attention" : "succeeded");
    expect(getNotices().every((notice) => notice.timeout !== 0)).toBe(true);
    activity.dispose();
  });
});
