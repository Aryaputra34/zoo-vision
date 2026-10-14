import { loadRegistry } from '@zoo-vision/contracts';
import { allowedDataField } from './fields';

const registry = loadRegistry();

describe('allowedDataField', () => {
  it('accepts a string or enum field for group, and a number or integer field for number', () => {
    expect(
      allowedDataField(registry, ['horse_crossing'], 'direction', 'group'),
    ).toBe(true);
    expect(
      allowedDataField(registry, ['vehicle_crossing'], 'vehicleType', 'group'),
    ).toBe(true);
    expect(
      allowedDataField(registry, ['customer_waiting'], 'waitingSec', 'number'),
    ).toBe(true);
    // a type that is ["number", "null"] still counts as a number
    expect(
      allowedDataField(
        registry,
        ['vehicle_crossing'],
        'ocrConfidence',
        'number',
      ),
    ).toBe(true);
  });

  it('refuses the other kind, undeclared fields and the envelope columns', () => {
    expect(
      allowedDataField(registry, ['horse_crossing'], 'direction', 'number'),
    ).toBe(false);
    expect(
      allowedDataField(registry, ['customer_waiting'], 'waitingSec', 'group'),
    ).toBe(false);
    expect(
      allowedDataField(registry, ['vehicle_crossing'], 'plateValid', 'group'),
    ).toBe(false); // a boolean
    expect(
      allowedDataField(registry, ['horse_crossing'], 'snapshot', 'group'),
    ).toBe(false);
    expect(
      allowedDataField(registry, ['horse_crossing'], 'time', 'group'),
    ).toBe(false);
  });

  it('needs the field in at least one requested type, and refuses an empty or unknown type list', () => {
    expect(
      allowedDataField(
        registry,
        ['horse_crossing', 'vehicle_crossing'],
        'vehicleType',
        'group',
      ),
    ).toBe(true);
    expect(allowedDataField(registry, [], 'direction', 'group')).toBe(false);
    expect(
      allowedDataField(registry, ['no_such_type'], 'direction', 'group'),
    ).toBe(false);
  });

  it('is not fooled by names on the prototype', () => {
    for (const field of [
      'constructor',
      '__proto__',
      'toString',
      'hasOwnProperty',
    ]) {
      expect(
        allowedDataField(registry, ['horse_crossing'], field, 'group'),
      ).toBe(false);
    }
    expect(
      allowedDataField(registry, ['constructor'], 'direction', 'group'),
    ).toBe(false);
  });
});
