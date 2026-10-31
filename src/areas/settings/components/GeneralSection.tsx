import { useAppStore } from '@shared/stores/appStore'
import { ModeSwitch } from '@shared/components/layout/Sidebar'
import { Segmented } from '@shared/components/ui/ImagePicker'
import { Section, Card, Row, Toggle } from '@shared/ui'
import { playSfx } from '@shared/utils/sfx'

export function GeneralSection(): JSX.Element {
  const uiMode = useAppStore((s) => s.uiMode)
  const textureMode = useAppStore((s) => s.textureMode)
  const setTextureMode = useAppStore((s) => s.setTextureMode)
  const { soundEnabled, setSoundEnabled, soundVolume, setSoundVolume } = useAppStore()

  return (
    <Section title="General" subtitle="How PolyPal looks and behaves.">
      <div className="flex flex-col gap-4">
        <Card title="Mode">
          <Row
            label="Interface mode"
            description={uiMode === 'simple'
              ? 'Simplified: 3D Generate, Image Generator, Library, Skills and Settings — everything else is handled for you.'
              : 'Advanced: the full studio with workflows, extensions, mesh editing and every option.'}
          >
            <div className="w-56"><ModeSwitch /></div>
          </Row>
        </Card>
        <Card title="Sound">
          <Row label="Interface sounds" description="Soft clicks, toggles and a chime when something finishes.">
            <Toggle value={soundEnabled} onChange={(v) => { setSoundEnabled(v); if (v) setTimeout(() => playSfx('success'), 0) }} />
          </Row>
          {soundEnabled && (
            <Row label="Volume">
              <input type="range" min={0.05} max={1} step={0.05} value={soundVolume} aria-label="Sound volume"
                onChange={(e) => setSoundVolume(Number(e.target.value))} onPointerUp={() => playSfx('success')}
                className="w-48 accent-green-500" />
            </Row>
          )}
        </Card>
        <Card title="New models">
          <Row label="Add colour (texture)" description="What to do after a model is generated. You can also change this on the 3D Generate page.">
            <div className="w-64">
              <Segmented
                ariaLabel="Texture new models"
                size="sm"
                value={textureMode}
                onChange={setTextureMode}
                options={[{ value: 'ask', label: 'Ask me' }, { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]}
              />
            </div>
          </Row>
        </Card>
      </div>
    </Section>
  )
}
