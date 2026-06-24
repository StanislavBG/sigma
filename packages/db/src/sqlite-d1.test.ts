import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSqliteD1 } from './sqlite-d1';

// Verifies the better-sqlite3 → D1 adapter against a real on-disk SQLite file: the exact D1 surface the
// query layer uses (prepare → bind → all<T>()/first<T>(col?)) plus FTS5 (search_index relies on it).

let dir: string;
let dbPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sigma-d1-'));
  dbPath = join(dir, 'test.sqlite');
  const seed = new Database(dbPath);
  seed.exec(`
    CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO t VALUES (1, 'alpha'), (2, 'beta');
    CREATE VIRTUAL TABLE fts USING fts5(subject);
    INSERT INTO fts (subject) VALUES ('строеж на път'), ('доставка на договор');
  `);
  seed.close();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('createSqliteD1', () => {
  it('all() returns the D1 { results } shape with bound params', async () => {
    const db = createSqliteD1(dbPath);
    const res = await db.prepare('SELECT id, name FROM t WHERE id >= ? ORDER BY id').bind(1).all();
    expect(res.results).toEqual([
      { id: 1, name: 'alpha' },
      { id: 2, name: 'beta' },
    ]);
  });

  it('first() returns the row, a single column, or null', async () => {
    const db = createSqliteD1(dbPath);
    expect(await db.prepare('SELECT id, name FROM t WHERE id = ?').bind(2).first()).toEqual({
      id: 2,
      name: 'beta',
    });
    expect(await db.prepare('SELECT name FROM t WHERE id = ?').bind(2).first('name')).toBe('beta');
    expect(await db.prepare('SELECT id FROM t WHERE id = ?').bind(999).first()).toBeNull();
  });

  it('runs FTS5 MATCH queries (search_index depends on it)', async () => {
    const db = createSqliteD1(dbPath);
    const hit = await db
      .prepare('SELECT count(*) AS c FROM fts WHERE fts MATCH ?')
      .bind('договор')
      .first<{ c: number }>();
    expect(hit?.c).toBe(1);
  });
});
