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
