# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Git workflow — push to main

- **All completed work is pushed directly to `main`.** Do not leave finished
  changes only on a side branch; a change is not delivered until it is on
  `main`.
- Before starting work, `git fetch origin main` and base your work on
  `origin/main` — the owner also develops locally and pushes to `main`
  frequently, so an assigned branch may be far behind. Never clobber newer
  work on `main` with an older base; rebase or re-apply onto the current
  `main` instead.
- Never force-push `main`.

## Build & deploy

- The app is deployed via GitHub Pages from `main:/docs`. `npm run build`
  writes the single-file bundle to `docs/index.html` — always rebuild and
  commit `docs/` together with source changes, otherwise the live site goes
  stale.
- The build wipes `docs/`; make sure `docs/.nojekyll` survives (it is kept via
  the build setup — verify it still exists after building).
- Verify before pushing: `npx tsc --noEmit` and `npm run build` must both
  pass.

## Project notes

- Vite + React + TypeScript + zustand. All state lives in
  `src/model/store.ts`; the timeline scene is `src/ui/Canvas.tsx`; the layout
  engine is `src/model/layout.ts`.
- Section depths are derived from geometric containment
  (`refreshSectionDepths`, called automatically inside `store.mutate`) — never
  set `Section.depth` by hand.
- Projects persist to `localStorage`; there is no backend.
