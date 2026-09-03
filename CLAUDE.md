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
  drag/create handlers in `Canvas.tsx`.
