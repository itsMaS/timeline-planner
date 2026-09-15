import type { Camera } from '../model/types'

/** Imperative navigation surface the Canvas registers on mount (keyboard/UI use it). */
export interface Nav {
  flyTo: (cam: Camera) => void
  fitAll: () => void
  zoomBy: (factor: number) => void
  flyToItem: (id: string) => void
  flyToSection: (id: string) => void
  back: () => void
  forward: () => void
  /** Create an item of the given type at the centre of the visible timeline; returns its id. */
  addItem: (typeId: string) => string | null
}

export const nav: { current: Nav | null } = { current: null }

/** Sidebar type-chip drag → canvas drop. */
export const chipDrop: { current: ((clientX: number, clientY: number, typeId: string) => void) | null } = { current: null }
