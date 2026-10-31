import { useEffect, useRef } from 'react'
import { useNavStore, type Page } from '@shared/stores/navStore'

/**
 * Runs `onActive` each time `page` becomes the current page. Kept-alive pages
 * use it to refresh data that other pages may have changed meanwhile.
 */
export function usePageActive(page: Page, onActive: () => void): void {
  const active = useNavStore((s) => s.currentPage === page)
  const callback = useRef(onActive)
  callback.current = onActive
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    if (active) callback.current()
  }, [active])
}
