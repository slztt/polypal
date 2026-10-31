import { create } from 'zustand'

/**
 * Pages. Simplified mode shows create · images · library · skills · settings;
 * Advanced mode adds the studio (the full Generate page), workflows and
 * extensions.
 */
export type Page =
  | 'create' | 'images' | 'library' | 'skills' | 'settings'
  | 'generate' | 'workflows' | 'models'

export const SIMPLE_PAGES: Page[] = ['create', 'images', 'library', 'skills', 'settings']
export const ADVANCED_PAGES: Page[] = ['generate', 'workflows', 'models', 'images', 'library', 'skills', 'settings']

interface NavState {
  currentPage: Page
  extensionToOpen: string | null
  navigate: (page: Page) => void
  openExtension: (extensionId: string) => void
  clearExtensionToOpen: () => void
}

export const useNavStore = create<NavState>((set) => ({
  currentPage: 'create',
  extensionToOpen: null,
  navigate: (page) => set({ currentPage: page }),
  openExtension: (extensionId) => set({ currentPage: 'models', extensionToOpen: extensionId }),
  clearExtensionToOpen: () => set({ extensionToOpen: null }),
}))
