-- Additive enrichment table for Sigma. NOT part of the app's tracked migrations — created on
-- demand by enrich.mjs (CREATE TABLE IF NOT EXISTS) so it never collides with packages/db/migrations.
-- Joined to the core data by EIK (= bidders.bulstat / bidders.eik_normalized / *_totals.eik).
CREATE TABLE IF NOT EXISTS company_enrichment (
  eik              TEXT PRIMARY KEY,   -- Bulgarian ЕИК / UIC, the universal join key
  name             TEXT,               -- name as seen at enrichment time (provenance only)

  -- CompanyBook (Trade Register mirror) — needs a verified free API key
  cb_legal_form    TEXT,
  cb_status        TEXT,
  cb_seat          TEXT,               -- JSON {country,region,address}
  cb_capital       TEXT,               -- JSON {amount,currency}
  cb_managers      TEXT,               -- JSON array of names/roles
  cb_partners      TEXT,               -- JSON array of owners/partners
  cb_nkids         TEXT,               -- JSON array of activity (NKID) codes
  cb_subsidiaries  INTEGER,            -- count of daughter companies
  cb_financials    TEXT,               -- JSON latest income/balance/ratios

  -- GLEIF (LEI) — no auth
  lei              TEXT,
  gleif_legal_form TEXT,
  gleif_status     TEXT,
  gleif_address    TEXT,               -- JSON legal address
  gleif_validation TEXT,               -- corroboration level
  gleif_parent     TEXT,               -- ultimate-parent name, if any (ownership graph)

  -- TED (EU eForms) — no auth
  ted_notice_count INTEGER,            -- notices naming this entity as a tendering party

  -- provenance
  sources          TEXT,               -- JSON array of sources that returned data
  raw              TEXT,               -- JSON of full raw payloads (audit / re-derivation)
  enriched_at      TEXT                -- ISO timestamp of last successful refresh
);
CREATE INDEX IF NOT EXISTS idx_company_enrichment_lei ON company_enrichment(lei);
CREATE INDEX IF NOT EXISTS idx_company_enrichment_at ON company_enrichment(enriched_at);
