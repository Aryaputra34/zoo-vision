import { INestApplication } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import {
  DocumentBuilder,
  type OpenAPIObject,
  SwaggerModule,
} from '@nestjs/swagger';
import { IS_PUBLIC_KEY } from '../auth/decorators';
import { ApiErrorBody } from '../common/errors';

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** `CamerasController.list` → `camerasList`, so the generated hooks read `useCamerasList`. */
export const operationId = (controllerKey: string, methodKey: string) =>
  lowerFirst(controllerKey.replace(/Controller$/, '')) + upperFirst(methodKey);

export function swaggerConfig(): Omit<OpenAPIObject, 'paths'> {
  return new DocumentBuilder()
    .setTitle('Zoo Vision API')
    .setVersion('1')
    .addCookieAuth(
      'zoo_session',
      { type: 'apiKey', in: 'cookie' },
      'zoo_session',
    )
    .addBearerAuth()
    .addSecurityRequirements('zoo_session')
    .addSecurityRequirements('bearer')
    .build();
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
type Operation = {
  operationId?: string;
  parameters?: unknown[];
  requestBody?: unknown;
  responses: Record<string, unknown>;
  security?: unknown[];
};

const ERROR_CONTENT = {
  'application/json': {
    schema: { $ref: '#/components/schemas/ApiErrorBody' },
  },
};

/** The operation ids of every `@Public()` route: they need no login, so no 401 or 403. */
function publicOperationIds(app: INestApplication): Set<string> {
  const ids = new Set<string>();
  for (const module of app.get(ModulesContainer).values()) {
    for (const { metatype } of module.controllers.values()) {
      if (typeof metatype !== 'function') continue;
      const classPublic = Reflect.getMetadata(IS_PUBLIC_KEY, metatype) === true;
      const proto = metatype.prototype as Record<string, unknown>;
      for (const key of Object.getOwnPropertyNames(proto)) {
        const handler = proto[key];
        if (key === 'constructor' || typeof handler !== 'function') continue;
        const methodPublic =
          Reflect.getMetadata(IS_PUBLIC_KEY, handler) === true;
        if (classPublic || methodPublic) {
          ids.add(operationId(metatype.name, key));
        }
      }
    }
  }
  return ids;
}

/**
 * Every operation lists the error shape for the statuses any route can answer: 400 when it takes
 * input, 401 and 403 unless public, 404 when the path names a resource. Routes that can answer
 * 409 declare it with `@ApiConflictResponse`.
 */
function addErrorResponses(doc: OpenAPIObject, publicIds: Set<string>): void {
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of HTTP_METHODS) {
      const op = (item as Record<string, Operation | undefined>)[method];
      if (!op) continue;
      const add = (status: string, description: string) => {
        op.responses[status] ??= { description, content: ERROR_CONTENT };
      };
      if (op.requestBody || (op.parameters?.length ?? 0) > 0) {
        add(
          '400',
          'The request is invalid (VALIDATION_FAILED, SETTINGS_INVALID, ...)',
        );
      }
      if (publicIds.has(op.operationId ?? '')) {
        op.security = [];
      } else {
        add('401', 'No valid session or token (UNAUTHENTICATED)');
        add('403', 'The role is too low (FORBIDDEN, ROLE_REQUIRED)');
      }
      if (path.includes('{')) add('404', 'No such resource (NOT_FOUND)');
    }
  }
}

export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const doc = SwaggerModule.createDocument(app, swaggerConfig(), {
    operationIdFactory: operationId,
    extraModels: [ApiErrorBody],
  });
  addErrorResponses(doc, publicOperationIds(app));
  return doc;
}
