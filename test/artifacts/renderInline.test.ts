import { describe, expect, it } from "vitest";
import { App, FakeElement } from "obsidian";
import { ArtifactModal, renderArtifactInline } from "../../src/artifacts/renderInline";

/** Sandbox tokens that would each hand an artifact a capability it must not have. */
const FORBIDDEN_SANDBOX_TOKENS = [
  "allow-same-origin",
  "allow-forms",
  "allow-modals",
  "allow-popups",
  "allow-popups-to-escape-sandbox",
  "allow-downloads",
  "allow-top-navigation",
  "allow-top-navigation-by-user-activation",
  "allow-pointer-lock",
  "allow-presentation",
  "allow-storage-access-by-user-activation",
];

/** The CSP directives that keep an artifact off the network and out of the vault. */
const REQUIRED_CSP_DIRECTIVES = [
  "default-src 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
];

interface RenderedFrame {
  sandbox: string | null;
  allow: string | null;
  srcdoc: string;
  src: string | null;
}

function frameOf(root: FakeElement): RenderedFrame {
  const iframe = root.querySelector("iframe");
  if (!iframe) throw new Error("no iframe was rendered");
  return {
    sandbox: iframe.getAttribute("sandbox"),
    allow: iframe.getAttribute("allow"),
    srcdoc: (iframe as unknown as { srcdoc?: string }).srcdoc ?? "",
    src: iframe.getAttribute("src"),
  };
}

function inline(html: string): RenderedFrame {
  const root = new FakeElement();
  renderArtifactInline(root as unknown as HTMLElement, html, 300, "Artifact");
  return frameOf(root);
}

function fullscreen(html: string): RenderedFrame {
  const modal = new ArtifactModal(new App() as never, html, "Artifact");
  modal.open();
  return frameOf(modal.contentEl as unknown as FakeElement);
}

const PAGE = "<html><head><title>t</title></head><body><p>hi</p></body></html>";

describe.each([
  ["inline", inline],
  ["fullscreen", fullscreen],
])("artifact sandbox (%s)", (_name, render) => {
  it("sandboxes with allow-scripts and nothing else", () => {
    expect(render(PAGE).sandbox).toBe("allow-scripts");
  });

  it.each(FORBIDDEN_SANDBOX_TOKENS)("never grants %s", (token) => {
    expect(render(PAGE).sandbox ?? "").not.toContain(token);
  });

  it("delegates clipboard-write and no other permission", () => {
    expect(render(PAGE).allow).toBe("clipboard-write");
  });

  it("carries the artifact in srcdoc so the frame never navigates", () => {
    const frame = render(PAGE);
    expect(frame.src).toBeNull();
    expect(frame.srcdoc).toContain("<p>hi</p>");
  });

  it.each(REQUIRED_CSP_DIRECTIVES)("enforces %s", (directive) => {
    expect(render(PAGE).srcdoc).toContain(directive);
  });

  it("injects the CSP as a meta http-equiv, not the unenforced iframe attribute", () => {
    expect(render(PAGE).srcdoc).toContain('<meta http-equiv="Content-Security-Policy"');
  });
});

describe("artifact CSP injection", () => {
  it("puts the policy immediately after an existing <head>", () => {
    const srcdoc = inline(PAGE).srcdoc;
    expect(srcdoc).toContain('<head><meta http-equiv="Content-Security-Policy"');
    expect(srcdoc.indexOf("Content-Security-Policy")).toBeLessThan(srcdoc.indexOf("<title>"));
  });

  it("creates a head when the artifact has <html> but no <head>", () => {
    const srcdoc = inline("<html><body><p>hi</p></body></html>").srcdoc;
    expect(srcdoc).toContain("<head><meta http-equiv=");
    expect(srcdoc.indexOf("Content-Security-Policy")).toBeLessThan(srcdoc.indexOf("<body>"));
  });

  it("prepends the policy to a bare fragment", () => {
    const srcdoc = inline("<p>hi</p>").srcdoc;
    expect(srcdoc.startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true);
  });

  it("lands ahead of any script the artifact declares", () => {
    const srcdoc = inline("<html><head><script>window.x=1</script></head><body></body></html>").srcdoc;
    expect(srcdoc.indexOf("Content-Security-Policy")).toBeLessThan(srcdoc.indexOf("<script>"));
  });

  it("still applies when the artifact ships its own permissive policy", () => {
    const hostile = "<html><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src *\"></head><body></body></html>";
    const srcdoc = inline(hostile).srcdoc;
    expect(srcdoc.indexOf("connect-src 'none'")).toBeLessThan(srcdoc.indexOf("default-src *"));
  });
});

describe("artifact sandbox parity", () => {
  it("gives the fullscreen modal the same contract as the inline frame", () => {
    const a = inline(PAGE);
    const b = fullscreen(PAGE);
    expect(b.sandbox).toBe(a.sandbox);
    expect(b.allow).toBe(a.allow);
    expect(b.srcdoc).toBe(a.srcdoc);
  });
});
