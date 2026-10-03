import { describe, expect, it } from "vitest";
import { PublishController, publishConfirmMessage, type PublishDeps } from "../../src/publish/controller";
import type { GistRequest } from "../../src/publish/gist";
import type { PublishedItem } from "../../src/publish/registry";

const NOTE = "---\nprivate: yes\n---\n# A\n\nvisible %%hidden%% text\n";

interface Harness {
  controller: PublishController;
  requests: GistRequest[];
  notices: string[];
  copied: string[];
  confirms: Array<[string, string]>;
  items: () => PublishedItem[];
  respond: (fn: (req: GistRequest) => { status: number; json: unknown }) => void;
  setNote: (text: string) => void;
}

const created = (id: string) => ({ id, html_url: `https://gist.github.com/me/${id}`, owner: { login: "me" } });

function harness(opts: { token?: string; confirm?: boolean; items?: PublishedItem[] } = {}): Harness {
  const requests: GistRequest[] = [];
  const notices: string[] = [];
  const copied: string[] = [];
  const confirms: Array<[string, string]> = [];
  let items = opts.items ?? [];
  let note = NOTE;
  let clock = 100;
  let serial = 0;
  let respond: Harness["respond"] extends (fn: infer F) => void ? F : never = (req) => {
    if (req.method === "DELETE") return { status: 204, json: null };
    if (req.method === "PATCH") return { status: 200, json: created(req.url.split("/").pop()!) };
    serial += 1;
    return { status: 201, json: created(`g${serial}`) };
  };
  const deps: PublishDeps = {
    token: () => opts.token ?? "tok",
    apiBase: () => "http://stub",
    request: async (req) => {
      requests.push(req);
      return respond(req);
    },
    readNote: async () => note,
    confirm: async (kind, title) => {
      confirms.push([kind, title]);
      return opts.confirm ?? true;
    },
    copy: async (text) => { copied.push(text); },
    notice: (text) => { notices.push(text); },
    getItems: () => items,
    setItems: async (next) => { items = next; },
    now: () => (clock += 1),
  };
  return {
    controller: new PublishController(deps),
    requests,
    notices,
    copied,
    confirms,
    items: () => items,
    respond: (fn) => { respond = fn; },
    setNote: (text) => { note = text; },
  };
}

describe("publishNote", () => {
  it("points at the Publishing settings and sends nothing without a token", async () => {
    const h = harness({ token: "" });
    await h.controller.publishNote("n/A.md");
    expect(h.requests).toEqual([]);
    expect(h.confirms).toEqual([]);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain("Publishing");
    expect(h.items()).toEqual([]);
  });

  it("confirms, creates a secret gist without frontmatter or comments, and records the link", async () => {
    const h = harness();
    await h.controller.publishNote("n/A.md");
    expect(h.confirms).toEqual([["note", "A"]]);
    expect(h.requests).toHaveLength(1);
    const req = h.requests[0]!;
    expect(req.method).toBe("POST");
    const body = JSON.parse(req.body!) as { public: boolean; description: string; files: Record<string, { content: string }> };
    expect(body.public).toBe(false);
    expect(body.description).toBe("A");
    const content = Object.values(body.files)[0]!.content;
    expect(content).toContain("visible");
    expect(content).not.toContain("private: yes");
    expect(content).not.toContain("hidden");
    expect(req.body).not.toContain("tok");
    expect(h.items()).toEqual([{ key: "n/A.md", kind: "note", title: "A", gistId: "g1", url: "https://gist.github.com/me/g1", owner: "me", publishedAt: 101, updatedAt: 101 }]);
    expect(h.copied).toEqual(["https://gist.github.com/me/g1"]);
    expect(h.notices.at(-1)).toContain("copied");
  });

  it("sends nothing when the confirm is cancelled", async () => {
    const h = harness({ confirm: false });
    await h.controller.publishNote("n/A.md");
    expect(h.requests).toEqual([]);
    expect(h.items()).toEqual([]);
    expect(h.copied).toEqual([]);
  });

  it("republishes the same gist with PATCH and no second confirm", async () => {
    const h = harness();
    await h.controller.publishNote("n/A.md");
    h.setNote("# A\n\nchanged");
    await h.controller.publishNote("n/A.md");
    expect(h.confirms).toHaveLength(1);
    expect(h.requests[1]).toMatchObject({ method: "PATCH", url: "http://stub/gists/g1" });
    expect(h.items()).toHaveLength(1);
    expect(h.items()[0]).toMatchObject({ gistId: "g1", publishedAt: 101 });
    expect(h.items()[0]!.updatedAt).toBeGreaterThan(101);
  });

  it("creates a new gist and replaces the entry when the gist was deleted on GitHub", async () => {
    const h = harness();
    await h.controller.publishNote("n/A.md");
    let first = true;
    h.respond((req) => {
      if (req.method === "PATCH" && first) { first = false; return { status: 404, json: { message: "Not Found" } }; }
      return { status: 201, json: created("g2") };
    });
    await h.controller.publishNote("n/A.md");
    expect(h.requests.map((r) => r.method)).toEqual(["POST", "PATCH", "POST"]);
    expect(h.items()).toHaveLength(1);
    expect(h.items()[0]).toMatchObject({ key: "n/A.md", gistId: "g2" });
    expect(h.notices.some((n) => /fail|error/i.test(n))).toBe(false);
    expect(h.confirms).toHaveLength(1);
  });

  it("publishes nothing for a note that is empty after the transform", async () => {
    const h = harness();
    h.setNote("---\na: 1\n---\n%%only a comment%%");
    await h.controller.publishNote("n/A.md");
    expect(h.requests).toEqual([]);
    expect(h.confirms).toEqual([]);
    expect(h.notices).toEqual(["Nothing to publish in A."]);
  });

  it("records nothing and shows one notice when GitHub refuses the token", async () => {
    const h = harness();
    h.respond(() => ({ status: 403, json: {} }));
    await h.controller.publishNote("n/A.md");
    expect(h.items()).toEqual([]);
    expect(h.copied).toEqual([]);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain("Gists: read and write");
  });

  it("reports a network failure without recording anything", async () => {
    const h = harness();
    h.respond(() => { throw new Error("offline"); });
    await h.controller.publishNote("n/A.md");
    expect(h.items()).toEqual([]);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain("offline");
  });

  it("ignores a second publish of the same note while one is in flight", async () => {
    const h = harness();
    await Promise.all([h.controller.publishNote("n/A.md"), h.controller.publishNote("n/A.md")]);
    expect(h.confirms).toHaveLength(1);
    expect(h.requests).toHaveLength(1);
  });
});

describe("publishArtifact", () => {
  it("confirms every time and creates a new secret gist with the rendered link", async () => {
    const h = harness();
    await h.controller.publishArtifact("<div>art</div>", "Chart");
    await h.controller.publishArtifact("<div>art</div>", "Chart");
    expect(h.confirms).toEqual([["artifact", "Chart"], ["artifact", "Chart"]]);
    expect(h.requests.map((r) => r.method)).toEqual(["POST", "POST"]);
    const body = JSON.parse(h.requests[0]!.body!) as { public: boolean; files: Record<string, { content: string }> };
    expect(body.public).toBe(false);
    expect(Object.keys(body.files)).toEqual(["index.html"]);
    expect(body.files["index.html"]!.content).toContain("connect-src 'none'");
    expect(h.items().map((i) => i.key)).toEqual(["artifact:g1", "artifact:g2"]);
    expect(h.items()[0]).toMatchObject({ kind: "artifact", title: "Chart", url: "https://gist.githack.com/me/g1/raw/index.html" });
    expect(h.copied[0]).toBe("https://gist.githack.com/me/g1/raw/index.html");
  });

  it("sends nothing without a token or when cancelled", async () => {
    const noToken = harness({ token: "" });
    await noToken.controller.publishArtifact("<p>x</p>", "T");
    expect(noToken.requests).toEqual([]);
    expect(noToken.notices[0]).toContain("Publishing");
    const cancelled = harness({ confirm: false });
    await cancelled.controller.publishArtifact("<p>x</p>", "T");
    expect(cancelled.requests).toEqual([]);
    expect(cancelled.items()).toEqual([]);
  });
});

describe("unpublish", () => {
  const seeded: PublishedItem = { key: "n/A.md", kind: "note", title: "A", gistId: "g1", url: "https://gist.github.com/me/g1", owner: "me", publishedAt: 1, updatedAt: 1 };

  it("deletes the gist and removes the entry", async () => {
    const h = harness({ items: [seeded] });
    await h.controller.unpublish("n/A.md");
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({ method: "DELETE", url: "http://stub/gists/g1" });
    expect(h.items()).toEqual([]);
  });

  it("removes the entry when the gist is already gone", async () => {
    const h = harness({ items: [seeded] });
    h.respond(() => ({ status: 404, json: {} }));
    await h.controller.unpublish("n/A.md");
    expect(h.items()).toEqual([]);
  });

  it("keeps the entry when GitHub refuses", async () => {
    const h = harness({ items: [seeded] });
    h.respond(() => ({ status: 401, json: {} }));
    await h.controller.unpublish("n/A.md");
    expect(h.items()).toEqual([seeded]);
    expect(h.notices.at(-1)).toContain("rejected");
  });

  it("sends nothing without a token", async () => {
    const h = harness({ items: [seeded], token: "" });
    await h.controller.unpublish("n/A.md");
    expect(h.requests).toEqual([]);
    expect(h.items()).toEqual([seeded]);
    expect(h.notices[0]).toContain("Publishing");
  });
});

describe("testToken, copyLink, rename", () => {
  it("reports the token result", async () => {
    const h = harness();
    expect(await h.controller.testToken()).toEqual({ ok: true, message: "GitHub accepted the token." });
    expect(h.requests[0]).toMatchObject({ method: "GET", url: "http://stub/gists?per_page=1" });
    h.respond(() => ({ status: 401, json: {} }));
    expect(await h.controller.testToken()).toEqual({ ok: false, message: "GitHub rejected the token." });
    expect(await harness({ token: "" }).controller.testToken()).toMatchObject({ ok: false });
  });

  it("copies a published link", async () => {
    const h = harness();
    await h.controller.publishNote("n/A.md");
    await h.controller.copyLink("n/A.md");
    expect(h.copied).toHaveLength(2);
    expect(h.requests).toHaveLength(1);
  });

  it("keeps a renamed note published under its new path", async () => {
    const h = harness();
    await h.controller.publishNote("n/A.md");
    await h.controller.renameNote("n/A.md", "m/B.md");
    expect(h.items().map((i) => i.key)).toEqual(["m/B.md"]);
    await h.controller.publishNote("m/B.md");
    expect(h.requests[1]).toMatchObject({ method: "PATCH", url: "http://stub/gists/g1" });
  });
});

describe("publishConfirmMessage", () => {
  it("states who can read it and what is not uploaded", () => {
    const note = publishConfirmMessage("note");
    expect(note).toContain("Anyone with the link can read this.");
    expect(note).toContain("Frontmatter, %%comments%%, and vault embeds and images are not uploaded.");
    expect(note).not.toContain("githack");
  });

  it("discloses the third-party host for artifacts", () => {
    expect(publishConfirmMessage("artifact")).toContain("The link opens through gist.githack.com, a third-party host that shows a confirmation page first.");
  });
});
