// 插件级测试：用假 ctx + 真存储/驱动，把四个工具的 execute 真跑一遍。
// 覆盖的是 tools.js 的接线（只读闸门、审批分支、渲染、参数校验），
// 不依赖 DSH 进程，也不需要真数据库。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { registerTools } from '../tools.js'
import { Registry } from '../drivers.js'
import { createSourceStore, normalizeSource, secretRefFor, slugify } from '../store.js'

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

const dir = mkdtempSync(join(tmpdir(), 'dsh-db-plugin-'))
const file = join(dir, 'sample.db')
{
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
  db.exec("INSERT INTO users (name) VALUES ('Ada'), ('Linus')")
  db.close()
}

const rawSources = [
  { id: 'ro', name: '只读库', dialect: 'sqlite', database: file, mode: 'read', maxRows: 10, timeoutMs: 5000 },
  { id: 'rw', name: '可写库', dialect: 'sqlite', database: file, mode: 'write', maxRows: 10, timeoutMs: 5000 },
]

/** 和 DbSourcesService 同形状的假服务：真存储 + 真驱动。 */
async function makeService() {
  const store = createSourceStore({ path: join(dir, 'sources.json') })
  await store.write(rawSources.map((item) => normalizeSource(item)))
  const registry = new Registry({
    all: () => store.read(),
    one: (id) => store.find(id),
    secret: async () => '',
  })
  return {
    registry,
    store,
    async list() {
      const sources = await store.read()
      return { sources: sources.map((item) => ({ ...item, hasPassword: false })), path: store.path }
    },
    async dispose() {
      await registry.closeAll()
    },
  }
}

/** 每个用例建的服务，收尾统一 dispose：Windows 上没关的 SQLite 句柄会让 rmSync 报 EPERM。 */
const opened = []

/** 假 ctx：记录注册的工具，按需提供 approval 服务。 */
async function makeContext({ approvalOutcome = 'allowed-once', withApproval = true } = {}) {
  const service = await makeService()
  const tools = new Map()
  const asked = []
  const ctx = {
    tools: { register: (definition) => tools.set(definition.name, definition) },
    effect: () => {},
    get: (name) => {
      if (name !== 'approval') return undefined
      if (!withApproval) return undefined
      return {
        request: async (req) => {
          asked.push(req)
          return approvalOutcome
        },
      }
    },
  }
  registerTools(ctx, service)
  opened.push(service)
  return { tools, asked, service }
}

const exec = { agent: { id: 'test-agent' }, signal: new AbortController().signal }

await check('注册了四个工具', async () => {
  const { tools } = await makeContext()
  assert.deepEqual([...tools.keys()].sort(), ['db_connections', 'db_exec', 'db_query', 'db_schema'])
})

await check('db_connections 列出数据源', async () => {
  const { tools } = await makeContext()
  const value = await tools.get('db_connections').execute({}, exec)
  assert.equal(value.connections.length, 2)
  assert.match(value.note, /只读库/)
  assert.match(value.note, /只读/)
})

await check('db_query 返回表格文本', async () => {
  const { tools } = await makeContext()
  const value = await tools.get('db_query').execute({ connection: 'ro', sql: 'SELECT id, name FROM users ORDER BY id' }, exec)
  assert.deepEqual(value.columns, ['id', 'name'])
  assert.deepEqual(value.rows, [['1', 'Ada'], ['2', 'Linus']])
  assert.match(value.note, /Ada/)
  assert.match(value.note, /2 行/)
  assert.match(value.note, /SQL: SELECT id, name FROM users/)
  assert.equal(value.sql, 'SELECT id, name FROM users ORDER BY id')
})

await check('db_query 拦下 PRAGMA 与有副作用的函数', async () => {
  const { tools } = await makeContext()
  const cases = [
    'PRAGMA user_version = 7',
    'PRAGMA journal_mode = DELETE',
    "SELECT load_extension('/tmp/evil.so')",
    "SELECT set_config('default_transaction_read_only', 'off', false)",
    "ATTACH DATABASE '/tmp/x.db' AS x",
  ]
  for (const sql of cases) {
    await assert.rejects(
      () => tools.get('db_query').execute({ connection: 'ro', sql }, exec),
      /db_query/,
      '应当拒绝：' + sql,
    )
  }
})

await check('db_query 在可写数据源上也写不进去', async () => {
  const { tools } = await makeContext()
  await assert.rejects(
    () => tools.get('db_query').execute({ connection: 'rw', sql: "INSERT INTO users (name) VALUES ('x')" }, exec),
    /只读连接不接受/,
  )
})

await check('db_query 拒绝写语句', async () => {
  const { tools } = await makeContext()
  await assert.rejects(
    () => tools.get('db_query').execute({ connection: 'ro', sql: 'DELETE FROM users' }, exec),
    /只读连接不接受/,
  )
})

await check('db_schema 列表与字段', async () => {
  const { tools } = await makeContext()
  const tables = await tools.get('db_schema').execute({ connection: 'ro' }, exec)
  assert.ok(tables.tables.some((row) => row.name === 'users'))
  const fields = await tools.get('db_schema').execute({ connection: 'ro', table: 'users' }, exec)
  assert.deepEqual(fields.fields.map((row) => row.name), ['id', 'name'])
})

await check('db_exec 在只读数据源上直接拒绝', async () => {
  const { tools } = await makeContext()
  await assert.rejects(
    () => tools.get('db_exec').execute({ connection: 'ro', sql: "INSERT INTO users (name) VALUES ('x')" }, exec),
    /只读模式/,
  )
})

await check('db_exec 审批通过后执行', async () => {
  const { tools, asked } = await makeContext()
  const value = await tools.get('db_exec').execute(
    { connection: 'rw', sql: "INSERT INTO users (name) VALUES ('Grace')", reason: '补一条测试数据' },
    exec,
  )
  assert.equal(value.affectedRows, 1)
  assert.equal(asked.length, 1)
  assert.match(asked[0].reason, /INSERT INTO users/)
  assert.match(asked[0].reason, /补一条测试数据/)
  assert.equal(asked[0].agent.id, 'test-agent')
  assert.match(value.note, /SQL: INSERT INTO users/)
})

await check('db_exec 审批被拒就不执行', async () => {
  const { tools } = await makeContext({ approvalOutcome: 'rejected' })
  await assert.rejects(
    () => tools.get('db_exec').execute({ connection: 'rw', sql: "INSERT INTO users (name) VALUES ('Mallory')" }, exec),
    /未获授权（rejected）/,
  )
  const again = await tools.get('db_query').execute({ connection: 'ro', sql: 'SELECT COUNT(*) AS n FROM users' }, exec)
  assert.equal(again.rows[0][0], '3', '被拒的写入不应该落库')
})

await check('没有审批服务时写操作失败关闭', async () => {
  const { tools } = await makeContext({ withApproval: false })
  await assert.rejects(
    () => tools.get('db_exec').execute({ connection: 'rw', sql: "INSERT INTO users (name) VALUES ('Eve')" }, exec),
    /没有挂载审批服务/,
  )
})

await check('db_exec 拒绝多语句', async () => {
  const { tools } = await makeContext()
  await assert.rejects(
    () => tools.get('db_exec').execute({ connection: 'rw', sql: 'DELETE FROM users; DROP TABLE users' }, exec),
    /一次只能执行一条语句/,
  )
})

await check('未知参数、缺参数、未知数据源都有明确报错', async () => {
  const { tools } = await makeContext()
  await assert.rejects(() => tools.get('db_query').execute({ connection: 'ro', sql: 'SELECT 1', extra: 'x' }, exec), /不认识的参数/)
  await assert.rejects(() => tools.get('db_query').execute({ connection: 'ro' }, exec), /缺少必填参数/)
  await assert.rejects(() => tools.get('db_query').execute({ connection: 'nope', sql: 'SELECT 1' }, exec), /当前可用：ro, rw/)
})

await check('数据源校验：缺名称/坏方言/坏 id 都拒绝', () => {
  assert.throws(() => normalizeSource({ dialect: 'opengauss', database: 'x' }), /缺少名称/)
  assert.throws(() => normalizeSource({ name: 'a', dialect: 'oracle', database: 'x' }), /不支持的方言/)
  assert.throws(() => normalizeSource({ name: 'a', id: 'Bad Id', dialect: 'postgres', database: 'x' }), /不合法/)
  assert.throws(() => normalizeSource({ name: 'a', dialect: 'postgres' }), /缺少数据库名/)
})

await check('数据源默认值：端口、模式、上限', () => {
  const source = normalizeSource({ name: '生产库', dialect: 'opengauss', database: 'app' })
  assert.equal(source.id, '生产库'.length > 0 ? slugify('生产库') : '')
  assert.equal(source.port, 5432)
  assert.equal(source.mode, 'read')
  assert.equal(source.maxRows, 200)
  assert.equal(source.host, '127.0.0.1')
})

await check('达梦方言：默认端口 5236，端口可覆盖', () => {
  const source = normalizeSource({ name: '达梦库', dialect: 'dameng', database: 'APP' })
  assert.equal(source.dialect, 'dameng')
  assert.equal(source.port, 5236)
  const custom = normalizeSource({ name: '达梦库2', dialect: 'dameng', database: 'APP', port: 5237 })
  assert.equal(custom.port, 5237)
})

await check('凭据键名可预测且是合法标识符', () => {
  assert.equal(secretRefFor('prod-ro'), 'DSH_DB_PROD_RO')
  assert.match(secretRefFor('a_b-1'), /^[A-Za-z_][A-Za-z0-9_]*$/)
})

for (const service of opened) {
  try {
    await service.dispose()
  } catch {
    // 清理失败不影响结论
  }
}
try {
  rmSync(dir, { recursive: true, force: true })
} catch {
  // Windows 上偶发 EPERM（文件句柄尚未释放）；临时目录留着无妨
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
