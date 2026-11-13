# Changelog

## 0.1.0

首个版本。

- 多数据源：在「设置 → 数据库」里添加 / 编辑 / 删除数据源，可以就地「测试连接」。
  数据源存 `$DSH_HOME/db/sources.json`（只有元数据），密码存 DSH 凭据库（`DSH_DB_<ID>`）。
- 四个工具：`db_connections` / `db_schema` / `db_query` / `db_exec`。
- 方言：海量 Vastbase / openGauss（`opengauss.js`，sha256 + SM3）、PostgreSQL、MySQL、SQLite（Node 内置 `node:sqlite`）。
- 只读三层：语句白名单、数据库会话只读、界面开关。
- 写入逐条走 DSH 审批通道，拒绝 / 取消 / 无审批服务一律失败关闭。
- 每次执行结束，结果里回显实际执行的 SQL；系统提示里要求模型把它写进回答正文。
