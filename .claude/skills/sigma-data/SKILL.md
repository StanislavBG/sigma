---
name: sigma-data
description: Query the live Sigma procurement database (Cloudflare D1 / local miniflare SQLite) directly from a session. Use whenever the user wants to look into the data — top companies/authorities, contracts, sectors, flows, totals, ad-hoc SQL, schema inspection, or to sanity-check what the site is serving. Read-only. Keywords: query sigma, look into the data, top companies, top authorities, contracts, D1, SQL, schema, who won, how much.
---

# sigma-data — live read-only queries against the Sigma D1

The Sigma website is 100% live-query: every page loader calls a function in
`packages/db/src/queries/*` against the D1 binding `context.cloudflare.env.DB`. Locally that D1
is a plain SQLite file under `apps/web/.wrangler/state/v3/d1/`. This skill queries that same file,
so what you read here is exactly what the running site would render.

## How to use

Run the helper (auto-resolves the local D1 file, refuses non-read queries):

```bash
node .claude/skills/sigma-data/query.mjs --schema                       # tables + row counts
node .claude/skills/sigma-data/query.mjs "SELECT name, won_eur, contracts FROM company_totals ORDER BY won_eur DESC LIMIT 10"
node .claude/skills/sigma-data/query.mjs --json "SELECT * FROM authority_totals LIMIT 5"
echo "SELECT * FROM data_freshness" | node .claude/skills/sigma-data/query.mjs
```

- Override the DB file with `--db <path>` or `SIGMA_D1_SQLITE=<path>`.
- Only `SELECT` / `WITH` / `PRAGMA` / `EXPLAIN` are allowed (read-only by design).
- For the remote/production D1 instead of local, use the project's own tool:
  `cd apps/web && wrangler d1 execute sigma --remote --command "SELECT ..."` (needs Cloudflare auth).

## What's in the database (the entities)

The site serves **contracts** as the unit, aggregated up to **companies** (winning bidders) and
**authorities** (institutions). Read-heavy pages hit precomputed rollups, not the base tables.

| Table | What it is |
|---|---|
| `authorities` | Institutions (id = `auth:<EIK>`, `bulstat` = EIK, `type_group`, location) |
| `bidders` | Companies/consortia (id = `eik:<EIK>` or `name:<slug>`, `bulstat` = raw EIK, `eik_normalized`, `ownership_kind`, `legal_form`) |
| `tenders` / `lots` / `contracts` / `amendments` | Procurement base records (contracts carry `amount_eur`, `value_flag`, `eu_funded`, `signed_at`) |
| `company_totals` | **Rollup** per company: `won_eur`, `contracts`, `authorities`, `primary_sector`, `eu_eur` — what the Companies leaderboard reads |
| `authority_totals` | **Rollup** per authority: `spent_eur`, `contracts`, `suppliers`, `avg_eur` |
| `home_totals` / `sector_totals` / `facet_counts` | Homepage + facet rollups |
| `flow_pairs` | Authority→company money edges (the Flows / Sankey view; closest thing to a graph) |
| `fx_rates` / `nuts_regions` / `data_freshness` | FX (ECB), region lookups, freshness watermark |
| `company_enrichment` | **Added by the `sigma-enrich` skill** — CompanyBook/GLEIF/TED enrichment, joinable by EIK |

Join enrichment to the core data by EIK, e.g.:

```sql
SELECT t.name, t.won_eur, e.lei, e.cb_status, e.cb_managers
FROM company_totals t
LEFT JOIN company_enrichment e ON e.eik = t.eik
ORDER BY t.won_eur DESC LIMIT 20;
```

## Notes

- If a rollup is empty, the DB only holds the demo seed — run the `sigma-enrich` skill (or
  `pnpm import`) to populate real data first.
- Values are EUR (`*_eur` columns), FX-normalised; rows flagged `value_flag` are excluded from the
  site's money sums by design — filter `value_flag IS NULL` to match the site.
- This skill never writes. To build/maintain data, use the **`sigma-enrich`** skill.
