---
name: timeline-agent
description: Work on a shared Timeline Planner project through its edit link — read it, propose reviewable changes (typo fixes, new items/types/sections, restructuring), apply changes directly when asked, and export filtered PDF documents. Use whenever a prompt mentions a timeline link, `#/s/<token>`, proposing/suggesting changes to a timeline, or exporting parts of a timeline as PDF.
---

# Timeline agent

Everything goes through one CLI. It talks to the same token-checked Supabase
RPCs the app uses, so it can do exactly what a person with the edit link can —
nothing more. Two ways to run it; pick whichever is available and use it as
`$TL` in the commands below:

- **Standalone** (this skill installed anywhere, e.g. `~/.claude/skills/`):
  `TL="node <this skill's folder>/scripts/timeline.cjs"` — a self-contained
  bundle, only Node 20+ needed. For `export`, run `npm install` once inside
  `scripts/` (installs `playwright-core`) and have a Chromium available.
- **Inside the timeline-planner repo**: `TL="npx tsx agent/timeline.ts"` from
  the repo root (run `npm ci` first if `node_modules` is missing).

The edit link is `https://…/#/s/<token>`. Pass it as `--link "<url>"` or set
`TIMELINE_LINK`. Never paste the token into commit messages, proposals or notes.

## Modes

- **Propose (default).** Changes go to a *proposal* the owner reviews in the app
  (Sidebar → Proposals: per-change diff, checkboxes, Apply selected). Use this
  unless the prompt clearly says to apply directly ("just do it", "apply
  directly", "no review").
- **Apply.** `apply` saves the edited document immediately. It refuses if the
  timeline changed since you read it; re-read and redo instead of `--force`
  unless the user explicitly accepts overwriting.

## Workflow for edits

```bash
$TL read --out /tmp/tl.json        # {version, timelineId, name, doc}
$TL outline --in /tmp/tl.json      # sections → items with ids, quick orientation
cp /tmp/tl.json /tmp/tl-edited.json   # edit the "doc" object in the copy
$TL propose --base /tmp/tl.json --edited /tmp/tl-edited.json \
  --title "Fix typos in descriptions" --summary "12 spelling fixes, no wording changes" \
  --notes /tmp/notes.json          # optional {entityId: "one-line reason"}
```

Rules for editing the document (`doc`):

- Keep entity ids. A proposal is diffed per entity (items, types, typeFolders,
  layers, sections, branches, views) plus the scalars `name`, `hierarchyLevels`,
  `settings`. Changing an id looks like remove + add.
- New entities need a fresh id: any short random string (e.g. 12 chars of
  `[a-z0-9]`). Fill every field of the type (see `src/model/types.ts`):
  an item is `{id, typeId, layerId: null, pathId: null, pos, duration: 0, title,
  description: '', tags: [], link: '', images: [], fieldValues: {}}`.
- `pos`/`start`/`end` are in the project's world units (see `settings.unit`).
  Put new items inside the section they belong to (`section.start ≤ pos ≤ end`).
- Descriptions and field values are minimal markdown (paragraphs, `**bold**`,
  `- lists`, `[links](url)`).
- Don't touch `camera`, `filters`, `activeViewId` — they are per-user and ignored.
- Collection order is not part of a proposal; reordering layers/types needs
  `apply`.
- One proposal per task, with a clear title and a summary saying what and why.
  Put a short note per entity in `--notes` when the reason isn't obvious from
  the diff (e.g. `"abc123": "recieve → receive"`).
- After proposing, report the proposal id and the change list to the user and
  tell them to open the project → Sidebar → Proposals.

`status` lists open proposals (with `--all`, decided ones too) so you can see
what the owner applied or rejected; `withdraw <id>` deletes one of yours.

## Export

The app's own document export (sections as headings, items as sub-headings with
description, fields, tags, link, images), printed to PDF by headless Chromium:

```bash
$TL export --out /tmp/chapter1-coins-enemies.pdf --sections "Chapter 1" --types "Coin,Enemy"
```

Filters mirror the app's: `--sections` (names or ids; only those sub-trees),
`--types`, `--layers` (only those, others hidden), `--tags` (any of), `--text`
(substring in title/description/tags). Names match case-insensitively, then by
substring. Use `outline` first to learn the exact names. Add `--html file.html`
to also keep the HTML. Send the PDF to the user with the file tool when done.

Chromium lookup order: `CHROMIUM_PATH`, playwright-core's own browser (install
with `npx playwright-core install chromium` next to the script), then common
system paths. On a desktop, pointing `CHROMIUM_PATH` at the installed Chrome or
Edge binary is the quickest (macOS: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`;
Windows: `C:\Program Files\Google\Chrome\Application\chrome.exe`). In Claude
Code on the web it is `/opt/pw-browsers/chromium`.

## Maintenance

`scripts/timeline.cjs` is generated from `agent/timeline.ts` by `npm run build:skill`
in the repo. Rebuild and commit it whenever the CLI or the modules it imports
change; never edit the bundle by hand.

## Reference

- Data model: `src/model/types.ts`. Proposal format and diff: `src/model/proposal.ts`.
- RPCs: `supabase/migrations/0001_timeline_sharing.sql` (`share_open`,
  `share_save`), `0002_proposals.sql` (`proposal_*`, `share_save_if`).
