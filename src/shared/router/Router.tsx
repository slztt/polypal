import { Suspense, useEffect, useState } from 'react'
import { useNavStore, type Page } from '@shared/stores/navStore'
import { ROUTES } from './routes'

// Pages stay mounted after their first visit (hidden when not current) so
// leaving a tab and coming back shows exactly what was there. Pages with a 3D
// viewer opt out — they keep their state in stores instead, so only one WebGL
// canvas is ever alive.
export default function Router(): JSX.Element {
  const currentPage = useNavStore((s) => s.currentPage)
  const [visited, setVisited] = useState<Page[]>([currentPage])

  useEffect(() => {
    setVisited((v) => (v.includes(currentPage) ? v : [...v, currentPage]))
  }, [currentPage])

  const mounted = visited.includes(currentPage) ? visited : [...visited, currentPage]

  return (
    <>
      {mounted.map((page) => {
        const { component: Component, wrapperClass, keepAlive = true } = ROUTES[page]
        const active = page === currentPage
        if (!active && !keepAlive) return null
        return (
          <div key={page} className={active ? `${wrapperClass} animate-page-in` : 'hidden'} aria-hidden={!active}>
            <Suspense fallback={null}><Component /></Suspense>
          </div>
        )
      })}
    </>
  )
}
