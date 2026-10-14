import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { configureRoutes } from '../bootstrap';
import { loadEnv } from '../config/env';
import { createOpenApiDocument } from './swagger';

type Operation = {
  operationId?: string;
  responses: Record<string, { content?: Record<string, { schema?: unknown }> }>;
};
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

describe('OpenAPI document', () => {
  let app: INestApplication;
  let doc: OpenAPIObject;
  let operations: { path: string; method: string; op: Operation }[];

  // Like the openapi script: the whole app, never initialised, so no Postgres or Redis is needed.
  beforeAll(async () => {
    const env = loadEnv({
      DATABASE_URL: 'postgresql://zoo_api:x@127.0.0.1:1/zoo',
      REDIS_URL: 'redis://127.0.0.1:1',
      CAMERA_URL_KEY: randomBytes(32).toString('base64'),
      ENGINE_TOKEN: 'swagger-spec-engine-token-0123456789abcdef',
      INGEST: 'off',
      JOBS: 'off',
    });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(env)],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureRoutes(app);
    doc = createOpenApiDocument(app);
    operations = Object.entries(doc.paths).flatMap(([path, item]) =>
      Object.entries(item)
        .filter(([method]) => METHODS.includes(method))
        .map(([method, op]) => ({ path, method, op: op as Operation })),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('every operation has an operationId matching ^[a-z][A-Za-z]+$, all unique, e.g. camerasList and authMe', () => {
    const ids = operations.map(({ op }) => op.operationId ?? '');
    expect(ids.filter((id) => !/^[a-z][A-Za-z]+$/.test(id))).toEqual([]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(['camerasList', 'authMe']));
  });

  it('every operation except 204 and file responses has a 2xx application/json schema', () => {
    const missing = operations
      .filter(({ op }) => {
        const ok = Object.entries(op.responses).filter(([status]) =>
          status.startsWith('2'),
        );
        if (ok.length === 0) return true;
        return ok.some(([status, res]) => {
          if (status === '204') return false;
          const types = Object.keys(res.content ?? {});
          if (types.some((t) => t !== 'application/json')) return false;
          return !res.content?.['application/json']?.schema;
        });
      })
      .map(({ method, path }) => `${method.toUpperCase()} ${path}`);
    expect(missing).toEqual([]);
  });

  it('no path starts with /internal', () => {
    expect(
      Object.keys(doc.paths).filter((p) => p.startsWith('/internal')),
    ).toEqual([]);
  });
});
