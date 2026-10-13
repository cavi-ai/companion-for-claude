import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestUrl } = vi.hoisted(() => ({
  requestUrl: vi.fn(async (_req: { url: string; method: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; json: unknown; text: string }> => ({ status: 204, json: null, text: "" })),
}));
vi.mock("obsidian", async (importOriginal) => ({ ...await importOriginal<typeof import("obsidian")>(), requestUrl }));

import { App, clearNotices, getNoticeMessages } from "obsidian";
import { ActivityStore } from "../../src/activity/store";
import { PublishFeature } from "../../src/publish/publishFeature";
import { DEFAULT_SETTINGS, type PluginSettings } from "../../src/types";

const ITEM = { key: "n/A.md", kind: "note", title: "A", gistId: "g1", url: "https://gist.github.com/me/g1", owner: "me", publishedAt: 1, updatedAt: 2 };

function rig(over: Partial<PluginSettings> = {}) {
  const settings = { ...structuredClone(DEFAULT_SETTINGS), ...over };
  const persist = vi.fn(async () => undefined);
  const feature = new PublishFeature({ app: new App(), settings: () => settings, activity: () => new ActivityStore(), persist });
  return { feature, persist, settings };
}

beforeEach(() => {
  clearNotices();
  requestUrl.mockReset().mockResolvedValue({ status: 204, json: null, text: "" });
});

describe("PublishFeature state", () => {
  it("restores valid published items and serializes them back", () => {
    const { feature } = rig();
    feature.restore([ITEM, { key: "bad" }]);
    expect(feature.publishedItems()).toEqual([ITEM]);
    expect(feature.serializeState()).toEqual({ published: [ITEM] });
  });

  it("starts empty for malformed data", () => {
    const { feature } = rig();
    feature.restore("junk");
    expect(feature.publishedItems()).toEqual([]);
  });

  it("returns the same publish and cloud controller on every call", () => {
    const { feature } = rig();
    expect(feature.publish()).toBe(feature.publish());
    expect(feature.cloud()).toBe(feature.cloud());
  });
});

describe("PublishFeature publishing", () => {
  it("unpublishing deletes the gist, persists the shorter registry and says so", async () => {
    const { feature, persist } = rig({ publishGithubToken: "tok" });
    feature.restore([ITEM]);
    await feature.unpublishItem("n/A.md");
    expect(requestUrl).toHaveBeenCalledTimes(1);
    expect(requestUrl.mock.calls[0]![0]).toMatchObject({ method: "DELETE" });
    expect(requestUrl.mock.calls[0]![0].url.endsWith("/gists/g1")).toBe(true);
    expect(feature.publishedItems()).toEqual([]);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(getNoticeMessages()).toEqual(["Unpublished A."]);
  });

  it("keeps the registry when no token is set", async () => {
    const { feature, persist } = rig({ publishGithubToken: "" });
    feature.restore([ITEM]);
    await feature.unpublishItem("n/A.md");
    expect(requestUrl).not.toHaveBeenCalled();
    expect(feature.publishedItems()).toEqual([ITEM]);
    expect(persist).not.toHaveBeenCalled();
    expect(getNoticeMessages()).toHaveLength(1);
  });

  it("tests the token against the configured API base", async () => {
    const { feature } = rig({ publishGithubToken: "tok" });
    requestUrl.mockResolvedValueOnce({ status: 200, json: { login: "me" }, text: "" });
    await expect(feature.testPublishToken()).resolves.toEqual({ ok: true, message: "GitHub accepted the token." });
    expect(requestUrl.mock.calls[0]![0].headers).toMatchObject({ authorization: "Bearer tok" });
  });

  it("reports a missing token without a request", async () => {
    const { feature } = rig({ publishGithubToken: "" });
    await expect(feature.testPublishToken()).resolves.toEqual({ ok: false, message: "No token set." });
    expect(requestUrl).not.toHaveBeenCalled();
  });

  it("renames a published note in the registry when the controller is told", async () => {
    const { feature, persist } = rig();
    feature.restore([ITEM]);
    await feature.publish().renameNote("n/A.md", "n/B.md");
    expect(feature.publishedItems().map((i) => i.key)).toEqual(["n/B.md"]);
    expect(persist).toHaveBeenCalledTimes(1);
  });
});

describe("PublishFeature cloud", () => {
  it("refuses to test replies until a repository is configured", async () => {
    const { feature } = rig({ cloudReplyRepo: "", cloudReplyToken: "" });
    const result = await feature.testCloudReplies();
    expect(result.ok).toBe(false);
    expect(requestUrl).not.toHaveBeenCalled();
  });

  it("pulls replies through the GitHub contents API with the configured token", async () => {
    const { feature } = rig({ cloudReplyRepo: "cavi-ai/vault", cloudReplyBranch: "main", cloudReplyFolder: "Claude/Replies", cloudReplyToken: "gh-token" });
    requestUrl.mockResolvedValue({ status: 200, json: [], text: "[]" });
    await feature.pullCloudReplies();
    expect(requestUrl).toHaveBeenCalled();
    expect(requestUrl.mock.calls[0]![0].url).toContain("repos/cavi-ai/vault/contents/Claude/Replies");
    expect(requestUrl.mock.calls[0]![0].headers).toMatchObject({ authorization: "Bearer gh-token" });
  });

  it("explains missing routine setup instead of dispatching", async () => {
    const { feature } = rig({ cloudRoutineFireUrl: "", cloudRoutineToken: "" });
    await feature.dispatchCloudSession();
    expect(requestUrl).not.toHaveBeenCalled();
    expect(getNoticeMessages()).toHaveLength(1);
  });
});
