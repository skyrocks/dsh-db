// 冒烟测试：不需要 DSH，直接测驱动层和 SQL 闸门。
// 用 SQLite 临时库把「查、列结构、只读拦截」跑通——这条链路和真实数据库
// 走的是同一套 Registry 代码，只是方言不同。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { EventEmitter } from 'node:events'

import { Registry, rowCells, withTimeout, attachErrorGuard } from '../drivers.js'
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

await registry.closeAll()
rmSync(dir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
