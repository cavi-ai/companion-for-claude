import { describe, expect, it } from "vitest";
import { clipperSetupFor } from "../../src/sources/clipperSetup";
import { getSchema } from "../../src/sources/registry";

const schemas = () => (["article", "video", "dataset"] as const).map((type) => getSchema(type));

describe("clipperSetupFor", () => {
  it("builds clear official import instructions without claiming verification", () => {
    const setup = clipperSetupFor("article", schemas(), {
      inboxFolder: "Clippings",
      baseTags: ["source"],
      savedFingerprint: "",
    });
    expect(setup).toMatchObject({
      type: "article",
      status: "not-set-up",
      destination: "Clippings",
      templateName: "Companion: article",
      schemaVersion: 1,
    });
    expect(setup.instructions).toContain("Web Clipper → Settings → Templates");
    expect(setup.instructions).toContain("Import");
    expect(setup.instructions).toContain(".json file");
    expect(setup.instructions).toMatch(/never paste it into|not into a template field/i);
    expect(setup.instructions).toContain("top of the template list");
    expect(setup.instructions).toContain("create one test clip");
    expect(JSON.parse(setup.json)).toMatchObject({ path: "Clippings", name: "Companion: article" });
  });

  it("tells triggered templates apart from list-order ones", () => {
    const video = clipperSetupFor("video", schemas(), { inboxFolder: "Clippings", baseTags: [], savedFingerprint: "" });
    expect(video.instructions).toContain("YouTube");
    expect(video.instructions).not.toContain("top of the template list");
  });

  it("distinguishes current and stale exported fingerprints", () => {
    const first = clipperSetupFor("video", schemas(), { inboxFolder: "Clippings", baseTags: [], savedFingerprint: "" });
    expect(clipperSetupFor("video", schemas(), {
      inboxFolder: "Clippings", baseTags: [], savedFingerprint: first.fingerprint,
    }).status).toBe("current");
    expect(clipperSetupFor("video", schemas(), {
      inboxFolder: "Different", baseTags: [], savedFingerprint: first.fingerprint,
    }).status).toBe("update-available");
  });

  it("separates page-known fields from Companion-enriched fields", () => {
    const setup = clipperSetupFor("article", schemas(), { inboxFolder: "Clippings", baseTags: [], savedFingerprint: "" });
    expect(setup.pageKnownFields).toEqual(expect.arrayContaining(["title", "author", "site", "published"]));
    expect(setup.companionFields).toEqual(expect.arrayContaining(["summary", "topics", "key_claims"]));
  });
});
