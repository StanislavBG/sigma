#!/usr/bin/env node
// Push the locally-built served D1 (the SQLite corpus) to the Replit-hosted app over SSH.
//
// Flow:  local ETL (pnpm import / --catchup)  →  this script (rsync)  →  Repl persistent disk  →  pnpm start
//
// The corpus is NEVER in git (it is ~1.7 GB); rsync moves only the changed SQLite pages, so steady-state
// catch-up pushes are cheap. The app on the Repl reads this same miniflare D1 path, so after a push you
// restart the Repl (or its "Sigma Dev" workflow / deployment) to reopen the swapped file.
//
// Required env:
//   REPLIT_SSH   ssh target for the Repl, e.g. "user@host" or a ~/.ssh/config alias. Get it from the
//                Repl's SSH pane (add your public key there first).
// Optional env:
//   REPLIT_DIR   absolute path of the cloned repo on the Repl (default: "~/sigma").
//   SSH_OPTS     extra ssh options (e.g. "-p 22 -i ~/.ssh/replit").
// Flags:
//   --dry-run    show what rsync would transfer without writing.
//   --no-checkpoint  skip the WAL checkpoint (use if sqlite3 is unavailable / DB is busy).

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');
const doCheckpoint = !process.argv.includes('--no-checkpoint');

const sshTarget = process.env.REPLIT_SSH;
if (!sshTarget) {
  console.error(
    'ERROR: set REPLIT_SSH to the Repl ssh target (e.g. REPLIT_SSH=user@host). See the Repl SSH pane.',
  );
  process.exit(1);
}
const remoteDir = process.env.REPLIT_DIR || '~/sigma';
const sshOpts = process.env.SSH_OPTS || '';

// The served D1 lives in the miniflare state apps/web reads (apps/web/vite.config.ts persistState).
const d1Rel = 'apps/web/.wrangler/state/v3/d1/miniflare-D1DatabaseObject';
const localD1 = join(root, d1Rel);
if (!existsSync(localD1)) {
  console.error(
    `ERROR: ${d1Rel} not found locally.\n` +
      'Build the corpus first — `pnpm bootstrap` (full backfill) or `pnpm import --catchup` (refresh).',
  );
  process.exit(1);
}

// Fold the WAL into the main DB so the snapshot we rsync is self-consistent. The main DB is the hashed
// *.sqlite (not metadata.sqlite). Best run when the local dev server / ETL is idle.
if (doCheckpoint) {
  const main = readdirSync(localD1).find((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
  if (main) {
    try {
      execFileSync('sqlite3', [join(localD1, main), 'PRAGMA wal_checkpoint(TRUNCATE);'], {
        stdio: 'inherit',
      });
      console.log('==> checkpointed WAL into the main DB');
    } catch {
      console.warn('!! sqlite3 checkpoint failed (sqlite3 missing or DB busy) — continuing as-is');
    }
  }
}

const remotePath = `${sshTarget}:${remoteDir}/${d1Rel}/`;
// --delete removes stale shards on the Repl; trailing slashes sync dir CONTENTS into the matching dir.
const rsyncArgs = [
  '-az',
  '--delete',
  '--mkpath',
  '--info=progress2',
  ...(dryRun ? ['--dry-run'] : []),
  ...(sshOpts ? ['-e', `ssh ${sshOpts}`] : []),
  `${localD1}/`,
  remotePath,
];

console.log(`==> rsync ${d1Rel}/  ->  ${remotePath}${dryRun ? '  (dry run)' : ''}`);
try {
  execFileSync('rsync', rsyncArgs, { stdio: 'inherit' });
} catch (err) {
  console.error(`\n!! rsync failed: ${err.message}`);
  console.error('   Check REPLIT_SSH / SSH_OPTS and that your key is added in the Repl SSH pane.');
  process.exit(1);
}

if (!dryRun) {
  console.log(
    '\n==> Done. Restart the Repl (its "Sigma Dev" workflow or the deployment) so the app reopens the new DB.',
  );
}
