export type Id = string

export type FieldKind = 'text' | 'int' | 'float' | 'ref'

/** Stored value: text → string, int/float → number, ref → target ids. */
export type FieldValue = string | number | Id[]

/** A project-wide field definition. Types and hierarchy levels attach these. */
export interface FieldDef {
  id: Id
  name: string
  kind: FieldKind
  /** Short hint shown under the input. */
  help: string
  /** Warn (red outline) when the owner leaves it empty. */
  required: boolean
  /** Show the value in the canvas hover tooltip. */
  showInTooltip: boolean
  /** Global fallback default; an attachment may override it. null = none. */
  defaultValue: FieldValue | null
  /** text: hard character limit; null = unlimited. */
  maxLength: number | null
  /** int / float bounds; null = unbounded. */
  min: number | null
  max: number | null
  /** float: digits after the decimal point; null = free. */
  decimals: number | null
  /** int / float: suffix shown after the value (e.g. "coins"). */
  unit: string
  /** ref: allowed item type ids and hierarchy level ids; empty = anything. */
  refTargets: Id[]
  /** ref: several targets instead of one. */
  refMultiple: boolean
  /** ref: draw connector lines on the canvas while the owner is selected. */
  refShowLinks: boolean
}

/** A field attached to a type or a hierarchy level. */
export interface FieldAttachment {
  fieldId: Id
  /** Overrides the field's own default for this type/level; null = inherit. */
  defaultValue: FieldValue | null
}

export type ProcessorOp = 'sum' | 'count' | 'avg' | 'min' | 'max' | 'distinct'

/** A project-wide aggregation over the items (and child sections) inside a section. */
export interface ProcessorDef {
  id: Id
  name: string
  op: ProcessorOp
  /** Field aggregated; null for count. */
  fieldId: Id | null
  /** Item type ids / hierarchy level ids to include; empty = everything. */
  targets: Id[]
}

export interface ProcessorAttachment {
  processorId: Id
  /** Append the result to the section's band label on the canvas. */
  showOnBand: boolean
}

/** One level of the section hierarchy (Chapter, Level, …); Section.depth indexes into these. */
export interface HierarchyLevel {
  id: Id
  name: string
  fields: FieldAttachment[]
  processors: ProcessorAttachment[]
}

export interface ItemType {
  id: Id
  name: string
  icon: string
  color: string
  defaultLayerId: Id | null
  fields: FieldAttachment[]
  /** Folder this type is filed under in the sidebar; null/undefined = root. */
  folderId?: Id | null
}

/** A loose sidebar folder for organizing item types. Folders nest via parentId. */
export interface TypeFolder {
  id: Id
  name: string
  color: string
  icon: string
  collapsed: boolean
  /** Parent folder; null/undefined = top level. */
  parentId?: Id | null
}

/** Order in Project.layers = significance (index 0 is most significant). */
export interface Layer {
  id: Id
  name: string
  /** Always hidden regardless of zoom/density. */
  eye: boolean
  /** Always shown regardless of zoom/density. */
  pin: boolean
  /** Visual scale multiplier for items in this layer (1 = normal). */
  size: number
  /**
   * Zoom threshold (camera px per world unit): when the camera is zoomed out
   * below this, items in this layer collapse to small dots on the line.
   * 0 = never minimize.
   */
  minZoom: number
}

export interface Section {
  id: Id
  name: string
  /** Index into Project.hierarchyLevels. */
  depth: number
  start: number
  end: number
  /** Markdown notes, like an item's description. Normalized to '' on load. */
  description?: string
  /** Values of the fields attached to the section's hierarchy level. */
  fieldValues: Record<Id, FieldValue>
}

export interface BranchPath {
  id: Id
  label: string
  terminal: boolean
}

export interface Branch {
  id: Id
  mode: 'any' | 'all'
  forkPos: number
  joinPos: number
  paths: BranchPath[]
}

export interface Item {
  id: Id
  typeId: Id
  /** null = use the type's default layer. */
  layerId: Id | null
  /** null = on the main spine; otherwise the id of a BranchPath. */
  pathId: Id | null
  pos: number
  duration: number
  title: string
  description: string
  tags: string[]
  link: string
  images: string[]
  fieldValues: Record<Id, FieldValue>
}

export interface Filters {
  /** Type ids currently toggled OFF. */
  offTypes: Id[]
  /** Layer ids currently toggled OFF via filtering (distinct from layer.eye). */
  offLayers: Id[]
  /** Tags that must be present (OR within, AND with other groups). */
  tags: string[]
  text: string
}

export interface View {
  id: Id
  name: string
  filters: Filters
}

export interface Camera {
  /** World coordinate at the left edge of the viewport. */
  x: number
  /** Pixels per world unit. */
  s: number
}

export type UnitPreset = 'none' | 'minutes' | 'hours' | 'days' | 'weeks' | 'months' | 'years' | 'custom'

export interface TimelineSettings {
  /** Where markers may be placed relative to the spine. */
  placement: 'above' | 'both'
  unit: {
    preset: UnitPreset
    /** Suffix used when preset is 'custom' (e.g. "beats"). */
    custom: string
    /** Draw tick marks + unit labels along the spine. */
    showRuler: boolean
  }
  grid: {
    show: boolean
    style: 'solid' | 'dashed' | 'dots'
    /** 0..1 */
    opacity: number
  }
  spine: {
    /** Stroke width in px. */
    width: number
    /** 0..1 */
    opacity: number
  }
  /** Multiplier for section band tint (0 = invisible, 1 = default, 2 = strong). */
  bandStrength: number
  sectionStyle: {
    /** Label font size (px) for top-level sections; deeper levels shrink. */
    labelSize: number
    /** Border opacity for top-level sections; fades with depth. */
    edgeStrength: number
    /** Show the section's duration in faint text after its name. */
    showDuration: boolean
  }
}

export interface Project {
  schemaVersion: 1
  id: Id
  name: string
  hierarchyLevels: HierarchyLevel[]
  fields: FieldDef[]
  processors: ProcessorDef[]
  types: ItemType[]
  typeFolders: TypeFolder[]
  layers: Layer[]
  sections: Section[]
  branches: Branch[]
  items: Item[]
  views: View[]
  camera: Camera
  filters: Filters
  activeViewId: Id | null
  settings: TimelineSettings
}
