# Changelog

## 0.1.2

把「查询路径只读」从「尽力而为」改成「要么只读、要么拒绝」。

- PostgreSQL / openGauss 先用 `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`，
  失败再试 `SET default_transaction_read_only = on`；两种都不认就**断开连接并拒绝查询**，
  不再退回「仅靠语句闸门」。
- MySQL 同理：`SET SESSION TRANSACTION READ ONLY` → `transaction_read_only = 1` → 拒绝。
- 错误文案说明是「无法建立只读会话」，便于区分「服务端太老」和「SQL 越界」。

## 0.1.1

安全修复（审阅反馈）：`db_query` 曾在可写数据源上复用写连接，能执行改状态的 `PRAGMA`
（如 `user_version` / `journal_mode`），绕开「写入逐条审批」。

- **查询路径改用独立只读连接**：`db_query` / `db_schema` 现在按 `id|ro` 单独建连，
  即使数据源是 `mode: write`，连接后也执行会话级只读
  （PG/openGauss `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`、
  MySQL `SET SESSION TRANSACTION READ ONLY`、SQLite 只读句柄 + `query_only`）。
  写路径用 `id|rw` 的另一条连接，互不影响。
- **拦截有副作用的语句**：只读白名单移除 `PRAGMA`，并显式拒绝 `PRAGMA` / `ATTACH` / `DETACH`；
  关键字扫描补充 `set_config` / `load_extension` / `writable_schema` / `pg_advisory_lock` 等。
- 测试 +7：查询路径在可写数据源上写不进去、PRAGMA 被数据库拒绝、PRAGMA/函数被闸门拦下。

## 0.1.0

首个版本。

- 多数据源：在「设置 → 数据库」里添加 / 编辑 / 删除数据源，可以就地「测试连接」。
  数据源存 `$DSH_HOME/db/sources.json`（只有元数据），密码存 DSH 凭据库（`DSH_DB_<ID>`）。
- 四个工具：`db_connections` / `db_schema` / `db_query` / `db_exec`。
- 方言：海量 Vastbase / openGauss（`opengauss.js`，sha256 + SM3）、PostgreSQL、MySQL、SQLite（Node 内置 `node:sqlite`）。
- 只读三层：语句白名单、数据库会话只读、界面开关。
- 写入逐条走 DSH 审批通道，拒绝 / 取消 / 无审批服务一律失败关闭。
- 每次执行结束，结果里回显实际执行的 SQL；系统提示里要求模型把它写进回答正文。
