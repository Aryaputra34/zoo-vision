import {
  INestApplication,
  RequestMethod,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import type { Express } from 'express';
import { ActorResolver } from './auth/actor-resolver';
import { TrustedProxy } from './auth/trusted-proxy';
import { validationException } from './common/errors';
import { ENV, type Env } from './config/env';
import { DOCS_PATHS, docsAccess } from './openapi/docs-access';
import { createOpenApiDocument } from './openapi/swagger';

/**
 * The URL layout, shared with the `openapi` script: routes live under /api/v1/... (health is
 * version-neutral at /api/health); /internal/engine/* is the Python engine's and /media/* the
 * snapshots and clips, both outside the `api` prefix and URI versioning.
 */
export function configureRoutes(app: INestApplication): void {
  app.setGlobalPrefix('api', {
    exclude: [
      { path: 'internal/{*path}', method: RequestMethod.ALL },
      { path: 'media/{*path}', method: RequestMethod.ALL },
    ],
  });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
}

/**
 * Everything main.ts and the e2e tests both apply before `init`/`listen`: the proxy setting,
 * cookies, routes, whitelisted DTOs and Swagger at /api/docs (+ /api/docs-json) per SWAGGER
 * (`public`, `superadmin` or `off`).
 */
export function configureApp(app: INestApplication): void {
  const env = app.get<Env>(ENV);

  // Exactly one proxy (Caddy) sits in front: req.ip is the client's address from X-Forwarded-For,
  // so the login throttle, the lockout log and LoginLog see the client, not the proxy. Only the
  // address Caddy resolves to may say so: anyone who reaches the API directly is just a socket
  // address (a forged X-Forwarded-For would let them pick the IP the throttle counts).
  (app.getHttpAdapter().getInstance() as Express).set(
    'trust proxy',
    app.get(TrustedProxy).trustHop,
  );
  app.use(cookieParser());
  configureRoutes(app);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: validationException,
    }),
  );
  app.enableShutdownHooks();

  if (env.SWAGGER !== 'off') {
    if (env.SWAGGER === 'superadmin') {
      app.use(DOCS_PATHS, docsAccess(app.get(ActorResolver)));
    }
    SwaggerModule.setup('api/docs', app, () => createOpenApiDocument(app));
  }
}
