import { createValidator } from '@zoo-vision/contracts';
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
});
