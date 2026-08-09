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
    expect(setup.instructions).toContain("choose Import");
    expect(setup.instructions).toContain("paste the JSON");
    expect(setup.instructions).toContain("create one test clip");
    expect(JSON.parse(setup.json)).toMatchObject({ path: "Clippings", name: "Companion: article" });
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
