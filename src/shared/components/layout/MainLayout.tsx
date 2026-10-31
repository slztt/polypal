import TopBar from './TopBar'
import Sidebar from './Sidebar'
import Router from '@shared/router/Router'

export default function MainLayout(): JSX.Element {

  return (
    <div className="flex flex-col h-full bg-surface-500 text-zinc-100">
      <TopBar />

      <div className="flex flex-1 overflow-hidden">
        <Sidebar />

        <main className="flex flex-1 overflow-hidden bg-[radial-gradient(1200px_600px_at_70%_-10%,rgba(34,197,94,0.06),transparent)]">
          <Router />
        </main>
      </div>
    </div>
  )
}
