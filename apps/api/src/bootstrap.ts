import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { ENV, type Env } from './config/env';

/**
 * Everything main.ts and the e2e tests both apply before `init`/`listen`: routes live under
 * /api/v1/... (health is version-neutral at /api/health), DTOs are whitelisted, and Swagger
 * is served at /api/docs (+ /api/docs-json) only when SWAGGER=public.
 */
export function configureApp(app: INestApplication): void {
  const env = app.get<Env>(ENV);

  app.use(cookieParser());
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableShutdownHooks();

  if (env.SWAGGER === 'public') {
    const config = new DocumentBuilder()
      .setTitle('Zoo Vision API')
      .setVersion('1')
      .addCookieAuth(
        'zoo_session',
        { type: 'apiKey', in: 'cookie' },
        'zoo_session',
      )
      .addBearerAuth()
      .build();
    SwaggerModule.setup('api/docs', app, () =>
      SwaggerModule.createDocument(app, config),
    );
  }
}
