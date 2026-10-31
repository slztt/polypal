// Which image-to-3D model the simplified pages use, and one-click setup of the
// recommended one when none is installed.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useExtensionsStore } from '@shared/stores/extensionsStore'
import { errorMessage, modelsApi, type GeneratorModel } from '@shared/api/polypalApi'

export const RECOMMENDED_3D = {
  name: 'PolyPal 3D Standard',
  url: 'https://github.com/lightningpixel/modly-triposg-extension',
  sizeNote: 'about 6 GB download · 8 GB+ graphics memory recommended',
}

export interface ModelSetup {
  models: GeneratorModel[]          // installed image→3D models
  ready: GeneratorModel | null      // the one generation will use
  loading: boolean
  installing: boolean
  progress: number | null
  status: string
  error: string | null
  refresh: () => Promise<void>
  installRecommended: () => Promise<void>
  download: (modelId: string) => Promise<void>
}

export function useModelSetup(preferredId?: string | null): ModelSetup {
  const modelExtensions = useExtensionsStore((s) => s.modelExtensions)
  const loadExtensions = useExtensionsStore((s) => s.loadExtensions)
  const installFromGitHub = useExtensionsStore((s) => s.installFromGitHub)
  const [all, setAll] = useState<GeneratorModel[]>([])
  const [loading, setLoading] = useState(true)
  const [installing, setInstalling] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)

  const imageNodeIds = useMemo(() => new Set(
    modelExtensions.flatMap((ext) => ext.nodes
      .filter((n) => (n.inputs ?? [n.input]).includes('image') && n.output === 'mesh')
      .map((n) => `${ext.id}/${n.id}`)),
  ), [modelExtensions])

  const refresh = useCallback(async () => {
    try {
      setAll(await modelsApi.all())
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void loadExtensions(); void refresh() }, [loadExtensions, refresh])

  const models = all.filter((m) => imageNodeIds.has(m.id))
  const downloaded = models.filter((m) => m.downloaded)
  const ready = downloaded.find((m) => m.id === preferredId) ?? downloaded.find((m) => m.active) ?? downloaded[0] ?? null

  const download = useCallback(async (modelId: string) => {
    setInstalling(true)
    setError(null)
    setStatus('Downloading the model…')
    setProgress(0)
    window.electron.model.onProgress((p) => {
      if (p.modelId !== modelId) return
      setProgress(p.percent)
      if (p.status) setStatus(p.status)
    })
    try {
      const result = await window.electron.model.download(modelId)
      if (!result.success && !result.cancelled && !result.paused) throw new Error(result.error ?? 'Download failed')
      await refresh()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      window.electron.model.offProgress()
      setInstalling(false)
      setProgress(null)
      setStatus('')
    }
  }, [refresh])

  const installRecommended = useCallback(async () => {
    setInstalling(true)
    setError(null)
    setStatus(`Installing ${RECOMMENDED_3D.name}…`)
    try {
      const before = new Set(useExtensionsStore.getState().modelExtensions.map((e) => e.id))
      const result = await installFromGitHub(RECOMMENDED_3D.url)
      if (!result.success) throw new Error(result.error ?? 'Install failed')
      await loadExtensions()
      const exts = useExtensionsStore.getState().modelExtensions
      const ext = exts.find((e) => !before.has(e.id)) ?? exts.find((e) => /triposg/i.test(e.id))
      const node = ext?.nodes.find((n) => (n.inputs ?? [n.input]).includes('image') && n.output === 'mesh')
      if (!ext || !node) throw new Error('The model installed but has no picture-to-3D step')
      setInstalling(false)
      await download(`${ext.id}/${node.id}`)
    } catch (e) {
      setError(errorMessage(e))
      setInstalling(false)
      setStatus('')
    }
  }, [installFromGitHub, loadExtensions, download])

  return { models, ready, loading, installing, progress, status, error, refresh, installRecommended, download }
}
