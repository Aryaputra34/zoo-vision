import { defineConfig } from 'prisma/config';

// The Prisma CLI (migrate, studio) connects as the owner role `zoo_owner`.
// The running API never reads this file: it connects with DATABASE_URL as `zoo_api`.
// process.env rather than env() from prisma/config: env() throws when the variable is unset,
// and `prisma generate` (postinstall, Docker build, CI) runs without any database URL.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_MIGRATE_URL },
});
