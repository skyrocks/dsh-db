// Host 半（工具层）：把四个模型工具注册到 ctx.tools 上。
//
// 数据源不再写在插件配置里，而是由「设置 → 数据库」界面维护，存在
// $DSH_HOME/db/sources.json；密码存 DSH 凭据库，文件里没有。
//
// 三条安全约束：
//   1. 默认只读：SQL 闸门 + 数据库会话只读 + 界面里的 mode 开关，三层；
//   2. 写入必须授权：mode: write 的数据源上，每条写语句都走 ctx.approval；
//   3. 密码不进配置、不进工具参数、不回传客户端。
import { assertReadable, assertSingleWritable } from './sqlguard.js'
import { rowCells } from './drivers.js'

/** 每次执行完都把「这个插件认哪些 SQL」附在结果里，省得模型和用户猜。 */
const SUPPORTED_SQL = [
  '支持语句（一次一条，不支持多语句）：',
  '· 查询 db_query：SELECT / WITH / SHOW / EXPLAIN / DESCRIBE / VALUES / TABLE / PRAGMA（只读，任何数据源）',
  '· 写入 db_exec：INSERT / UPDATE / DELETE / MERGE / UPSERT / CREATE / DROP / ALTER / TRUNCATE 等任意单条写语句（仅可写数据源，逐条审批）',
].join('\n')

const DIALECT_LABEL = {
  opengauss: '海量/openGauss',
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  sqlite: 'SQLite',
}

/** 把单元格裁到固定宽度，避免一列把整张表挤爆。 */
function clip(text, width) {
  const value = String(text)
  if (value.length <= width) return value
  return `${value.slice(0, width - 1)}…`
}

/** 渲染成等宽表格文本。 */
function renderTable(columns, rows, rowCount, truncated) {
  const head = columns.map((name, index) => clip(name, index === 0 ? 28 : 40))
  const body = rows.map((row) => row.map((cell, index) => clip(cell, index === 0 ? 28 : 40)))
  const widths = head.map((name, index) => Math.max(
    name.length,
    ...body.map((row) => (row[index] ?? '').length),
  ))
  const line = (cells) => cells
    .map((cell, index) => cell + ' '.repeat(Math.max(0, widths[index] - cell.length)))
    .join('  ')
    .trimEnd()
  const lines = [line(head), widths.map((width) => '-'.repeat(width)).join('  ')]
  for (const row of body) lines.push(line(row))
  lines.push(truncated
    ? `…… 还有 ${rowCount - rows.length} 行没显示（结果上限 ${rows.length}；需要全量请加条件或聚合）`
    : `（${rowCount} 行）`)
  return lines.join('\n')
}

/** 统一参数校验：只认声明过的字段，类型不对直接说清楚。 */
function readArgs(tool, args, spec) {
  const value = args === undefined || args === null ? {} : args
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${tool}: 参数必须是对象。`)
  }
  const allowed = Object.keys(spec)
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`${tool}: 不认识的参数「${key}」；只接受 ${allowed.join(', ')}。`)
    }
  }
  const out = {}
  for (const [key, entry] of Object.entries(spec)) {
    const raw = value[key]
    const present = raw !== undefined && raw !== null && !(typeof raw === 'string' && raw.trim() === '')
    if (!present) {
      if (entry.required === true) throw new Error(`${tool}: 缺少必填参数「${key}」。`)
      continue
    }
    if (entry.type === 'number') {
      const number = typeof raw === 'number' ? raw : Number(raw)
      if (!Number.isFinite(number)) throw new Error(`${tool}: 参数「${key}」必须是数字。`)
      out[key] = number
      continue
    }
    if (typeof raw !== 'string') throw new Error(`${tool}: 参数「${key}」必须是字符串。`)
    out[key] = raw
  }
  return out
}

/** 取一个可选服务；没挂载或读取抛错都当没有。 */
function safeService(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

/** 数据源一行摘要，给 db_connections 用。 */
function describeSource(item) {
  const where = item.dialect === 'sqlite' ? item.database : `${item.host}:${item.port}/${item.database}`
  const mode = item.mode === 'write' ? '可写（需审批）' : '只读'
  return `- ${item.id} · ${item.name} · ${DIALECT_LABEL[item.dialect] ?? item.dialect} · ${where} · ${mode}`
    + `${item.hasPassword === false ? ' · ⚠ 未设置密码' : ''}`
}

const SOURCE_PROP = {
  type: 'string',
  description: '数据源 id，取值来自 db_connections 的返回（用户在「设置 → 数据库」里维护）',
}

export function registerTools(ctx, service) {
  const registry = service.registry

  ctx.tools.register({
    name: 'db_connections',
    description: [
      '列出用户配置了哪些数据源（id、名称、方言、地址、库、读写模式）。',
      '开始任何查询前先调它，确认连的是哪个库；数据源由用户在设置里维护，不要猜。',
    ].join(''),
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { connections: { type: 'array' }, note: { type: 'string' } },
        required: ['connections', 'note'],
      },
      render: (_args, value) => [{ type: 'text', text: value.note }],
    },
    async execute() {
      const { sources } = await service.list()
      if (sources.length === 0) {
        return {
          connections: [],
          note: '还没有数据源。让用户在「设置 → 数据库」里点「添加数据源」加一个（地址、库、用户、密码）。',
        }
      }
      return {
        connections: sources.map((item) => ({
          id: item.id,
          name: item.name,
          dialect: item.dialect,
          host: item.host,
          database: item.database,
          mode: item.mode,
          hasPassword: item.hasPassword,
        })),
        note: `共 ${sources.length} 个数据源：\n${sources.map(describeSource).join('\n')}`,
      }
    },
  })

  ctx.tools.register({
    name: 'db_schema',
    description: [
      '查看数据库结构。只给 connection 时列出表/视图；再给 table 时列出这张表的字段、类型、是否可空、默认值。',
      '写 SQL 之前先用它确认表名和列名，不要凭印象猜。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        connection: SOURCE_PROP,
        schema: { type: 'string', description: '可选。模式名；postgres/openGauss 默认 public' },
        table: { type: 'string', description: '可选。给了就列这张表的字段' },
      },
      required: ['connection'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          connection: { type: 'string' },
          tables: { type: 'array' },
          fields: { type: 'array' },
          note: { type: 'string' },
        },
        required: ['connection', 'note'],
      },
      render: (_args, value) => [{ type: 'text', text: value.note }],
    },
    async execute(rawArgs) {
      const args = readArgs('db_schema', rawArgs, {
        connection: { required: true },
        schema: {},
        table: {},
      })
      const spec = await registry.spec(args.connection)
      if (args.table !== undefined) {
        const { rows } = await registry.fields(spec.id, args.schema ?? '', args.table)
        if (rows.length === 0) {
          return {
            connection: spec.id,
            note: `表 ${args.table} 没有字段（表名或模式不对？先用不带 table 的 db_schema 看看有哪些表）。`,
          }
        }
        const lines = rows.map((row) => (
          `- ${row.name} ${row.type}${row.null ? '' : ' NOT NULL'}`
          + `${row.primaryKey ? ' PK' : ''}${row.default === '' ? '' : ` default=${row.default}`}`
        ))
        return {
          connection: spec.id,
          fields: rows,
          note: `表 ${args.table}（${spec.name}）共 ${rows.length} 个字段：\n${lines.join('\n')}`,
        }
      }
      const { rows } = await registry.tables(spec.id, args.schema ?? '')
      if (rows.length === 0) {
        return { connection: spec.id, tables: [], note: `${spec.name} 里没有看到表（模式名对不对？）` }
      }
      return {
        connection: spec.id,
        tables: rows,
        note: `${spec.name} 共 ${rows.length} 张表/视图：\n${rows.map((row) => `- ${row.schema}.${row.name} · ${row.type}`).join('\n')}`,
      }
    },
  })

  ctx.tools.register({
    name: 'db_query',
    description: [
      '执行一条只读查询（SELECT / WITH / SHOW / EXPLAIN 等），返回表格文本。',
      '任何数据源上都可以用，但它永远不会写：即使数据源本身是可写的，这条路径也走独立的只读会话——'
      + 'PRAGMA / ATTACH 和有副作用的函数（set_config、load_extension 等）一律拒绝。需要写入时用 db_exec。',
      '一次只执行一条语句；结果行数受数据源的 maxRows 限制，超了会明确告诉你还剩多少行。',
      '结果里会带上实际执行的 SQL。回答用户时，必须把这条 SQL 用 \`\`\`sql 代码块放在回答里（多表/多步就逐条列出），不要只在工具卡片里给。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        connection: SOURCE_PROP,
        sql: { type: 'string', description: '一条只读 SQL' },
        maxRows: { type: 'number', description: '可选。本次最多返回多少行，默认用数据源里的 maxRows' },
      },
      required: ['connection', 'sql'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          connection: { type: 'string' },
          sql: { type: 'string' },
          columns: { type: 'array' },
          rows: { type: 'array' },
          rowCount: { type: 'number' },
          truncated: { type: 'boolean' },
          elapsedMs: { type: 'number' },
          note: { type: 'string' },
        },
        required: ['connection', 'sql', 'columns', 'rows', 'rowCount', 'truncated', 'elapsedMs', 'note'],
      },
      render: (_args, value) => [{ type: 'text', text: value.note }],
    },
    async execute(rawArgs) {
      const args = readArgs('db_query', rawArgs, {
        connection: { required: true },
        sql: { required: true },
        maxRows: { type: 'number' },
      })
      const spec = await registry.spec(args.connection)
      assertReadable(args.sql, 'db_query')
      const limit = Math.min(Math.max(1, args.maxRows ?? spec.maxRows), 2000)
      const result = await registry.query(spec.id, args.sql, limit)
      const rows = result.rows.map((row) => rowCells(row, result.columns))
      return {
        connection: spec.id,
        sql: args.sql,
        columns: result.columns,
        rows,
        rowCount: result.totalRows,
        truncated: result.truncated,
        elapsedMs: result.elapsedMs,
        note: `${spec.name} · ${result.elapsedMs}ms\nSQL: ${args.sql.trim()}\n${renderTable(result.columns, rows, result.totalRows, result.truncated)}`,
      }
    },
  })

  ctx.tools.register({
    name: 'db_exec',
    description: [
      '在可写数据源上执行一条写入语句（INSERT / UPDATE / DELETE / DDL）。',
      '每一条都会先请求用户授权：理由里会带上完整 SQL，用户同意后才执行，一次授权只管这一条。',
      '只读数据源上直接拒绝。不确定时先用 db_query 看清楚影响范围。',
      '结果里会带上实际执行的 SQL。回答用户时，必须把这条 SQL 用 \`\`\`sql 代码块放在回答里，不要只在工具卡片里给。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        connection: SOURCE_PROP,
        sql: { type: 'string', description: '一条写入语句' },
        reason: { type: 'string', description: '可选。为什么要改数据，会一起展示给用户' },
      },
      required: ['connection', 'sql'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          connection: { type: 'string' },
          sql: { type: 'string' },
          affectedRows: { type: 'number' },
          elapsedMs: { type: 'number' },
          note: { type: 'string' },
        },
        required: ['connection', 'sql', 'affectedRows', 'elapsedMs', 'note'],
      },
      render: (_args, value) => [{ type: 'text', text: value.note }],
    },
    async execute(rawArgs, exec) {
      const args = readArgs('db_exec', rawArgs, {
        connection: { required: true },
        sql: { required: true },
        reason: {},
      })
      const spec = await registry.spec(args.connection)
      if (spec.mode !== 'write') {
        throw new Error(
          `db_exec: 数据源「${spec.name}」是只读模式。要写入请让用户在「设置 → 数据库」里把它改成可写——`
          + `这个开关只能由用户改，我不会自己去改。\n\n${SUPPORTED_SQL}`,
        )
      }
      assertSingleWritable(args.sql, 'db_exec')

      const approval = safeService(ctx, 'approval')
      if (approval === undefined || typeof approval.request !== 'function') {
        throw new Error('db_exec: 这个 DSH 部署没有挂载审批服务，写操作一律拒绝（fail closed）。')
      }
      const agent = exec === undefined || exec === null ? undefined : exec.agent
      if (agent === undefined || agent === null) {
        throw new Error('db_exec: 拿不到当前 agent，无法发起审批，写操作已拒绝。')
      }
      const why = args.reason === undefined ? '' : `\n理由：${args.reason}`
      const outcome = await approval.request({
        agent,
        toolName: 'db_exec',
        reason: `在数据源「${spec.name}」（${spec.database}）上执行写操作：\n${args.sql}${why}`,
        signal: exec.signal,
      })
      if (outcome !== 'allowed-once') {
        throw new Error(`db_exec: 写操作未获授权（${outcome}），没有执行任何语句。`)
      }

      const result = await registry.execute(spec.id, args.sql)
      const affected = typeof result.affectedRows === 'number' ? result.affectedRows : -1
      return {
        connection: spec.id,
        sql: args.sql,
        affectedRows: affected,
        elapsedMs: result.elapsedMs,
        note: `已执行（${spec.name}）· ${result.elapsedMs}ms · `
          + `${affected >= 0 ? `${affected} 行受影响` : '服务端没有返回影响行数'}\nSQL: ${args.sql.trim()}`,
      }
    },
  })

}
