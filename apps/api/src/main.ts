import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { EnvError, loadEnv } from './config/env';

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule.forRoot(env), {
    forceCloseConnections: true,
  });
  configureApp(app);
  await app.listen(env.PORT);
}

main().catch((err: unknown) => {
  // An invalid environment gets its list of variables, not a stack trace.
  console.error(err instanceof EnvError ? err.message : err);
  process.exit(1);
});
