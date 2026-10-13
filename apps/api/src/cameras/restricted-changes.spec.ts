import { createValidator, type Validator } from '@zoo-vision/contracts';
import { restrictedChanges } from './restricted-changes';

const validator = createValidator();
const base = {
  clerk_zone: [
    [0.1, 0.1],
    [0.9, 0.1],
    [0.9, 0.9],
  ],
};

describe('restrictedChanges', () => {
  it('a manager changing /model_name gets ["/model_name"]', () => {
    expect(
      restrictedChanges(
        validator,
        'cashier_presence',
        base,
        { ...base, model_name: 'other.onnx' },
        'MANAGER',
      ),
    ).toEqual(['/model_name']);
  });

  it('a manager adding model_name equal to its default gets []', () => {
    expect(
      restrictedChanges(
        validator,
        'cashier_presence',
        base,
        { ...base, model_name: 'yolo11s.onnx' },
        'MANAGER',
      ),
    ).toEqual([]);
  });

  it('a superadmin gets []', () => {
    expect(
      restrictedChanges(
        validator,
        'cashier_presence',
        base,
        { ...base, model_name: 'other.onnx', imgsz: 1280 },
        'SUPERADMIN',
      ),
    ).toEqual([]);
  });

  it('a manager changing confidence_threshold gets []', () => {
    expect(
      restrictedChanges(
        validator,
        'cashier_presence',
        base,
        { ...base, confidence_threshold: 0.5 },
        'MANAGER',
      ),
    ).toEqual([]);
  });

  it('with no before, any non-default restricted value counts', () => {
    expect(
      restrictedChanges(
        validator,
        'cashier_presence',
        null,
        { ...base, imgsz: 1280 },
        'MANAGER',
      ),
    ).toEqual(['/imgsz']);
  });

  describe('paths with a * segment', () => {
    const stub = {
      restrictedFields: () => [{ path: '/zones/*/sensitivity', minRole: 'SUPERADMIN' }],
      withDefaults: (_useCase: string, doc: object) => structuredClone(doc),
    } as unknown as Validator;
    const zone = (id: string, sensitivity?: number) => ({
      id,
      ...(sensitivity === undefined ? {} : { sensitivity }),
    });
    const run = (before: object | null, after: object) =>
      restrictedChanges(stub, 'demo', before, after, 'MANAGER');

    it("a manager changing one zone's sensitivity gets that zone's concrete path", () => {
      expect(
        run(
          { zones: [zone('a', 0.5), zone('b', 0.5)] },
          { zones: [zone('a', 0.5), zone('b', 0.9)] },
        ),
      ).toEqual(['/zones/1/sensitivity']);
    });

    it('zones are matched by id, so reordering them is not a change', () => {
      expect(
        run(
          { zones: [zone('a', 0.5), zone('b', 0.9)] },
          { zones: [zone('b', 0.9), zone('a', 0.5)] },
        ),
      ).toEqual([]);
    });

    it('a manager may add a zone without sensitivity, but not one with it', () => {
      const before = { zones: [zone('a', 0.5)] };
      expect(run(before, { zones: [zone('a', 0.5), zone('c')] })).toEqual([]);
      expect(run(before, { zones: [zone('a', 0.5), zone('c', 0.7)] })).toEqual([
        '/zones/1/sensitivity',
      ]);
    });

    it('a manager may remove a zone', () => {
      expect(
        run({ zones: [zone('a', 0.5), zone('b', 0.9)] }, { zones: [zone('a', 0.5)] }),
      ).toEqual([]);
    });
  });
});
