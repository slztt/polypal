import test from 'node:test'
import assert from 'node:assert/strict'
import { loadTsModule } from '../../../scripts/load-ts-module.mjs'

const u = loadTsModule('src/shared/utils/units.ts')

test('converts between metres and display units', () => {
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`)
  close(u.fromMetres(0.25, 'cm'), 25)
  close(u.toMetres(3, 'in'), 0.0762)
  assert.ok(Math.abs(u.fromMetres(u.toMetres(7.5, 'ft'), 'ft') - 7.5) < 1e-12)
})

test('formats lengths, areas, volumes and dimensions', () => {
  assert.equal(u.formatNumber(12.3456), '12.3')
  assert.equal(u.formatNumber(0.000123), '0.000123')
  assert.equal(u.formatNumber(1500), '1500')
  assert.equal(u.formatNumber(2), '2')
  assert.equal(u.formatLength(0.18, 'mm'), '180 mm')
  assert.equal(u.formatArea(0.0001, 'cm'), '1 cm²')
  assert.equal(u.formatVolume(0.000001, 'cm'), '1 cm³')
  assert.equal(u.formatDimensions([0.1, 0.2, 0.05], 'cm'), '10 × 20 × 5 cm')
  assert.equal(u.formatUnitless([1, 1.25, 0.5]), '1 × 1.25 × 0.5 units')
})

test('recognises unit ids', () => {
  assert.ok(u.isLengthUnit('mm'))
  assert.ok(!u.isLengthUnit('furlong'))
  assert.deepEqual(u.LENGTH_UNITS, ['mm', 'cm', 'm', 'in', 'ft'])
})
