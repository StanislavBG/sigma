#!/usr/bin/env node
// sigma-enrich: build up & maintain the company_enrichment table from free adjacent sources.
//   - GLEIF   (no auth)            -> LEI, legal form, validated address, status, ownership parent
//   - TED     (no auth)            -> count of EU notices naming the company as tendering party
//   - CompanyBook (X-API-Key)      -> legal form, status, seat, capital, managers, partners,
//                                     NKID codes, subsidiaries, latest financials
//
// Idempotent UPSERT keyed on EIK. Re-running refreshes; rows fresh within --stale days are skipped.
//
// Pick targets (one of):
//   --top N            rank companies by funding from company_totals (or contracts if empty) and enrich top N
//   --eik 831641791,103267194[,...]            explicit list
//   --name "СОФАРМА ТРЕЙДИНГ АД"                pair with a single --eik for better TED/GLEIF naming
//   --from-json /path.json                      array of {eik,name} (e.g. the ranked feed output)
//   --all-bidders [LIMIT]                        every bidder in the DB with a valid EIK
//
// Options:
//   --stale DAYS   (default 30)  skip rows refreshed within DAYS
//   --force                      ignore staleness
//   --no-companybook             skip CompanyBook (GLEIF+TED only, fully free/no-auth)
//   --cb-limit N   (default 25)  cap CompanyBook profile calls this run (free tier = 100/day)
//   --fin-limit N  (default 25)  cap CompanyBook financial calls (free tier = 30/day)
//   --db PATH | SIGMA_D1_SQLITE  override the D1 sqlite file
//   --dry-run                    fetch + print, do not write
//
// Env: COMPANYBOOK_API_KEY (required for CompanyBook; email must be verified).

{
  const e = process.emit;
  process.emit = function (n, w) {
    return n === 'warning' && w?.name === 'ExperimentalWarning'
      ? false
      : e.apply(process, arguments);
  };
}
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(n);
  return i === -1 ? d : (argv[i + 1] ?? true);
};
const has = (n) => argv.includes(n);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SKILL = dirname(fileURLToPath(import.meta.url));
const KEY = process.env.COMPANYBOOK_API_KEY;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BGN = 1.95583;

function resolveDb() {
  if (process.env.SIGMA_D1_SQLITE) return process.env.SIGMA_D1_SQLITE;
  if (typeof flag('--db') === 'string') return flag('--db');
  for (const app of ['apps/web', 'apps/etl']) {
    const dir = resolve(ROOT, app, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
    if (!existsSync(dir)) continue;
    const hit = readdirSync(dir).find((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
    if (hit) return resolve(dir, hit);
  }
  throw new Error('No local D1 sqlite found. Run `pnpm run setup` first.');
}

async function getJSON(url, opts) {
  try {
    const r = await fetch(url, opts);
    const t = await r.text();
    try {
      return { ok: r.ok, status: r.status, body: JSON.parse(t) };
    } catch {
      return { ok: r.ok, status: r.status, body: t };
    }
  } catch (e) {
    return { ok: false, status: 0, body: String(e) };
  }
}

// ---- source probes -------------------------------------------------------
async function gleif(eik) {
  const r = await getJSON(
    `https://api.gleif.org/api/v1/lei-records?filter[entity.registeredAs]=${encodeURIComponent(eik)}`,
  );
  const rec = r.body?.data?.[0];
  if (!rec) return null;
  const a = rec.attributes;
  const lei = a.lei;
  let parent = null;
  const p = await getJSON(`https://api.gleif.org/api/v1/lei-records/${lei}/ultimate-parent`);
  parent = p.body?.data?.attributes?.entity?.legalName?.name ?? null;
  return {
    lei,
    legal_form: a.entity?.legalForm?.id ?? null,
    status: a.entity?.status ?? null,
    address: a.entity?.legalAddress ?? null,
    validation: a.registration?.corroborationLevel ?? null,
    parent,
    raw: a,
  };
}
async function ted(name) {
  if (!name) return null;
  const r = await getJSON('https://api.ted.europa.eu/v3/notices/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `tendering-party-name="${name.replace(/"/g, '')}"`,
      fields: ['publication-number'],
      limit: 1,
    }),
  });
  return { notice_count: r.body?.totalNoticeCount ?? null };
}
async function companybook(eik, doFin) {
  if (!KEY) return { skipped: 'no-key' };
  const H = { headers: { 'X-API-Key': KEY } };
  const c = await getJSON(`https://api.companybook.bg/api/companies/${eik}?with_data=true`, H);
  if (!c.ok || c.body?.error)
    return { error: c.body?.errorEN || c.body?.error || `HTTP ${c.status}` };
  const co = c.body.company || c.body;
  const out = {
    legal_form: co.legalForm ?? null,
    status: co.status ?? null,
    seat: co.seat ?? null,
    capital: co.capital ?? null,
    managers: co.managers ?? null,
    partners: co.partners ?? null,
    nkids: co.nkids ?? null,
    subsidiaries: Array.isArray(c.body.daughters) ? c.body.daughters.length : null,
    financials: null,
    raw: co,
  };
  if (doFin) {
    const f = await getJSON(`https://api.companybook.bg/api/companies/${eik}/financial`, H);
    if (f.ok && !f.body?.error) out.financials = Array.isArray(f.body) ? f.body[0] : f.body;
  }
  return out;
}

// ---- target selection ----------------------------------------------------
function num(s) {
  if (s == null || s === '') return 0;
  return parseFloat(String(s).replace(/\s/g, '').replace(/\./g, '').replace(',', '.')) || 0;
}
function targets(db) {
  if (typeof flag('--from-json') === 'string')
    return JSON.parse(readFileSync(flag('--from-json'), 'utf8')).filter((x) => x.eik);
  if (typeof flag('--eik') === 'string') {
    const eiks = String(flag('--eik'))
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const name = typeof flag('--name') === 'string' ? flag('--name') : null;
    return eiks.map((eik, i) => ({ eik, name: eiks.length === 1 ? name : null }));
  }
  if (has('--top')) {
    const n = Number(flag('--top')) || 10;
    const ct = db.prepare('SELECT COUNT(*) c FROM company_totals').get().c;
    if (ct > 0)
      return db
        .prepare(
          `SELECT eik, name FROM company_totals WHERE eik IS NOT NULL AND eik_valid=1 ORDER BY won_eur DESC LIMIT ?`,
        )
        .all(n);
    // fall back to base contracts if rollups are empty
    return db
      .prepare(
        `SELECT b.bulstat AS eik, b.name AS name, SUM(COALESCE(c.amount_eur,0)) won
       FROM contracts c JOIN bidders b ON b.id=c.bidder_id
       WHERE b.bulstat IS NOT NULL GROUP BY b.bulstat ORDER BY won DESC LIMIT ?`,
      )
      .all(n);
  }
  if (has('--all-bidders')) {
    const lim = Number(flag('--all-bidders')) || 100000;
    return db
      .prepare(`SELECT bulstat AS eik, name FROM bidders WHERE bulstat IS NOT NULL LIMIT ?`)
      .all(lim);
  }
  throw new Error('No target selector. Use --top N | --eik a,b | --from-json f | --all-bidders.');
}

// ---- main ----------------------------------------------------------------
const dbPath = resolveDb();
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout=10000');
db.exec(readFileSync(resolve(SKILL, 'schema.sql'), 'utf8'));

const dry = has('--dry-run');
const staleDays = Number(flag('--stale', 30));
const noCB = has('--no-companybook');
let cbBudget = Number(flag('--cb-limit', 25));
let finBudget = Number(flag('--fin-limit', 25));
const list = targets(db);
console.error(
  `db: ${dbPath}\ntargets: ${list.length}  | companybook: ${noCB ? 'off' : KEY ? 'on' : 'no-key'}  | stale<${staleDays}d skipped\n`,
);

const upsert = db.prepare(`INSERT INTO company_enrichment
  (eik,name,cb_legal_form,cb_status,cb_seat,cb_capital,cb_managers,cb_partners,cb_nkids,cb_subsidiaries,cb_financials,
   lei,gleif_legal_form,gleif_status,gleif_address,gleif_validation,gleif_parent,ted_notice_count,sources,raw,enriched_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?, ?, ?,?,?)
  ON CONFLICT(eik) DO UPDATE SET
   name=excluded.name,
   cb_legal_form=COALESCE(excluded.cb_legal_form,cb_legal_form),
   cb_status=COALESCE(excluded.cb_status,cb_status),
   cb_seat=COALESCE(excluded.cb_seat,cb_seat),
   cb_capital=COALESCE(excluded.cb_capital,cb_capital),
   cb_managers=COALESCE(excluded.cb_managers,cb_managers),
   cb_partners=COALESCE(excluded.cb_partners,cb_partners),
   cb_nkids=COALESCE(excluded.cb_nkids,cb_nkids),
   cb_subsidiaries=COALESCE(excluded.cb_subsidiaries,cb_subsidiaries),
   cb_financials=COALESCE(excluded.cb_financials,cb_financials),
   lei=COALESCE(excluded.lei,lei),
   gleif_legal_form=COALESCE(excluded.gleif_legal_form,gleif_legal_form),
   gleif_status=COALESCE(excluded.gleif_status,gleif_status),
   gleif_address=COALESCE(excluded.gleif_address,gleif_address),
   gleif_validation=COALESCE(excluded.gleif_validation,gleif_validation),
   gleif_parent=COALESCE(excluded.gleif_parent,gleif_parent),
   ted_notice_count=COALESCE(excluded.ted_notice_count,ted_notice_count),
   sources=excluded.sources, raw=excluded.raw, enriched_at=excluded.enriched_at`);
const getFresh = db.prepare('SELECT enriched_at FROM company_enrichment WHERE eik=?');

let done = 0,
  skipped = 0;
const now = Date.now();
for (const t of list) {
  const eik = String(t.eik).trim();
  if (!/^[0-9]{9,13}$/.test(eik)) {
    console.error('skip (bad eik):', eik);
    continue;
  }
  if (!has('--force')) {
    const prev = getFresh.get(eik);
    if (prev?.enriched_at && now - Date.parse(prev.enriched_at) < staleDays * 86400e3) {
      skipped++;
      continue;
    }
  }
  const sources = [];
  const g = await gleif(eik);
  if (g) sources.push('gleif');
  const td = await ted(t.name);
  if (td?.notice_count != null) sources.push('ted');
  let cb = null;
  if (!noCB && KEY && cbBudget > 0) {
    const doFin = finBudget > 0;
    cb = await companybook(eik, doFin);
    if (cb && !cb.error && !cb.skipped) {
      sources.push('companybook');
      cbBudget--;
      if (doFin && cb.financials) finBudget--;
    }
  }
  const raw = JSON.stringify({ gleif: g?.raw, companybook: cb?.raw, ted: td });
  const row = [
    eik,
    t.name ?? null,
    cb?.legal_form ?? null,
    cb?.status ?? null,
    J(cb?.seat),
    J(cb?.capital),
    J(cb?.managers),
    J(cb?.partners),
    J(cb?.nkids),
    cb?.subsidiaries ?? null,
    J(cb?.financials),
    g?.lei ?? null,
    g?.legal_form ?? null,
    g?.status ?? null,
    J(g?.address),
    g?.validation ?? null,
    g?.parent ?? null,
    td?.notice_count ?? null,
    JSON.stringify(sources),
    raw,
    new Date().toISOString(),
  ];
  if (dry)
    console.log(
      JSON.stringify({
        eik,
        name: t.name,
        sources,
        lei: g?.lei,
        ted: td?.notice_count,
        cb: cb?.status ?? cb?.error ?? cb?.skipped,
      }),
    );
  else upsert.run(...row);
  done++;
  console.error(
    `  ${done}/${list.length} ${eik} [${sources.join(',') || 'none'}]${cb?.error ? ' cb:' + cb.error : ''}`,
  );
  await sleep(250);
}
function J(v) {
  return v == null ? null : JSON.stringify(v);
}
console.error(
  `\n${dry ? 'DRY-RUN ' : ''}done: ${done} enriched, ${skipped} fresh-skipped. cb-left=${cbBudget} fin-left=${finBudget}`,
);
