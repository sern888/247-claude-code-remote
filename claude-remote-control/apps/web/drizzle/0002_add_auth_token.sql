-- Adds the per-connection bearer token captured during pairing, and heals the
-- pre-existing "color" drift (present in schema.ts since an earlier change but
-- never written to a migration). IF NOT EXISTS keeps this safe to apply on a
-- database where "color" was already added out of band via drizzle-kit push.
ALTER TABLE "agent_connection" ADD COLUMN IF NOT EXISTS "color" text;--> statement-breakpoint
ALTER TABLE "agent_connection" ADD COLUMN IF NOT EXISTS "auth_token" text;
