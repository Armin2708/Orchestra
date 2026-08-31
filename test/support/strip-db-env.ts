// Tests must never inherit a real database URL from the shell — a developer
// with the prod Supabase pooler exported (e.g. after sourcing
// .env.hub.supabase-cloud.local) would otherwise hand it to any code path that
// reads process.env. All hub tests use PGlite or inject their own env maps, so
// nothing legitimate loses anything here.
delete process.env.HUB_DATABASE_URL
delete process.env.DATABASE_URL
