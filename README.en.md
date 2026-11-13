# dsh-db

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) plugin for **multi-source database queries**. Add, edit, and remove data sources under **Settings → Databases**; the model then queries them through tools. Read-only by default, every write asks you first.

Speaks **Vastbase / openGauss**, PostgreSQL, MySQL, and SQLite.

## Why openGauss needs its own path

Vastbase (openGauss kernel) authenticates with `sha256` by default, and the stock `pg` driver fails during the handshake. The official Node.js connector,
[`openGauss-connector-nodejs`](https://gitee.com/opengauss/openGauss-connector-nodejs)
(a node-postgres fork with sha256/SM3), is not published to npm and needs a `git` install plus a lerna build.

This plugin uses **`opengauss.js`** from npm instead: it is built on node-postgres 8.22 and that same official connector, implementing openGauss sha256 (auth code 10) and SM3 (auth code 13). One dependency, no build step.

## Install

```sh
cd dsh-db
npm install
```

Then **Settings → Plugins → Add plugin** and pick this directory (or let an agent install it with `install_bundle`). Restart DSH afterwards.

## Usage: Settings → Databases

- **Add data source**: name, dialect, host, port, database, user, password, mode (read/write), row cap, timeout.
- **Test connection**: try before saving; the result shows up in the form.
- **Edit / delete**: on each row.
- Leave the password field **empty to keep** the stored password.

Data sources live in `$DSH_HOME/db/sources.json` (metadata only, mode 0600). Passwords live in the DSH credential store under the fixed key `DSH_DB_<ID>`, so that file is safe to read and back up.

## Four tools

| Tool | What it does | Safety |
|---|---|---|
| `db_connections` | List data sources | read-only |
| `db_schema` | Tables/views; with `table`, its columns and types | read-only |
| `db_query` | One SELECT/SHOW/EXPLAIN, returns a table | three gates |
| `db_exec` | One write statement | per-statement approval |

Every result also echoes the SQL that actually ran.

## How read-only is enforced

Three layers; any one of them refuses, so the call fails:

1. **Statement gate** (`sqlguard.js`): only single statements starting with `select / with / show / explain / describe / values / table / pragma`. Comments and string literals are stripped first, so `-- delete` is not a false positive and `with x as (delete …)` cannot slip through.
2. **Session-level read-only**: `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY` on connect (MySQL uses `SET SESSION TRANSACTION READ ONLY`, SQLite opens with `mode=ro` plus `PRAGMA query_only`). The database refuses the write, not the plugin.
3. **The switch in the UI**: `db_exec` refuses on a read-only source; making it writable is a click only you can make.

## Why writes need approval

`db_exec` asks through DSH's approval channel for every statement, with the full SQL in the reason. Only `allowed-once` runs it; a refusal, a cancellation, or a deployment without an approval service all fail closed. One approval covers exactly one statement.

## Known limits

- PostgreSQL-family, MySQL, and SQLite only; Oracle and SQL Server are not wired up.
- Results come back as text: cells become strings (`NULL` shown as `NULL`) and a single call returns at most `maxRows` rows. CSV export is not implemented.
- Queries on one data source run serially, so a slow query blocks the next one.
- `db_schema` does not list foreign keys, indexes, or triggers.
- A real Vastbase instance has not been exercised here; the sha256 path follows the driver source and the official docs. Try a read-only account first.

## Tests

```sh
node test/smoke.mjs    # driver layer + SQL gate (10)
node test/plugin.mjs   # tool wiring + source validation (14)
```

Both run against a temporary SQLite database: no real server, no DSH process.
