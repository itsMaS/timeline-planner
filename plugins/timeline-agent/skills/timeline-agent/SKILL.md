---
name: timeline-agent
description: Work on a shared Timeline Planner project through its edit link - read it, query items with the app's rule language (and read computed values such as processor totals), propose reviewable changes (typo fixes, new items/types/sections/fields, restructuring), apply changes directly when asked, and export filtered PDF documents. Use whenever a prompt contains a timeline link (the `#/s/...` share URL), or asks to list/count/find things on a timeline, suggest/propose/apply changes to one, or export a timeline or part of it as a PDF.
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/scripts/timeline.cjs:*)
---

# Timeline agent

One self-contained CLI does everything (Node 18+, no install):

```bash
TL="node ${CLAUDE_SKILL_DIR}/scripts/timeline.cjs"
```

It talks to the same token-checked backend the app uses, so it can do exactly
what a person holding the edit link can - nothing more.

## The link

The user pastes a share link in the chat (`https://…/#/s/…`). Pass it to every
command as `--link "<the link>"`. If they haven't given one and
`$TIMELINE_LINK` isn't set, ask for it. An **edit link** allows everything; a
**suggest link** allows reading, proposing, `status` and `export` but not
`apply` or `withdraw` (the CLI says so); a **view link** only allows reading and
`export`. Never repeat the token back in your
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
$TL outline --in /tmp/tl.json                   # timelines → sections → items with ids, quick orientation
$TL query --in /tmp/tl.json --where "Implemented = no and [VFX Scope] >= 10" --compute
                                                # items matching a rule; --compute adds derived values and
                                                # processor results per section (never stored in the doc)
cp /tmp/tl.json /tmp/tl-edited.json             # edit the "doc" object in the copy
$TL propose --link "$LINK" --base /tmp/tl.json --edited /tmp/tl-edited.json \
  --title "Fix typos in descriptions" --summary "12 spelling fixes, no wording changes" \
  --notes /tmp/notes.json                       # optional {entityId: "one-line reason"}
```

Rules for editing `doc`:

- A project holds one or more **timelines** (subtabs sharing the schema):
  `doc.timelines = [{id, name, settings}]`. Every item and section carries
  `timelineId`; positions on different timelines are unrelated, and a section
  only contains items of its own timeline. `outline` shows one block per
  timeline. Put new entries on the timeline the user means (by name in the
  outline); an entry without `timelineId` lands on the first timeline. Don't
  add, rename or delete timelines unless asked; the per-timeline `settings`
  (unit, grid, spine) live on each timeline, and the top-level `settings` is
  only the legacy copy.
- Keep entity ids. A proposal is diffed per entity (items, types, typeFolders,
  layers, timelines, sections, views, hierarchyLevels, fields, processors) plus
  the scalars `name` and `settings`. Changing an id looks like remove + add.
- New entities need a fresh id: any short random string (e.g. 12 chars of
  `[a-z0-9]`). Fill every field. An item is `{id, typeId, timelineId, layerId: null,
  pos, duration: 0, title, description: '', tags: [], link: '',
  images: [], fieldValues: {}}`; a type is `{id, name, icon, color, defaultLayerId,
  fields: [{fieldId, defaultValue: null}], folderId: null}` (a type also
  inherits the `fields` of its folder and every folder above it); a
  section is `{id, name, timelineId, depth, start, end, description: '', fieldValues: {}}`
  where `depth` indexes `hierarchyLevels` (`{id, name, fields, processors}`).
- Fields are global: `doc.fields` holds
  `{id, name, kind: 'text'|'int'|'float'|'toggle'|'select'|'ref'|'group', help, required,
  defaultValue, options, min, max, …, folderId, badge, children, template, parentId, formula}`.
  A select field lists its `options`; `fieldValues` are strings, numbers,
  booleans, arrays of chosen options or arrays of referenced ids by kind.
  A `group` field is a **composite**: `children` lists the ids of the fields
  inside it (each with `parentId` set back), it is attached to types as one
  unit, and only the children carry values. A non-empty `formula` makes a
  field **derived** (read-only, computed on read in the same expression
  language as `query`; never write a value for it). `folderId` files a field
  under `doc.fieldFolders` (`{id, name, color, icon, collapsed, parentId}`);
  processors have `doc.processorFolders` and an optional `where` rule that
  restricts what they aggregate. `outline` prints fields with their folder,
  composite children indented, and formulas.
- `pos`/`start`/`end` are in the timeline's world units (its `settings.unit`).
  Put new items inside the section they belong to (`section.start ≤ pos ≤ end`,
  same `timelineId`).
- Descriptions and field values are minimal markdown (paragraphs, `**bold**`,
  `- lists`, `[links](url)`). Icons are Lucide icon names (`Coins`, `Skull`…).
- Don't touch `camera`, `cameras`, `filters`, `activeViewId`, `activeTimelineId` - per-user, ignored.
- Collection order is not part of a proposal; reordering needs `apply`.
- One proposal per task, with a clear title and a summary saying what and why.
  Add a per-entity note in `--notes` when the reason isn't obvious from the diff
  (e.g. `"abc123": "recieve → receive"`).

After proposing, tell the user the proposal title, how many changes it holds
and a short list of what they are, and that it is waiting under
Sidebar → Proposals in the app. `status --link "$LINK"` shows open proposals
(with `--all`, decided ones too); `withdraw <id>` deletes one of yours.

## Query

`query --where "<expr>"` answers "which items …" questions without you
scanning the JSON, using the app's own rule language (the same as its funnel
filter, processor conditions and derived formulas):

- Names are the item's fields (case-insensitive, `[brackets]` when they have
  spaces; a composite child also as `Group.child`) or built-ins: `title`,
  `type`, `tags`, `layer`, `pos`, `duration`, `end`, `description`, `link`,
  `section`, `sections`, `timeline`. A bare word that names nothing is text,
  so `Status = blocked` needs no quotes.
- Operators: `and`, `or`, `not`, `= != < <= > >=`, `contains`, `has`,
  `one of (a, b)`, `is set` / `is empty`, `+ - * / %`; functions `if`, `min`,
  `max`, `abs`, `round`, `floor`, `ceil`, `len`, `sum`, `avg`, `coalesce`,
  `lower`, `upper`.
- `--timeline a,b` limits the search; `--compute` also prints every derived
  field value and every processor result per section (text and the matched
  ids), which the document itself never contains; `--json` prints
  `{version, matches, computed?}` for further processing.

```bash
$TL query --link "$LINK" --where "type = Checkpoint and Implemented = no"
$TL query --in /tmp/tl.json --where "tags has boss or Stage one of (Blocked, Review)" --compute --json
```

## Export

The app's own document export (sections as headings, items as sub-headings with
description, fields, tags, link, images), printed to PDF by the Chrome, Chromium
or Edge already installed on the machine (found automatically; `CHROMIUM_PATH`
overrides):

```bash
$TL export --link "$LINK" --out /tmp/chapter1-coins-enemies.pdf --sections "Chapter 1" --types "Coin,Enemy"
```

Filters mirror the app's: `--timeline` (names or ids; default every timeline,
each under its own heading), `--sections` (names or ids; only those sub-trees,
all on one timeline), `--types` and `--layers` (only those; others hidden),
`--tags` (any of), `--text` (substring in title/description/tags), `--where`
(a rule expression, as in `query`). Names match case-insensitively, then by
substring - run `outline` first to learn the exact names. `--html file.html`
also keeps the HTML. Then hand the PDF to the user (send the file).

## Reference

- Data model: `src/model/types.ts` in the timeline-planner repo; proposal format
  and diff in `src/model/proposal.ts`.
- `scripts/timeline.cjs` is generated from `agent/timeline.ts` there with
  `npm run build:skill` - never edit the bundle by hand.
