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
- Per-project display settings live on `Project.settings` (see
  `normalizeProject` in `src/model/store.ts` for migration of old saves).

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
- The token cannot touch the schema, delete, move items or manage links; keep
  it that way and grow the surface with new `api_*` functions rather than
  widening existing ones. Private helpers are `revoke execute`d from
  `anon`/`authenticated`.
- The live project has anonymous sign-ins off, so tabs poll (every 4 s) and
  `realtime.messages` has no partitions; the API broadcast is a no-op there
  and the version-checked autosave is what keeps API writes safe.

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

- Fields are project-global (`Project.fields`, kinds text / int / float / select / ref).
  Item types and hierarchy levels attach them via `FieldAttachment` (with an
  optional per-attachment default that overrides the field's default); items
  and sections store explicit values in `fieldValues`. Helpers, validation,
  reference lookups and `repairSchema` live in `src/model/fields.ts`.
- `Project.hierarchyLevels` are objects (`HierarchyLevel`, id'd); old string
  arrays and per-type `{id,name}` fields are migrated in `normalizeProject`
  (deterministically, so shared docs migrate identically on every client).
- Processors (`Project.processors`, evaluated in `src/model/processors.ts`)
  are attached to hierarchy levels and aggregate items / nested sections whose
  start lies inside a section. Results are computed on read, never stored.
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
  `activeViewId` when tweaking filters.
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
  a shared timeline through its edit link: `read`, `outline`, `propose`
  (default), `apply` (direct save with version check via `share_save_if`),
  `status`, `withdraw`, `export` (the app's document export → PDF via the
  locally installed Chrome/Chromium/Edge, no npm dependency).
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
