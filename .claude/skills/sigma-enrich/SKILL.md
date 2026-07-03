---
name: sigma-enrich
description: Build up and maintain the Sigma database by enriching companies (by EIK) from free adjacent sources — CompanyBook (Bulgarian Trade Register mirror), GLEIF (LEI), and TED (EU procurement). Writes an additive company_enrichment table joinable to the live data. Use whenever the user wants to populate, grow, refresh, or maintain enrichment data — directors, owners, capital, subsidiaries, financials, LEI, ownership graph, EU footprint. Keywords: enrich, build database, maintain data, populate, refresh, company info, owners, directors, financials, LEI, CompanyBook, GLEIF, TED, top companies.
---

# sigma-enrich — build & maintain enrichment for Sigma entities

Sigma's core data (companies/authorities/contracts) comes from storage.eop.bg and carries little
about _who the companies are_. This skill enriches them, by **EIK**, from three free sources and
writes an additive `company_enrichment` table that the `sigma-data` skill (and the app, if wired)
can join to `bidders` / `company_totals`.

| Source          | Auth                               | Adds                                                                                                         |
| --------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **GLEIF**       | none                               | LEI, legal form, validated address, status, ultimate parent (ownership graph)                                |
| **TED**         | none                               | count of EU notices naming the company (EU footprint, cross-border)                                          |
| **CompanyBook** | `X-API-Key` (free, verified email) | legal form, status, seat, capital, managers, partners/owners, NKID activity, subsidiaries, latest financials |

GLEIF + TED always run (no auth). CompanyBook runs only if `COMPANYBOOK_API_KEY` is set **and the
account's email is verified** (otherwise the API returns `emailNotVerified`).

## Quick start

```bash
# free/no-auth layer for the 25 best-funded companies already in the DB
node .claude/skills/sigma-enrich/enrich.mjs --top 25 --no-companybook

# full enrichment (needs verified key) for an explicit list
export COMPANYBOOK_API_KEY=...           # from https://companybook.bg account page
node .claude/skills/sigma-enrich/enrich.mjs --eik 831641791,103267194 --name "ИНФОРМАЦИОННО ОБСЛУЖВАНЕ АД"

# enrich from a ranked feed file (e.g. [{eik,name},...])
node .claude/skills/sigma-enrich/enrich.mjs --from-json /tmp/top.json

# maintenance: refresh everything older than 30 days, capped to free-tier budgets
node .claude/skills/sigma-enrich/enrich.mjs --all-bidders --stale 30 --cb-limit 90 --fin-limit 28
```

Then read it back with the sister skill:

```bash
node .claude/skills/sigma-data/query.mjs \
  "SELECT name, lei, cb_status, cb_subsidiaries, ted_notice_count FROM company_enrichment ORDER BY enriched_at DESC LIMIT 20"
```

## Target selectors (pick one)

- `--top N` — best-funded companies from `company_totals` (or computed from `contracts` if rollups are empty)
- `--eik a,b,c` — explicit EIK list (`--name` improves TED/GLEIF matching for a single EIK)
- `--from-json FILE` — array of `{eik, name}`
- `--all-bidders [LIMIT]` — every bidder with a valid EIK

## Maintenance behaviour

- **Idempotent UPSERT** on EIK; new non-null values fill in, `enriched_at` is bumped.
- `--stale DAYS` (default 30) skips rows refreshed recently; `--force` re-fetches all.
- Free-tier guards: `--cb-limit` (profiles, ≤100/day) and `--fin-limit` (financials, ≤30/day) cap
  CompanyBook calls per run so you can grow the DB across sessions without hitting limits.
- `--dry-run` fetches and prints without writing.

## Notes / safety

- The API key is read **only** from `COMPANYBOOK_API_KEY` — never hardcode or commit it.
- Writes to the local D1 sqlite. If `pnpm dev` is running it holds the file; the script waits up to
  10s (busy_timeout). If you see lock errors, stop the dev server, enrich, then restart.
- `company_enrichment` is created with `CREATE TABLE IF NOT EXISTS` and is **not** added to
  `packages/db/migrations` — it stays additive and never collides with the app's schema.
- To also load real _core_ procurement data first, use the project's own `pnpm import` (the EOP ETL);
  this skill enriches whatever companies exist, it does not replace the ETL.
