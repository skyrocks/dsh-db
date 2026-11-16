// 驱动层：按方言选实现，把「连接、超时、只读会话、结果归一化」收在一起。
//
// 海量数据库（Vastbase / openGauss 内核）默认 sha256 认证，npm 上的原版 pg 在
// 握手阶段就失败；这里用 opengauss.js —— 它基于 node-postgres 8.22 和 openGauss
// 官方的 openGauss-connector-nodejs，实现了 openGauss 的 sha256（认证码 10）和
// SM3（认证码 13）。
import { createRequire } from 'node:module'
import { skeleton } from './sqlguard.js'

const require = createRequire(import.meta.url)

/**
 * 给读查询套一层 LIMIT，避免 `SELECT * FROM 大表` 先把几百万行拉进内存。
 * 只在「一眼看得出是 select/with 且没写过 limit」时套；套了之后如果数据库
 * 报错（子查询语法不兼容之类），调用方会退回原语句再跑一次。
 * @param {string} sql - 原查询。
 * @param {number} maxRows - 想取的行数。
 * @returns {string|null} 套好的语句，或 null 表示不套。
 */
export function wrapForLimit(sql, maxRows) {
  const core = skeleton(sql).trim().toLowerCase()
  if (!/^(select|with)\b/.test(core)) return null
  if (/\blimit\b|\bfetch\b|\boffset\b/.test(core)) return null
  return `SELECT * FROM (\n${sql.trim().replace(/;+$/, '')}\n) AS dsh_wrapped LIMIT ${Math.max(1, maxRows) + 1}`
}

/** 方言 → 需要的 npm 包（用于给出可读的缺依赖提示）。 */
const DRIVER_PACKAGE = {
  opengauss: 'opengauss.js',
  postgres: 'opengauss.js',
  mysql: 'mysql2',
  sqlite: null,
}

function missingDriver(dialect, error) {
  const pkg = DRIVER_PACKAGE[dialect]
  if (error !== null && typeof error === 'object' && error.code === 'MODULE_NOT_FOUND') {
    return new Error(
      `方言 ${dialect} 需要 npm 包 ${pkg}，但这个插件目录里没有装。`
      + `在插件目录执行 \`npm install ${pkg}\` 后重启 DSH。`,
    )
  }
  return error
}

/** 把值转成安全可读的字符串（NULL 明确写出来，不静默变空串）。 */
export function cellText(value) {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const hex = Buffer.from(value).toString('hex')
    return hex.length > 64 ? `0x${hex.slice(0, 64)}…(${value.length} bytes)` : `0x${hex}`
  }
  try {
    const json = JSON.stringify(value)
    return json.length > 2000 ? `${json.slice(0, 2000)}…` : json
  } catch {
    return String(value)
  }
}

/** 行对象 → 按列顺序的字符串数组。 */
export function rowCells(row, columns) {
  return columns.map((column) => cellText(row[column]))
}

/**
 * 一条连接的生命周期：懒建连接、串行执行、出错即丢弃。
 * 单条连接上不做并发——数据库侧本来就是串行处理，串行能保证只读会话设置生效。
 */
class Entry {
  /**
   * @param {object} spec - 数据源定义。
   * @param {boolean} readOnly - 这条连接是否强制只读会话（查询路径永远为 true）。
   */
  constructor(spec, readOnly) {
    this.spec = spec
    this.readOnly = readOnly === true
    this.client = null
    this.queue = Promise.resolve()
    this.password = ''
  }

  /** 串行化：任何时刻只有一个查询在跑。 */
  run(task) {
    const next = this.queue.then(task, task)
    this.queue = next.catch(() => {})
    return next
  }

  async close() {
    const client = this.client
    this.client = null
    if (client === null) return
    try {
      if (typeof client.close === 'function') client.close()
      else if (typeof client.end === 'function') await client.end()
    } catch {
      // 关闭失败不影响主流程
    }
  }
}

export class Registry {
  /**
   * @param {object} options
   * @param {() => Promise<object[]>} options.all - 全部数据源。
   * @param {(id: string) => Promise<object|undefined>} options.one - 按 id 取一条。
   * @param {(source: object) => Promise<string>} options.secret - 取该数据源的密码。
   */
  constructor({ all, one, secret }) {
    this.allSources = all
    this.oneSource = one
    this.secret = secret
    this.entries = new Map()
  }

  /** 按 id 找数据源；找不到时把所有可用 id 报出来。 */
  async spec(id) {
    const found = await this.oneSource(id)
    if (found === undefined) {
      const list = await this.allSources()
      const available = list.map((item) => item.id).join(', ') || '（还没有添加任何数据源）'
      throw new Error(`没有 id 为「${id}」的数据源。当前可用：${available}`)
    }
    return found
  }

  async list() {
    const list = await this.allSources()
    return list.map((item) => ({
      id: item.id,
      name: item.name,
      dialect: item.dialect,
      host: item.dialect === 'sqlite' ? item.database : `${item.host}:${item.port}`,
      database: item.database,
      mode: item.mode,
    }))
  }

  /** 数据源被编辑或删除后调用：丢掉旧连接，下次按新配置重连。 */
  async invalidate(id) {
    for (const [key, entry] of [...this.entries]) {
      if (key !== `${id}|ro` && key !== `${id}|rw`) continue
      this.entries.delete(key)
      await entry.close()
    }
  }

  /**
   * 取一条连接。读写两条分开缓存：查询路径永远用只读连接，
   * 这样即使数据源本身是可写的，db_query 也绕不过数据库的只读保护。
   */
  async entryFor(spec, readOnly) {
    const key = `${spec.id}|${readOnly === true ? 'ro' : 'rw'}`
    let entry = this.entries.get(key)
    if (entry === undefined) {
      entry = new Entry(spec, readOnly === true)
      entry.password = spec.dialect === 'sqlite' ? '' : await this.secret(spec)
      this.entries.set(key, entry)
    }
    return entry
  }

  /** 确保连接可用；坏了就丢掉重连一次。 */
  async clientOf(entry) {
    if (entry.client !== null) return entry.client
    const { spec } = entry
    const timeoutMs = spec.timeoutMs
    try {
      if (spec.dialect === 'sqlite') {
        entry.client = openSqlite(spec, entry.readOnly)
        return entry.client
      }
      if (spec.dialect === 'mysql') {
        entry.client = await openMysql(spec, entry.password, timeoutMs, entry.readOnly)
        return entry.client
      }
      entry.client = await openPostgresLike(spec, entry.password, timeoutMs, entry.readOnly)
      return entry.client
    } catch (error) {
      entry.client = null
      throw missingDriver(spec.dialect, error)
    }
  }

  /**
   * 跑一条查询，返回归一化结果。
   * @returns {Promise<{columns: string[], rows: object[], elapsedMs: number}>}
   */
  async query(id, sql, maxRows) {
    const spec = await this.spec(id)
    // 查询路径强制只读会话：可写数据源也一样，PRAGMA / 写函数在这里由数据库拒绝。
    const entry = await this.entryFor(spec, true)
    return entry.run(async () => {
      const started = Date.now()
      try {
        const client = await this.clientOf(entry)
        const result = await queryClient(spec, client, sql, maxRows, spec.timeoutMs)
        return { ...result, elapsedMs: Date.now() - started }
      } catch (error) {
        // 语句级错误不等于连接坏；但超时/网络错误后连接不可信，丢掉重连。
        const message = String(error === null || error === undefined ? '' : error.message ?? error)
        if (/timeout|closed|terminated|ECONNRESET|EPIPE|not connected/i.test(message)) {
          await entry.close()
        }
        throw error
      }
    })
  }

  /** 跑一条写语句，返回影响行数（拿不到就给 null）。 */
  async execute(id, sql) {
    const spec = await this.spec(id)
    const entry = await this.entryFor(spec, false)
    return entry.run(async () => {
      const started = Date.now()
      try {
        const client = await this.clientOf(entry)
        const result = await execClient(spec, client, sql)
        return { ...result, elapsedMs: Date.now() - started }
      } catch (error) {
        await entry.close()
        throw error
      }
    })
  }

  /** 列 schema 下的表 / 视图。 */
  async tables(id, schema) {
    const spec = await this.spec(id)
    const entry = await this.entryFor(spec, true)
    return entry.run(async () => {
      const client = await this.clientOf(entry)
      return { rows: await listTables(spec, client, schema) }
    })
  }

  /** 列一张表的字段。 */
  async fields(id, schema, table) {
    const spec = await this.spec(id)
    const entry = await this.entryFor(spec, true)
    return entry.run(async () => {
      const client = await this.clientOf(entry)
      return { rows: await listFields(spec, client, schema, table) }
    })
  }

  async closeAll() {
    for (const entry of this.entries.values()) await entry.close()
    this.entries.clear()
  }
}

/** 带超时的 Promise。 */
function withTimeout(promise, timeoutMs, label) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${timeoutMs}ms）`)), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * 把会话切到只读。两种等价写法都试一遍；都失败就断开连接并拒绝查询——
 * 查询路径宁可报错，也不能在没有数据库级只读保护的情况下跑。
 * @param {object} client - 已连接的客户端。
 * @param {string[]} statements - 依次尝试的 SET 语句。
 * @returns {Promise<void>}
 */
async function requireReadOnlySession(client, statements) {
  const failures = []
  for (const statement of statements) {
    try {
      await client.query(statement)
      return
    } catch (error) {
      failures.push(`${statement} → ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  try {
    if (typeof client.end === 'function') await client.end()
    else if (typeof client.close === 'function') client.close()
  } catch {
    // 关不掉也不影响结论
  }
  throw new Error(
    '无法把连接切到只读会话，已拒绝执行查询（查询路径必须由数据库保证只读）：'
    + failures.join('；'),
  )
}

async function openPostgresLike(spec, password, timeoutMs, readOnly) {
  const { Client } = require('opengauss.js')
  const options = {
    host: spec.host,
    port: spec.port,
    user: spec.user,
    password,
    database: spec.database,
    databaseType: spec.dialect === 'opengauss' ? 'openGauss' : 'postgres',
    connectionTimeoutMillis: timeoutMs,
  }
  if (spec.sslmode !== 'disable') {
    options.ssl = spec.sslmode === 'verify-full'
      ? { rejectUnauthorized: true }
      : { rejectUnauthorized: false }
  }
  const client = new Client(options)
  await withTimeout(client.connect(), timeoutMs, '连接')
  // 只读 + 语句超时：放在会话级，比逐条改 SQL 可靠。
  try {
    await client.query(`SET statement_timeout = ${Math.max(1000, spec.timeoutMs)}`)
  } catch {
    // 老版本可能不认，不影响查询
  }
  if (readOnly === true) {
    await requireReadOnlySession(client, [
      'SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY',
      'SET default_transaction_read_only = on',
    ])
  }
  return client
}

async function openMysql(spec, password, timeoutMs, readOnly) {
  const mysql = require('mysql2/promise')
  const connection = await withTimeout(
    mysql.createConnection({
      host: spec.host,
      port: spec.port,
      user: spec.user,
      password,
      database: spec.database,
      connectTimeout: timeoutMs,
      supportBigNumbers: true,
      dateStrings: true,
    }),
    timeoutMs,
    '连接',
  )
  if (readOnly === true) {
    await requireReadOnlySession(connection, [
      'SET SESSION TRANSACTION READ ONLY',
      'SET SESSION transaction_read_only = 1',
    ])
  }
  return connection
}

function openSqlite(spec, readOnly) {
  const { DatabaseSync } = require('node:sqlite')
  const database = new DatabaseSync(spec.database, { readOnly: readOnly === true })
  if (readOnly === true) {
    try {
      database.exec('PRAGMA query_only = ON')
    } catch {
      // 只读文件本身已够
    }
  }
  return database
}

async function queryClient(spec, client, sql, maxRows, timeoutMs) {
  const wrapped = wrapForLimit(sql, maxRows)

  if (spec.dialect === 'sqlite') {
    const run = (text) => {
      const statement = client.prepare(text)
      return { columns: statement.columns().map((column) => column.name), rows: statement.all() }
    }
    let result
    try {
      result = run(wrapped ?? sql)
    } catch (error) {
      if (wrapped === null) throw error
      result = run(sql)
    }
    const truncated = result.rows.length > maxRows
    return {
      columns: result.columns,
      rows: truncated ? result.rows.slice(0, maxRows) : result.rows,
      truncated,
      totalRows: result.rows.length,
    }
  }

  if (spec.dialect === 'mysql') {
    const run = async (text) => {
      const [rows, fields] = await withTimeout(client.query({ sql: text, rowsAsArray: false }), timeoutMs, '查询')
      const columns = Array.isArray(fields) ? fields.map((field) => field.name) : Object.keys(rows[0] ?? {})
      return { columns, rows, fields }
    }
    let result
    try {
      result = await run(wrapped ?? sql)
    } catch (error) {
      if (wrapped === null) throw error
      result = await run(sql)
    }
    if (!Array.isArray(result.rows)) {
      return { columns: [], rows: [], truncated: false, totalRows: 0, affectedRows: result.rows.affectedRows ?? null }
    }
    const truncated = result.rows.length > maxRows
    return {
      columns: result.columns,
      rows: truncated ? result.rows.slice(0, maxRows) : result.rows,
      truncated,
      totalRows: result.rows.length,
    }
  }

  const run = async (text) => {
    const result = await withTimeout(client.query(text), timeoutMs, '查询')
    const rows = Array.isArray(result.rows) ? result.rows : []
    const columns = Array.isArray(result.fields) && result.fields.length > 0
      ? result.fields.map((field) => field.name)
      : Object.keys(rows[0] ?? {})
    return { columns, rows }
  }
  let result
  try {
    result = await run(wrapped ?? sql)
  } catch (error) {
    if (wrapped === null) throw error
    result = await run(sql)
  }
  const truncated = result.rows.length > maxRows
  return {
    columns: result.columns,
    rows: truncated ? result.rows.slice(0, maxRows) : result.rows,
    truncated,
    totalRows: result.rows.length,
  }
}

async function execClient(spec, client, sql) {
  if (spec.dialect === 'sqlite') {
    const statement = client.prepare(sql)
    const info = statement.run()
    return { affectedRows: Number(info.changes ?? 0) }
  }
  if (spec.dialect === 'mysql') {
    const [result] = await client.query(sql)
    return {
      affectedRows: typeof result.affectedRows === 'number' ? result.affectedRows : null,
      info: typeof result.info === 'string' ? result.info : '',
    }
  }
  const result = await client.query(sql)
  return {
    affectedRows: typeof result.rowCount === 'number' ? result.rowCount : null,
    command: typeof result.command === 'string' ? result.command : '',
  }
}

async function listTables(spec, client, schema) {
  if (spec.dialect === 'sqlite') {
    const rows = client
      .prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
    return rows.map((row) => ({ schema: 'main', name: row.name, type: row.type }))
  }
  if (spec.dialect === 'mysql') {
    const [rows] = await client.query(
      'SELECT table_schema, table_name, table_type FROM information_schema.tables '
      + "WHERE table_schema NOT IN ('mysql','sys','performance_schema','information_schema') "
      + 'ORDER BY table_schema, table_name LIMIT 500',
    )
    return rows.map((row) => ({ schema: row.table_schema, name: row.table_name, type: row.table_type }))
  }
  const keyword = schema === '' ? '' : 'AND table_schema = $1 '
  const params = schema === '' ? [] : [schema]
  const result = await client.query(
    'SELECT table_schema, table_name, table_type FROM information_schema.tables '
    + "WHERE table_schema NOT IN ('pg_catalog','information_schema') "
    + `${keyword}ORDER BY table_schema, table_name LIMIT 500`,
    params,
  )
  return result.rows.map((row) => ({
    schema: row.table_schema,
    name: row.table_name,
    type: row.table_type,
  }))
}

async function listFields(spec, client, schema, table) {
  if (spec.dialect === 'sqlite') {
    const rows = client
      .prepare('SELECT name, type, "notnull", COALESCE(dflt_value, \'\') AS dflt, pk FROM pragma_table_info(?)')
      .all(table)
    return rows.map((row) => ({
      name: row.name,
      type: row.type === '' ? 'ANY' : row.type,
      null: Number(row.notnull) === 0,
      default: String(row.dflt ?? ''),
      primaryKey: Number(row.pk) > 0,
    }))
  }
  if (spec.dialect === 'mysql') {
    const [rows] = await client.query(
      'SELECT column_name, column_type, is_nullable, COALESCE(column_default, \'\') AS dflt, column_key '
      + 'FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position',
      [schema === '' ? spec.database : schema, table],
    )
    return rows.map((row) => ({
      name: row.column_name,
      type: row.column_type,
      null: String(row.is_nullable).toUpperCase() === 'YES',
      default: String(row.dflt ?? ''),
      primaryKey: String(row.column_key).toUpperCase() === 'PRI',
    }))
  }
  const result = await client.query(
    'SELECT column_name, data_type, is_nullable, COALESCE(column_default, \'\') AS dflt '
    + 'FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position',
    [schema === '' ? 'public' : schema, table],
  )
  return result.rows.map((row) => ({
    name: row.column_name,
    type: row.data_type,
    null: String(row.is_nullable).toUpperCase() === 'YES',
    default: String(row.dflt ?? ''),
    primaryKey: false,
  }))
}
