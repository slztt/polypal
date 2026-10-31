import { useAppStore } from '@shared/stores/appStore'
import { ModeSwitch } from '@shared/components/layout/Sidebar'
import { Segmented } from '@shared/components/ui/ImagePicker'
import { Section, Card, Row } from '@shared/ui'

export function GeneralSection(): JSX.Element {
  const uiMode = useAppStore((s) => s.uiMode)
  const textureMode = useAppStore((s) => s.textureMode)
  const setTextureMode = useAppStore((s) => s.setTextureMode)

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
