import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import type { Request } from 'express';
import type { StorageEngine } from 'multer';

export const MODEL_EXTENSIONS = ['onnx', 'pt', 'engine'] as const;
export type ModelExtension = (typeof MODEL_EXTENSIONS)[number];

export const ONLY_ONNX_MESSAGE =
  'Only ONNX models can be uploaded. Copy .pt or .engine files into the inbox folder on the server and press Rescan.';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An ONNX file is a protobuf whose first field, `ir_version`, makes the first byte 0x08. */
export function isOnnxHeader(head: Buffer): boolean {
  return head.length > 0 && head[0] === 0x08;
}

/** The extension (without the dot, lower case) of a model file name, or null for any other file. */
export function modelExtension(name: string): ModelExtension | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return (MODEL_EXTENSIONS as readonly string[]).includes(ext)
    ? (ext as ModelExtension)
    : null;
}

/** Where a registered file lives, relative to MODELS_DIR and with "/" separators. */
export function registryPath(id: string, ext: string): string {
  if (!UUID.test(id)) throw new Error('Not a model id');
  if (!(MODEL_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new Error('Not a model file extension');
  }
  return `registry/${id}.${ext}`;
}

/** The absolute path of `rel` under `base`; throws when it would land outside `base`. */
export function resolveInside(base: string, rel: string): string {
  const root = resolve(base);
  const target = resolve(root, rel);
  const back = relative(root, target);
  if (
    back === '' ||
    back === '..' ||
    back.startsWith(`..${sep}`) ||
    isAbsolute(back)
  ) {
    throw new Error('Path is outside the models folder');
  }
  return target;
}

/** The last path segment of a client file name, without control characters, at most 255 long. */
export function safeOriginalName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const name = (raw.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f]/g, '');
  return name.slice(0, 255) || 'model';
}

/** SHA-256 (hex) of a file, read as a stream. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** What the storage engine reports about the file it stored. */
export type StoredUpload = { path: string; size: number; sha256: string };

/**
 * Multer storage for model uploads. The bytes stream to `registry/.upload-<uuid>` (a name the
 * server picks, never the client's). The engine rejects a wrong first byte or too many bytes while
 * streaming, and removes the temp file on every failure, including a client that disconnects.
 */
export class ModelUploadStorage implements StorageEngine {
  constructor(
    private readonly modelsDir: string,
    private readonly maxBytes: number,
  ) {}

  _handleFile(
    _req: Request,
    file: Express.Multer.File,
    cb: (
      error?: unknown,
      info?: Partial<Express.Multer.File & StoredUpload>,
    ) => void,
  ): void {
    const dir = join(this.modelsDir, 'registry');
    const path = join(dir, `.upload-${randomUUID()}`);
    const hash = createHash('sha256');
    let size = 0;
    const maxBytes = this.maxBytes;

    const guard = new Transform({
      transform(chunk: Buffer, _enc, done) {
        if (size === 0 && !isOnnxHeader(chunk)) {
          return done(new BadRequestException(ONLY_ONNX_MESSAGE));
        }
        size += chunk.length;
        if (size > maxBytes) {
          return done(
            new PayloadTooLargeException(
              `The model file is larger than ${maxBytes} bytes`,
            ),
          );
        }
        hash.update(chunk);
        done(null, chunk);
      },
      flush(done) {
        done(
          size === 0
            ? new BadRequestException('The model file is empty')
            : null,
        );
      },
    });

    mkdir(dir, { recursive: true })
      .then(() =>
        pipeline(file.stream, guard, createWriteStream(path, { flags: 'wx' })),
      )
      .then(
        () => cb(null, { path, size, sha256: hash.digest('hex') }),
        async (err: unknown) => {
          await rm(path, { force: true }).catch(() => undefined);
          cb(err);
        },
      );
  }

  _removeFile(
    _req: Request,
    file: Express.Multer.File,
    cb: (error: Error | null) => void,
  ): void {
    rm(file.path, { force: true }).then(
      () => cb(null),
      (err: Error) => cb(err),
    );
  }
}
