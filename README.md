# Timeline Planner

A single-line, zoomable timeline editor for planning linear experiences — games,
films, courses, project plans. Built for planning a linear game (every story
beat, death opportunity and mechanic on one line), but nothing in it is
game-specific.

The full design rationale lives in [DESIGN.md](DESIGN.md).

## Running it

```bash
npm install
npm run dev       # local dev server
npm run build     # produces docs/index.html — one self-contained file
```

The build is a **single HTML file** (`docs/index.html`). Host it anywhere
static, or just open it from disk. All data autosaves to the browser's
localStorage; use *Export → Project JSON* for durable, git-committable saves.

### GitHub Pages

The site is served from the `main` branch's `docs/` folder
(repo Settings → Pages → *Deploy from a branch* → `main` / `/docs`):
**https://itsmas.github.io/timeline-planner/**

To ship an update: `npm run build`, commit the regenerated
`docs/index.html`, push to `main`.

## What it does

- **One horizontal spine** — scroll to pan, wheel/pinch to zoom toward the
  cursor. The axis is an abstract sequence, not clock time.
- **Items** — points or spans (drag the edge handles). Created by dragging a
  type from the sidebar onto the line, double-clicking the line, or `N`.
- **Types** — user-defined, each with a vector icon (Lucide library, searchable
  picker), a color, a default layer, and optional custom fields (e.g. a
  "How the player dies" field on *Death opportunity*). Types can be filed into
  sidebar folders, and folders nest inside each other (drag a type or a folder
  onto a folder to file it); hide/solo on a folder applies to everything inside.
- **Layers** — an ordered significance list. What's visible at each zoom is
  decided automatically by density (the *detail* dial in the toolbar); each
  layer also has hide-always (eye) and show-always (pin) overrides. Items that
  lose the space competition collapse into `+n` cluster pills — hover to peek,
  click to zoom in.
- **Sections** — a nestable hierarchy with project-defined level names
  (Chapter → Level → Section by default), drawn as subtle full-height bands
  with a header rail; the breadcrumb (bottom-left) tracks where you are.
- **Branches** — drag with the branch tool (`B`) to fork the line. `ANY`
  branches (pick one path, dashed) vs `ALL` branches (complete every path in
  any order, solid + checkboxes). Paths can be labeled, reordered, marked as
  dead ends, and hold their own items.
- **Filters & views** — toggle types (Alt-click to solo), layers, tags; live
  text filter (`/`). Filtered-out items ghost at 15% (or hide entirely). Any
  filter combination can be saved as a named view, switched with `1`–`9`.
- **Feel** — springy micro-animations, particle bursts on create/delete/snap,
  optional synthesized sound (off by default), automatic
  `prefers-reduced-motion` support, dark and light themes.
- **Data** — multiple timelines as tabs, continuous autosave + periodic
  rollback snapshots, JSON import/export, PNG export of the current view, SVG
  export of the whole timeline, CSV of all items. Everything is undoable
  (`Ctrl+Z`).
- **Document export (PDF)** — *Export → Document PDF* renders the timeline as
  a printable outline: sections become headings (outermost level H1, next H2,
  …), items are sub-headings one level below their section with the type's
  icon and name beside the title, and descriptions, custom fields, tags, links
  and images follow as body text — readable by people and AI agents alike.
  Only items currently visible on the canvas are included (filtered-out and
  hidden-layer items are skipped, so a saved view doubles as an export
  preset). It opens in a new tab with the print dialog up; pick *Save as PDF*. With a
  section selected (or via the section inspector's document button) only that
  section and everything inside it is exported, starting at H1.

Press `?` in the app for the full shortcut list.

## File format (schema v1)

`Export → Project JSON` writes one self-describing document. All references are
by stable random ids; positions are floats on an unbounded abstract axis.

```jsonc
{
  "schemaVersion": 1,
  "id": "…", "name": "Linear game",
  "hierarchyLevels": ["Chapter", "Level", "Section"],   // section depth names
  "types":    [{ "id": "…", "name": "Death opportunity", "icon": "Skull",
                 "color": "#ef4444", "defaultLayerId": "…",
                 "folderId": null,       // sidebar folder, null = top level
                 "fields": [{ "id": "…", "name": "How the player dies" }] }],
  "typeFolders": [{ "id": "…", "name": "Story", "icon": "Folder", "color": "#f59e0b",
                    "collapsed": false,
                    "parentId": null }],  // folders nest: id of the parent folder
  "layers":   [{ "id": "…", "name": "Critical", "eye": false, "pin": false }],
                 // array order = significance, index 0 = most significant
  "sections": [{ "id": "…", "name": "Chapter 1", "depth": 0,
                 "start": 0, "end": 25 }],
  "branches": [{ "id": "…", "mode": "any" /* or "all" */,
                 "forkPos": 27, "joinPos": 36,
                 "paths": [{ "id": "…", "label": "Stealth route",
                             "terminal": false }] }],
  "items":    [{ "id": "…", "typeId": "…",
                 "layerId": null,        // null → type's default layer
                 "pathId": null,         // null → main line, else a branch path id
                 "pos": 5, "duration": 4, // duration 0 = point event
                 "title": "…", "description": "markdown…",
                 "tags": ["…"], "link": "https://…",
                 "images": ["data:image/…"],
                 "fieldValues": { "<fieldId>": "…" } }],
  "views":    [{ "id": "…", "name": "Story beats",
                 "filters": { "offTypes": ["…"], "offLayers": [],
                              "tags": [], "text": "" } }],
  "camera":   { "x": 0, "s": 14 },       // world-at-left-edge, px per unit
  "filters":  { "offTypes": [], "offLayers": [], "tags": [], "text": "" },
  "activeViewId": null
}
```

Consumers (e.g. a game build step) can safely ignore `camera`, `filters`,
`activeViewId` and `views` — they are editor state.

## Tech

Vite + React + TypeScript. SVG scene with a canvas overlay for particles;
Zustand store where every change goes through a single mutate action (which is
what powers undo/redo, autosave snapshots, and keeps the door open for a
CRDT-backed realtime mode later).
