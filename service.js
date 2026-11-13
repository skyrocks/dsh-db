// Host 服务：数据源的增删改查 + 连通性测试。
//
// 这一层同时服务两个调用方（见 dsh-doc 的 user-actions 约定）：
//   - 「设置 → 数据库」界面通过 ctx.remote.dbSources.* 调它；
//   - 模型工具 db_connections / db_schema / db_query / db_exec 也用它拿数据源。
// 所以「操作只实现一次」，界面和工具不会各写一套。
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

import { Registry } from './drivers.js'
import { createSourceStore, normalizeSource, secretRefFor } from './store.js'

/** 取一个可选服务，拿不到就返回 undefined（凭据服务在精简组合里可能没挂）。 */
function optionalService(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

export class DbSourcesService extends TypertRemoteService {
  constructor(ctx, options = {}) {
    super(ctx, 'dbSources')
    this.store = createSourceStore({
      path: typeof options.storePath === 'string' ? options.storePath : undefined,
    })
    this.registry = new Registry({
      all: () => this.store.read(),
      one: (id) => this.store.find(id),
      secret: (source) => this.secretFor(source),
    })
  }

  /** 凭据服务里的密码；读不到再退到同名环境变量。 */
  async secretFor(source) {
    const ref = secretRefFor(source.id)
    const credentials = optionalService(this.ctx, 'credentials')
    if (credentials !== undefined && credentials !== null && typeof credentials.resolve === 'function') {
      try {
        const found = await credentials.resolve(ref)
        if (found !== undefined && found !== null && typeof found.value === 'string' && found.value !== '') {
          return found.value
        }
      } catch {
        // 未设置或凭据服务拒绝，继续看环境变量
      }
    }
    return process.env[ref] ?? ''
  }

  /** 列表：带上 hasPassword，但永远不返回密码本身。 */
  async list() {
    const sources = await this.store.read()
    const credentials = optionalService(this.ctx, 'credentials')
    const described = await Promise.all(sources.map(async (source) => {
      let hasPassword = false
      if (credentials !== undefined && credentials !== null && typeof credentials.describe === 'function') {
        try {
          const info = await credentials.describe(secretRefFor(source.id))
          hasPassword = info?.configured === true
        } catch {
          hasPassword = false
        }
      }
      if (!hasPassword) hasPassword = (process.env[secretRefFor(source.id)] ?? '') !== ''
      return { ...source, hasPassword }
    }))
    return { sources: described, path: this.store.path }
  }

  /**
   * 新增或更新一条。`password` 省略/空串表示「不动已存的密码」。
   * @param {{ source: object, password?: string }} request
   */
  async save(request) {
    const input = request?.source
    const password = typeof request?.password === 'string' ? request.password : undefined
    const existing = await this.store.read()
    const rawId = typeof input?.id === 'string' ? input.id.trim() : ''
    const otherIds = existing.filter((item) => item.id !== rawId).map((item) => item.id)
    const source = normalizeSource(input, { takenIds: otherIds })
    const created = !existing.some((item) => item.id === source.id)

    if (password !== undefined && password !== '') {
      const credentials = optionalService(this.ctx, 'credentials')
      if (credentials === undefined || credentials === null || typeof credentials.set !== 'function') {
        throw new Error('这个 DSH 部署没有可写的凭据库，密码存不下来；先配置 credentials 再保存。')
      }
      await credentials.set(secretRefFor(source.id), password)
    }

    const next = created
      ? [...existing, source]
      : existing.map((item) => (item.id === source.id ? source : item))
    await this.store.write(next)
    await this.registry.invalidate(source.id)

    const credentials = optionalService(this.ctx, 'credentials')
    let hasPassword = false
    if (credentials !== undefined && credentials !== null && typeof credentials.describe === 'function') {
      try {
        hasPassword = (await credentials.describe(secretRefFor(source.id)))?.configured === true
      } catch {
        hasPassword = false
      }
    }
    return { source: { ...source, hasPassword }, created }
  }

  /** 删除一条，并清掉它的密码。（不能叫 remove：与 Remote 命名空间服务自带方法重名） */
  async delete(request) {
    const id = typeof request?.id === 'string' ? request.id.trim() : ''
    if (id === '') throw new Error('缺少数据源 id。')
    const existing = await this.store.read()
    const next = existing.filter((item) => item.id !== id)
    if (next.length === existing.length) return { removed: false }
    await this.store.write(next)
    await this.registry.invalidate(id)

    const credentials = optionalService(this.ctx, 'credentials')
    if (credentials !== undefined && credentials !== null && typeof credentials.unset === 'function') {
      try {
        await credentials.unset(secretRefFor(id))
      } catch {
        // 凭据删不掉不影响数据源已经移除
      }
    }
    return { removed: true }
  }

  /**
   * 用表单里当前的值试连一次（不落盘）。
   * @param {{ source: object, password?: string }} request
   */
  async test(request) {
    const input = request?.source
    const password = typeof request?.password === 'string' && request.password !== ''
      ? request.password
      : undefined
    const source = normalizeSource(input, {})
    let secret = password
    if (secret === undefined) secret = await this.secretFor(source)

    const probe = new Registry({
      all: async () => [source],
      one: async () => source,
      secret: async () => secret,
    })
    const started = Date.now()
    try {
      await probe.query(source.id, 'SELECT 1 AS ok', 1)
      return { ok: true, elapsedMs: Date.now() - started, dialect: source.dialect }
    } catch (error) {
      return {
        ok: false,
        elapsedMs: Date.now() - started,
        dialect: source.dialect,
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      await probe.closeAll()
    }
  }

  async dispose() {
    await this.registry.closeAll()
  }
}
