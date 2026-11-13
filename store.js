// 数据源存储层：纯文件逻辑，不依赖 Cordis / DSH 服务，方便单测。
//
// 一条数据源不含密码：密码按 id 存在 DSH 凭据库里（键名见 secretRefFor），
// 所以 sources.json 可以直接给人看、给客户端列，泄不出去凭据。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** 支持的方言。opengauss 覆盖海量 Vastbase / openGauss / MogDB。 */
export const DIALECTS = ['opengauss', 'postgres', 'mysql', 'sqlite']

/** id 直接进文件名与凭据键，限制得严一点。 */
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,40}$/

const DEFAULT_PORT = { opengauss: 5432, postgres: 5432, mysql: 3306, sqlite: 0 }

/**
 * DSH home：显式 $DSH_HOME 优先，与 dsh-home-paths 的约定一致。
 * @returns {string} 绝对路径。
 */
export function dshHome() {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return configured.length > 0 ? resolve(configured) : join(homedir(), '.dsh')
}

/** 默认数据源文件。 */
export function defaultStorePath() {
  return join(dshHome(), 'db', 'sources.json')
}

/**
 * 派生密码用的凭据键：DSH_DB_<ID>。DSH 的凭据引用要求是 shell 标识符。
 * @param {string} id - 数据源 id。
 * @returns {string} 凭据引用名。
 */
export function secretRefFor(id) {
  return `DSH_DB_${String(id).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
}

/** 把名字压成 id：小写、非字母数字换 -、截断。 */
export function slugify(name) {
  const ascii = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return ascii.length > 0 ? ascii : `db-${Date.now().toString(36).slice(-6)}`
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
}

function asNumber(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

/**
 * 校验并补全一条数据源。非法输入抛带字段名的错误，而不是静默丢字段。
 * @param {unknown} input - 客户端/工具传上来的原始对象。
 * @param {{ takenIds?: string[], fallbackId?: string }} options
 * @returns {object} 归一化后的数据源。
 */
export function normalizeSource(input, options = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('数据源必须是对象。')
  }
  const dialect = asString(input.dialect, 'opengauss')
  if (!DIALECTS.includes(dialect)) {
    throw new Error(`不支持的方言「${dialect}」；可选：${DIALECTS.join(' / ')}。`)
  }

  const name = asString(input.name)
  if (name.length === 0) throw new Error('缺少名称。')

  const rawId = asString(input.id)
  const id = rawId.length > 0 ? rawId : (options.fallbackId ?? slugify(name))
  if (!ID_PATTERN.test(id)) {
    throw new Error(`id「${id}」不合法：只能用小写字母、数字、- 和 _，且以字母或数字开头（最长 41）。`)
  }
  const taken = Array.isArray(options.takenIds) ? options.takenIds : []
  if (taken.includes(id) && rawId.length === 0) {
    throw new Error(`已经有 id 为「${id}」的数据源；换个名字，或编辑那一条。`)
  }

  const database = asString(input.database)
  if (database.length === 0) {
    throw new Error(dialect === 'sqlite' ? '缺少数据库文件路径。' : '缺少数据库名。')
  }

  const mode = asString(input.mode, 'read')
  if (mode !== 'read' && mode !== 'write') throw new Error('mode 只能是 read 或 write。')

  const port = dialect === 'sqlite' ? 0 : asNumber(input.port, DEFAULT_PORT[dialect])
  if (dialect !== 'sqlite' && (port <= 0 || port > 65535)) {
    throw new Error(`端口「${port}」不合法。`)
  }

  const maxRows = Math.min(Math.max(1, asNumber(input.maxRows, 200)), 2000)
  const timeoutMs = Math.min(Math.max(1000, asNumber(input.timeoutMs, 30000)), 600000)
  const sslmode = asString(input.sslmode, 'disable') || 'disable'

  return {
    id,
    name,
    dialect,
    host: dialect === 'sqlite' ? '' : (asString(input.host) || '127.0.0.1'),
    port,
    database,
    user: dialect === 'sqlite' ? '' : asString(input.user),
    sslmode,
    mode,
    maxRows,
    timeoutMs,
  }
}

/**
 * 数据源文件读写。
 * @param {{ path?: string }} options - path 覆盖默认位置（测试用）。
 */
export function createSourceStore(options = {}) {
  const path = typeof options.path === 'string' && options.path.length > 0
    ? resolve(options.path)
    : defaultStorePath()

  /** 读全量；文件不存在当作空库。坏 JSON 抛错，不静默吞掉。 */
  async function read() {
    let text
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    if (text.trim() === '') return []
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(`${path} 不是合法 JSON，先修好这个文件再加数据源。`)
    }
    const list = Array.isArray(parsed?.sources) ? parsed.sources : []
    return list.filter((item) => item !== null && typeof item === 'object')
  }

  /** 原子写：先写临时文件再 rename，避免半截文件。 */
  async function write(sources) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${process.pid}.tmp`
    const body = `${JSON.stringify({ version: 1, sources }, null, 2)}\n`
    await writeFile(temporary, body, { mode: 0o600 })
    await rename(temporary, path)
  }

  return {
    path,
    read,
    write,
    async find(id) {
      const sources = await read()
      return sources.find((item) => item.id === id)
    },
  }
}
