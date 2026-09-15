---
name: timeline-agent
description: Work on a shared Timeline Planner project through its edit link — read it, propose reviewable changes (typo fixes, new items/types/sections, restructuring), apply changes directly when asked, and export filtered PDF documents. Use whenever a prompt contains a timeline link (the `#/s/...` share URL), or asks to suggest/propose/apply changes to a timeline, or to export a timeline or part of it as a PDF.
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/scripts/timeline.cjs:*)
---

# Timeline agent

One self-contained CLI does everything (Node 18+, no install):

```bash
TL="node ${CLAUDE_SKILL_DIR}/scripts/timeline.cjs"
```

It talks to the same token-checked backend the app uses, so it can do exactly
what a person holding the edit link can — nothing more.

## The link

The user pastes their edit link in the chat (`https://…/#/s/<token>`). Pass it
to every command as `--link "<the link>"`. If they haven't given one and
`$TIMELINE_LINK` isn't set, ask for it. Never repeat the token back in your
replies, proposal titles/summaries/notes, file names or commits.

## Modes

- **Propose (default).** Changes go to a *proposal* the user reviews in the app
  (Sidebar → Proposals: per-change diff, checkboxes, Apply selected). Use this
  unless the prompt clearly says to apply directly ("just do it", "apply
  directly", "no review needed").
- **Apply.** `apply` saves immediately. It refuses when the timeline changed
  since you read it; then re-read and redo the edit rather than `--force`,
  unless the user explicitly accepts overwriting.

## Editing workflow

```bash
$TL read --link "$LINK" --out /tmp/tl.json      # {version, timelineId, name, doc}
$TL outline --in /tmp/tl.json                   # sections → items with ids, quick orientation
cp /tmp/tl.json /tmp/tl-edited.json             # edit the "doc" object in the copy
$TL propose --link "$LINK" --base /tmp/tl.json --edited /tmp/tl-edited.json \
  --title "Fix typos in descriptions" --summary "12 spelling fixes, no wording changes" \
  --notes /tmp/notes.json                       # optional {entityId: "one-line reason"}
```

Rules for editing `doc`:

- Keep entity ids. A proposal is diffed per entity (items, types, typeFolders,
  layers, sections, branches, views, hierarchyLevels, fields, processors) plus
  the scalars `name` and `settings`. Changing an id looks like remove + add.
- New entities need a fresh id: any short random string (e.g. 12 chars of
  `[a-z0-9]`). Fill every field. An item is `{id, typeId, layerId: null,
  pathId: null, pos, duration: 0, title, description: '', tags: [], link: '',
  images: [], fieldValues: {}}`; a type is `{id, name, icon, color, defaultLayerId,
  fields: [{fieldId, defaultValue: null}], folderId: null}` (fields are global:
  `doc.fields` holds `{id, name, kind: 'text'|'int'|'float'|'ref', …}` and
  `fieldValues` are strings, numbers or arrays of referenced ids by kind); a
  section is `{id, name, depth, start, end, description: '', fieldValues: {}}`
  where `depth` indexes `hierarchyLevels` (`{id, name, fields, processors}`).
- `pos`/`start`/`end` are in the project's world units (`settings.unit`). Put new
  items inside the section they belong to (`section.start ≤ pos ≤ end`).
- Descriptions and field values are minimal markdown (paragraphs, `**bold**`,
  `- lists`, `[links](url)`). Icons are Lucide icon names (`Coins`, `Skull`…).
- Don't touch `camera`, `filters`, `activeViewId` — per-user, ignored.
- Collection order is not part of a proposal; reordering needs `apply`.
- One proposal per task, with a clear title and a summary saying what and why.
  Add a per-entity note in `--notes` when the reason isn't obvious from the diff
  (e.g. `"abc123": "recieve → receive"`).

After proposing, tell the user the proposal title, how many changes it holds
and a short list of what they are, and that it is waiting under
Sidebar → Proposals in the app. `status --link "$LINK"` shows open proposals
(with `--all`, decided ones too); `withdraw <id>` deletes one of yours.

## Export

The app's own document export (sections as headings, items as sub-headings with
description, fields, tags, link, images), printed to PDF by the Chrome, Chromium
or Edge already installed on the machine (found automatically; `CHROMIUM_PATH`
overrides):

```bash
$TL export --link "$LINK" --out /tmp/chapter1-coins-enemies.pdf --sections "Chapter 1" --types "Coin,Enemy"
```

Filters mirror the app's: `--sections` (names or ids; only those sub-trees),
`--types` and `--layers` (only those; others hidden), `--tags` (any of),
`--text` (substring in title/description/tags). Names match case-insensitively,
then by substring — run `outline` first to learn the exact names. `--html
file.html` also keeps the HTML. Then hand the PDF to the user (send the file).

## Reference

- Data model: `src/model/types.ts` in the timeline-planner repo; proposal format
  and diff in `src/model/proposal.ts`.
- `scripts/timeline.cjs` is generated from `agent/timeline.ts` there with
  `npm run build:skill` — never edit the bundle by hand.
