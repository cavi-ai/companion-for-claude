import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function readStyles(): string {
  return readFileSync(join(__dirname, "..", "..", "styles.css"), "utf8");
}

/** The `body { ... }` token block at the top of the stylesheet (the one declaring --cc-surface). */
export function bodyBlock(css: string): string {
  let start = css.indexOf("body {");
  while (start !== -1) {
    const end = css.indexOf("}", start);
    const block = css.slice(start, end);
    if (block.includes("--cc-surface:")) return block;
    start = css.indexOf("body {", start + 1);
  }
  throw new Error("body { } token block (with --cc-surface:) not found");
}

/** The `.cc-root { ... }` token block at the top of the stylesheet. */
export function rootBlock(css: string): string {
  const start = css.indexOf(".cc-root {");
  const end = css.indexOf("}", start);
  return css.slice(start, end);
}

const SEMANTIC = [
  "--cc-surface:", "--cc-surface-raised:", "--cc-surface-sunken:", "--cc-border:", "--cc-border-hover:",
  "--cc-text:", "--cc-text-muted:", "--cc-text-faint:", "--cc-accent:", "--cc-accent-fg:",
  "--cc-accent-wash:", "--cc-accent-wash-strong:", "--cc-success:", "--cc-danger:",
  "--cc-space-1:", "--cc-space-2:", "--cc-space-3:", "--cc-space-4:", "--cc-space-5:", "--cc-space-6:",
  "--cc-radius-sm:", "--cc-radius-md:", "--cc-radius-lg:", "--cc-radius-pill:",
  "--cc-elevation-1:", "--cc-elevation-2:",
  "--cc-text-2xs:", "--cc-text-xs:", "--cc-text-sm:", "--cc-text-base:", "--cc-text-md:", "--cc-text-lg:", "--cc-text-xl:",
  "--cc-touch-min:",
];

describe("design tokens", () => {
  it("declares every semantic token on body, so leaf views and modals outside .cc-root see them", () => {
    const block = bodyBlock(readStyles());
    for (const name of SEMANTIC) expect(block, name).toContain(name);
  });

  it("keeps the brand accents on body (with the semantic tokens that derive from them) and the font stacks on .cc-root", () => {
    const css = readStyles();
    const body = bodyBlock(css);
    for (const name of ["--cc-clay:", "--cc-olive:"]) expect(body, name).toContain(name);
    const root = rootBlock(css);
    for (const name of ["--cc-serif:", "--cc-sans:", "--cc-mono:"]) expect(root, name).toContain(name);
  });

  it("derives surfaces and text from Obsidian's variables", () => {
    const block = bodyBlock(readStyles());
    expect(block).toMatch(/--cc-surface:\s*var\(--background-primary\)/);
    expect(block).toMatch(/--cc-text:\s*var\(--text-normal\)/);
    expect(block).toMatch(/--cc-accent:\s*var\(--cc-clay\)/);
  });
});

/** All rules whose selector starts with the given prefix, concatenated. */
export function rulesFor(css: string, selectorPrefix: string): string {
  const out: string[] = [];
  const re = new RegExp(`(^|\\n)(${selectorPrefix.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}[^{]*)\\{([^}]*)\\}`, "g");
  for (const m of css.matchAll(re)) out.push(`${m[2]}{${m[3]}}`);
  return out.join("\n");
}

describe("research desk surfaces", () => {
  it("carries no gradient, glow, or Obsidian purple", () => {
    const css = readStyles();
    const desk = rulesFor(css, ".cc-desk") + rulesFor(css, ".cc-research-desk");
    expect(desk).not.toContain("linear-gradient(");
    expect(desk).not.toContain("--cc-research-glow");
    expect(desk).not.toContain("--interactive-accent");
    expect(desk).not.toContain("--color-cyan");
  });

  it("keeps the whole research/workbench surface off Obsidian's accent and the retired glow token", () => {
    const css = readStyles();
    const research = rulesFor(css, ".cc-research");
    const workbench = rulesFor(css, ".cc-workbench");
    expect(research).not.toContain("--interactive-accent");
    expect(research).not.toContain("--cc-research-glow");
    expect(workbench).not.toContain("--interactive-accent");
    expect(workbench).not.toContain("--cc-research-glow");
  });

  it("derives the research tokens from the Companion accent", () => {
    const css = readStyles();
    const block = css.slice(css.indexOf(".cc-research-desk,"), css.indexOf("}", css.indexOf(".cc-research-desk,")));
    expect(block).toMatch(/--cc-research-surface:[^;]*var\(--cc-accent\)/);
    expect(block).toMatch(/--cc-research-radius:\s*var\(--cc-radius-lg\)/);
    expect(block).not.toContain("--interactive-accent");
  });

  it("keeps desk and research eyebrows/counts off Obsidian's purple --text-accent", () => {
    const css = readStyles();
    const desk = rulesFor(css, ".cc-desk") + rulesFor(css, ".cc-research");
    expect(desk).not.toContain("--text-accent");
  });

  it("puts the desk and workbench primary button on the Companion accent", () => {
    const css = readStyles();
    expect(css).toMatch(/\.cc-research-desk \.mod-cta,\s*\.cc-research-workbench \.mod-cta\s*\{[^}]*background:\s*var\(--cc-accent\)/);
  });
});

describe("diff review", () => {
  it("uses the Companion accent for the hunk card, checkbox, and primary button", () => {
    const css = readStyles();
    const hunk = rulesFor(css, ".cc-diff-hunk");
    expect(hunk).toMatch(/border-radius:\s*var\(--cc-radius-lg\)/);
    expect(hunk).toMatch(/background:\s*var\(--cc-surface-raised\)/);
    expect(css).toMatch(/\.cc-diff-modal \.mod-cta\s*\{[^}]*background:\s*var\(--cc-accent\)/);
    expect(css).toMatch(/\.cc-diff-modal input\[type="checkbox"\]:checked\s*\{[^}]*background-color:\s*var\(--cc-accent\)/);
  });

  it("keeps the batch-diff file checkbox off Obsidian's accent too", () => {
    const css = readStyles();
    const checkbox = rulesFor(css, ".cc-batch-diff-file-checkbox");
    expect(checkbox).not.toContain("--interactive-accent");
  });
});

describe("header controls", () => {
  it("icon buttons and the backend pill read the tokens", () => {
    const css = readStyles();
    const btn = rulesFor(css, ".cc-icon-btn");
    expect(btn).toMatch(/border-radius:\s*var\(--cc-radius-sm\)/);
    expect(btn).toMatch(/\.cc-icon-btn:hover\s*\{[^}]*var\(--cc-accent-wash\)/);
    const pill = rulesFor(css, ".cc-backend-pill");
    expect(pill).toMatch(/\.cc-backend-pill\.is-ok\s*\{[^}]*var\(--cc-success\)/);
    expect(pill).toMatch(/\.cc-backend-pill\.is-warn\s*\{[^}]*var\(--cc-accent\)/);
    expect(pill).not.toContain("--cc-gray-");
  });
});

/** Drops the `.cc-root { ... }` token block and every rule whose selector contains `.is-mobile` or `.cc-artifact`. */
export function stripAllowlisted(css: string): string {
  let out = css;
  const rootStart = out.indexOf(".cc-root {");
  if (rootStart !== -1) {
    const rootEnd = out.indexOf("}", rootStart);
    out = out.slice(0, rootStart) + out.slice(rootEnd + 1);
  }
  out = out.replace(/(^|\n)[^{}\n]*\.is-mobile[^{}]*\{[^}]*\}/g, "");
  out = out.replace(/(^|\n)[^{}\n]*\.cc-artifact[^{}]*\{[^}]*\}/g, "");
  return out;
}

describe("type scale", () => {
  it("uses no raw pixel font-size outside .cc-root, .is-mobile, and .cc-artifact rules", () => {
    const stripped = stripAllowlisted(readStyles());
    expect(stripped).not.toMatch(/font-size:\s*[0-9.]+px/);
  });
});

describe("send button stop pulse", () => {
  it("rings on the danger token, not a hardcoded slate rgba", () => {
    const css = readStyles();
    const anchor = css.indexOf(".cc-send.is-stop");
    const start = css.indexOf("@keyframes cc-pulse", anchor);
    const end = css.indexOf("}", css.indexOf("}", start) + 1);
    const block = css.slice(start, end);
    expect(block).not.toMatch(/rgba\(20,\s*20,\s*19/);
    expect(block).toContain("color-mix(in srgb, var(--cc-danger) 35%, transparent)");
  });
});

describe("hex literal retirement", () => {
  it("keeps no new raw hex color outside the token blocks and .cc-artifact rules", () => {
    const css = readStyles();
    const bodyStart = css.indexOf("body {");
    let bs = bodyStart;
    let be = -1;
    while (bs !== -1) {
      const end = css.indexOf("}", bs);
      if (css.slice(bs, end).includes("--cc-surface:")) { be = end; break; }
      bs = css.indexOf("body {", bs + 1);
    }
    const rs = css.indexOf(".cc-root {");
    const re = css.indexOf("}", rs);
    let out = css;
    for (const [s, e] of [[bs, be], [rs, re]].sort((a, b) => b[0] - a[0])) {
      out = out.slice(0, s) + out.slice(e + 1);
    }
    out = out.replace(/(^|\n)[^{}\n]*\.cc-artifact[^{}]*\{[^}]*\}/g, "");
    const hexLiterals = out.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(hexLiterals.length).toBeLessThanOrEqual(33);
  });
});

describe("light-theme accent text", () => {
  it("declares --cc-accent-text on body and overrides it under body.theme-light", () => {
    const css = readStyles();
    const body = bodyBlock(css);
    expect(body).toMatch(/--cc-accent-text:\s*var\(--cc-clay\)/);
    const lightStart = css.indexOf("body.theme-light {");
    const lightEnd = css.indexOf("}", lightStart);
    const lightBlock = css.slice(lightStart, lightEnd);
    expect(lightBlock).toMatch(/--cc-accent-text:\s*color-mix\(in srgb, var\(--cc-clay\) 72%, black\)/);
  });

  it("reads --cc-accent-text on the eyebrow rules", () => {
    const css = readStyles();
    const eyebrow = rulesFor(css, ".cc-eyebrow");
    expect(eyebrow).toMatch(/color:\s*var\(--cc-accent-text\)/);
    const deskEyebrow = rulesFor(css, ".cc-desk-eyebrow");
    expect(deskEyebrow).toMatch(/color:\s*var\(--cc-accent-text\)/);
  });
});

describe("stage-dot ring", () => {
  it("rings the current stage dot on the accent wash", () => {
    const css = readStyles();
    const rule = rulesFor(css, ".cc-desk-stage-step.is-current .cc-desk-stage-dot");
    expect(rule).toContain("--cc-accent-wash-strong");
  });
});

describe("interactive-accent retirement", () => {
  it("reads no --interactive-accent anywhere in Companion CSS", () => {
    expect(readStyles()).not.toContain("--interactive-accent");
  });
});

describe("artifact palette retirement", () => {
  it("reads no --cc-ivory/--cc-slate/--cc-oat/--cc-gray- token outside .cc-root and .cc-artifact rules", () => {
    const css = readStyles();
    let out = css;
    const rootStart = out.indexOf(".cc-root {");
    if (rootStart !== -1) {
      const rootEnd = out.indexOf("}", rootStart);
      out = out.slice(0, rootStart) + out.slice(rootEnd + 1);
    }
    out = out.replace(/(^|\n)[^{}\n]*\.cc-artifact[^{}]*\{[^}]*\}/g, "");
    expect(out).not.toMatch(/var\(--cc-(ivory|slate|oat|gray-\d+)/);
  });
});
