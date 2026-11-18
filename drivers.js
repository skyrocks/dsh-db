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
  dameng: 'dmdb',
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
    /** 连接上是否已经发生过 'error' 事件（socket 断了、服务端踢了）。 */
    this.broken = false
    this.lastError = null
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
    this.broken = false
    if (client === null) return
    try {
      const closing = typeof client.close === 'function'
        ? client.close()
        : (typeof client.end === 'function' ? client.end() : Promise.resolve())
      // 连接已经坏了的时候 end() 可能一直等：最多等 2 秒，然后放手。
      await Promise.race([
        Promise.resolve(closing),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, 2000)
          if (typeof timer.unref === 'function') timer.unref()
        }),
      ])
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
    for (const key of [...this.entries.keys()]) {
      if (key !== `${id}|ro` && key !== `${id}|rw`) continue
      const entry = this.entries.get(key)
      if (entry === undefined) continue
      // 先从缓存摘掉：新请求会建新连接，不会拿到这条正在关闭的。
      this.entries.delete(key)
      // 关闭也排队：正跑着的查询先结束，别把 SQLite 句柄从它脚下抽走
      // （Windows 上句柄没关干净，删库/改名会 EBUSY）。
      await entry.run(() => entry.close())
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
    // socket 已经报过错（服务端踢连接、网络断）就丢掉重连，别在死连接上等超时。
    if (entry.client !== null && entry.broken === true) await entry.close()
    if (entry.client !== null) return entry.client
    const { spec } = entry
    const timeoutMs = spec.timeoutMs
    try {
      const client = await connect(spec, entry, timeoutMs)
      entry.client = client
      attachErrorGuard(entry, client)
      return client
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
        const result = await queryClient(spec, client, sql, maxRows, spec.timeoutMs, entry.readOnly)
        return { ...result, elapsedMs: Date.now() - started }
      } catch (error) {
        // 语句级错误不等于连接坏；但超时/网络错误后连接不可信，丢掉重连。
        const message = String(error === null || error === undefined ? '' : error.message ?? error)
        const code = error === null || error === undefined ? undefined : error.code
        if (code === 'DSH_DB_TIMEOUT' || code === 'ECONNRESET' || code === 'EPIPE'
          || /timeout|超时|closed|terminated|ECONNRESET|EPIPE|not connected/i.test(message)) {
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
    const entries = [...this.entries.values()]
    this.entries.clear()
    for (const entry of entries) await entry.run(() => entry.close())
  }
}

/**
 * 给连接挂一个 'error' 监听。
 *
 * pg（opengauss.js）、mysql2、dmdb 都是 EventEmitter。EventEmitter 在没有
 * 'error' 监听时会把 'error' 直接抛出——那是同步的未捕获异常，会把整个 Host
 * 进程打掉（DSH 直接退出），而不是让那条查询失败。
 */
/** 关掉一个刚建/建了一半的连接；任何失败都吞掉，这只是在清理。 */
async function destroyClient(client) {
  if (client === null || client === undefined) return
  try {
    if (typeof client.destroy === 'function') client.destroy()
    else if (typeof client.close === 'function') await client.close()
    else if (typeof client.end === 'function') await client.end()
  } catch {
    // 清理失败不影响结论
  }
}

export function attachErrorGuard(entry, client) {
  if (client === null || client === undefined || typeof client.on !== 'function') return
  try {
    client.on('error', (error) => {
      entry.broken = true
      entry.lastError = error
    })
  } catch {
    // 有些连接对象不接受监听，忽略
  }
}

/** 按方言建连接。每个 open* 都必须在 connect 之前挂好 error 监听。 */
async function connect(spec, entry, timeoutMs) {
  if (spec.dialect === 'sqlite') return openSqlite(spec, entry.readOnly)
  if (spec.dialect === 'mysql') return openMysql(spec, entry, timeoutMs)
  if (spec.dialect === 'dameng') return openDameng(spec, entry, timeoutMs)
  return openPostgresLike(spec, entry, timeoutMs)
}

/** 带超时的 Promise。 */
export function withTimeout(promise, timeoutMs, label) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise
  const settled = Promise.resolve(promise)
  // 关键：超时赢了以后，原来那个 promise 仍然会 reject。不接住的话就是
  // unhandledRejection，Node 默认直接退出进程（DSH 崩掉就是这么来的）。
  settled.catch(() => {})
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} 超时（${timeoutMs}ms）`)
      error.code = 'DSH_DB_TIMEOUT'
      reject(error)
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([settled, timeout]).finally(() => clearTimeout(timer))
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

/** 达梦：官方 dmdb 驱动（纯 JS，oracledb 风格 API）。 */
async function openDameng(spec, entry, timeoutMs) {
  const dmdb = require('dmdb')
  const connection = await withTimeout(
    dmdb.getConnection({
      user: spec.user,
      password: entry.password,
      connectString: `${spec.host}:${spec.port}`,
      // 只读连接关掉自动提交：每条查询自己包一个只读事务，查完回滚。
      autoCommit: entry.readOnly !== true,
      connectTimeout: timeoutMs,
      socketTimeout: Math.max(1000, spec.timeoutMs),
    }),
    timeoutMs,
    '连接',
  )
  attachErrorGuard(entry, connection)
  return connection
}

/**
 * 达梦执行一条语句。只读模式下先开 READ ONLY 事务，查完无论成败都回滚，
 * 保证这条路径改不动数据；开不起来就抛错（fail closed）。
 */
async function damengRun(client, sql, params, options = {}) {
  const { readOnly = false, timeoutMs = 0, maxRows } = options
  if (readOnly === true) {
    try {
      await client.execute('SET TRANSACTION READ ONLY')
    } catch (error) {
      throw new Error(
        '无法把达梦连接切到只读事务，已拒绝执行查询：'
        + (error instanceof Error ? error.message : String(error)),
      )
    }
  }
  try {
    const executeOptions = {}
    if (Number.isFinite(maxRows) && maxRows > 0) executeOptions.maxRows = maxRows
    const pending = params.length > 0 || Object.keys(executeOptions).length > 0
      ? client.execute(sql, params, executeOptions)
      : client.execute(sql)
    return timeoutMs > 0 ? await withTimeout(pending, timeoutMs, '查询') : await pending
  } finally {
    if (readOnly === true) {
      try {
        await client.rollback()
      } catch {
        // 事务已经结束或连接已断，忽略
      }
    }
  }
}

/** dmdb 默认把行返回成数组；列名在 metaData 里。 */
function damengColumns(result) {
  const meta = Array.isArray(result === null || result === undefined ? undefined : result.metaData)
    ? result.metaData
    : []
  return meta.map((column) => column.name)
}

/** 数组行 → 以列名为键的对象行（对象行原样返回）。 */
function damengRows(result, columns) {
  const rows = Array.isArray(result === null || result === undefined ? undefined : result.rows)
    ? result.rows
    : []
  return rows.map((row) => (Array.isArray(row)
    ? Object.fromEntries(columns.map((name, index) => [name, row[index]]))
    : row))
}

async function openPostgresLike(spec, entry, timeoutMs) {
  const { Client } = require('opengauss.js')
  const options = {
    host: spec.host,
    port: spec.port,
    user: spec.user,
    password: entry.password,
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
  // 必须在 connect 之前挂监听：连接失败时 socket 也会 emit 'error'，
  // 没人接就是未捕获异常，直接打掉 Host 进程。
  attachErrorGuard(entry, client)
  try {
    await withTimeout(client.connect(), timeoutMs, '连接')
  } catch (error) {
    await destroyClient(client)
    throw error
  }
  // 只读 + 语句超时：放在会话级，比逐条改 SQL 可靠。
  try {
    await client.query(`SET statement_timeout = ${Math.max(1000, spec.timeoutMs)}`)
  } catch {
    // 老版本可能不认，不影响查询
  }
  if (entry.readOnly === true) {
    await requireReadOnlySession(client, [
      'SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY',
      'SET default_transaction_read_only = on',
    ])
  }
  return client
}

async function openMysql(spec, entry, timeoutMs) {
  const mysql = require('mysql2/promise')
  let connection
  try {
    connection = await withTimeout(
      mysql.createConnection({
        host: spec.host,
        port: spec.port,
        user: spec.user,
        password: entry.password,
        database: spec.database,
        connectTimeout: timeoutMs,
        supportBigNumbers: true,
        dateStrings: true,
      }),
      timeoutMs,
      '连接',
    )
  } catch (error) {
    throw error
  }
  attachErrorGuard(entry, connection)
  if (entry.readOnly === true) {
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

async function queryClient(spec, client, sql, maxRows, timeoutMs, readOnly) {
  // 达梦不认 PG/MySQL 的子查询 + LIMIT 包装，行数上限交给驱动（ExecuteOptions.maxRows）。
  const wrapped = spec.dialect === 'dameng' ? null : wrapForLimit(sql, maxRows)

  if (spec.dialect === 'dameng') {
    const result = await damengRun(client, sql, [], {
      readOnly,
      timeoutMs,
      maxRows: maxRows + 1,
    })
    const columns = damengColumns(result)
    const rows = damengRows(result, columns)
    const truncated = rows.length > maxRows
    return {
      columns,
      rows: truncated ? rows.slice(0, maxRows) : rows,
      truncated,
      totalRows: rows.length,
    }
  }

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
  if (spec.dialect === 'dameng') {
    const result = await client.execute(sql)
    return {
      affectedRows: typeof result.rowsAffected === 'number' ? result.rowsAffected : null,
      command: typeof result.sqlType === 'string' ? result.sqlType : '',
    }
  }
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
  if (spec.dialect === 'dameng') {
    const filter = schema === '' ? '' : ' AND OWNER = ? '
    const params = schema === '' ? [] : [schema]
    const scope = schema === '' ? 'USER_TABLES' : 'ALL_TABLES'
    const result = await damengRun(
      client,
      `SELECT OWNER AS "schema", TABLE_NAME AS "name", 'TABLE' AS "type" FROM ${scope}`
      + ' WHERE 1 = 1' + filter + ' ORDER BY OWNER, TABLE_NAME',
      params,
      { readOnly: true },
    )
    return damengRows(result, damengColumns(result)).map((row) => ({
      schema: row.schema,
      name: row.name,
      type: row.type,
    }))
  }
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
  if (spec.dialect === 'dameng') {
    const scope = schema === '' ? 'USER_TAB_COLUMNS' : 'ALL_TAB_COLUMNS'
    const params = schema === '' ? [table] : [schema, table]
    const filter = schema === '' ? 'TABLE_NAME = ?' : 'OWNER = ? AND TABLE_NAME = ?'
    const result = await damengRun(
      client,
      `SELECT COLUMN_NAME AS "name", DATA_TYPE AS "type", NULLABLE AS "nullable", `
      + `COALESCE(DATA_DEFAULT, '') AS "default" FROM ${scope} WHERE ${filter} ORDER BY COLUMN_ID`,
      params,
      { readOnly: true },
    )
    return damengRows(result, damengColumns(result)).map((row) => ({
      name: row.name,
      type: row.type,
      null: String(row.nullable).toUpperCase() === 'Y',
      default: String(row.default ?? ''),
      primaryKey: false,
    }))
  }
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
