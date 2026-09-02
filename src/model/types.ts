export type Id = string

export interface FieldDef {
  id: Id
  name: string
}

export interface ItemType {
  id: Id
  name: string
  icon: string
  color: string
  defaultLayerId: Id | null
  fields: FieldDef[]
}

/** Order in Project.layers = significance (index 0 is most significant). */
export interface Layer {
  id: Id
  name: string
  /** Always hidden regardless of zoom/density. */
  eye: boolean
  /** Always shown regardless of zoom/density. */
  pin: boolean
}

export interface Section {
  id: Id
  name: string
  /** Index into Project.hierarchyLevels. */
  depth: number
  start: number
  end: number
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
  fieldValues: Record<Id, string>
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
}

export interface Project {
  schemaVersion: 1
  id: Id
  name: string
  hierarchyLevels: string[]
  types: ItemType[]
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
