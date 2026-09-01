# Timeline Planner — Design Specification

A general-purpose, single-line timeline editor for planning linear experiences
(games, films, courses, projects). Primary driving use case: planning a linear
~4-hour game — every story beat, death opportunity, mechanic introduction and
pacing element on one zoomable line — but nothing in the tool is locked to that
case.

This spec is the outcome of a 100-question design interview (2026-09-01).
Decisions below are numbered Q1–Q100 and grouped by theme.

---

## 1. Time model & structure

- **Q1 — Axis semantics: abstract sequence.** The horizontal axis is an ordered
  sequence, not clock time. Positions are relative ("this happens after that,
  roughly this far along"), with no timestamps. Internally positions are
  floats on an unbounded axis.
- **Q2 — Snapping: on by default, toggleable.** Items snap to a
  zoom-dependent grid; holding `Alt` places freely. A toolbar toggle disables
  snapping globally.
- **Q3 — Length: grows automatically.** The timeline extends whenever content
  is placed beyond the current end. No fixed duration setting.
- **Q4 + Q5 — Structure: nestable section hierarchy (first-class) AND item
  spans.** Two complementary systems:
  - **Sections** are first-class, *nestable* structural containers. The
    project defines its own hierarchy level names (e.g. Chapter → Level →
    Section; a film might use Act → Sequence → Scene). Arbitrary depth,
    configurable per project. Sections render as stacked tinted bands and
    power navigation (breadcrumbs, jump-to, per-section counts).
  - **Items** may additionally have their own duration spans (see Q6).
- **Q73 — Section rendering: stacked tinted bands.** Nested translucent bands
  behind the spine — outermost level widest, each deeper level nested inside;
  names on the band edge; deeper levels appear progressively as you zoom in.
- **Q74 — Section color: auto palette.** Bands are auto-colored from a
  tasteful rotation; no per-section color config.
- **Q75 — No ruler.** Bands, breadcrumbs and the minimap-free navigation carry
  orientation (axis is abstract, so a numeric ruler adds nothing).
- **Q76 — No playhead/position marker.**

## 2. Items

- **Q6 — One item kind, duration ≥ 0.** Every item is a point until its edge
  is dragged out into a span.
- **Q7 — Item fields (all of):** title, description, free-form tags, external
  link (URL), plus **custom fields defined per ItemType** (e.g. Death
  opportunity → "How the player dies").
- **Q8 — Overlap layout: auto-stack vertically.** Items near the same position
  fan out above/below the spine automatically with connector stems.
- **Q56 — Description format: Markdown**, rendered in tooltip and inspector.
- **Q79 — Images: paste/drop into the description**, shown in tooltip and
  inspector (stored in the project data).
- **Q78 — No status field.** This is a design map, not a task tracker; tags
  cover ad-hoc workflow needs.
- **Q80 — No separate notes areas.** Item/section descriptions suffice.
- **Q77 — No item→item dependency links in v1** (branches + spans cover
  structure).

## 3. Item types

- **Q9 — Global per-project ItemTypes.** A type defines name, icon, color,
  default layer, and custom fields. Editing a type updates all its items.
- **Q10 — One type per item + free-form tags** for cross-cutting concerns.
- **Q11 — Type sets the default layer; per-item override allowed.**
- **Q12 — Type management lives in a collapsible left sidebar** that doubles
  as the legend and filter panel (icon + color + live count per type).

## 4. Icons & color

- **Q13 — Icon library: Lucide** (~1500 MIT-licensed stroke icons; clean,
  consistent, tint perfectly — vector, no emojis).
- **Q14 — Icon picker: search + browsable categories**, recently used pinned.
- **Q15 — Color: curated ~16-swatch palette + full custom picker** behind a
  "custom" affordance. Palette tuned to read well in both themes.
- **Q16 — Color applies everywhere (all of):** node + icon tint, duration
  bars, selection glow + click particles, and subtle label text tint.

## 5. Layers & level-of-detail (LOD)

- **Q17 — Layers: ordered, user-defined list per project** (e.g. Critical /
  Major / Minor / Detail). Order = significance.
- **Q18 + Q21 — Visibility: automatic by density, with optional per-layer
  override.** By default the engine shows as many layers as fit without
  clutter at the current zoom (significance order decides who wins). A layer
  can opt into an explicit "visible from zoom X" rule when manual control is
  wanted.
- **Q86 — Density control: one global "detail" dial** in the toolbar
  (sparse ↔ dense) scaling how eagerly items appear; per-layer overrides
  tucked into layer settings.
- **Q19 — Threshold transition: fade + scale away** (~200 ms toward the
  spine), reversed on zoom-in.
- **Q87 — Flicker prevention: hysteresis gap** (appear at zoom X, disappear
  below X − gap).
- **Q20 — Per-layer eye (always hide) and pin (always show) overrides.**
- **Q22 — Vertical mapping: one spine, smart offsets.** No fixed lanes:
  higher-significance items sit nearer the line, lower ones fan further out.
- **Q23 — Layer changed via dropdown in the item inspector.**
- **Q24 — New items land on their type's default layer.**
- **Q41 — Fully zoomed out: section bands + top-layer items only**, rest
  summarized as density.
- **Q42 — Crowded labels: icon-only first**, labels hide before icons;
  hover reveals the title instantly.
- **Q43 — Clustering: merged count pills with BOTH behaviors** — hover fans
  the cluster out for a peek; click zooms into it.
- **Q44 — LOD entry/exit animation: scale + fade with spring overshoot,
  slightly staggered by position.**
- **Q88 — Zoom state indicator: the section breadcrumb** (e.g.
  "Chapter 2 › Level 1") plus a subtle "showing N of M items". No zoom %.

## 6. Branching

- **Q25 — ANY vs ALL distinguished by gate glyph AND line style.**
  Fork nodes carry a glyph (diverging arrows = ANY "pick one path";
  layered/AND glyph = ALL "complete every path, any order") and the line
  styles differ (ANY dashed, ALL solid) so the distinction reads at any zoom.
- **Q90 — ALL branches additionally use a checkbox motif:** each required
  path gets a small hollow-check glyph at its start; the join node reads
  "n paths converge".
- **Q26 — Unlimited nesting** (paths can fork again).
- **Q27 — Paths normally reconnect, but may be marked terminal**
  (dead-end/game-over) with an end-cap glyph.
- **Q28 — Layout: automatic vertical spacing, drag-to-reorder paths.**
- **Q29 — Paths are sequentially independent.** Each path has its own
  internal sequence; X positions across parallel paths are not comparable.
- **Q30 — Optional label per path** (e.g. "Stealth route"); blank allowed.
- **Q31 — Full feature parity on paths:** points, spans, and section bands
  can all live on a branch path.
- **Q32 — Creation: drag off the line** (pull a path out of the spine, drag
  its end back onto the line to rejoin).
- **Q91 — Editing: drag fork/join endpoint handles** along the spine; path
  items shift proportionally.
- **Q92 — Up to 4 parallel paths per fork.**
- **Q89 — Branch LOD: fork→join regions collapse into a single "braid" glyph
  with a path-count badge at low zoom**, expanding as you zoom in.

## 7. Filtering, views & search

- **Q33 — Filter axes (all of): type, layer, tags, text search.**
- **Q82 — Combination logic: AND across groups, OR within a group.**
- **Q35 — Filtered-out items: ghosted (~15%) by default, one toggle hides
  them fully.**
- **Q34 — Saved Views capture filters only** (named presets like
  "Story beats"); the camera stays where it is on switch.
- **Q36 — View switching: tab chips in the top bar + hotkeys 1–9**, with an
  animated transition.
- **Q81 — Search: filter-as-you-type.** Typing in the search box live-dims
  non-matching items directly on the canvas; `Esc` clears.
- **Q40 — Jump aids (all of): fit-all button, clickable section breadcrumbs,
  search-result jump, camera back/forward history.**
- **Q83 — Solo: Alt-click a type row to isolate it** (DAW-style); Alt-click
  again restores.
- **Q84 — Counts shown per type/layer row in the sidebar**, respecting
  active filters.

## 8. Navigation & camera

- **Q37 — Wheel/pinch zoom toward cursor + drag-pan on empty space**;
  trackpad two-finger pan supported.
- **Q38 — No minimap.**
- **Q39 — Zoom range: fit-all ↔ one item comfortably filling the screen.**
- **Q85 — Continuous (analog) zoom**, no steps or detents.
- **Q61 — Jump camera: smooth ~400 ms fly**, long jumps arc (zoom out then
  in) to preserve orientation.

## 9. Editing interactions

- **Q45 — Item creation: drag a type chip from the sidebar onto the line.**
  (Primary creation path; the sidebar is the palette.)
- **Q46 — Move: drag with live snap** and magnetic feel near other items and
  section edges.
- **Q47 — Details edited in a docked right inspector panel** (title,
  description, type, tags, layer, link, custom fields).
- **Q48 — Span duration: drag edge handles on the selected item**; dragging a
  point's edge turns it into a span.
- **Q49 — Full multi-select:** shift-click + rubber-band marquee; bulk move,
  re-type, re-layer, tag, delete.
- **Q50 — Everything undoable** (Ctrl+Z/Y), including type/layer/branch/config
  edits, session-long history.
- **Q51 — Delete: instant with particle poof + 10 s Undo toast.** No confirm
  dialogs.
- **Q52 — Duplication (all of): Alt-drag clone, Ctrl+D duplicate-in-place,
  and copy/paste (Ctrl+C/V pastes at cursor).**

## 10. Information display

- **Q53 — On-canvas card at comfortable zoom: icon + title.** Description
  lives in hover tooltip and inspector.
- **Q54 — Hover: rich tooltip** after ~250 ms (title, type, tags, description
  preview); the item scales ~1.1× with a soft glow immediately.
- **Q55 — Selection: animated glow ring in the item's type color.**

## 11. Feel — animation, particles, sound

- **Q57 — Juicy but fast:** springy overshoot everywhere, durations ≤ 250 ms;
  settings slider (off / subtle / full).
- **Q62 — Springs everywhere:** physical, interruptible spring animations for
  items and UI.
- **Q58 — Particles: sparks + ripple.** Ripple ring on click/select; geometric
  vector shards (6–10, item-colored) on create/delete.
- **Q59 — Particle triggers (all of): create, delete, select/click, and
  drag-snap landings / branch connects.**
- **Q64 — Idle motion: selection glow breathes gently; everything else
  static.**
- **Q63 — `prefers-reduced-motion` respected automatically** (springs and
  particles swap for fast fades).
- **Q60 — Sound: tiny synthesized ticks/pops for create/snap/delete,
  OFF by default**, toolbar mute toggle.

## 12. Data, persistence & projects

- **Q65 — Local-first now, cloud-ready later.** Autosave to
  localStorage/IndexedDB + JSON file import/export. The store is architected
  so a sync backend can be added without rework (see Q99).
- **Q66 — Multiple timelines as tabs** within the app.
- **Q67 — Continuous autosave + periodic version snapshots** with rollback.
- **Q68 — Schema is critical:** stable, versioned, human-readable JSON schema
  documented in the README, consumable by the game engine or other tools.
- **Q99 — Realtime co-editing is a future requirement** (solo for now).
  → Architectural consequence: model all mutations as actions over a
  document store that can later be CRDT-backed (e.g. Yjs-compatible
  structure); IDs are stable/globally unique; no array-index references.
- **Q98 — Export: PNG of the current view AND full-timeline SVG** (honoring
  filters).
- **Q97 — Onboarding: template picker** — Empty / Linear game / Film script /
  Project plan — emphasizing the tool's generality. Templates pre-seed
  hierarchy level names, item types and sample items.

## 13. Platform & technical

- **Q69 — Stack: implementer's choice.** Chosen: **Vite + React +
  TypeScript**, SVG for items/structure (crisp, easy hit-testing) over a
  canvas underlay for particles and density rendering; Zustand (action-based,
  CRDT-swappable) store; Framer-Motion-style springs or hand-rolled spring
  physics.
- **Q70 — Scale target: ~500 items smooth**, with viewport culling.
- **Q71 — Deploy: static hosting AND a single-file build** (one
  self-contained .html that opens from disk, via vite-plugin-singlefile).
- **Q96 — 60 fps always:** aggressive culling/virtualization, capped particle
  counts.
- **Q72 — Testing: minimal.** Manual verification; ship fast.
- **Q93 — Full keyboard shortcut set + '?' cheatsheet overlay.**
- **Q94 — Dark-first design with a proper light theme**, system-preference
  default.
- **Q95 — Basic touch gestures** (pinch-zoom, drag-pan, tap-select); editing
  remains desktop-optimized.

## 14. Scope

- **Q100 — Everything above is in scope for v1.** Suggested build order
  (all phases to be delivered):
  1. Core canvas: spine, items, zoom/pan, springs, particles, LOD engine.
  2. Organization: types/icons/colors, layers, density system, filters,
     views, solo, search.
  3. Structure: section hierarchy bands, branching with ANY/ALL gates and
     braid LOD.
  4. Data: schema, autosave + versions, tabs, import/export, PNG/SVG export,
     templates, keyboard layer, themes, sound.

---

## Data model sketch

```
Project
├─ meta { id, name, schemaVersion, hierarchyLevels: ["Chapter","Level","Section"] }
├─ types:    ItemType[]   { id, name, icon, color, defaultLayerId, customFields[] }
├─ layers:   Layer[]      { id, name, order, eye, pin, zoomOverride? }
├─ sections: Section[]    { id, name, depth, start, end, parentId?, pathId? }
├─ items:    Item[]       { id, typeId, layerId?, pathId?, pos, duration,
│                           title, descriptionMd, tags[], link?, images[],
│                           customValues{}, vOffset? }
├─ branches: Branch[]     { id, mode: "any"|"all", forkPos, joinPos?,
│                           paths: Path[] { id, label?, order, terminal? } }
└─ views:    View[]       { id, name, filters{ typeIds, layerIds, tags, text } }
```

All entities use stable unique IDs; every mutation is an action → undo/redo,
version snapshots, and a future CRDT/realtime backend all hang off the same
action log.
