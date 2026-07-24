import { setIcon, Notice, Modal, App } from "obsidian";
import { validateArtifactInteractivity } from "./parse";
import type { ArtifactOpenTarget } from "../types";

/** Sandbox CSP shared by the inline iframe and the fullscreen modal: scripts run
 *  but can't reach the vault, cookies, forms, or the network. `connect-src 'none'`
 *  + data/blob-only assets is the load-bearing guarantee (blocks fetch/XHR/beacon
 *  exfiltration); `'unsafe-eval'` is kept so charting/templating artifacts that
 *  use eval/new Function still render. */
const ARTIFACT_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; " +
  "img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; " +
  "form-action 'none'; base-uri 'none';";

/**
 * Inject the CSP as a `<meta http-equiv>` at the top of `<head>` so it's actually
 * enforced. The `csp` iframe attribute is the abandoned "Embedded Enforcement"
 * proposal and is NOT honored by Electron/Obsidian, so the meta tag — not the
 * attribute — is what restricts the artifact.
 */
function withCsp(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${meta}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${meta}</head>`);
  return `${meta}${html}`;
}

function sandboxFrame(iframe: HTMLIFrameElement, html: string): void {
  iframe.setAttribute("sandbox", "allow-scripts");
  // Delegate clipboard *write* so artifact "Copy" buttons work on user click.
  // This is a one-way push to the OS clipboard, not same-origin/network access,
  // so it doesn't widen the sandbox's reach into the vault, cookies, or forms.
  iframe.setAttribute("allow", "clipboard-write");
  iframe.srcdoc = withCsp(html);
}

export interface ArtifactActions {
  /** 1-click open, honoring the user's artifact-open setting. */
  open?: (html: string, title: string) => void;
  /** Open with an explicit target (from the split-button dropdown). */
  openWith?: (html: string, title: string, target: ArtifactOpenTarget) => void;
}

/** Targets offered in the Open split-button's dropdown. */
const OPEN_MENU: ReadonlyArray<readonly [string, ArtifactOpenTarget]> = [
  ["Open in Obsidian (full screen)", "obsidian"],
  ["Default browser", "default"],
  ["Google Chrome", "chrome"],
  ["Safari", "safari"],
  ["Brave", "brave"],
  ["Firefox", "firefox"],
];

/**
 * Render an HTML artifact inline inside a note using a sandboxed iframe.
 *
 * The iframe is sandboxed WITHOUT `allow-same-origin` and gets a restrictive
 * CSP, so artifact scripts can run (charts, toggles, interactions) but cannot
 * read cookies, reach the vault, submit forms, or call out to the network.
 */
export function renderArtifactInline(
  el: HTMLElement,
  html: string,
  height: number,
  title: string,
  actions: ArtifactActions = {},
): void {
  const wrap = el.createDiv({ cls: "cc-artifact" });

  const bar = wrap.createDiv({ cls: "cc-artifact-bar" });
  const label = bar.createDiv({ cls: "cc-artifact-label" });
  setIcon(label.createSpan({ cls: "cc-artifact-icon" }), "layout-dashboard");
  label.createSpan({ text: title });

  const open1Click = actions.open ?? ((h, t) => void openArtifactExternally(h, t));
  const openWith = actions.openWith ?? ((h, t, target) => void openArtifactExternally(h, t, target));

  // Quick in-app fullscreen.
  const fsBtn = bar.createEl("button", { cls: "cc-artifact-btn", attr: { "aria-label": "Open full screen in Obsidian" } });
  setIcon(fsBtn, "maximize-2");
  fsBtn.addEventListener("click", () => openWith(html, title, "obsidian"));

  // Split "Open" button: the body is a 1-click open (per setting); the caret
  // opens a dropdown to choose a target one-off.
  const split = bar.createDiv({ cls: "cc-artifact-open-split" });
  const openBtn = split.createEl("button", { cls: "cc-artifact-btn cc-artifact-open", attr: { "aria-label": "Open artifact" } });
  openBtn.setText("Open ↗");
  openBtn.addEventListener("click", () => open1Click(html, title));

  const caret = split.createEl("button", { cls: "cc-artifact-btn cc-artifact-caret", attr: { "aria-label": "Choose where to open" } });
  setIcon(caret, "chevron-down");
  const menu = split.createDiv({ cls: "cc-artifact-menu" });
  // The outside-click listener must be torn down on EVERY close path (menu-item
  // click, toggle-close, outside click), or it leaks on `activeDocument` and
  // retains the artifact DOM/HTML closure.
  let closeMenu: ((e: MouseEvent) => void) | null = null;
  const detachClose = () => {
    if (closeMenu) {
      activeDocument.removeEventListener("mousedown", closeMenu);
      closeMenu = null;
    }
  };
  const closeMenuNow = () => {
    menu.removeClass("is-open");
    detachClose();
  };
  for (const [menuLabel, target] of OPEN_MENU) {
    const item = menu.createEl("button", { cls: "cc-artifact-menu-item", text: menuLabel });
    item.addEventListener("click", () => {
      closeMenuNow();
      openWith(html, title, target);
    });
  }
  caret.addEventListener("click", (e) => {
    e.stopPropagation();
    const opening = !menu.hasClass("is-open");
    menu.toggleClass("is-open", opening);
    if (!opening) {
      detachClose();
      return;
    }
    closeMenu = (ev: MouseEvent) => {
      if (!split.contains(ev.target as Node)) closeMenuNow();
    };
    // Defer so this same click doesn't immediately close it.
    window.setTimeout(() => closeMenu && activeDocument.addEventListener("mousedown", closeMenu), 0);
  });

  const iframe = wrap.createEl("iframe", { cls: "cc-artifact-frame" });
  sandboxFrame(iframe, html);
  iframe.setAttribute("loading", "lazy");
  iframe.setCssStyles({ height: `${Math.max(120, height)}px` });

  // Flag faux-interactive artifacts (handlers wired to undefined JS) — a model
  // regression guard, so a tab bar that does nothing doesn't ship silently.
  const report = validateArtifactInteractivity(html);
  if (!report.ok) console.warn("[Claude Companion] artifact interactivity issues:", report.issues);
}

/**
 * A full-window, sandboxed view of an artifact inside Obsidian — the
 * "keep everything in one app" path (the default open target).
 */
export class ArtifactModal extends Modal {
  constructor(
    app: App,
    private html: string,
    private artifactTitle: string,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("cc-artifact-modal");
    this.titleEl.setText(this.artifactTitle || "Artifact");
    const iframe = this.contentEl.createEl("iframe", { cls: "cc-artifact-frame cc-artifact-frame-full" });
    sandboxFrame(iframe, this.html);
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/** macOS .app names for the browsers we offer. */
const BROWSER_APP: Record<string, string> = {
  chrome: "Google Chrome",
  safari: "Safari",
  brave: "Brave Browser",
  firefox: "Firefox",
};

/**
 * Open an artifact in an external browser. "default" uses the OS default; a
 * named browser is launched via `open -a` on macOS, falling back to the default
 * if that browser isn't installed or we're not on macOS. Blob URLs / window.open
 * are unreliable in Obsidian's Electron renderer, so we write a temp file and
 * hand it to the OS shell.
 */
export async function openArtifactExternally(html: string, title: string, target: ArtifactOpenTarget = "default"): Promise<void> {
  try {
    const req = (window as { require?: (m: string) => unknown }).require;
    if (!req) throw new Error("native modules unavailable");
    const os = req("os") as { tmpdir(): string; platform(): string };
    const path = req("path") as { join(...p: string[]): string };
    const fs = req("fs") as {
      promises: {
        writeFile(p: string, d: string, enc: string): Promise<void>;
        readdir(p: string): Promise<string[]>;
        stat(p: string): Promise<{ mtimeMs: number }>;
        unlink(p: string): Promise<void>;
      };
    };
    const electron = req("electron") as { shell: { openPath(p: string): Promise<string> } };

    const dir = os.tmpdir();
    await sweepStaleArtifacts(fs, path, dir);
    const safe = (title || "artifact").replace(/[^a-z0-9-_]+/gi, "-").slice(0, 60) || "artifact";
    const file = path.join(dir, `companion-${safe}-${Date.now()}.html`);
    await fs.promises.writeFile(file, html, "utf8");

    const appName = target !== "default" && target !== "obsidian" ? BROWSER_APP[target] : undefined;
    if (appName && os.platform() === "darwin") {
      // execFile (arg array, no shell) — avoids interpolating a shell string over
      // a path derived from the user-controlled $TMPDIR.
      const cp = req("child_process") as { execFile(cmd: string, args: string[], cb: (err: unknown) => void): void };
      await new Promise<void>((resolve) => {
        cp.execFile("open", ["-a", appName, file], (err) => {
          if (err) void electron.shell.openPath(file); // browser not installed → default
          resolve();
        });
      });
      return;
    }

    const err = await electron.shell.openPath(file);
    if (err) throw new Error(err);
  } catch (e) {
    try {
      window.open(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`, "_blank");
    } catch {
      new Notice(`Couldn't open the artifact externally: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** fs surface used by the temp-file sweep. */
interface SweepFs {
  promises: {
    readdir(p: string): Promise<string[]>;
    stat(p: string): Promise<{ mtimeMs: number }>;
    unlink(p: string): Promise<void>;
  };
}

/**
 * Best-effort removal of temp artifact files left by previous external opens.
 * Only files older than a minute are deleted, so we never race a file a browser
 * is still loading (the fresh file is written after this returns). All errors
 * are swallowed — cleanup must never block opening the artifact.
 */
async function sweepStaleArtifacts(fs: SweepFs, path: { join(...p: string[]): string }, dir: string): Promise<void> {
  try {
    const names = await fs.promises.readdir(dir);
    const now = Date.now();
    await Promise.all(
      names
        .filter((n) => /^companion-.*\.html$/.test(n))
        .map(async (n) => {
          const p = path.join(dir, n);
          try {
            const st = await fs.promises.stat(p);
            if (now - st.mtimeMs > 60_000) await fs.promises.unlink(p);
          } catch {
            /* file vanished or unreadable — ignore */
          }
        }),
    );
  } catch {
    /* readdir failed — ignore, cleanup is best-effort */
  }
}
