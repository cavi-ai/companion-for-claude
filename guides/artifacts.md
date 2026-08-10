# Interactive artifacts

Some answers are documents, not paragraphs. When you ask for a plan, an audit, a
dashboard, or a diagram, Claude can reply with a self-contained HTML page that
Companion renders **live inside your note** — a real interactive page, not a
screenshot of one.

![A claude-html artifact rendered inline](../obsidian-plugin/assets/artifact-inline.png)

## How to get one

Type `/artifact` in the composer with a note open, or just ask — "turn this into a
dashboard", "audit this spec and score it", "diagram this architecture".
`/diagram` and `/plan` are shortcuts to specific shapes.

Claude replies with a fenced ```` ```claude-html ```` block. Companion registers a
Markdown processor for that language, so **any note containing one renders it** —
in chat, in a saved artifact note, in a note you wrote by hand.

Claude is instructed to default to a Markdown reply and reserve artifacts for
deliverables with visual structure. Use `/artifact` to request one explicitly.

## The sandbox

Artifacts are model-generated JavaScript rendered inside your notes, so they are
treated as untrusted.

The artifact runs in an `<iframe sandbox="allow-scripts">` — **without**
`allow-same-origin`. Scripts run, so charts, tabs, and toggles work. But the
frame has no same-origin privileges, which means no access to Obsidian's DOM,
your vault, or your cookies.

On top of that, a Content-Security-Policy meta tag is injected at the top of the
document:

```
default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline';
img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none';
form-action 'none'; base-uri 'none';
```

What that buys you:

- **`connect-src 'none'`** — no `fetch`, no `XMLHttpRequest`, no `sendBeacon`, no WebSocket. This is the load-bearing guarantee: an artifact cannot exfiltrate anything, because it cannot make a network request at all.
- **`default-src 'none'` with data/blob-only images, fonts, and media** — no remote asset can be pulled in as a side channel.
- **`form-action 'none'`** — nothing can be POSTed anywhere.
- **`base-uri 'none'`** — the document can't rewrite its own resolution base.
- **`'unsafe-eval'` is allowed** so artifacts using `eval`/`new Function` for charting or templating render. It grants no additional reach, since the frame has no network and no same-origin access.

Two implementation details that matter:

- The CSP is delivered as a `<meta http-equiv>` tag, **not** the iframe `csp` attribute. That attribute is from the abandoned "Embedded Enforcement" proposal and Electron/Obsidian does not honor it — the meta tag is what actually restricts the page.
- `clipboard-write` is delegated to the frame so an artifact's "Copy" button works on your click. That's a one-way push to the OS clipboard; it doesn't widen the sandbox's reach into the vault, cookies, or forms.

Companion also runs a check for **faux interactivity** — handlers wired to
functions that don't exist — and logs a console warning, so a tab bar that does
nothing doesn't ship silently.

## Opening and saving

Every rendered artifact gets a small toolbar:

- **Maximize** — full-window view inside Obsidian, same sandbox and CSP.
- **Open ↗** — one-click open per your *Open artifacts in* setting.
- **Caret dropdown** — pick a target for this one: Obsidian full screen, default browser, Chrome, Safari, Brave, or Firefox.

External opens write a temp HTML file and hand it to the OS shell (blob URLs and
`window.open` are unreliable in Obsidian's Electron renderer). Temp files from
earlier opens are swept on the next open, and only ones older than a minute are
removed so nothing races a browser that's still loading. Named browsers are
launched via `open -a` on macOS and fall back to your default if that browser
isn't installed.

To keep an artifact, save it as a note. It lands in your artifacts folder
(*Settings → Companion for Claude → Storage → Artifacts folder*) with YAML
frontmatter — title, tags, summary — so it indexes in search, the tag pane, and
Dataview like any other note. With *Auto-tag on save* enabled, tags are suggested
from your existing vault tags rather than invented.

Because the rendering is a Markdown processor, a saved artifact note is portable:
open it anywhere in the vault and it renders again.

## The design system

Artifacts don't come out looking generic because a design system is embedded in
every system prompt. It pins a specific palette and typography — ivory
background, slate headings, terracotta accent, serif headings over a sans body,
mono for small labels — plus per-template structure: a plan gets a goal box and a
milestone timeline, an audit leads with a verdict and a score, a dashboard is KPI
tiles plus small charts.

Charts are CSS bars or inline `<svg>`, no libraries, which keeps each artifact
self-contained and consistent with the CSP.

That aesthetic is an **original reformulation** of the look in Thariq Shihipar's
["unreasonable effectiveness of HTML"](https://github.com/ThariqS/html-effectiveness)
gallery — not a copy of his HTML. The gallery is vendored here only as a pinned,
unmodified submodule. Full attribution is in [`NOTICE`](../NOTICE).

## Settings reference

*Settings → Companion for Claude → Storage*

| Setting | Effect |
|---|---|
| Open artifacts in | Target for the one-click **Open ↗** button |
| Artifacts folder | Where saved artifact notes land |
| Inline artifact height | Rendered height of the inline frame |
| Templates folder | Notes here become your own slash commands — see [getting-started.md](getting-started.md#your-own-slash-commands) |

See also: [agent-mode.md](agent-mode.md) for Canvas and Bases output, which are
native Obsidian files rather than HTML artifacts.
