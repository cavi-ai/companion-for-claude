import { describe, it, expect } from "vitest";
import { extractArtifact, titleFromHtml, sanitizeFileName, validateArtifactInteractivity } from "../src/artifacts/parse";

describe("validateArtifactInteractivity", () => {
  it("flags tab handlers that reference an undefined function", () => {
    const html = `<nav><button onclick="switchTab('a')">A</button><button onclick="switchTab('b')">B</button></nav>`;
    const r = validateArtifactInteractivity(html);
    expect(r.ok).toBe(false);
    expect(r.issues.join(" ")).toContain("switchTab");
  });
  it("passes when the handler's function is defined in a <script>", () => {
    const html = `<button onclick="switchTab('a')">A</button><script>function switchTab(id){document.body.dataset.tab=id;}</script>`;
    expect(validateArtifactInteractivity(html).ok).toBe(true);
  });
  it("accepts arrow/const definitions and is fine with no interactivity", () => {
    expect(validateArtifactInteractivity(`<button onclick="go()">x</button><script>const go = () => {};</script>`).ok).toBe(true);
    expect(validateArtifactInteractivity(`<h1>static</h1>`).ok).toBe(true);
  });
  it("accepts window.fn assignments and addEventListener-only scripts", () => {
    expect(validateArtifactInteractivity(`<button onclick="go()">x</button><script>window.go = function(){};</script>`).ok).toBe(true);
    // No inline handlers → self-contained JS, nothing to flag.
    expect(validateArtifactInteractivity(`<button id="b">x</button><script>document.getElementById('b').addEventListener('click',()=>{});</script>`).ok).toBe(true);
  });
  it("flags only the missing handler when several are wired", () => {
    const html = `<button onclick="go()">go</button><button onchange="stop()">stop</button><script>function go(){}</script>`;
    const r = validateArtifactInteractivity(html);
    expect(r.ok).toBe(false);
    expect(r.issues.join(" ")).toContain("stop");
    expect(r.issues.join(" ")).not.toContain("go(");
  });

  it("does not flag JS keywords or built-in globals used in inline handlers", () => {
    expect(validateArtifactInteractivity(`<button onclick="alert('hi')">x</button>`).ok).toBe(true);
    expect(validateArtifactInteractivity(`<button onclick="if(x)doThing()">x</button><script>function doThing(){}</script>`).ok).toBe(true);
    expect(validateArtifactInteractivity(`<button onclick="print()">x</button>`).ok).toBe(true);
  });
  it("checks every call in a multi-statement handler, not just the first", () => {
    const r = validateArtifactInteractivity(`<button onclick="event.preventDefault(); switchTab('x')">x</button>`);
    expect(r.ok).toBe(false);
    expect(r.issues.join(" ")).toContain("switchTab");
  });
  it("skips member (dotted) calls it cannot validate", () => {
    expect(validateArtifactInteractivity(`<button onclick="App.switchTab('x')">x</button>`).ok).toBe(true);
  });
  it("flags a handler whose function is only defined at module scope (not global)", () => {
    const html = `<button onclick="switchTab('a')">x</button><script type="module">function switchTab(id){}</script>`;
    expect(validateArtifactInteractivity(html).ok).toBe(false);
  });

  it("matches script end tags with whitespace and bogus attributes (CodeQL bad-tag-filter)", () => {
    // Browsers close the element on `</script >` and even `</script\t\n bar>`, so
    // the regex must too — else the script body is missed and a correctly-defined
    // handler is falsely flagged as undefined.
    expect(validateArtifactInteractivity(`<button onclick="go()">x</button><script>function go(){}</script >`).ok).toBe(true);
    expect(validateArtifactInteractivity(`<button onclick="go()">x</button><script>function go(){}</script\t\n bar>`).ok).toBe(true);
  });
});

describe("extractArtifact", () => {
  it("extracts a claude-html block and reads its <title>", () => {
    const md = "Here you go:\n\n```claude-html\n<!DOCTYPE html><html><head><title>My Plan</title></head><body>hi</body></html>\n```\n";
    const a = extractArtifact(md);
    expect(a).not.toBeNull();
    expect(a!.title).toBe("My Plan");
    expect(a!.html).toContain("<!DOCTYPE html>");
  });

  it("accepts a claude-html block with a height directive on the fence", () => {
    const md = "```claude-html height=720\n<h1>Inline</h1>\n```";
    const a = extractArtifact(md);
    expect(a!.title).toBe("Inline");
  });

  it("falls back to a plain html block only when it is a full document", () => {
    const fullDoc = "```html\n<!DOCTYPE html><html><body><h1>Doc</h1></body></html>\n```";
    expect(extractArtifact(fullDoc)!.title).toBe("Doc");

    const snippet = "```html\n<span>just a snippet</span>\n```";
    expect(extractArtifact(snippet)).toBeNull();
  });

  it("returns null when there is no artifact", () => {
    expect(extractArtifact("plain prose, no code block")).toBeNull();
  });

  it("returns null for an empty block", () => {
    expect(extractArtifact("```claude-html\n\n```")).toBeNull();
  });
});

describe("titleFromHtml", () => {
  it("prefers <title>, then <h1>, then a default", () => {
    expect(titleFromHtml("<title> Spaced </title>")).toBe("Spaced");
    expect(titleFromHtml("<h1>Heading <em>x</em></h1>")).toBe("Heading x");
    expect(titleFromHtml("<p>nothing</p>")).toBe("Claude artifact");
  });

  it("strips tags safely against the multi-char reconstruction bypass (CodeQL)", () => {
    // A single-pass /<[^>]+>/ leaves a reconstructed tag/bracket behind.
    const title = titleFromHtml("<h1><<b>script>alert(1)</h1>");
    expect(title).not.toMatch(/[<>]/);
    expect(title).not.toContain("script>");
  });
});

describe("sanitizeFileName", () => {
  it("strips path-hostile characters and collapses whitespace", () => {
    expect(sanitizeFileName('a/b:c*?"<>|#^[]d')).toBe("a b c d");
  });
  it("never yields an empty name", () => {
    expect(sanitizeFileName("///")).toBe("Untitled");
    expect(sanitizeFileName("   ")).toBe("Untitled");
  });
  it("caps length at 80 chars", () => {
    expect(sanitizeFileName("x".repeat(200)).length).toBe(80);
  });
});
