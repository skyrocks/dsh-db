# Changelog

## 0.2.3

- 设置页左侧导航补上专属图标：注册 `settings.section.icon`（之前只注册了 `settings.section`，不注册图标就会显示壳默认的齿轮）。

## 0.2.2

资源释放修复。审阅指出 Windows 上 `EPERM` / `EBUSY: ... unlink sample.db`，并怀疑
「删数据源」这条路径同样会卡住——这个怀疑是对的，确实是同一类问题。

- **关闭连接改为排队执行**：`invalidate()` / `closeAll()` 之前直接调 `entry.close()`，
  绕过了串行队列。如果这时正有一条查询在这个连接上跑，SQLite 句柄会被从查询脚下抽走；
  Windows 上就表现为文件被占用（`EBUSY`）。现在关闭排进队列，等当前查询结束再关。
- **删除数据源改为「先断连接，再落盘」**：句柄必须在数据源从列表里消失之前释放干净。
- 测试新增：关闭时机的顺序断言（查询未结束不关）、关闭后句柄真的不可用
  （`prepare` 抛 `database is not open`，说明文件描述符已归还）、关闭后重连可用。

## 0.2.1

崩溃修复：连接失败或查询失败时，DSH Host 进程会被直接打掉（崩溃日志里的
`dsh: fatal uncaught exception: Error: read EADDRNOTAVAIL`）。

- **根因**：pg（opengauss.js）、mysql2、dmdb 都是 EventEmitter，socket 上的 `error`
  没人监听时会被 EventEmitter 直接抛出——那是未捕获异常，整个进程退出。
  旧代码在连接成功之后才用到客户端，连接失败/中途断开时完全没有监听。
- 现在**建出连接对象的第一时间就挂 `error` 监听**（在 `connect()` 之前），
  标记该连接已坏；下一次调用自动丢掉重连。连接失败时也会 `destroy()` 掉半个连接。
- 超时错误带上 `code = DSH_DB_TIMEOUT`。原来靠中文字面「超时」去匹配 `/timeout/`，
  永远匹配不上，坏连接不会被丢弃，会在同一条还在跑的查询上再发查询
  （崩溃日志里那条 `client.query() when the client is already executing a query` 就是它）。
- 关闭连接最多等 2 秒，不再让一次工具调用被坏连接拖住。
- 测试 33 条（+3：无监听会抛、guard 能接住并标记、超时可判定）。

## 0.2.0

新增 **达梦 DM8** 数据源，用官方 `dmdb` 驱动（纯 JS，oracledb 风格 API，Node 12+）。

- 方言列表、默认端口（5236）、设置界面、`db_connections` 展示都接上。
- 只读路径：每条查询前 `SET TRANSACTION READ ONLY`，查完回滚；开不起只读事务就拒绝查询（与其他方言一致的 fail closed）。
- 写路径：连接开 `autoCommit`，和常见客户端行为一致。
- 结构查询走 `USER_TABLES` / `ALL_TABLES`、`USER_TAB_COLUMNS` / `ALL_TAB_COLUMNS`（Oracle 兼容视图）。
- `peerDependencies` 标记为 optional：`npm install` 不再因 DSH 内置 cordis 版本冲突而失败。
- 测试 30 条（+1：达梦默认端口与方言校验）。

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
