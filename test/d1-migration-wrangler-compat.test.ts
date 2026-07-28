import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { unstable_splitSqlQuery } from 'wrangler';
import { describe, expect, it } from 'vitest';

const MIGRATIONS_DIRECTORY = resolve('migrations');

describe('D1 migration Wrangler compatibility', () => {
  it('keeps the migration ledger insert outside every compound SQL statement', () => {
    const migrationNames = readdirSync(MIGRATIONS_DIRECTORY)
      .filter((name) => name.endsWith('.sql'))
      .sort();

    expect(migrationNames.length).toBeGreaterThan(0);
    for (const migrationName of migrationNames) {
      const ledgerInsert =
        `INSERT INTO d1_migrations (name) values ('${migrationName.replaceAll("'", "''")}')`;
      const source = readFileSync(resolve(MIGRATIONS_DIRECTORY, migrationName), 'utf8');
      const statements = unstable_splitSqlQuery(`${source}\n${ledgerInsert};`);

      expect(statements.at(-1), migrationName).toBe(ledgerInsert);
      for (const statement of statements) {
        if (!/^CREATE\s+TRIGGER\b/i.test(statement)) continue;
        expect(statement.match(/;/g) ?? [], migrationName).toHaveLength(1);
      }
    }
  });
});
