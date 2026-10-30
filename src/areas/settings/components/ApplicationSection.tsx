import { useAppStore } from '@shared/stores/appStore'
import { Section, Card, Row, Select, Toggle } from '@shared/ui'
import { LENGTH_UNITS, UNIT_LABELS, type LengthUnit } from '@shared/utils/units'

export function ApplicationSection(): JSX.Element {
  const { showRamIndicator, setShowRamIndicator, units, setUnits, contactShadows, setContactShadows } = useAppStore()

  return (
    <Section title="Application" subtitle="General application settings.">
      <div className="flex flex-col gap-4">
        <Card title="Interface">
          <Row
            label="RAM indicator"
            description="Show live memory usage in the top bar."
          >
            <Toggle value={showRamIndicator} onChange={setShowRamIndicator} />
          </Row>
        </Card>

        <Card title="Units & viewer" description="How sizes and distances are shown.">
          <Row
            label="Length units"
            description="Used for dimensions, measurements and the real-world size form. Models are stored in metres."
          >
            <Select
              value={units}
              onChange={(v) => setUnits(v as LengthUnit)}
              options={LENGTH_UNITS.map((u) => ({ value: u, label: UNIT_LABELS[u] }))}
            />
          </Row>
          <Row label="Contact shadows" description="Soft shadow under the model, to judge how it sits on the ground.">
            <Toggle value={contactShadows} onChange={setContactShadows} />
          </Row>
        </Card>
      </div>
    </Section>
  )
}
