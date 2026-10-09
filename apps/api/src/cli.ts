import { PrismaPg } from '@prisma/adapter-pg';
import { normalizeUsername } from './auth/auth.service';
import { hashPassword } from './auth/password';
import { PrismaClient } from './generated/prisma/client';

export const MIN_PASSWORD_LENGTH = 10;

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

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const usage =
    'usage: ZOO_ADMIN_PASSWORD=... node dist/cli.js create-superadmin --username <u> --name <n>';
  if (command !== 'create-superadmin') {
    console.error(usage);
    return 1;
  }
  const username = arg(rest, '--username');
  const name = arg(rest, '--name');
  const password = process.env.ZOO_ADMIN_PASSWORD;
  const databaseUrl = process.env.DATABASE_URL;
  if (!username || !name || !password || !databaseUrl) {
    console.error(
      `${usage}\nDATABASE_URL and ZOO_ADMIN_PASSWORD must be set in the environment.`,
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

if (require.main === module) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
