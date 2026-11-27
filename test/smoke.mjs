// 冒烟测试：不需要 DSH，直接测驱动层和 SQL 闸门。
// 用 SQLite 临时库把「查、列结构、只读拦截」跑通——这条链路和真实数据库
// 走的是同一套 Registry 代码，只是方言不同。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { EventEmitter } from 'node:events'

import { Registry, rowCells, withTimeout, attachErrorGuard, isConnectionClosed } from '../drivers.js'
import { assertReadable, assertSingleWritable, statements, skeleton } from '../sqlguard.js'

let passed = 0
let failed = 0

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}\n     ${error.message}`)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-db-test-'))
const file = join(dir, 'sample.db')

// 造一个库：一张表、三行数据。
{
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT)')
  db.exec("INSERT INTO users (name, email) VALUES ('Ada', 'ada@example.com'), ('Linus', 'linus@example.com'), ('Grace', NULL)")
  db.close()
}

const sources = [
  { id: 'ro', name: '只读库', dialect: 'sqlite', host: '', port: 0, database: file, user: '', sslmode: 'disable', mode: 'read', maxRows: 2, timeoutMs: 5000 },
  { id: 'rw', name: '可写库', dialect: 'sqlite', host: '', port: 0, database: file, user: '', sslmode: 'disable', mode: 'write', maxRows: 200, timeoutMs: 5000 },
]


const registry = new Registry({
  all: async () => sources,
  one: async (id) => sources.find((item) => item.id === id),
  secret: async () => '',
})

await check('查询返回列与行', async () => {
  const result = await registry.query('ro', 'SELECT id, name FROM users ORDER BY id', 10)
  assert.deepEqual(result.columns, ['id', 'name'])
  assert.equal(result.totalRows, 3)
  assert.deepEqual(result.rows.map((row) => rowCells(row, result.columns)), [['1', 'Ada'], ['2', 'Linus'], ['3', 'Grace']])
})

await check('maxRows 截断并标记', async () => {
  const result = await registry.query('ro', 'SELECT id FROM users ORDER BY id', 2)
  assert.equal(result.rows.length, 2)
  assert.equal(result.truncated, true)
  assert.equal(result.totalRows, 3)
})

await check('列结构（表 + 字段）', async () => {
  const tables = await registry.tables('ro', '')
  assert.ok(tables.rows.some((row) => row.name === 'users'))
  const fields = await registry.fields('ro', '', 'users')
  assert.deepEqual(fields.rows.map((row) => row.name), ['id', 'name', 'email'])
  assert.equal(fields.rows[1].null, false)
})

await check('只读连接上写入被数据库拒绝', async () => {
  await assert.rejects(
    () => registry.query('ro', "INSERT INTO users (name) VALUES ('mallory')"),
    /readonly|read-only|attempt to write/i,
  )
})

await check('可写连接上写入生效', async () => {
  const info = await registry.execute('rw', "INSERT INTO users (name, email) VALUES ('Barbara', 'b@example.com')")
  assert.equal(info.affectedRows, 1)
  const result = await registry.query('rw', 'SELECT COUNT(*) AS n FROM users', 10)
  assert.equal(rowCells(result.rows[0], result.columns)[0], '4')
})

await check('只读校验：放行读语句', () => {
  for (const sql of [
    'SELECT 1',
    "select * from users where name = 'delete'",
    'WITH x AS (SELECT 1) SELECT * FROM x',
    'SHOW search_path',
    'EXPLAIN SELECT 1',
    '-- 注释里有 delete\nSELECT 1',
  ]) assertReadable(sql, 'db_query')
})

await check('只读校验：拦下写语句', () => {
  for (const sql of [
    'DELETE FROM users',
    'UPDATE users SET name = 1',
    "WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x",
    'SELECT * INTO backup FROM users',
    'CREATE TABLE t (id int)',
    'TRUNCATE users',
  ]) {
    assert.throws(() => assertReadable(sql, 'db_query'), /db_query/)
  }
})

await check('只读校验：多语句被拒', () => {
  assert.throws(() => assertReadable('SELECT 1; DROP TABLE users', 'db_query'), /一次只能执行一条语句/)
  assert.throws(() => assertSingleWritable('SELECT 1; SELECT 2', 'db_exec'), /一次只能执行一条语句/)
})

await check('骨架抹掉注释与字符串', () => {
  const text = skeleton("SELECT 'a;b' /* ; */ -- ;\nFROM t;")
  assert.equal(statements(text).length, 1)
  assert.ok(!text.includes('a;b'))
})

await check('未知数据源给出可用列表', async () => {
  await assert.rejects(() => registry.spec('nope'), /当前可用：ro, rw/)
})

await check('查询路径在可写数据源上也是只读会话', async () => {
  await assert.rejects(
    () => registry.query('rw', "INSERT INTO users (name) VALUES ('via-query')"),
    /readonly|read-only|attempt to write/i,
  )
  const after = await registry.query('ro', 'SELECT COUNT(*) AS n FROM users', 10)
  assert.equal(rowCells(after.rows[0], after.columns)[0], '4', 'db_query 不能写进可写数据源')
})

await check('PRAGMA 写在查询路径上被数据库拒绝', async () => {
  await assert.rejects(
    () => registry.query('rw', 'PRAGMA user_version = 7'),
    /readonly|read-only|attempt to write/i,
  )
})

await check('可写数据源上读仍然可用', async () => {
  const result = await registry.query('rw', 'SELECT COUNT(*) AS n FROM users', 10)
  assert.equal(rowCells(result.rows[0], result.columns)[0], '4')
})

await check('删除数据源：先等在跑的查询结束，再关连接', async () => {
  const registry2 = new Registry({
    all: async () => [sources[0]],
    one: async (id) => (id === sources[0].id ? sources[0] : undefined),
    secret: async () => '',
  })
  const entry = await registry2.entryFor(sources[0], true)
  const order = []
  // 用一个假的连接记录关闭时机；真 SQLite 是同步的，无法制造并发。
  entry.client = { close: () => { order.push('close'); return Promise.resolve() } }
  const task = entry.run(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
    order.push('query-done')
  })
  const closing = registry2.invalidate(sources[0].id)
  await Promise.all([task, closing])
  assert.deepEqual(order, ['query-done', 'close'], '必须等查询跑完再关')
  assert.equal(registry2.entries.size, 0, '关闭后不应残留条目')
})

await check('关闭后再次查询会重新建连接', async () => {
  const registry3 = new Registry({
    all: async () => [sources[0]],
    one: async (id) => (id === sources[0].id ? sources[0] : undefined),
    secret: async () => '',
  })
  const first = await registry3.query(sources[0].id, 'SELECT 1 AS n', 5)
  assert.equal(rowCells(first.rows[0], first.columns)[0], '1')
  assert.equal(registry3.entries.size, 1)
  await registry3.invalidate(sources[0].id)
  assert.equal(registry3.entries.size, 0)
  const second = await registry3.query(sources[0].id, 'SELECT 2 AS n', 5)
  assert.equal(rowCells(second.rows[0], second.columns)[0], '2', '应当能重连')
  await registry3.closeAll()
})

await check('删除数据源后 SQLite 句柄真的关掉了（Windows 上才不会 EBUSY）', async () => {
  const registry4 = new Registry({
    all: async () => [sources[0]],
    one: async (id) => (id === sources[0].id ? sources[0] : undefined),
    secret: async () => '',
  })
  await registry4.query(sources[0].id, 'SELECT 1 AS n', 5)
  const entry = [...registry4.entries.values()][0]
  const client = entry.client
  assert.doesNotThrow(() => client.prepare('SELECT 1'), '删之前句柄应当是开着的')
  await registry4.invalidate(sources[0].id)
  // close() 之后再操作会抛 "database is not open"：说明文件描述符已归还，
  // Windows 上删/改名这个 .db 文件才不会 EBUSY。
  assert.throws(() => client.prepare('SELECT 1'), /not open|closed/i)
})

await check('没有 error 监听时，连接报错会直接抛出（DSH 崩溃的成因）', () => {
  assert.throws(() => new EventEmitter().emit('error', new Error('socket hang up')))
})

await check("挂上 guard 后 'error' 不再抛出，并标记连接已坏", () => {
  const entry = { broken: false, lastError: null }
  const client = new EventEmitter()
  attachErrorGuard(entry, client)
  assert.doesNotThrow(() => client.emit('error', new Error('read EADDRNOTAVAIL')))
  assert.equal(entry.broken, true)
  assert.match(entry.lastError.message, /EADDRNOTAVAIL/)
})

await check('超时错误带 DSH_DB_TIMEOUT，超时后旧连接会被丢弃重连', async () => {
  const never = new Promise(() => {})
  // withTimeout 里的定时器是 unref 的（生产环境不该拖着进程）；测试里需要自己保活，
  // 否则事件循环空转、进程在定时器触发前就退出了。
  const keepAlive = setTimeout(() => {}, 500)
  try {
    await assert.rejects(
      () => withTimeout(never, 10, '查询'),
      (error) => error.code === 'DSH_DB_TIMEOUT',
    )
  } finally {
    clearTimeout(keepAlive)
  }
})

await check('判死：中文断连文案、驱动 code、SQLite 句柄都算连接已关', () => {
  const closed = [
    new Error('连接已经关闭'),
    new Error('连接已关闭'),
    new Error('连接已被关闭'),
    new Error('连接已经被关闭'),
    new Error('连接已被服务端关闭'),
    new Error('连接已断开'),
    new Error('连接被重置'),
    new Error('会话已经结束'),
    new Error('会话已断开'),
    new Error('未连接到数据库'),
    new Error('database is not open'),
    new Error('Connection lost'),
    new Error('socket hang up'),
    Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    Object.assign(new Error('whatever'), { code: 'PROTOCOL_CONNECTION_LOST' }),
    Object.assign(new Error('whatever'), { code: 'ER_CONNECTION_KILLED' }),
    'Connection terminated unexpectedly',
  ]
  for (const error of closed) assert.equal(isConnectionClosed(error), true, String(error && error.message ? error.message : error))
})

await check('判死：语句级错误不算断连', () => {
  for (const error of [
    null,
    undefined,
    new Error('near "FROM": syntax error'),
    new Error('表 users 不存在'),
    new Error('对只读事务不允许 INSERT'),
    new Error('连接超时'),          // 超时由 needsFreshConnection 走另一条路：丢连接但不重试
    new Error('连接不合法'),
    Object.assign(new Error('duplicate key'), { code: '23505' }),
  ]) assert.equal(isConnectionClosed(error), false, String(error && error.message ? error.message : error))
})

function fakeEntry() {
  return {
    client: null,
    broken: false,
    lastError: null,
    closes: 0,
    async close() {
      this.closes += 1
      this.client = null
    },
  }
}

await check('读路径：连接被关掉后丢掉旧连接、重连、重试一次', async () => {
  const registry5 = new Registry({ all: async () => [], one: async () => undefined, secret: async () => '' })
  registry5.clientOf = async () => ({})
  const entry = fakeEntry()
  let attempts = 0
  const result = await registry5.readTask(entry, async () => {
    attempts += 1
    if (attempts === 1) throw new Error('连接已经关闭')
    return 'ok'
  })
  assert.equal(result, 'ok')
  assert.equal(attempts, 2)
  assert.equal(entry.closes, 1, '重试前必须丢掉死连接')
})

await check('读路径：连续断连只重试一次，不再无限循环', async () => {
  const registry6 = new Registry({ all: async () => [], one: async () => undefined, secret: async () => '' })
  registry6.clientOf = async () => ({})
  const entry = fakeEntry()
  let attempts = 0
  await assert.rejects(
    () => registry6.readTask(entry, async () => {
      attempts += 1
      throw new Error('连接已经关闭')
    }),
    /连接已经关闭/,
  )
  assert.equal(attempts, 2, '最多两次尝试')
  assert.equal(entry.closes, 2)
})

await check('读路径：超时只丢连接、不重试', async () => {
  const registry7 = new Registry({ all: async () => [], one: async () => undefined, secret: async () => '' })
  registry7.clientOf = async () => ({})
  const entry = fakeEntry()
  let attempts = 0
  await assert.rejects(
    () => registry7.readTask(entry, async () => {
      attempts += 1
      throw Object.assign(new Error('查询 超时（10ms）'), { code: 'DSH_DB_TIMEOUT' })
    }),
    (error) => error.code === 'DSH_DB_TIMEOUT',
  )
  assert.equal(attempts, 1, '超时的重查询不该跑两遍')
  assert.equal(entry.closes, 1)
})

await check('读路径：语句错误不动连接', async () => {
  const registry8 = new Registry({ all: async () => [], one: async () => undefined, secret: async () => '' })
  const client = {}
  registry8.clientOf = async () => client
  const entry = fakeEntry()
  entry.client = client
  let attempts = 0
  await assert.rejects(
    () => registry8.readTask(entry, async () => {
      attempts += 1
      throw new Error('near "FROM": syntax error')
    }),
    /syntax error/,
  )
  assert.equal(attempts, 1)
  assert.equal(entry.closes, 0)
  assert.equal(entry.client, client, '连接没坏就不该丢')
})

await check('SQLite：句柄被外部关掉后，query / tables 自动重连', async () => {
  const registry9 = new Registry({
    all: async () => [sources[0]],
    one: async (id) => (id === sources[0].id ? sources[0] : undefined),
    secret: async () => '',
  })
  const first = await registry9.query(sources[0].id, 'SELECT 1 AS n', 5)
  assert.equal(rowCells(first.rows[0], first.columns)[0], '1')
  const entry = [...registry9.entries.values()][0]
  entry.client.close()
  const second = await registry9.query(sources[0].id, 'SELECT 2 AS n', 5)
  assert.equal(rowCells(second.rows[0], second.columns)[0], '2', '应当重连后成功')
  assert.doesNotThrow(() => entry.client.prepare('SELECT 1'), '应当换成了可用连接')
  // 语句级错误不该动连接：同一条连接继续用。
  const kept = entry.client
  await assert.rejects(() => registry9.query(sources[0].id, 'SELECT * FROM nope', 5), /no such table/)
  assert.equal(entry.client, kept, '语句错误不该丢掉连接')
  entry.client.close()
  const tables = await registry9.tables(sources[0].id, '')
  assert.ok(tables.rows.some((row) => row.name === 'users'), 'db_schema 也应重连')
  entry.client.close()
  const fields = await registry9.fields(sources[0].id, '', 'users')
  assert.deepEqual(fields.rows.map((row) => row.name), ['id', 'name', 'email'], '字段查询也应重连')
  await registry9.closeAll()
})

await check('达梦：只读事务失败若是断连，保留原始「连接已经关闭」', async () => {
  const dm = { id: 'dm', name: '达梦', dialect: 'dameng', host: '127.0.0.1', port: 5236, database: '', user: 'SYSDBA', sslmode: 'disable', mode: 'read', maxRows: 10, timeoutMs: 5000 }
  const registry10 = new Registry({
    all: async () => [dm],
    one: async (id) => (id === dm.id ? dm : undefined),
    secret: async () => '',
  })
  let calls = 0
  let closes = 0
  const fake = {
    execute: async () => {
      calls += 1
      throw new Error('连接已经关闭')
    },
    rollback: async () => {},
    close: async () => { closes += 1 },
  }
  registry10.clientOf = async (entry) => {
    entry.client = fake
    return fake
  }
  await assert.rejects(
    () => registry10.query('dm', 'SELECT 1', 10),
    (error) => error.message === '连接已经关闭',
  )
  assert.equal(calls, 2, '断连 → 重连 → 再试一次')
  assert.equal(closes, 2)
})

await check('达梦：非断连的只读事务失败仍然包装成 fail-closed 提示', async () => {
  const dm = { id: 'dm2', name: '达梦', dialect: 'dameng', host: '127.0.0.1', port: 5236, database: '', user: 'SYSDBA', sslmode: 'disable', mode: 'read', maxRows: 10, timeoutMs: 5000 }
  const registry11 = new Registry({
    all: async () => [dm],
    one: async (id) => (id === dm.id ? dm : undefined),
    secret: async () => '',
  })
  let calls = 0
  let closes = 0
  registry11.clientOf = async () => ({
    execute: async () => {
      calls += 1
      throw new Error('无效的事务状态')
    },
    rollback: async () => {},
    close: async () => { closes += 1 },
  })
  await assert.rejects(
    () => registry11.query('dm2', 'SELECT 1', 10),
    /无法把达梦连接切到只读事务/,
  )
  assert.equal(calls, 1, '不是断连就不该重试')
  assert.equal(closes, 0)
})

await registry.closeAll()
rmSync(dir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
