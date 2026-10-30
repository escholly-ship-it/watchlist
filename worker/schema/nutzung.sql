-- WL-NUTZUNG-MESSEN (2026-10-30): D1-Datenbank watchlist-nutzung.
-- Eine Zeile je UTC-Tag und Pseudonym; der Worker zaehlt per Upsert hoch.
-- Angelegt per Cloudflare-Konnektor (d1_database_query); neu anlegen:
--   npx wrangler@3.114.17 d1 execute watchlist-nutzung --remote --file worker/schema/nutzung.sql
create table if not exists nutzung (
  tag text not null,                    -- UTC-Datum JJJJ-MM-TT
  wer text not null,                    -- erste 12 Hex-Zeichen von SHA-256(Sync-Schluessel)
  abrufe integer not null default 0,    -- GET /sync
  sendungen integer not null default 0, -- PUT /sync
  primary key (tag, wer)
);
