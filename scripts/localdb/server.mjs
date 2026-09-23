/**
 * A local stand-in for the Supabase project: real Postgres (PGlite, in-process)
 * loaded with supabase/schema.sql and every migration, behind a small server that
 * speaks the slice of the PostgREST protocol this app's supabase-js calls use.
 *
 * It exists so the whole app — pages, route handlers, server actions, the E2E
 * scripts — can run where the live project is not reachable, without writing a
 * single test row to production. It is not a general PostgREST: it covers the
 * filters, modifiers, upserts and embedded selects this codebase uses, and fails
 * loudly (400, "unsupported") on anything else so a gap cannot pass silently.
 *
 *   node scripts/localdb/server.mjs            # listens on :54321, in memory
 *   SUPABASE_URL=http://localhost:54321 npm run dev
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

const PORT = Number(process.env.LOCALDB_PORT ?? 54321);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");

/* ---------------- database ---------------- */
const pg = new PGlite(process.env.LOCALDB_DIR || undefined);
async function boot() {
  const { rows } = await pg.query("select to_regclass('public.tournaments') t");
  if (!rows[0].t) {
    await pg.exec(fs.readFileSync(path.join(ROOT, "supabase/schema.sql"), "utf8"));
    // Migrations after the schema snapshot (0014 onwards) are applied on top.
    const dir = path.join(ROOT, "supabase/migrations");
    for (const f of fs.readdirSync(dir).sort()) {
      const n = parseInt(f, 10);
      if (n >= 14) await pg.exec(fs.readFileSync(path.join(dir, f), "utf8"));
    }
  }
}

/** Foreign keys, for embedded selects: [{ table, column, refTable, refColumn }]. */
let FKS = [];
/** Column names and types per table. */
let COLS = {};
/** Primary key columns per table. */
let PKS = {};
async function loadCatalog() {
  const fk = await pg.query(`
    select tc.table_name as table, kcu.column_name as column, ccu.table_name as "refTable", ccu.column_name as "refColumn"
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
    join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
    where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public'`);
  FKS = fk.rows;
  const cols = await pg.query(`select table_name, column_name, data_type from information_schema.columns where table_schema = 'public'`);
  COLS = {};
  for (const r of cols.rows) (COLS[r.table_name] ??= {})[r.column_name] = r.data_type;
  const pks = await pg.query(`
    select tc.table_name, kcu.column_name from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name
    where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = 'public' order by kcu.ordinal_position`);
  PKS = {};
  for (const r of pks.rows) (PKS[r.table_name] ??= []).push(r.column_name);
}

/* ---------------- helpers ---------------- */
class Unsupported extends Error {}
const ident = (s) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(s)) throw new Unsupported(`bad identifier ${s}`);
  return `"${s}"`;
};
function checkTable(t) {
  if (!COLS[t]) {
    const e = new Error(`relation "public.${t}" does not exist`);
    e.code = "42P01";
    throw e;
  }
}

/** Splits on commas outside parentheses. */
function splitTop(s) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** select=... → { cols: [{name, alias}], star, embeds: [{alias, target, inner, spec}] } */
function parseSelect(spec) {
  const out = { star: false, cols: [], embeds: [] };
  for (const part of splitTop(spec || "*")) {
    const open = part.indexOf("(");
    if (open >= 0) {
      const head = part.slice(0, open).trim();
      const inner = part.slice(open + 1, part.lastIndexOf(")"));
      let [alias, target] = head.includes(":") ? head.split(":").map((x) => x.trim()) : [head, head];
      let innerJoin = false;
      if (target.endsWith("!inner")) {
        innerJoin = true;
        target = target.slice(0, -6);
      }
      out.embeds.push({ alias, target: target.split("!")[0], inner: parseSelect(inner), innerJoin });
    } else if (part === "*") out.star = true;
    else {
      const [alias, name] = part.includes(":") ? part.split(":").map((x) => x.trim()) : [part, part];
      out.cols.push({ alias, name: name.split("::")[0] });
    }
  }
  return out;
}

const OPS = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=", like: "like", ilike: "ilike" };

/** Parses "(a,b,"c,d")" into ["a","b","c,d"]. */
function parseList(s) {
  const body = s.replace(/^\(/, "").replace(/\)$/, "");
  const out = [];
  let cur = "";
  let quoted = false;
  for (const ch of body) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (body.length) out.push(cur);
  return out;
}

/** One condition, e.g. column "status", expr "in.(a,b)" → SQL. */
function condition(table, column, expr, params) {
  const col = column.includes("->") ? jsonPath(column) : ident(column);
  let negate = false;
  if (expr.startsWith("not.")) {
    negate = true;
    expr = expr.slice(4);
  }
  const dot = expr.indexOf(".");
  const op = expr.slice(0, dot);
  const raw = expr.slice(dot + 1);
  let sql;
  if (OPS[op]) {
    params.push(op === "like" || op === "ilike" ? raw.replace(/\*/g, "%") : raw);
    sql = `${col} ${OPS[op]} $${params.length}`;
  } else if (op === "is") {
    const v = raw.toLowerCase();
    if (!["null", "true", "false", "unknown"].includes(v)) throw new Unsupported(`is.${raw}`);
    sql = `${col} is ${v}`;
  } else if (op === "in") {
    const vals = parseList(raw);
    if (vals.length === 0) sql = "false";
    else {
      const ph = vals.map((v) => {
        params.push(v);
        return `$${params.length}`;
      });
      sql = `${col} in (${ph.join(",")})`;
    }
  } else if (op === "cs" || op === "cd" || op === "ov") {
    const type = COLS[table]?.[column];
    let value = raw;
    if (type === "ARRAY" && raw.startsWith("{")) value = raw;
    params.push(value);
    sql = `${col} ${op === "cs" ? "@>" : op === "cd" ? "<@" : "&&"} $${params.length}`;
  } else throw new Unsupported(`operator ${op}`);
  return negate ? `not (${sql})` : sql;
}
function jsonPath(column) {
  const parts = column.split(/(->>|->)/);
  let out = ident(parts[0]);
  for (let i = 1; i < parts.length; i += 2) out += `${parts[i]}'${parts[i + 1].replace(/'/g, "''")}'`;
  return out;
}

/** or=(a.eq.1,b.in.(x,y)) */
function orCondition(table, expr, params) {
  const items = splitTop(expr.replace(/^\(/, "").replace(/\)$/, ""));
  return `(${items
    .map((item) => {
      if (item.startsWith("and(")) {
        const inner = splitTop(item.slice(4, -1));
        return `(${inner.map((i) => leaf(i)).join(" and ")})`;
      }
      return leaf(item);
    })
    .join(" or ")})`;
  function leaf(item) {
    const d = item.indexOf(".");
    return condition(table, item.slice(0, d), item.slice(d + 1), params);
  }
}

const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);
function whereClause(table, search, params) {
  const conds = [];
  for (const [k, v] of search) {
    if (RESERVED.has(k)) continue;
    if (k === "or") conds.push(orCondition(table, v, params));
    else if (k === "and") conds.push(`(${splitTop(v.slice(1, -1)).map((i) => { const d = i.indexOf("."); return condition(table, i.slice(0, d), i.slice(d + 1), params); }).join(" and ")})`);
    else if (k.includes(".")) throw new Unsupported(`filter on embedded resource ${k}`);
    else conds.push(condition(table, k, v, params));
  }
  return conds.length ? ` where ${conds.join(" and ")}` : "";
}
function orderClause(order) {
  if (!order) return "";
  return ` order by ${order
    .split(",")
    .map((o) => {
      const [col, ...mods] = o.split(".");
      let s = col.includes("->") ? jsonPath(col) : ident(col);
      if (mods.includes("desc")) s += " desc";
      if (mods.includes("nullsfirst")) s += " nulls first";
      if (mods.includes("nullslast")) s += " nulls last";
      return s;
    })
    .join(", ")}`;
}

/** Rows of `table` as JSON objects, shaped by the select tree (embeds resolved per level). */
async function shape(table, rows, sel) {
  if (rows.length === 0) return rows;
  for (const emb of sel.embeds) {
    const e = resolveEmbed(table, emb);
    const keys = [...new Set(rows.map((r) => r[e.localKey]).filter((v) => v !== null && v !== undefined))];
    let children = [];
    if (keys.length) {
      const { rows: got } = await pg.query(
        `select row_to_json(t) j from ${ident(e.table)} t where ${ident(e.remoteKey)}::text = any($1::text[])`,
        [keys.map(String)],
      );
      children = await shape(e.table, got.map((r) => r.j), emb.inner);
    }
    for (const r of rows) {
      const match = children.filter((c) => String(c[e.remoteKey]) === String(r[e.localKey]));
      r[`__embed_${emb.alias}`] = e.many ? match.map((c) => project(c, emb.inner)) : match[0] ? project(match[0], emb.inner) : null;
    }
  }
  return rows;
}
function project(row, sel) {
  const out = {};
  if (sel.star || (sel.cols.length === 0 && sel.embeds.length === 0)) {
    for (const [k, v] of Object.entries(row)) if (!k.startsWith("__embed_")) out[k] = v;
  }
  for (const c of sel.cols) out[c.alias] = row[c.name];
  for (const e of sel.embeds) out[e.alias] = row[`__embed_${e.alias}`];
  return out;
}
function resolveEmbed(table, emb) {
  // alias:fk_column (many-to-one through a named column)
  const byColumn = FKS.find((f) => f.table === table && f.column === emb.target);
  if (byColumn) return { table: byColumn.refTable, localKey: byColumn.column, remoteKey: byColumn.refColumn, many: false };
  // many-to-one: this table references the target
  const toOne = FKS.filter((f) => f.table === table && f.refTable === emb.target);
  if (toOne.length === 1) return { table: emb.target, localKey: toOne[0].column, remoteKey: toOne[0].refColumn, many: false };
  // one-to-many: the target references this table
  const toMany = FKS.filter((f) => f.table === emb.target && f.refTable === table);
  if (toMany.length === 1) return { table: emb.target, localKey: toMany[0].refColumn, remoteKey: toMany[0].column, many: true };
  throw new Unsupported(`cannot resolve embed ${emb.target} from ${table}`);
}

async function selectRows(table, search, { head = false, count = false } = {}) {
  checkTable(table);
  const params = [];
  const where = whereClause(table, search, params);
  let total = null;
  if (count) {
    const { rows } = await pg.query(`select count(*)::int n from ${ident(table)}${where}`, params);
    total = rows[0].n;
  }
  if (head) return { rows: [], total };
  let sql = `select row_to_json(t) j from (select * from ${ident(table)}${where}${orderClause(search.get("order"))}`;
  if (search.get("limit")) sql += ` limit ${parseInt(search.get("limit"), 10)}`;
  if (search.get("offset")) sql += ` offset ${parseInt(search.get("offset"), 10)}`;
  sql += ") t";
  const { rows } = await pg.query(sql, params);
  const sel = parseSelect(search.get("select"));
  const shaped = await shape(table, rows.map((r) => r.j), sel);
  return { rows: shaped.map((r) => project(r, sel)), total };
}

async function writeReturn(table, rawRows, search) {
  const sel = parseSelect(search.get("select"));
  const shaped = await shape(table, rawRows, sel);
  return shaped.map((r) => project(r, sel));
}

async function insertRows(table, body, search, prefer) {
  checkTable(table);
  const rows = Array.isArray(body) ? body : [body];
  const merge = /resolution=merge-duplicates/.test(prefer);
  const ignore = /resolution=ignore-duplicates/.test(prefer);
  const conflict = search.get("on_conflict")?.split(",").map((s) => s.trim()) ?? PKS[table] ?? ["id"];
  const out = [];
  for (const row of rows) {
    const keys = Object.keys(row).filter((k) => COLS[table][k]);
    for (const k of Object.keys(row)) if (!COLS[table][k]) {
      const e = new Error(`Could not find the '${k}' column of '${table}' in the schema cache`);
      e.code = "PGRST204";
      throw e;
    }
    const cols = keys.map(ident).join(", ");
    let sql =
      keys.length === 0
        ? `insert into ${ident(table)} default values`
        : `insert into ${ident(table)} (${cols}) select ${cols} from json_populate_record(null::${ident(table)}, $1::json)`;
    if (merge || ignore) {
      sql += ` on conflict (${conflict.map(ident).join(", ")}) do `;
      const updatable = keys.filter((k) => !conflict.includes(k));
      sql += ignore || updatable.length === 0 ? "nothing" : `update set ${updatable.map((k) => `${ident(k)} = excluded.${ident(k)}`).join(", ")}`;
    }
    sql += " returning row_to_json(" + ident(table) + ".*) j";
    const { rows: got } = await pg.query(sql, keys.length ? [JSON.stringify(row)] : []);
    out.push(...got.map((r) => r.j));
  }
  return out;
}

async function updateRows(table, body, search) {
  checkTable(table);
  const keys = Object.keys(body).filter((k) => COLS[table][k]);
  if (keys.length === 0) return [];
  const params = [JSON.stringify(body)];
  const where = whereClause(table, search, params);
  const sql = `update ${ident(table)} set (${keys.map(ident).join(", ")}) = (select ${keys.map(ident).join(", ")} from json_populate_record(null::${ident(table)}, $1::json))${where} returning row_to_json(${ident(table)}.*) j`;
  const { rows } = await pg.query(keys.length === 1 ? sql.replace(/set \(([^)]*)\) = \(select ([^ ]*) from/, "set $1 = (select $2 from") : sql, params);
  return rows.map((r) => r.j);
}

async function deleteRows(table, search) {
  checkTable(table);
  const params = [];
  const where = whereClause(table, search, params);
  const { rows } = await pg.query(`delete from ${ident(table)}${where} returning row_to_json(${ident(table)}.*) j`, params);
  return rows.map((r) => r.j);
}

/* ---------------- http ---------------- */
function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(body === undefined ? "" : JSON.stringify(body));
}
function pgError(res, e) {
  if (e instanceof Unsupported) return send(res, 400, { code: "LOCALDB", message: `localdb unsupported: ${e.message}`, details: null, hint: null });
  const code = e.code ?? "XX000";
  const status = code === "23505" ? 409 : code === "42P01" ? 404 : code.startsWith("23") ? 409 : 400;
  send(res, status, { code, message: e.message, details: e.detail ?? null, hint: e.hint ?? null });
}

let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn, fn));

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () =>
    serial(async () => {
      try {
        const url = new URL(req.url, "http://x");
        if (url.pathname === "/__health") return send(res, 200, { ok: true });
        if (url.pathname === "/__sql" && req.method === "POST") {
          const r = await pg.query(JSON.parse(body).query);
          return send(res, 200, r.rows);
        }
        if (url.pathname.startsWith("/storage/v1/")) return send(res, 200, { Key: "local" });
        const m = url.pathname.match(/^\/rest\/v1\/([a-z_0-9]+)$/);
        if (!m) return send(res, 404, { message: `no route ${url.pathname}` });
        const table = m[1];
        const prefer = req.headers.prefer ?? "";
        const single = (req.headers.accept ?? "").includes("vnd.pgrst.object");
        const wantCount = /count=exact/.test(prefer);
        let rows;
        let total = null;
        if (req.method === "GET" || req.method === "HEAD") {
          ({ rows, total } = await selectRows(table, url.searchParams, { head: req.method === "HEAD", count: wantCount }));
        } else if (req.method === "POST") {
          const raw = await insertRows(table, body ? JSON.parse(body) : {}, url.searchParams, prefer);
          rows = /return=representation/.test(prefer) ? await writeReturn(table, raw, url.searchParams) : [];
          if (!/return=representation/.test(prefer)) return send(res, 201, undefined);
        } else if (req.method === "PATCH") {
          const raw = await updateRows(table, JSON.parse(body || "{}"), url.searchParams);
          if (wantCount) total = raw.length;
          if (!/return=representation/.test(prefer)) return send(res, 204, undefined, total !== null ? { "Content-Range": `*/${total}` } : {});
          rows = await writeReturn(table, raw, url.searchParams);
        } else if (req.method === "DELETE") {
          const raw = await deleteRows(table, url.searchParams);
          if (wantCount) total = raw.length;
          if (!/return=representation/.test(prefer)) return send(res, 204, undefined, total !== null ? { "Content-Range": `*/${total}` } : {});
          rows = await writeReturn(table, raw, url.searchParams);
        } else return send(res, 405, { message: "method" });

        const range = { "Content-Range": `${rows.length ? `0-${rows.length - 1}` : "*"}/${total ?? "*"}` };
        if (req.method === "HEAD") return send(res, 200, undefined, range);
        if (single) {
          if (rows.length !== 1) {
            return send(res, 406, {
              code: "PGRST116",
              details: `The result contains ${rows.length} rows`,
              hint: null,
              message: "JSON object requested, multiple (or no) rows returned",
            });
          }
          return send(res, 200, rows[0], range);
        }
        send(res, req.method === "POST" ? 201 : 200, rows, range);
      } catch (e) {
        if (process.env.LOCALDB_DEBUG) console.error(req.method, req.url, e);
        pgError(res, e);
      }
    }),
  );
});

await boot();
await loadCatalog();
server.listen(PORT, () => console.log(`localdb ready on http://localhost:${PORT}`));
