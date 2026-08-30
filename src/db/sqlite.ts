/**
 * SQLite -> PostgreSQL SQL translator.
 *
 * Business code keeps writing SQLite-flavored SQL (D1 dialect); the PostgreSQL
 * adapter routes every statement through `toPostgresSql` before execution.
 *
 * Covered rewrites:
 *  - `?` placeholders -> `$1,$2,...` (skipping string literals)
 *  - `INSERT OR REPLACE INTO t (cols) VALUES ...` -> `INSERT ... ON CONFLICT (pk) DO UPDATE SET ...`
 *  - `INSERT OR IGNORE INTO ...` -> `INSERT ... ON CONFLICT DO NOTHING`
 *  - `datetime('now'[, modifier])` -> UTC `'YYYY-MM-DD HH24:MI:SS'` string
 *    (matches the exact format D1 stored, so callers like `parseD1Date` keep working)
 *  - `strftime('%s','now')` -> `CAST(EXTRACT(EPOCH FROM now()) AS INTEGER)`
 *  - DDL `INTEGER PRIMARY KEY AUTOINCREMENT` -> `SERIAL PRIMARY KEY`
 *  - INSERT statements get ` RETURNING <pk>` appended so `meta.last_row_id` works
 */

import { TABLE_PRIMARY_KEYS } from './types';

const UTC_NOW = `(now() AT TIME ZONE 'UTC')`;
const TIME_FORMAT = `'YYYY-MM-DD HH24:MI:SS'`;
const DT_NOW = `to_char(${UTC_NOW}, ${TIME_FORMAT})`;

// datetime('now', '+' || ? || ' minutes'|' seconds'|...) - parameterized modifier
function replaceParamDatetime(sql: string): string {
  return sql.replace(
    /datetime\(\s*'now'\s*,\s*'\+\s*'\s*\|\|\s*\?\s*\|\|\s*'\s*(minutes|seconds|hours|days)'\s*\)/gi,
    (_m, unit: string) => `to_char(${UTC_NOW} + (('+' || ? || ' ${unit}')::interval), ${TIME_FORMAT})`
  );
}

// datetime('now', '+1 day') / datetime('now', '-10 minutes') - literal modifier
function replaceLiteralDatetime(sql: string): string {
  return sql.replace(
    /datetime\(\s*'now'\s*,\s*'([^']+)'\s*\)/gi,
    (_m, modifier: string) => `to_char(${UTC_NOW} + INTERVAL '${modifier}', ${TIME_FORMAT})`
  );
}

// datetime('now') / datetime("now")
function replacePlainDatetime(sql: string): string {
  return sql.replace(/datetime\(\s*["']now["']\s*\)/gi, () => DT_NOW);
}

// strftime('%s','now') -> unix seconds (keep an outer CAST(... AS INTEGER) intact)
function replaceStrftime(sql: string): string {
  let out = sql.replace(
    /CAST\s*\(\s*strftime\(\s*'%s'\s*,\s*["']now["']\s*\)\s*AS\s+INTEGER\s*\)/gi,
    () => `CAST(EXTRACT(EPOCH FROM now()) AS INTEGER)`
  );
  out = out.replace(
    /strftime\(\s*'%s'\s*,\s*["']now["']\s*\)/gi,
    () => `EXTRACT(EPOCH FROM now())`
  );
  return out;
}

function replaceInsertOrReplace(sql: string): string {
  const re = /INSERT\s+OR\s+REPLACE\s+INTO\s+(\w+)\s*\(([^)]*)\)/i;
  const m = sql.match(re);
  if (!m) return sql;

  const table = m[1].toLowerCase();
  const colsRaw = m[2];
  const cols = colsRaw
    .split(',')
    .map(c => c.trim())
    .filter(Boolean);
  const pks = TABLE_PRIMARY_KEYS[table] || [];
  if (pks.length === 0 || cols.length === 0) {
    // Unknown table: fall back to a plain INSERT (dup key will raise).
    return sql.replace(re, 'INSERT INTO $1 ($2)');
  }

  let out = sql.replace(re, `INSERT INTO ${m[1]} (${colsRaw})`).replace(/;\s*$/, '');

  const nonPk = cols.filter(c => !pks.includes(c));
  if (nonPk.length > 0) {
    out += ` ON CONFLICT (${pks.join(', ')}) DO UPDATE SET ${nonPk.map(c => `${c} = EXCLUDED.${c}`).join(', ')}`;
  } else {
    out += ` ON CONFLICT (${pks.join(', ')}) DO NOTHING`;
  }
  return out;
}

function replaceInsertOrIgnore(sql: string): string {
  const re = /INSERT\s+OR\s+IGNORE\s+INTO\s+(\w+)/i;
  if (!re.test(sql)) return sql;
  return sql.replace(re, 'INSERT INTO $1').replace(/;\s*$/, '') + ' ON CONFLICT DO NOTHING';
}

function replaceAutoincrement(sql: string): string {
  return sql.replace(/INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi, 'BIGSERIAL PRIMARY KEY');
}

// SQLite INTEGER is signed 64-bit, but PostgreSQL INTEGER is only 32-bit.
// Map remaining DDL `INTEGER` columns to BIGINT so 64-bit values (e.g. the
// 0xFFFFFFFF admin permission bitmask) do not overflow. Runs after
// replaceAutoincrement, so the BIGSERIAL primary key is left untouched.
// Only DDL is rewritten — column types never appear in DML.
function replaceDdlInteger(sql: string): string {
  if (!/^\s*(CREATE\s+TABLE|ALTER\s+TABLE)/i.test(sql)) return sql;
  return sql.replace(/\bINTEGER\b/gi, 'BIGINT');
}

// Append ` RETURNING <pk>` so `result.meta.last_row_id` can be populated.
function appendReturning(sql: string): string {
  const m = sql.match(/^\s*INSERT\s+INTO\s+(\w+)/i);
  if (!m || /\bRETURNING\b/i.test(sql)) return sql;
  const pks = TABLE_PRIMARY_KEYS[m[1].toLowerCase()];
  if (!pks || pks.length === 0) return sql;
  return sql.replace(/;\s*$/, '') + ` RETURNING ${pks[0]}`;
}

// `?` -> `$1,$2,...`, skipping single-quoted string literals (incl. '' escapes).
function replacePlaceholders(sql: string): string {
  let out = '';
  let i = 0;
  let n = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      // Copy the whole string literal.
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2; // escaped quote ('')
            continue;
          }
          break;
        }
        j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '?') {
      n += 1;
      out += `$${n}`;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Translate a single SQLite-flavored statement to PostgreSQL syntax. */
export function toPostgresSql(sql: string): string {
  let out = sql;
  out = replaceParamDatetime(out);
  out = replaceLiteralDatetime(out);
  out = replacePlainDatetime(out);
  out = replaceStrftime(out);
  out = replaceInsertOrReplace(out);
  out = replaceInsertOrIgnore(out);
  out = replaceAutoincrement(out);
  out = replaceDdlInteger(out);
  out = appendReturning(out);
  out = replacePlaceholders(out);
  return out;
}
