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
  `timeline:<id>`, and folded into a debounced full-document `share_save`.
  Undo history is patch-based so undo only reverts your own edits.
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

## Fields & processors

- Fields are project-global (`Project.fields`, kinds text / int / float / ref).
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
