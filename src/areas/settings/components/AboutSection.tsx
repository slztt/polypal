import { useEffect, useState } from 'react'
import { Section, Card, Row, LinkButton } from '@shared/ui'
import { BRANDS } from '@shared/branding'

export function AboutSection(): JSX.Element {
  const [version, setVersion] = useState<string>('')

  useEffect(() => {
    window.electron.app.info().then(({ version }) => setVersion(version))
  }, [])

  return (
    <Section title="About" subtitle="Application information and useful resources.">
      <div className="grid grid-cols-2 gap-4">

        <Card>
          <Row label="PolyPal" description="Local AI 3D generation, editing and diagnostics.">
            <span className="text-xs font-mono text-zinc-400">{version ? `v${version}` : '—'}</span>
          </Row>
          <Row label="Documentation" description="Guides and architecture overview.">
            <LinkButton label="Open" href="https://github.com/slztt/polypal#readme" />
          </Row>
          <Row label="GitHub" description="Source code and issues.">
            <LinkButton label="Open" href="https://github.com/slztt/polypal" />
          </Row>
        </Card>

        <Card>
          <Row label="Based on Modly" description="By Lightning Pixel — credited per the MIT attribution clause.">
            <LinkButton label="Open" href="https://github.com/lightningpixel/modly" />
          </Row>
          <Row label="Open-source licenses" description="Third-party licenses used in this app.">
            <LinkButton label="View" href="https://github.com/slztt/polypal/blob/main/LICENSE" />
          </Row>
        </Card>

      </div>

      <div className="mt-4">
        <Card title="Open-source models" description="PolyPal's AI models and engines are built on these projects. Each keeps its own licence — some (for example the FLUX and SDXL Turbo weights) are for non-commercial use only.">
          <ul className="grid grid-cols-2 gap-x-6 gap-y-1.5 px-4 py-3 text-[11.5px]">
            {[...new Map(BRANDS.filter((b) => b.name !== 'PolyPal' && (typeof b.name === 'string' || b.basedOn.startsWith('Qwen'))).map((b) => [b.basedOn, b])).values()].map((b) => (
              <li key={b.basedOn} className="flex justify-between gap-3">
                <span className="text-zinc-300">{typeof b.name === 'string' ? b.name : 'PolyPal Assistant'}</span>
                <span className="truncate text-right text-zinc-500">{b.basedOn}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </Section>
  )
}
