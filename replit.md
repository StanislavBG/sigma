# Sigma on Replit

This file is the Replit-facing companion to [`AGENTS.md`](AGENTS.md) (the repo's source of truth
for conventions) and the design docs in [`docs/`](docs/). It explains **how Sigma runs on Replit**,
**where the data lives**, and **what still has to be ported**. Read `AGENTS.md` for branching/commit
rules — they are unchanged here. Read `docs/architecture.md` and `docs/etl.md` for _why_ the system
is shaped the way it is.

> **TL;DR** — Sigma is a React Router v7 SSR app over a ~1.7 GB SQLite corpus of Bulgarian public
> procurement. It was built for **Cloudflare Workers + D1**. Hosting it on Replit means (a) running a
> **Node server** instead of the Workers runtime, and (b) keeping the **SQLite corpus on Replit's
> persistent disk — never in git**. The git repo is public; the data is not in it.

## What this project is

A public, read-only explorer/visualizer over ~192k procurement contracts (2020–present) from ЦАИС
ЕОП (`storage.eop.bg`). Bulgarian UI. Surfaces: search, company/authority profiles, contract detail,
flows (Sankey), trends, competition, a **network graph**, CSV/JSON open-data exports. Everything is
server-rendered against the corpus; there is no public write path and no auth. Scope and data model
are documented in [`docs/`](docs/) — do not re-derive them.

## The data: hosted on Replit, never in git

The served corpus is a **single SQLite database (~1.7 GB)**: domain tables (contracts, tenders, lots,
authorities, bidders) + precomputed rollups + an FTS5 search index. It is **gitignored** (`.gitignore`
excludes `data/`, `*.sqlite`, `.wrangler/`) and must stay that way — a public repo must never carry it.

**Specified environment: SQLite on the Repl's persistent disk** (`SIGMA_DB_PATH`, default
`/home/runner/<repl>/data-runtime/sigma.sqlite`). Rationale: D1 _is_ SQLite, and `packages/db`'s queries
plus the FTS5 search index are SQLite-dialect — keeping SQLite means **zero query rewrites**. The
alternative (migrate to Replit Postgres) is a large rewrite (every query + FTS5 → `tsvector`/`pg_trgm`)
and is only worth it if you need Replit **Autoscale** (stateless) instead of a **Reserved VM**.

Because SQLite needs a stable filesystem, **deploy as a Replit Reserved VM** (`deploymentTarget = "vm"`
in `.replit`), which has a persistent disk. Autoscale would lose the file between instances.

> **Where the served corpus actually lives today.** The app runs on Replit through **miniflare**
> (`pnpm dev`/`pnpm start`), whose D1 is a SQLite file under
> `apps/web/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/`. That is what gets served — so the data
> pipeline below writes/ships there. `SIGMA_DB_PATH` is reserved for the _future_ Node-server adapter
> (port checklist below); it is unused while miniflare is the runtime.

### Getting the data into a fresh Repl (it is not in git)

1. **Sample data (fastest, works offline)** — `pnpm setup` applies the D1 migrations and loads
   `scripts/seed.sql` (a small sample) into `apps/web/.wrangler/state`. The app runs immediately with
   representative-but-partial data. Best for first boot / UI work.
2. **Full corpus** — built locally and pushed over SSH; see the runbook next.

### Production runbook: local ETL → rsync → online (the chosen flow)

The corpus is built and refreshed **on your local machine**, then pushed to the Repl over SSH. rsync
sends only changed SQLite pages, so steady-state refreshes are cheap. (Decision: rsync-over-SSH, 2026.)

**One-time, on the Repl:** enable SSH in the Repl's SSH pane and add your public key; note the ssh
target (`user@host`).

**One-time backfill (local):**

```bash
# needs the sqlite3 CLI + the data/eop buckets (see docs/etl.md)
pnpm bootstrap          # or: pnpm run import   — full backfill into apps/web/.wrangler/state
REPLIT_SSH=user@host REPLIT_DIR=~/sigma pnpm run replit:push    # rsync the ~1.7 GB D1 up once
```

**Recurring refresh (local), keeps the online copy fresh:**

```bash
REPLIT_SSH=user@host pnpm run replit:refresh    # = import --catchup  +  rsync the changed pages
```

`scripts/replit-push.mjs` checkpoints the WAL, then rsyncs
`apps/web/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/` to the same path on the Repl (`--dry-run`
to preview; `REPLIT_DIR` defaults to `~/sigma`; `SSH_OPTS` for a custom port/key). **After a push,
restart the Repl** (its "Sigma Dev" workflow or the deployment) so the app reopens the swapped file.
Run pushes when the local dev server/ETL is idle so the snapshot is consistent. Per the project rule:
full backfill **once**, catch-up only after — never re-import the whole corpus.

**Prerequisite:** the ETL shells out to the **`sqlite3` CLI** (work-DB transforms); install it locally
(`apt install sqlite3` / nix `pkgs.sqlite`). The Repl already has it via `replit.nix`.

**Caveat (size):** miniflare/workerd must open the 1.7 GB served file. The served DB was split out from
the ~1.8 GB ETL staging precisely so workerd can open it, but if it balks on the Repl, the fallback is
the Node-server + `better-sqlite3` adapter below (no size limit).

## Runtime reality: this targets Cloudflare Workers today

Sigma currently boots through the **Cloudflare Workers** runtime, not plain Node. The coupling points
(all in `apps/web/workers/app.ts` + `apps/web/vite.config.ts`):

- **D1** — query functions in `@sigma/db` take a `D1Database` (`env.DB`) and call
  `.prepare().bind().all()/.first()` (the D1 API).
- **`caches.default`** — the per-colo edge cache used for page caching.
- **R2 `CSV_CACHE`** — cached CSV exports.
- **Rate-limit bindings** — `CSV_RATE_LIMITER`, `AGG_RATE_LIMITER`, `SEARCH_RATE_LIMITER`.
- **`@cloudflare/vite-plugin`** — runs the SSR in a `workerd` environment (miniflare) for dev.

`pnpm dev` works on Replit **as long as `workerd`/miniflare runs in the Nix env** (it is x86_64 Linux,
so it generally does), emulating D1/R2/caches locally. That gives you a running dev server fast. A real
**production** deploy on Replit, however, needs a Node server — see the checklist.

## Replit port checklist (the actual work)

To run as a deployable Replit **Node** full-stack app (not just the miniflare dev server):

1. **Node server entry** — add a small Hono/Express server that calls React Router v7's
   `createRequestHandler` (`@react-router/node`) and builds the `AppLoadContext`. Wire it to a
   `pnpm start` script (referenced by `.replit` `[deployment].run`). React Router v7 supports a Node
   adapter; this replaces `apps/web/workers/app.ts` for the Node target.
2. **D1 → SQLite adapter** — implement a thin object that satisfies the `D1Database` interface
   (`prepare/bind/all/first/run/batch`) backed by `better-sqlite3` (or `@libsql/client`) opening
   `SIGMA_DB_PATH`. Inject it as `context.cloudflare.env.DB`. **This keeps every `@sigma/db` query
   unchanged** — the highest-leverage step.
3. **Drop/replace the edge primitives** — `caches.default` → standard HTTP `Cache-Control` (Replit/CDN
   handles caching) or a small in-memory LRU; R2 `CSV_CACHE` → local disk or regenerate on demand;
   rate-limit bindings → optional Node middleware (or no-op behind Replit's networking).
4. **Vite config** — add a Node build target alongside (or instead of) the `@cloudflare/vite-plugin`
   SSR environment for the deployed server.
5. **ETL refresh** — the 6-hourly Cloudflare cron Worker (`apps/etl`) has no Replit equivalent; replace
   with a Replit Scheduled Deployment or a cron that runs the catch-up import against `SIGMA_DB_PATH`.

Keep this incremental: steps 1–2 get the app serving real data on Node; 3–5 restore caching, exports,
and auto-refresh.

## Commands

| Command           | What it does                                                                  |
| ----------------- | ----------------------------------------------------------------------------- |
| `pnpm install`    | Install workspace deps (pnpm + turbo monorepo)                                |
| `pnpm setup`      | One-time: deps + D1 migrations + small sample data into local miniflare state |
| `pnpm dev`        | Run the app (Workers dev server via Vite/miniflare) on `:5173` + ETL worker   |
| `pnpm build`      | Turbo build across the monorepo                                               |
| `pnpm test`       | Vitest across packages                                                        |
| `pnpm run import` | Full ETL backfill/catch-up from `storage.eop.bg` (see `docs/etl.md`)          |
| `pnpm start`      | **Not yet present** — the Node server entry from the port checklist           |

## Secrets / env

- **No secrets are required to serve** — the corpus is public data and there is no auth/write path.
- ETL ingestion credentials (НАП/АОП/Търговски регистър), if used for refresh, are **production
  secrets**: set them via Replit **Secrets**, never in git, never in `.replit`. `.env*` and `.dev.vars`
  are gitignored — keep it so.
- `SIGMA_DB_PATH` (in `.replit` `[env]`) points the Node adapter at the SQLite corpus on persistent disk.

## Conventions

All repo conventions live in [`AGENTS.md`](AGENTS.md) and apply unchanged: conventional commits, one
branch per change, **never commit secrets/`.env*`/data**, decisions go in `docs/` not scattered notes.
The only Replit-specific addition is this file plus `.replit` / `replit.nix`.
