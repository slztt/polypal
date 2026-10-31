import { lazy } from 'react'
import type { Page } from '@shared/stores/navStore'

const CreatePage     = lazy(() => import('@areas/create/CreatePage'))
const MapsPage       = lazy(() => import('@areas/maps/MapsPage'))
const ImagesPage     = lazy(() => import('@areas/images/ImagesPage'))
const LibraryPage    = lazy(() => import('@areas/library/LibraryPage'))
const SkillsPage     = lazy(() => import('@areas/skills/SkillsPage'))
const GeneratePage   = lazy(() => import('@areas/generate/GeneratePage'))
const WorkflowsPage  = lazy(() => import('@areas/workflows/WorkflowsPage'))
const ModelsPage     = lazy(() => import('@areas/models/ModelsPage'))
const SettingsPage   = lazy(() => import('@areas/settings/SettingsPage'))

export interface RouteConfig {
  component:    React.ComponentType
  wrapperClass: string
  /** Stay mounted while hidden (default true). Viewer pages keep state in stores instead. */
  keepAlive?:   boolean
}

export const ROUTES: Record<Page, RouteConfig> = {
  create:    { component: CreatePage,    wrapperClass: 'flex flex-1 overflow-hidden', keepAlive: false },
  maps:      { component: MapsPage,      wrapperClass: 'flex flex-1 overflow-hidden', keepAlive: false },
  images:    { component: ImagesPage,    wrapperClass: 'flex flex-1 overflow-hidden' },
  library:   { component: LibraryPage,   wrapperClass: 'flex flex-1 overflow-hidden' },
  skills:    { component: SkillsPage,    wrapperClass: 'flex-1 overflow-y-auto'      },
  generate:  { component: GeneratePage,  wrapperClass: 'flex flex-1 overflow-hidden', keepAlive: false },
  workflows: { component: WorkflowsPage, wrapperClass: 'flex flex-1 overflow-hidden' },
  models:    { component: ModelsPage,    wrapperClass: 'flex-1 overflow-y-auto'      },
  settings:  { component: SettingsPage,  wrapperClass: 'flex-1 overflow-hidden'      },
}
