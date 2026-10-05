import { defineConfig } from 'drizzle-kit';

// drizzle-kit only connects for commands like `push`/`migrate`, and this file
// is also loaded statically by tooling (knip, lint) with no DATABASE_URL set.
// Default to an empty string so loading never throws; drizzle-kit reports a
// clear connection error itself when a command actually needs the URL.
const databaseUrl = process.env.DATABASE_URL ?? '';

export default defineConfig({
  schema: './src/lib/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: databaseUrl,
  },
});
