# 发布清单（维护者用）

这份文件不会随 tarball 发布，只用于把仓库整理成可公开的状态。

## 1. 发布前检查

```sh
node test/smoke.mjs       # 驱动层 + SQL 闸门（10 条）
node test/plugin.mjs      # 工具接线 + 数据源校验（14 条）
node --check index.js && node --check service.js && node --check tools.js
node --check client.js && node --check drivers.js && node --check store.js
```

- [ ] 版本号与 `CHANGELOG.md` 对应
- [ ] `README.md` / `README.en.md` 与当前界面一致
- [ ] `package.json` 的 `repository` / `homepage` / `bugs` 指向 `skyrocks/dsh-db`
- [ ] `engines.dsh` 与目标 DSH 版本匹配
- [ ] `peerDependencies` 只用真正 import 的包（`react` / `cordis` / `typert-protocol`）

## 2. 本地安装自测

```sh
cd ~/PrivateCode/dsh/dsh-db && npm install
dsh plugin add /Users/shilei/PrivateCode/dsh/dsh-db
```

装完在「设置 → 数据库」里加一条数据源，点「测试连接」，再用 `db_query` 跑一条 `SELECT 1`。

## 3. 打包

```sh
pnpm pack     # 生成 skyrocks-dsh-db-0.1.0.tgz
```

## 4. 发布

```sh
git push -u origin main
gh release create v0.1.0 ./skyrocks-dsh-db-0.1.0.tgz --title "v0.1.0" --generate-notes
```

## 5. 更新插件索引

把 tarball 放进 `dsh-plugins/dist/`，在 `index.json` 里加一条 `versions[]`
（`source.commit` 填本次提交 sha），并更新 `README.md` / `README.en.md` 的表格。

## 6. 可选：发布到 npm

```sh
npm publish --access public
```

注意：`mysql2` 与 `opengauss.js` 是运行时依赖，会随 npm 安装；目录直装时需要在插件目录里
跑一次 `npm install`。
