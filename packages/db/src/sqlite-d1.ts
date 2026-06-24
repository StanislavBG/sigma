// A minimal D1Database adapter backed by better-sqlite3, for running the read-only @sigma/db query
// layer on Node (e.g. a Replit host) directly against an on-disk SQLite corpus — no Cloudflare D1.
//
// It implements only the D1 surface the query layer actually uses: `prepare(sql)` → `.bind(...args)` →
// `.all<T>()` / `.first<T>(col?)`. The served app never writes, so the connection is read-only; the ETL
// writes the file out of band. better-sqlite3 bundles FTS5, so the search_index queries run unchanged.
//
// NOT exported from the package barrel — import it as `@sigma/db/sqlite` so better-sqlite3 (a native
// module) never gets pulled into the Cloudflare Workers bundle, which keeps its own real D1 binding.
import Database from 'better-sqlite3';

type Row = Record<string, unknown>;

class SqliteStatement {
  #stmt: Database.Statement;
  #params: unknown[] = [];

  constructor(stmt: Database.Statement) {
    this.#stmt = stmt;
  }

  bind(...params: unknown[]): this {
    // D1 accepts null for an absent parameter; better-sqlite3 rejects `undefined`, so normalise.
    this.#params = params.map((p) => (p === undefined ? null : p));
    return this;
  }

  async all<T = Row>(): Promise<{ results: T[]; success: true; meta: Record<string, never> }> {
    return { results: this.#stmt.all(...this.#params) as T[], success: true, meta: {} };
  }

  async first<T = Row>(column?: string): Promise<T | null> {
    const row = this.#stmt.get(...this.#params) as Row | undefined;
    if (row === undefined) return null;
    return (column === undefined ? row : (row[column] ?? null)) as T | null;
  }
}

class SqliteD1 {
  #db: Database.Database;

  constructor(path: string) {
    this.#db = new Database(path, { readonly: true, fileMustExist: true });
    this.#db.pragma('query_only = ON');
  }

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.#db.prepare(sql));
  }

  close(): void {
    this.#db.close();
  }
}

/**
 * Open `path` as a read-only D1-compatible database. The returned value satisfies the subset of the
 * `D1Database` interface the @sigma/db query layer uses, so the queries run unchanged on Node.
 */
export function createSqliteD1(path: string): D1Database {
  return new SqliteD1(path) as unknown as D1Database;
}
