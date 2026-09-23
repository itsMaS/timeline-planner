# Timeline Planner — notes for Claude

## Git workflow

- **Always push to `main` after any changes.** Whatever branch work happens on,
  once a change is committed it must also be pushed to `main`
  (`git push origin HEAD:main`) so it deploys immediately.
- GitHub Pages serves the app from `main:/docs`. `npm run build` writes the
  single-file build into `docs/`, so always run the build and commit `docs/`
  together with source changes — otherwise the deployed app goes stale.

## Project layout

- Vite + React + TypeScript + zustand, no test suite. `npm run build` runs
  `tsc --noEmit` first, so it doubles as the typecheck.
- `src/model/` — data types, store (persistence/undo), layout solver, utils.
- `src/ui/` — components; `Canvas.tsx` holds all pointer interactions.
- Display settings live on each timeline (`Timeline.settings`, see the
  Timelines section); `Project.settings` only seeds new timelines. See
  `normalizeProject` in `src/model/normalize.ts` for migration of old saves.
  `normalize.ts` holds the pure helpers (`blankProject`, `emptyFilters`,
  `normalizeFilters`, `normalizeProject`) so the CLI and the Edge Function
  can import them without pulling in zustand; `store.ts` re-exports them.
- `ROADMAP.md` records what the fields system shipped, the decisions taken
  with the owner and what comes next. Update it when a listed item ships or a
  decision changes.

## Sharing / realtime (Supabase)

- Backend: Supabase project "Timeline Planner" (`qrkywsxdujxlognlthts`). Schema
  and RPCs live in `supabase/migrations/` (applied via the Supabase MCP; keep the
  SQL file in sync when changing them).
- Access model: no accounts. Each shared timeline has an **edit token** and a
  **view token**; links are `#/s/<token>`. Edit links add a persistent synced tab,
  view links open the lightweight read-only `Viewer`. Anonymous sign-in (silent)
  gives each browser an identity for Realtime authorization, presence and
  Storage uploads; without it the app degrades to polling.
- Sync model (`src/sync/share.ts`): every `mutate`/`tweak` is diffed into an
  entity patch (`src/model/patch.ts`), broadcast on private channel
  `timeline:<id>`, and folded into a debounced full-document save through
  `share_save_if` (version-checked: on `conflict` the tab pulls, replays its
  unsaved patches and saves again, so a stale tab never overwrites an API
  write or another polling tab). Undo history is patch-based so undo only
  reverts your own edits.
  Camera, filters, selection and active view never sync.
- Images on shared tabs go to the public `timeline-images` bucket; inline
  base64 is migrated on share.
- `ui.readOnly` (viewer) and a `view` share role block `mutate` in the store and
  drag/create handlers in `Canvas.tsx`. `useCanEdit()` exposes the same check to
  components: `Sidebar` and `Inspector` render read-only variants from it (the
  `Viewer` page mounts both), using per-user `filters` (never the shared doc)
  for anything a viewer toggles.
- Type folders nest via `TypeFolder.parentId`; helpers live in
  `src/model/folders.ts` and `repairFolders` runs on load/mutate/remote patch to
  cut cycles and dangling links.
- Three links per timeline: **edit**, **suggest** and **view**
  (`0003_suggest_and_history.sql`). `share_open`/`share_pull`/`history_list`
  accept any of them; `proposal_create`/`proposal_list` accept edit or suggest;
  everything that writes the document or decides proposals needs the edit token.

## External API (Unity plugin, scripts)

- `API.md` is the contract. `supabase/migrations/0004_api.sql` adds a fourth
  per-timeline token (`timelines.api_token`, null until the owner creates it in
  the Share dialog via `share_api_token` create / rotate / revoke; `share_open`
  returns it as `apiToken` to the owner only) and the `api_*` RPCs: `api_read`,
  `api_version`, `api_schema` (reads) and `api_set_field`, `api_set_tags`,
  `api_update_item`, `api_create_item` (writes). Writes patch one entity inside
  the stored doc, validate values like `src/model/fields.ts` does
  (`api_coerce`), bump `version`, append `timeline_history` rows with source
  `api`, and `realtime.send` the same `patch` message the app broadcasts.
- In-app reference: the `?` next to the API token row (and "What can it do?"
  before a token exists) opens `ApiHelpModal` (`src/ui/ApiHelp.tsx`, overlay
  `apihelp`), which renders capabilities, the call convention, a function
  table, recipes and copyable examples pre-filled with the real endpoint, key
  and the tab's token. Keep it in step with `API.md` when the surface changes.
- The token can create fields and change their settings (`api_create_field`,
  `api_update_field` in `0009_fields_schema_api.sql`; never a field's kind,
  children, parent or folder) but cannot touch types, levels, layers or
  timelines, delete, move items or manage links; keep it that way and grow the
  surface with new `api_*` functions rather than widening existing ones.
  Private helpers are `revoke execute`d from `anon`/`authenticated`.
- Rule evaluation and computed values need the app's TypeScript, so they live
  in the `api-query` Edge Function (`supabase/functions/api-query/src.ts`,
  bundled into `index.ts` by `npm run build:api`, deployed with
  `verify_jwt: false` because publishable keys are not JWTs). It calls
  `api_read` with the caller's token and evaluates through
  `src/api/compute.ts` (`prepare`, `queryItems`, `computeDoc`), which the
  agent CLI's `query` command shares. Rebuild and redeploy the bundle whenever
  `expr.ts`, `scope.ts`, `fields.ts`, `processors.ts` or `normalize.ts`
  change.
- The live project has anonymous sign-ins off, so tabs poll (every 4 s) and
  `realtime.messages` has no partitions; the API broadcast is a no-op there
  and the version-checked autosave is what keeps API writes safe.

## Timelines (subtabs)

- A project holds `Project.timelines` (`Timeline = {id, name, settings}`), a
  synced collection; items and sections carry `timelineId`. Fields, types,
  folders, layers, hierarchy levels, processors and views are shared by the
  project; sections, items, settings and the camera belong to a timeline.
  Helpers live in `src/model/timelines.ts`; `repairTimelines` runs with every
  other repair (load, mutate, undo, remote patch) and gives entities without a
  timeline the one on screen (mutate) or the first one.
- Migration is deterministic: an older document becomes one timeline
  `timeline-0` named "Main" carrying the old `Project.settings` (kept only as
  the seed for new timelines). `0008_timelines.sql` backfills stored documents
  the same way.
- Per-user, never synced: `activeTimelineId` and `cameras` (parked cameras of
  the other timelines; `Project.camera` is the active one's). `keepUserState`
  in the store carries them across remote replaces, drafts and suggest mode.
- **Reads are scoped, writes are whole.** `useActiveProject()` returns
  `timelineView(project)`: only the active timeline's items and sections, with
  its settings and camera (cached per project object, so selectors stay
  stable). Everything position based (canvas, layout, section nesting,
  processors, snapping, ripple, exports) works on that view. `mutate` recipes
  still get the whole project. Use `useActiveWhole()` (or `store.active()`) for
  anything that must see every timeline: references (`ownerOf` also falls
  back from a view to the whole project it was cut from), proposal conflicts,
  suggest diffs, Project JSON, field usage counts, tags.
- UI (`src/ui/Timelines.tsx`): the active project tab shows "› name ▾" once
  the project has two or more timelines; the menu switches, renames,
  reorders, duplicates (fresh ids, internal references remapped) and deletes
  (confirm lists cross-timeline references; undoable). The first extra
  timeline comes from the tab's context menu (right-click / long-press). The
  viewer gets a switch-only menu. Cross-timeline jumps (references, proposal
  rows, search hints under the filter box) switch the timeline and set
  `ui.jumpTo`; the canvas flies to the entity once it is on screen.
- Share links may end in `/<timelineId>` (`parseShareRoute`); the Share
  dialog has a toggle for it. Exports: PNG/SVG are the active timeline; CSV
  and the document PDF take an "All timelines" toggle (`exportCSV(..., true)`
  adds a Timeline column, `buildDocHTML(whole, sectionIds, timelineIds)` puts
  each timeline under its own H1). The API takes `timelineId`/`timelineName`
  on `api_create_item` and lists timelines in `api_schema`; the agent CLI's
  `outline` groups by timeline and `export` takes `--timeline`.
- In user-facing copy the shared document is a **project**; "timeline" means
  a subtab. Database tables, channels and RPC names keep their old names.

## Suggest mode and history

- Suggest mode = a **draft** (`store.drafts[projectId]`, persisted to
  localStorage). While a draft exists `useActiveProject()` returns it and
  `mutate`/`tweak`/`undo`/`redo`/`setCamera`/`renameProject` write to it instead
  of the document (own undo stack `d:<id>`). Remote patches rebase the draft
  (`rebaseDraft`). `diffToChanges(base, draft)` is the pending suggestion;
  `SuggestBar`/`SuggestModal` (`src/ui/Suggest.tsx`) send it via
  `submitSuggestion` and `resetDraft` keeps whatever was not sent. Suggest-link
  tabs are always in suggest mode (`enterSuggest` in `main.tsx`); edit tabs
  toggle it with the toolbar lightbulb. Use `useActiveBase()` when you need the
  saved document.
- History: every change that reaches the document goes through
  `syncHooks.onHistory` (entity-level, with before/after and a source such as
  `edit`, `undo`, `restore`, `proposal:<id>`), is coalesced in
  `src/sync/history.ts` and appended to `timeline_history` (edit token only,
  last 200 per entity). `HistorySection` (`src/ui/History.tsx`) in the
  Inspector lists it for items and sections with a diff and a restore button
  (which is a suggestion in suggest mode).

## Fields & processors

- Fields are project-global (`Project.fields`, kinds text / int / float / toggle / select / ref / group;
  toggles store a boolean, `parseToggle` reads yes/no-ish input, and `sum` over a
  toggle counts the ones switched on).
- **Expression language** (`src/model/expr.ts`): one tokenizer, parser and
  evaluator shared by rule filters (`Filters.rules`), processor conditions
  (`ProcessorDef.where`), derived formulas (`FieldDef.formula`), the API and
  the CLI. `compile` caches, `toText`/`quoteName`/`quoteValue` round-trip,
  `looseEqual` compares loosely (an unset toggle equals `no`).
  `src/model/scope.ts` resolves names for an entity (`entityScope`: attached
  fields case-insensitively, `Group.child`, built-ins, `$name` aliases;
  `matchesRule`, `evalOn`). `fields.ts` and `scope.ts` import each other on
  purpose; keep the calls at run time, never at module init.
- **Folders** are generic (`Folder`, `FolderKind = 'types' | 'fields' |
  'processors'`, `Project.fieldFolders` / `processorFolders`,
  `folderId` on fields and processors) with the helpers in
  `src/model/folders.ts` (`foldersOf`, `orderedMembers`, `groupedMembers`,
  `moveMember`, `dissolveFolder`). `SchemaTree` (`src/ui/SchemaTree.tsx`) is
  the sidebar tree for fields and processors: drag to reorder or file, eye
  for visibility, target to reveal.
- **Composites**: kind `group` with `children` ids and `parentId` on each
  child, `template` for the display text, `FieldAttachment.childDefaults`.
  `typeAttachments` / `levelAttachments` / `attachmentsFor` return the
  expanded list with a `group` on each entry, so children are attached
  through their root; `displayEntries` is what renders (canvas label,
  tooltip, exports) and `groupText` fills the template. `repairSchema` cuts
  cycles and dangling children.
- **Derived fields**: `isDerived(f)` when `formula` is non-empty; `readValue`
  (and `valueOn`) evaluates it on read with a cycle guard and coerces to the
  field's kind. They are never stored, read-only in the inspector, and
  refused by the API writes.
- **Visibility and badges**: `Filters.offFields` / `offProcessors` hide ids
  everywhere but the inspector (`isFieldShown` in `layout.ts`,
  `shownProcessorResults`); `FieldDef.badge` on a toggle draws ✓ / ✗ on the
  icon (`toggleBadges`, `ToggleBadges` in `Canvas.tsx`) and after section
  names, and drops the field from the label.
  Item types, type folders and hierarchy levels attach them via
  `FieldAttachment` (with an optional per-attachment default that overrides
  the field's default); items and sections store explicit values in
  `fieldValues`. Helpers, validation, reference lookups and `repairSchema`
  live in `src/model/fields.ts`.
- A type inherits the attachments of every folder above it
  (`TypeFolder.fields`): `typeAttachments()` resolves the full list (outermost
  folder first, nearest attachment wins on duplicates) and `attachmentsFor()`
  uses it for items, so anything that renders or validates item fields must go
  through those rather than `type.fields`. The API mirrors the walk in
  `api_field_attached` (`0006_folder_fields.sql`).
- `Project.hierarchyLevels` are objects (`HierarchyLevel`, id'd); old string
  arrays and per-type `{id,name}` fields are migrated in `normalizeProject`
  (deterministically, so shared docs migrate identically on every client).
- Processors (`Project.processors`, evaluated in `src/model/processors.ts`)
  are attached to hierarchy levels and aggregate items / nested sections whose
  start lies inside a section and satisfy the optional `where` rule. Results
  are computed on read, never stored; the document PDF and the CSV's second
  sections table include them.
  Empty `targets` = "All" (every entity that has the field, minus
  `ProcessorDef.exclude`), so types created later are included; a non-empty
  `targets` is "Only selected". `TargetPicker` in `SchemaEditors.tsx` shows
  All as every row ticked and is searchable.
- Reference pick mode, hover highlight and the confirm dialog run through
  `ui.pickRef`, `ui.highlightId` and `ui.confirm`; deletes of items/sections
  go through `requestDelete` (`src/ui/deletion.ts`) so referenced entries warn.
- Panel widths (`ui.sidebarW` / `ui.inspectorW`) persist per browser only.
- `FieldDef.showName` (default true) hides the field's name wherever a value is
  displayed (canvas label, tooltip, inspector, document export) — use
  `fieldLabel()` when rendering a name next to a value. Reference values render
  as a list of `RefEntry` rows (`src/ui/FieldInputs.tsx`), chips are only used
  for "Referenced by".

## Views, filters and exports

- `Project.activeViewId` survives filter changes: `viewDirty()`
  (`src/model/views.ts`) compares the live filters with the view, and the
  viewbar offers Update / Revert / Save as new view. Never reset
  `activeViewId` when tweaking filters. `Filters` also carry `rules` (the
  funnel expression, AND-ed on top, items only, hidden items hide),
  `offFields` and `offProcessors`; `filtersEqual` / `isUnfiltered` /
  `emptyFilters` must stay in step when a key is added. `RuleFilterButton`
  and `RuleEditor` (`src/ui/RuleFilter.tsx`) are the funnel popover and the
  rows ↔ text editor, reused by the processor and formula editors.
- Sidebar search boxes (`ListFilter` in `Sidebar.tsx`) filter their list in
  place; creating items stays on the canvas.
- New types go through `hideNewTypeInFilters()` so type-restricted views (and
  live filters) keep hiding them; the create-type-and-item path un-hides the
  type in the live filters afterwards.
- `ui.showTitles` / `ui.showFields` (per browser) drive canvas labels via
  `layoutTimeline(..., showFields, showTitles)` and `splitLabel`.
- `exportScope()` (`src/ui/exportScope.ts`) is the single rule for what an
  export contains (visible items, optionally only inside the selected
  sections); PNG, SVG, CSV and the document PDF all take it. Project JSON is
  always complete.

## Proposals (suggested changes) and the agent CLI

- A proposal is a list of entity-level changes with `before`/`after` snapshots
  (`src/model/proposal.ts`), stored in `timeline_proposals`
  (`supabase/migrations/0002_proposals.sql`, RPCs `proposal_*`). Edit tabs fetch
  them with every sync pull (`src/sync/proposals.ts`) and review them in
  Sidebar → Proposals (`src/ui/Proposals.tsx`): per-change word diff, conflict
  detection against the live doc, apply / reject buttons on every row plus
  checkboxes with "Apply selected"; every apply is one `mutate` (undoable,
  synced), decisions recorded server-side (`decideChanges`); decided proposals
  stay as history.
- While a proposal is open the canvas previews it: `previewProject()` applies
  its pending additions and updates (items, types, layers, fields) on top of the
  document, so `Canvas.tsx` lays out and draws `view` instead of `proj`. Added
  items get a green dashed ring, moved / resized ones a ghost of their current
  place, removed ones stay faded and struck through (removals are never applied
  to the preview); previewed items cannot be dragged. Selecting a previewed item
  or section shows the same diff with its own Apply / Reject in the Inspector
  (`ProposalChangeCard`, `usePendingChange`) and scrolls the review panel to
  that change; clicking a change in the panel selects and flies to its entity.
- `agent/timeline.ts` (`npx tsx agent/timeline.ts …`) is how an agent works on
  a shared timeline through its edit link: `read`, `outline`, `query`
  (`--where` rule, `--compute` for derived values and processor results,
  `--json`), `propose` (default), `apply` (direct save with version check
  via `share_save_if`), `status`, `withdraw`, `export` (the app's document
  export → PDF via the locally installed Chrome/Chromium/Edge, no npm
  dependency; `--where` filters like the funnel).
- **Parity rule**: whatever the app learns about the document (a new field
  kind, a new filter key, a new computed value) must reach the API
  (`API.md`, `ApiHelp.tsx`, migration or Edge Function) and the CLI
  (`agent/timeline.ts`, `SKILL.md`, bundle, version bump) in the same
  release.
- It ships as the `timeline-agent` plugin: `.claude-plugin/marketplace.json`
  makes this repo a Claude Code marketplace and `plugins/timeline-agent/` holds
  the skill plus `scripts/timeline.cjs`, a self-contained bundle regenerated by
  `npm run build:skill`. Rebuild and commit the bundle, and bump the version in
  `plugin.json` + `marketplace.json`, whenever the CLI or the skill changes.
  Users install with `/plugin marketplace add itsMaS/timeline-planner` then
  `/plugin install timeline-agent@timeline-planner`; `.claude/settings.json`
  enables it for sessions inside this repo.

## Working with the owner

- **Decisions must be clickable.** When brainstorming or presenting choices,
  always use the interactive question tool (AskUserQuestion) with a/b/c-style
  options, never a plain-text list. Split into several rounds if there are more
  than four decisions.
