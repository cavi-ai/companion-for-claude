# Research Desk

## What it is

- One view per research project: the argument, how well it is backed, and what to do next.
- Every record is a Markdown note in your vault; the view reads and writes those notes.
- Open it with `/research` or the `Open research desk` command.
- External MCP clients can read and write the same records through the optional [MCP bridge](claude-code-bridge.md).

![Research Desk showing a project's suggested next steps, claim cards with their status, and document progress](../assets/research-desk.png)

## The page

- **Fix first** appears when records have broken references, unreadable notes, or unverifiable sources; each row opens the note.
- **Ask Claude** lists up to three suggested steps and a box for typed instructions.
- **Argument** shows one card per claim with its status, supporting and challenging counts, and passages.
- **Document** shows the outline or draft with sections drafted, sections changed, and buttons to open it or work on its sections.
- **Add sources** has Link or file, Search papers, and Pull passages.
- Unused passages, unread sources, and rejected claims sit in collapsed groups under the cards.

## Ask Claude

- Suggested steps come from the project's notes and need no model request to appear.
- Typed instructions and chat steps run in agent mode with the project attached.
- New evidence and claims arrive as proposed; you check them before they count.
- Draft steps preview a section and wait for Accept before writing to the document.

## Claim statuses

The first matching row applies.

| Status | Shows when |
|---|---|
| Rejected | The claim is rejected |
| Needs check | The claim is still proposed |
| Unsupported | No trusted evidence supports it |
| Thin | One trusted passage supports it |
| Challenged | Challenging evidence or a contradiction exists and no limitation is recorded |
| Changed since drafted | The claim or its evidence changed after its section was drafted |
| Drafted | Its section is drafted by a model and unedited since accept |
| Not drafted | It is in the outline and has no draft |
| Not in outline | An outline exists and the claim is not in it |
| Ready | No outline exists yet |

Audit and analysis findings appear as Fix first rows and as notes on the claim cards.

## Trusted evidence

- Only reviewed evidence with a locator and a current source fingerprint counts as trusted support.
- Proposed evidence stays visible and does not satisfy the audit.
- Review changes evidence records only and ends in `reviewed` or `rejected`.
- Evidence is stale when the source's current fingerprint differs from the one captured with it; the excerpt needs re-verifying.

## Documents

- Each section is a `##` heading named after its claim.
- A `claude-provenance` block at the end of the note records each section's claim, passages, and citations.
- The block renders as References in Reading view and Live Preview.
- Renaming a managed heading detaches that section until the heading is restored or the outline is rebuilt.
- Clean up format converts older notes to this layout.

## Claim-preserving revision

- Revisions carry the grounded section packet and an explicit intent.
- The model's response is validated before preview.
- You review the proposed result before it replaces the section.
- Unsupported citations, silent claim loss, stale grounding, and malformed responses are rejected instead of written.

## Search papers

- Searches OpenAlex, enriched with Crossref and arXiv metadata, ranked locally with an optional model rerank.
- Results import into the project as sources.
- Network requests fire only on explicit actions, and results cache locally.
- Enable it under Settings > Companion for Claude > Scholarly discovery; OpenAlex asks for a contact email.
- A Zotero user id, plus an API key for private libraries, resolves `zotero_key` imports to title, authors, date, publication, DOI, url, and abstract.
- A failed Zotero lookup still imports the key.

## See also

- [agent-mode.md](agent-mode.md): the research tools available to Claude in chat.
- [claude-code-bridge.md](claude-code-bridge.md): driving research records from Claude Code.
