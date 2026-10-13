import type { App, Component } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VersionedMarkdownRenderer } from "../../src/view/chat/markdownRender";

const render = vi.hoisted(() => vi.fn());
vi.mock("obsidian", async (importOriginal) => ({
  ...(await importOriginal<typeof import("obsidian")>()),
  MarkdownRenderer: { render },
}));

interface Node {
  text?: string;
  cls?: string;
  childNodes: Node[];
  createDiv(options: { cls: string }): Node;
  createSpan(options: { cls: string; text: string }): Node;
}

function node(text?: string, cls?: string): Node {
  const self: Node = {
    text,
    cls,
    childNodes: [],
    createDiv: (options) => { const child = node(undefined, options.cls); self.childNodes.push(child); return child; },
    createSpan: (options) => { const child = node(options.text, options.cls); self.childNodes.push(child); return child; },
  };
  return self;
}

function element(): HTMLElement & { children: Node[] } {
  const el = { children: [] as Node[], replaceChildren(...nodes: Node[]) { el.children = nodes; } };
  return el as unknown as HTMLElement & { children: Node[] };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}

const component = {} as Component;
const app = { workspace: { getActiveFile: () => ({ path: "Notes/a.md" }) } } as unknown as App;

function pendingRenders(): Array<{ markdown: string; resolve(): void }> {
  const pending: Array<{ markdown: string; resolve(): void }> = [];
  render.mockImplementation((_app: App, markdown: string, target: Node) => {
    const gate = deferred();
    pending.push({ markdown, resolve: () => { target.childNodes.push(node(markdown)); gate.resolve(); } });
    return gate.promise;
  });
  return pending;
}

beforeEach(() => {
  render.mockReset();
  vi.stubGlobal("createDiv", () => node());
});

describe("VersionedMarkdownRenderer.renderInto", () => {
  it("replaces the element's children with the rendered nodes", async () => {
    const pending = pendingRenders();
    const el = element();
    el.children = [node("old")];
    const done = new VersionedMarkdownRenderer(app, component).renderInto(el, "# hi");
    pending[0]!.resolve();
    await done;
    expect(el.children.map((child) => child.text)).toEqual(["# hi"]);
    expect(render).toHaveBeenCalledWith(app, "# hi", expect.anything(), "Notes/a.md", component);
  });

  it("drops the result of a render that a newer one superseded", async () => {
    const pending = pendingRenders();
    const el = element();
    const renderer = new VersionedMarkdownRenderer(app, component);
    const first = renderer.renderInto(el, "first");
    const second = renderer.renderInto(el, "second");
    pending[1]!.resolve();
    await second;
    pending[0]!.resolve();
    await first;
    expect(el.children.map((child) => child.text)).toEqual(["second"]);
  });
});

describe("VersionedMarkdownRenderer.renderStreamingArtifactInto", () => {
  const withProse = "Here is the plan:\n\n```claude-html\n<div>";

  it("renders the lead-in prose, then paints the building chip", async () => {
    const pending = pendingRenders();
    const el = element();
    new VersionedMarkdownRenderer(app, component).renderStreamingArtifactInto(el, withProse);
    expect(el.children).toEqual([]);
    pending[0]!.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(pending[0]!.markdown).toBe("Here is the plan:\n\n");
    expect(el.children.map((child) => child.text ?? child.cls)).toEqual(["Here is the plan:\n\n", "cc-artifact-building"]);
    expect(el.children[1]!.childNodes.map((child) => child.text)).toEqual(["Building artifact…"]);
  });

  it("paints the chip immediately when no prose precedes the artifact", () => {
    pendingRenders();
    const el = element();
    new VersionedMarkdownRenderer(app, component).renderStreamingArtifactInto(el, "```claude-html\n<div>");
    expect(render).not.toHaveBeenCalled();
    expect(el.children.map((child) => child.cls)).toEqual(["cc-artifact-building"]);
  });

  it("suppresses a late chip paint after a newer render bumped the element", async () => {
    const pending = pendingRenders();
    const el = element();
    const renderer = new VersionedMarkdownRenderer(app, component);
    renderer.renderStreamingArtifactInto(el, withProse);
    const final = renderer.renderInto(el, "final");
    pending[1]!.resolve();
    await final;
    pending[0]!.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(el.children.map((child) => child.text)).toEqual(["final"]);
  });
});
