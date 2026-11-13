// Host 半（插件入口）：建数据源服务，再把工具挂上去。
//
// 数据源不在插件配置里，而由「设置 → 数据库」界面维护，存在
// $DSH_HOME/db/sources.json；密码存 DSH 凭据库，文件里没有。
//
// 拆成两个文件是为了可测：tools.js 只依赖服务对象，测试里可以塞一个假的。
import { DbSourcesService } from './service.js'
import { registerTools } from './tools.js'

/** 要用 ctx.tools 注册工具，必须先声明依赖，否则激活时报 "cannot get property tools"。 */
export const inject = ['tools']

/** 取一个可选服务；没挂载就返回 undefined。 */
function optionalService(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

export function apply(ctx) {
  const service = new DbSourcesService(ctx)
  registerTools(ctx, service)

  // 工具结果只会进卡片，而卡片默认是折叠的。要让 SQL 出现在回答正文里，只有把
  // 这条约定写进系统提示，模型才会照做——工具自己没法往回答里写字。
  const systemPrompt = optionalService(ctx, 'systemPrompt')
  if (systemPrompt !== undefined && typeof systemPrompt.section === 'function') {
    const dispose = systemPrompt.section({
      name: 'dsh-db:sql-in-answer',
      order: 9000,
      text: [
        '数据库工具约定：每次调用 db_query 或 db_exec 之后，回答用户时必须在正文里列出实际执行的 SQL',
        '（用 \`\`\`sql 代码块），不能只让它出现在工具卡片里；一次调用跑了多条就逐条列出。',
        '这条要求优先于“回答要简洁”。',
      ].join(''),
    })
    if (typeof ctx.effect === 'function') ctx.effect(() => () => dispose())
  }
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => service.dispose())
  }
}
