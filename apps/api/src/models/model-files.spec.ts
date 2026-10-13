import { isOnnxHeader, registryPath, resolveInside } from './model-files';

describe('isOnnxHeader', () => {
  it('accepts the protobuf ir_version tag 0x08', () => {
    expect(isOnnxHeader(Buffer.from([0x08, 0x07]))).toBe(true);
  });

  it.each([
    ['a zip (PK)', Buffer.from('PK\x03\x04', 'latin1')],
    ['a pickle protocol 2 (0x80)', Buffer.from([0x80, 0x02])],
    ['an empty file', Buffer.alloc(0)],
  ])('rejects %s', (_name, bytes) => {
    expect(isOnnxHeader(bytes)).toBe(false);
  });
});

describe('registryPath', () => {
  const id = '0b9c5a2e-4a53-4e2b-9d57-3b1d3f1a6c11';

  it('is relative to the models folder and uses "/"', () => {
    expect(registryPath(id, 'onnx')).toBe(`registry/${id}.onnx`);
  });

  it('refuses an id or extension that could change the folder', () => {
    expect(() => registryPath('../../etc/passwd', 'onnx')).toThrow();
    expect(() => registryPath(id, 'onnx/../../x')).toThrow();
    expect(() => registryPath(id, 'exe')).toThrow();
  });
});

describe('resolveInside', () => {
  it('resolves a relative path under the folder', () => {
    expect(resolveInside('/data/models', 'registry/a.onnx')).toMatch(
      /registry[\\/]a\.onnx$/,
    );
  });

  it('refuses a path that leaves the folder', () => {
    expect(() => resolveInside('/data/models', '../x.onnx')).toThrow();
    expect(() => resolveInside('/data/models', 'registry/../../x')).toThrow();
    expect(() => resolveInside('/data/models', '/etc/passwd')).toThrow();
  });
});
