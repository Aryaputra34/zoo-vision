import { PrismaPg } from '@prisma/adapter-pg';
import { normalizeUsername } from './auth/auth.service';
import { hashPassword, MIN_PASSWORD_LENGTH } from './auth/password';
import { PrismaClient } from './generated/prisma/client';

type NewSuperadmin = { username: string; name: string; password: string };

/** Creates a SUPERADMIN and returns its id. Throws when the username exists or the password is short. */
export async function createSuperadmin(
  prisma: PrismaClient,
  input: NewSuperadmin,
): Promise<string> {
  const username = normalizeUsername(input.username);
  if (!username) throw new Error('username is required');
  if (!input.name.trim()) throw new Error('name is required');
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    );
  }
  if (await prisma.user.findUnique({ where: { username } })) {
    throw new Error(`user "${username}" already exists`);
  }
  const user = await prisma.user.create({
    data: {
      username,
      name: input.name.trim(),
      passwordHash: await hashPassword(input.password),
      role: 'SUPERADMIN',
    },
  });
  return user.id;
}

function arg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const USAGE = [
  'usage: ZOO_ADMIN_PASSWORD=... node dist/cli.js create-superadmin --username <u> --name <n>',
  '       ZOO_DEMO=on DEMO_PASSWORD=... node dist/cli.js demo-seed',
  '       node dist/cli.js demo-feed [--backfill-days N]',
].join('\n');

async function createSuperadminCommand(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const username = arg(args, '--username');
  const name = arg(args, '--name');
  const password = env.ZOO_ADMIN_PASSWORD;
  const databaseUrl = env.DATABASE_URL;
  if (!username || !name || !password || !databaseUrl) {
    console.error(
      `${USAGE}\nDATABASE_URL and ZOO_ADMIN_PASSWORD must be set in the environment.`,
    );
    return 1;
  }
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
  try {
    console.log(await createSuperadmin(prisma, { username, name, password }));
    return 0;
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Creates the demo cameras and users. Refuses unless ZOO_DEMO=on, so known-password users cannot
 * appear on a real site by accident, and refuses a short DEMO_PASSWORD, both before anything is built.
 */
async function demoSeedCommand(env: NodeJS.ProcessEnv): Promise<number> {
  if (env.ZOO_DEMO !== 'on') {
    console.error('demo-seed runs only with ZOO_DEMO=on');
    return 1;
  }
  const password = env.DEMO_PASSWORD ?? '';
  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(
      `DEMO_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`,
    );
    return 1;
  }
  // loaded here so create-superadmin does not start the whole application graph
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('./app.module.js');
  const { loadEnv } = await import('./config/env.js');
  const { seedDemo } = await import('./demo/demo-seed.js');
  const app = await NestFactory.createApplicationContext(
    AppModule.forRoot(loadEnv({ ...env, INGEST: 'off', JOBS: 'off' })),
    { logger: ['error', 'warn'] },
  );
  try {
    const created = await seedDemo(app, password);
    console.log(
      `demo-seed: created ${created.cameras.length} cameras and ${created.users.length} users`,
    );
    return 0;
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  } finally {
    await app.close();
  }
}

/** The command line; returns the exit code. Exported for the tests. */
export async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'create-superadmin':
      return createSuperadminCommand(rest, env);
    case 'demo-seed':
      return demoSeedCommand(env);
    default:
      console.error(USAGE);
      return 1;
  }
}

if (require.main === module) {
  void runCli(process.argv.slice(2), process.env).then((code) =>
    process.exit(code),
  );
}
