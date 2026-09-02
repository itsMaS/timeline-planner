import type { Item } from '../model/types'

/** In-memory item clipboard shared by keyboard shortcuts and the context menu. */
let items: Item[] = []

export const getClipboard = (): Item[] => items
export const setClipboard = (v: Item[]) => { items = v.map(i => structuredClone(i)) }
