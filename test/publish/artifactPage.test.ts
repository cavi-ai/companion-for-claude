import { describe, expect, it } from "vitest";
import { artifactPageHtml } from "../../src/publish/artifactPage";

describe("artifactPageHtml", () => {
  it("wraps a fragment in a full document with the CSP and a title", () => {
    const page = artifactPageHtml("<div>hi</div>", "My chart");
    expect(page).toMatch(/^<!doctype html>/i);
    expect(page).toContain('http-equiv="Content-Security-Policy"');
    expect(page).toContain("connect-src 'none'");
    expect(page).toContain("<title>My chart</title>");
    expect(page).toContain("<div>hi</div>");
  });

  it("injects the CSP before the artifact's own head content", () => {
    const page = artifactPageHtml("<!doctype html><html><head><script>1</script></head><body>x</body></html>", "T");
    expect(page.indexOf("Content-Security-Policy")).toBeLessThan(page.indexOf("<script>"));
    expect(page.match(/<!doctype/gi)).toHaveLength(1);
  });

  it("keeps an existing title and escapes a supplied one", () => {
    expect(artifactPageHtml("<html><head><title>Own</title></head><body></body></html>", "Other")).toContain("<title>Own</title>");
    expect(artifactPageHtml("<p>x</p>", "<b>&</b>")).toContain("<title>&lt;b&gt;&amp;&lt;/b&gt;</title>");
  });

  it("adds a head to an html element that has none", () => {
    const page = artifactPageHtml("<html><body>x</body></html>", "T");
    expect(page).toContain("<head>");
    expect(page).toContain("<title>T</title>");
    expect(page).toContain("connect-src 'none'");
  });
});
