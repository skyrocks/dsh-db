// SQL 语句分类：给「只读」这条线做第一道闸。
//
// 真正的保证在数据库那边（只读会话 / 只读事务），这里只是把明显越界的语句
// 提前挡掉，并给出能读懂的错误，而不是让模型去猜为什么被拒。
//
// 做法：先把注释和字符串字面量抹成空格（避免 `-- delete` 这种误判，也避免
// 字面量里的分号被当成多语句），再在剩下的骨架上判断。

const READ_KEYWORDS = new Set([
  'select', 'with', 'show', 'explain', 'describe', 'desc', 'values', 'table',
])

// 需要点名拦掉的语句形态：PRAGMA 能改库头（user_version / journal_mode / writable_schema），
// 只读会话挡得住写文件，但明确拒绝更清楚，也挡住「先改成可写再写」的尝试。
const BLOCKED_STATEMENTS = new Set(['pragma', 'attach', 'detach'])

// 只读连接里出现这些词就拒绝。宁可错杀：模型改一句 SQL 的成本，远低于
// 在生产库上误写一笔数据的成本。
const WRITE_KEYWORDS = [
  'insert', 'update', 'delete', 'merge', 'upsert',
  'create', 'drop', 'alter', 'truncate', 'comment',
  'grant', 'revoke', 'copy', 'call', 'do', 'vacuum', 'analyze', 'reindex', 'refresh',
  'lock', 'listen', 'notify', 'unlisten',
  'begin', 'start', 'commit', 'rollback', 'savepoint', 'release', 'prepare', 'execute',
  'deallocate', 'declare', 'fetch', 'move',
  'into', 'nextval', 'setval', 'pg_terminate_backend', 'pg_cancel_backend',
  // 有副作用的函数：写配置、拿咨询锁、加载扩展、改 schema 版本
  'set_config', 'pg_advisory_lock', 'pg_advisory_unlock', 'load_extension', 'writable_schema',
  'get_lock', 'release_lock', 'checkpoint',
]

/**
 * 抹掉注释和字面量，只留语句骨架。
 * @param {string} sql - 原始 SQL。
 * @returns {string} 同样长度量级的骨架文本。
 */
export function skeleton(sql) {
  let out = ''
  let i = 0
  const text = String(sql)

  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]

    // 行注释
    if (ch === '-' && next === '-') {
      while (i < text.length && text[i] !== '\n') i += 1
      out += ' '
      continue
    }
    // 块注释（允许嵌套一层，够用）
    if (ch === '/' && next === '*') {
      let depth = 1
      i += 2
      while (i < text.length && depth > 0) {
        if (text[i] === '/' && text[i + 1] === '*') { depth += 1; i += 2; continue }
        if (text[i] === '*' && text[i + 1] === '/') { depth -= 1; i += 2; continue }
        i += 1
      }
      out += ' '
      continue
    }
    // 单引号字符串（'' 是转义）
    if (ch === "'") {
      i += 1
      while (i < text.length) {
        if (text[i] === "'" && text[i + 1] === "'") { i += 2; continue }
        if (text[i] === "'") { i += 1; break }
        i += 1
      }
      out += ' '
      continue
    }
    // 双引号标识符 / 反引号标识符：保留内容（它可能是列名），但去掉引号
    if (ch === '"' || ch === '`') {
      const quote = ch
      i += 1
      let ident = ''
      while (i < text.length) {
        if (text[i] === quote && text[i + 1] === quote) { ident += quote; i += 2; continue }
        if (text[i] === quote) { i += 1; break }
        ident += text[i]
        i += 1
      }
      out += ` ${ident} `
      continue
    }
    // 美元引用（$$...$$ 或 $tag$...$tag$）
    if (ch === '$') {
      const match = /^\$[A-Za-z_0-9]*\$/.exec(text.slice(i))
      if (match) {
        const tag = match[0]
        const end = text.indexOf(tag, i + tag.length)
        i = end < 0 ? text.length : end + tag.length
        out += ' '
        continue
      }
    }
    out += ch
    i += 1
  }
  return out
}

/**
 * 把骨架按分号切开，丢掉空段。返回真正的语句骨架数组。
 * @param {string} sql - 原始 SQL。
 * @returns {string[]} 骨架语句。
 */
export function statements(sql) {
  return skeleton(sql)
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

/**
 * 单语句检查。多语句一律拒绝：审批和日志都按「一条语句」表达，多语句会让
 * 展示与执行脱节。
 * @param {string} sql - 原始 SQL。
 * @param {string} tool - 工具名，用于错误文案。
 * @returns {string} 去掉首尾空白的单条语句骨架的首词（小写）。
 */
export function firstKeywordOf(sql, tool) {
  const parts = statements(sql)
  if (parts.length === 0) throw new Error(`${tool}: SQL 是空的。`)
  if (parts.length > 1) {
    throw new Error(`${tool}: 一次只能执行一条语句，检测到 ${parts.length} 条。请拆开逐条执行。`)
  }
  const keyword = /^[A-Za-z_]+/.exec(parts[0])
  return keyword === null ? '' : keyword[0].toLowerCase()
}

/**
 * 只读校验：不是读语句、或含有写关键字，就抛错。
 * @param {string} sql - 原始 SQL。
 * @param {string} tool - 工具名，用于错误文案。
 * @returns {void}
 */
export function assertReadable(sql, tool) {
  const keyword = firstKeywordOf(sql, tool)
  if (BLOCKED_STATEMENTS.has(keyword)) {
    throw new Error(
      `${tool}: 不接受 ${keyword.toUpperCase()} 语句——它可以修改数据库状态，绕开写入审批。`
      + ' 读结构请用 db_schema；SQLite 的只读表函数（如 SELECT * FROM pragma_table_info(\'t\')）仍可用。',
    )
  }
  if (!READ_KEYWORDS.has(keyword)) {
    throw new Error(
      `${tool}: 只读连接不接受 \`${keyword || '?'}\` 开头的语句；`
      + `只放行 ${[...READ_KEYWORDS].join(' / ')}。要写入请用 db_exec 并走审批。`,
    )
  }
  const flat = statements(sql)[0].toLowerCase()
  for (const word of WRITE_KEYWORDS) {
    const pattern = new RegExp(`(^|[^A-Za-z0-9_])${word}([^A-Za-z0-9_]|$)`, 'i')
    if (pattern.test(flat)) {
      throw new Error(`${tool}: 只读连接不允许出现 \`${word}\`（即使它藏在 CTE 或函数调用里）。`)
    }
  }
}

/**
 * 写语句的单语句校验（不做关键字白名单，交给数据库）。
 * @param {string} sql - 原始 SQL。
 * @param {string} tool - 工具名，用于错误文案。
 * @returns {string} 首词。
 */
export function assertSingleWritable(sql, tool) {
  return firstKeywordOf(sql, tool)
}
