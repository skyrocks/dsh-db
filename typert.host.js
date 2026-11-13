// Typert Host 清单：声明 dbSources/{list,save,remove,test} 四个 direct 调用。
// 0.2.x 的 strict codec 必须是 `{ mode, typeSymbol, create() }`；这里不依赖 zod，
// 目录直装不会缺包。Client 侧 client.js 里有一份形状相同的声明。
//
// 注意：密码永远不在参数里回传——save 只接受「新密码」，list 只回 hasPassword。

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function fail(field, expected) {
  throw new Error(`dsh-db ${field}: 需要 ${expected}`)
}

function string(field, value, { optional = false } = {}) {
  if (optional && (value === undefined || value === null)) return value
  if (typeof value !== 'string') fail(field, '字符串')
  return value
}

function codec(typeSymbol, parse) {
  return { mode: 'strict', typeSymbol, create: () => ({ parse }) }
}

const result = (name, parse) => codec(`@skyrocks/dsh-db#DbSources${name}Result`, parse)
const parameter = (name, parse) => ({
  name,
  wire: name,
  source: 'json',
  codec: codec(`@skyrocks/dsh-db#${name}`, parse),
})

function parseSourceShape(value) {
  if (!isRecord(value)) fail('source', '对象')
  // 新增时没有 id：Host 侧按名称生成。
  string('source.id', value.id, { optional: true })
  string('source.name', value.name)
  string('source.dialect', value.dialect)
  string('source.database', value.database)
  string('source.mode', value.mode)
  return value
}

function parseSaveRequest(value) {
  if (!isRecord(value)) fail('save request', '对象')
  parseSourceShape(value.source)
  // 密码可以为空：编辑时留空表示「不修改已存的密码」。
  if (value.password !== undefined) string('save request.password', value.password)
  return value
}

function parseDeleteRequest(value) {
  if (!isRecord(value)) fail('delete request', '对象')
  string('delete request.id', value.id)
  return value
}

function parseTestRequest(value) {
  if (!isRecord(value)) fail('test request', '对象')
  parseSourceShape(value.source)
  if (value.password !== undefined) string('test request.password', value.password)
  return value
}

const parseListResult = (value) => {
  if (!isRecord(value)) fail('list result', '对象')
  if (!Array.isArray(value.sources)) fail('result.sources', '数组')
  string('result.path', value.path)
  return value
}

const parseSaveResult = (value) => {
  if (!isRecord(value)) fail('save result', '对象')
  parseSourceShape(value.source)
  if (typeof value.created !== 'boolean') fail('result.created', '布尔值')
  return value
}

const parseDeleteResult = (value) => {
  if (!isRecord(value)) fail('remove result', '对象')
  if (typeof value.removed !== 'boolean') fail('result.removed', '布尔值')
  return value
}

const parseTestResult = (value) => {
  if (!isRecord(value)) fail('test result', '对象')
  if (typeof value.ok !== 'boolean') fail('result.ok', '布尔值')
  if (typeof value.elapsedMs !== 'number') fail('result.elapsedMs', '数字')
  return value
}

const invocation = (method, parameters, parseResult) => ({
  id: `@skyrocks/dsh-db#dbSources/${method}`,
  service: 'dbSources',
  namespace: 'dbSources',
  method,
  invocation: { kind: 'direct' },
  parameters,
  result: result(`${method[0].toUpperCase()}${method.slice(1)}`, parseResult),
})

export const TYPERT = {
  package: '@skyrocks/dsh-db',
  face: 'host',
  schemas: [],
  invocations: [
    invocation('list', [], parseListResult),
    invocation('save', [parameter('request', parseSaveRequest)], parseSaveResult),
    invocation('delete', [parameter('request', parseDeleteRequest)], parseDeleteResult),
    invocation('test', [parameter('request', parseTestRequest)], parseTestResult),
  ],
  model: { services: [], events: [], objects: [] },
}
