// Client 半：「设置 → 数据库」里增删改数据源，并试连。
//
// 手写 lazy-CJS bundle：脚本执行时只注册 factory，模块体在 materialize 时才运行。
// 只依赖 React 与 DSH 既有服务（slots / remote），不引入 primitives。
window.__ModuleLoader__.load({
  id: "@skyrocks/dsh-db",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");

    // Client 只声明调用形状；真正的校验在 Host 侧完成。
    const passThrough = () => ({ parse: (value) => value });
    const codec = (typeSymbol) => ({ mode: "strict", typeSymbol, create: passThrough });
    const parameter = (name) => ({ name, wire: name, source: "json", codec: codec(`@skyrocks/dsh-db#${name}`) });

    const REMOTE = {
      package: "@skyrocks/dsh-db",
      descriptors: [
        {
          id: "@skyrocks/dsh-db#dbSources/list",
          service: "dbSources",
          namespace: "dbSources",
          method: "list",
          invocation: { kind: "direct" },
          parameters: [],
          result: codec("@skyrocks/dsh-db#DbSourcesListResult")
        },
        {
          id: "@skyrocks/dsh-db#dbSources/save",
          service: "dbSources",
          namespace: "dbSources",
          method: "save",
          invocation: { kind: "direct" },
          parameters: [parameter("request")],
          result: codec("@skyrocks/dsh-db#DbSourcesSaveResult")
        },
        {
          id: "@skyrocks/dsh-db#dbSources/delete",
          service: "dbSources",
          namespace: "dbSources",
          method: "delete",
          invocation: { kind: "direct" },
          parameters: [parameter("request")],
          result: codec("@skyrocks/dsh-db#DbSourcesRemoveResult")
        },
        {
          id: "@skyrocks/dsh-db#dbSources/test",
          service: "dbSources",
          namespace: "dbSources",
          method: "test",
          invocation: { kind: "direct" },
          parameters: [parameter("request")],
          result: codec("@skyrocks/dsh-db#DbSourcesTestResult")
        }
      ]
    };

    const DIALECTS = [
      { value: "opengauss", label: "海量 Vastbase / openGauss", port: 5432 },
      { value: "postgres", label: "PostgreSQL", port: 5432 },
      { value: "mysql", label: "MySQL / MariaDB", port: 3306 },
      { value: "sqlite", label: "SQLite 文件", port: 0 }
    ];

    const CSS = [
      ".dsh-db-section{display:flex;flex-direction:column;gap:12px;padding:4px 2px 24px;}",
      ".dsh-db-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;}",
      ".dsh-db-head h3{margin:0;font-size:13px;font-weight:600;}",
      ".dsh-db-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98);word-break:break-all;}",
      ".dsh-db-list{display:flex;flex-direction:column;gap:1px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));border-radius:10px;overflow:hidden;background:var(--dsw-alias-border-l1,rgba(127,127,127,.18));}",
      ".dsh-db-row{display:flex;align-items:center;gap:12px;padding:10px 12px;background:var(--dsw-alias-bg-module-platform,#fff);}",
      ".dsh-db-row-main{flex:1;min-width:0;}",
      ".dsh-db-row-title{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--dsw-alias-label-primary,#1f2329);}",
      ".dsh-db-row-title span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
      ".dsh-db-row-sub{margin-top:2px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
      ".dsh-db-row-actions{display:flex;gap:2px;flex:none;}",
      ".dsh-db-badge{flex:none;padding:1px 6px;border-radius:999px;font-size:10px;line-height:16px;border:1px solid transparent;}",
      ".dsh-db-badge.is-read{color:var(--dsw-alias-state-success-primary,#2f9e44);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2f9e44) 12%,transparent);}",
      ".dsh-db-badge.is-write{color:var(--dsw-alias-state-warning-primary,#d97706);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d97706) 14%,transparent);}",
      ".dsh-db-badge.is-warn{color:var(--dsw-alias-state-error-primary,#e5484d);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 12%,transparent);}",
      ".dsh-db-empty{padding:28px 12px;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8f98);}",
      ".dsh-db-error{margin-top:10px;padding:8px 10px;border-radius:8px;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-state-error-primary,#e5484d);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 10%,transparent);}",
      ".dsh-db-ok{margin-top:10px;padding:8px 10px;border-radius:8px;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-state-success-primary,#2f9e44);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2f9e44) 10%,transparent);}",
      ".dsh-db-btn{height:30px;padding:0 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));background:transparent;color:inherit;font-size:12px;cursor:pointer;}",
      ".dsh-db-btn:hover{background:color-mix(in srgb,currentColor 8%,transparent);}",
      ".dsh-db-btn:disabled{opacity:.5;cursor:default;}",
      ".dsh-db-btn.is-primary{color:#fff;background:var(--dsw-alias-state-business-primary,#4d6bfe);border-color:transparent;}",
      ".dsh-db-btn.is-danger{color:#fff;background:var(--dsw-alias-state-error-primary,#e5484d);border-color:transparent;}",
      ".dsh-db-btn.is-link{padding:0 6px;height:24px;border-color:transparent;font-size:11.5px;color:var(--dsw-alias-state-business-primary,#4d6bfe);}",
      ".dsh-db-overlay{position:fixed;inset:0;z-index:2200;pointer-events:auto;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.38);}",
      ".dsh-db-dialog{width:min(520px,100%);max-height:calc(100vh - 64px);overflow:auto;border-radius:12px;background:var(--dsw-alias-bg-module-platform,#fff);border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));box-shadow:0 18px 48px rgba(0,0,0,.26);color:var(--dsw-alias-label-primary,#1f2329);padding:18px;}",
      ".dsh-db-dialog h2{margin:0 0 12px;font-size:14px;font-weight:600;}",
      ".dsh-db-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 12px;}",
      ".dsh-db-field{display:flex;flex-direction:column;gap:4px;min-width:0;}",
      ".dsh-db-field.is-wide{grid-column:1 / -1;}",
      ".dsh-db-field label{font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);}",
      ".dsh-db-field input,.dsh-db-field select{height:30px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));background:transparent;color:inherit;font-size:12px;min-width:0;}",
      ".dsh-db-hint{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8a8f98);line-height:1.5;}",
      ".dsh-db-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px;}",
      ".dsh-db-actions .dsh-db-spacer{flex:1;}"
    ].join("");

    function ensureStyle() {
      if (typeof document === "undefined") return () => {};
      const id = "dsh-db-style";
      if (document.getElementById(id) !== null) return () => {};
      const element = document.createElement("style");
      element.id = id;
      element.textContent = CSS;
      document.head.appendChild(element);
      return () => {
        element.remove();
      };
    }

    /** 极简共享快照：版本号变化让列表重新拉取。 */
    function createStore(initial) {
      const listeners = new Set();
      let value = initial;
      return {
        get: () => value,
        set(next) {
          value = next;
          for (const listener of listeners) listener();
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        }
      };
    }

    function useStore(store) {
      return React.useSyncExternalStore(store.subscribe, store.get, store.get);
    }

    const revisionStore = createStore(0);
    const bumpRevision = () => revisionStore.set(revisionStore.get() + 1);

    let ctxRef = null;
    let mountReady = Promise.resolve();

    async function call(method, argument) {
      await mountReady;
      const remote = ctxRef === null ? undefined : ctxRef.get("remote.dbSources");
      if (remote === undefined || remote === null) throw new Error("数据库服务不可用（Host 未加载）");
      const result = argument === undefined ? await remote[method]() : await remote[method](argument);
      if (!result || result.ok === false) {
        const reason = result && result.error ? result.error.message || String(result.error) : "操作失败，请重试";
        throw new Error(reason);
      }
      return result.value;
    }

    function notify(text, success, action) {
      try {
        const menus = ctxRef === null ? undefined : ctxRef.get("contextMenus");
        if (menus !== undefined && typeof menus.notify === "function") menus.notify(text, success, action);
      } catch {
        // toast 不可用就静默；操作已经完成。
      }
    }

    function dialectLabel(value) {
      const hit = DIALECTS.find((item) => item.value === value);
      return hit === undefined ? value : hit.label;
    }

    function where(source) {
      if (source.dialect === "sqlite") return source.database;
      const user = source.user === "" ? "" : `${source.user}@`;
      return `${user}${source.host}:${source.port}/${source.database}`;
    }

    function emptyDraft() {
      return {
        id: "",
        name: "",
        dialect: "opengauss",
        host: "127.0.0.1",
        port: 5432,
        database: "",
        user: "",
        password: "",
        sslmode: "disable",
        mode: "read",
        maxRows: 200,
        timeoutMs: 30000
      };
    }

    function draftOf(source) {
      return {
        id: source.id,
        name: source.name,
        dialect: source.dialect,
        host: source.host,
        port: source.port,
        database: source.database,
        user: source.user,
        password: "",
        sslmode: source.sslmode ?? "disable",
        mode: source.mode,
        maxRows: source.maxRows,
        timeoutMs: source.timeoutMs
      };
    }

    function field(label, control, hint, wide) {
      return React.createElement(
        "div",
        { className: wide === true ? "dsh-db-field is-wide" : "dsh-db-field", key: label },
        React.createElement("label", null, label),
        control,
        hint === undefined ? null : React.createElement("div", { className: "dsh-db-hint" }, hint)
      );
    }

    /** 编辑器：新增 / 编辑共用一份表单。 */
    function Editor({ draft, editing, onClose }) {
      const [form, setForm] = React.useState(draft);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [ok, setOk] = React.useState(null);

      const patch = (next) => setForm((current) => ({ ...current, ...next }));
      const isSqlite = form.dialect === "sqlite";

      React.useEffect(() => {
        if (typeof document === "undefined") return undefined;
        const onKey = (event) => {
          if (event.key === "Escape" && !busy) onClose();
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
      }, [busy, onClose]);

      const payload = () => ({
        source: {
          id: form.id === "" ? undefined : form.id,
          name: form.name,
          dialect: form.dialect,
          host: isSqlite ? "" : form.host,
          port: isSqlite ? 0 : Number(form.port),
          database: form.database,
          user: isSqlite ? "" : form.user,
          sslmode: form.sslmode ?? "disable",
          mode: form.mode,
          maxRows: Number(form.maxRows),
          timeoutMs: Number(form.timeoutMs)
        },
        password: form.password === "" ? undefined : form.password
      });

      const runTest = async () => {
        setBusy(true);
        setError(null);
        setOk(null);
        try {
          const request = payload();
          const body = {
            source: { ...request.source, name: request.source.name === "" ? "临时测试" : request.source.name },
            password: request.password
          };
          const value = await call("test", body);
          if (value.ok === true) setOk(`连接成功（${value.elapsedMs}ms）`);
          else setError(value.error || "连接失败");
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
          setBusy(false);
        }
      };

      const save = async () => {
        setBusy(true);
        setError(null);
        setOk(null);
        try {
          await call("save", payload());
          bumpRevision();
          notify(editing === true ? "已保存数据源" : "已添加数据源", true);
          onClose();
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
          setBusy(false);
        }
      };

      const input = (key, props) => React.createElement("input", {
        value: String(form[key] ?? ""),
        onChange: (event) => patch({ [key]: event.target.value }),
        ...props
      });

      return React.createElement(
        "div",
        {
          className: "dsh-db-overlay",
          onMouseDown: (event) => {
            if (event.target === event.currentTarget && !busy) onClose();
          }
        },
        React.createElement(
          "div",
          { className: "dsh-db-dialog", role: "dialog", "aria-modal": "true", "aria-label": editing ? "编辑数据源" : "添加数据源" },
          React.createElement("h2", null, editing ? "编辑数据源" : "添加数据源"),
          React.createElement(
            "div",
            { className: "dsh-db-grid" },
            field("名称", input("name", { placeholder: "例如：生产只读库", autoFocus: true })),
            field(
              "方言",
              React.createElement(
                "select",
                {
                  value: form.dialect,
                  onChange: (event) => {
                    const next = event.target.value;
                    const hit = DIALECTS.find((item) => item.value === next);
                    patch({ dialect: next, port: hit === undefined ? form.port : hit.port });
                  }
                },
                DIALECTS.map((item) => React.createElement("option", { value: item.value, key: item.value }, item.label))
              )
            ),
            isSqlite
              ? field("数据库文件路径", input("database", { placeholder: "/Users/me/data/app.db" }), "SQLite 用绝对路径；只读模式以只读方式打开。", true)
              : field("主机", input("host", { placeholder: "10.0.0.12" })),
            isSqlite ? null : field("端口", input("port", { type: "number", min: 1, max: 65535 })),
            isSqlite ? null : field("数据库名", input("database", { placeholder: "app" })),
            isSqlite ? null : field("用户名", input("user", { placeholder: "readonly" })),
            isSqlite
              ? null
              : field(
                  "密码",
                  input("password", { type: "password", placeholder: editing ? "留空表示不修改" : "写入 DSH 凭据库" }),
                  "密码存进 DSH 凭据库，不写进配置文件，也不会回传界面。",
                  true
                ),
            field(
              "模式",
              React.createElement(
                "select",
                { value: form.mode, onChange: (event) => patch({ mode: event.target.value }) },
                React.createElement("option", { value: "read" }, "只读（默认，推荐）"),
                React.createElement("option", { value: "write" }, "可写（每条写入都要审批）")
              )
            ),
            field("单次最多行数", input("maxRows", { type: "number", min: 1, max: 2000 })),
            field("查询超时（毫秒）", input("timeoutMs", { type: "number", min: 1000 })),
            isSqlite ? null : field(
              "SSL 模式",
              React.createElement(
                "select",
                { value: form.sslmode ?? "disable", onChange: (event) => patch({ sslmode: event.target.value }) },
                React.createElement("option", { value: "disable" }, "disable"),
                React.createElement("option", { value: "require" }, "require"),
                React.createElement("option", { value: "verify-full" }, "verify-full")
              )
            )
          ),
          error !== null ? React.createElement("div", { className: "dsh-db-error", role: "alert" }, error) : null,
          ok !== null ? React.createElement("div", { className: "dsh-db-ok" }, ok) : null,
          React.createElement(
            "div",
            { className: "dsh-db-actions" },
            React.createElement(
              "button",
              { type: "button", className: "dsh-db-btn", disabled: busy, onClick: runTest },
              busy ? "测试中…" : "测试连接"
            ),
            React.createElement("div", { className: "dsh-db-spacer" }),
            React.createElement("button", { type: "button", className: "dsh-db-btn", disabled: busy, onClick: onClose }, "取消"),
            React.createElement("button", { type: "button", className: "dsh-db-btn is-primary", disabled: busy, onClick: save }, "保存")
          )
        )
      );
    }

    /** 设置 → 数据库。 */
    function DbSection() {
      const revision = useStore(revisionStore);
      const [state, setState] = React.useState({ status: "loading", sources: [], path: "", error: null });
      const [draft, setDraft] = React.useState(null);
      const [busyId, setBusyId] = React.useState(null);
      const [confirmId, setConfirmId] = React.useState(null);
      const [probe, setProbe] = React.useState(null);

      const load = React.useCallback(async () => {
        setState((current) => ({ ...current, status: "loading", error: null }));
        try {
          const value = await call("list");
          setState({ status: "ready", sources: Array.isArray(value.sources) ? value.sources : [], path: value.path, error: null });
        } catch (failure) {
          setState({ status: "error", sources: [], path: "", error: failure instanceof Error ? failure.message : String(failure) });
        }
      }, []);

      React.useEffect(() => {
        load();
      }, [load, revision]);

      const test = async (source) => {
        setBusyId(source.id);
        setProbe(null);
        try {
          const value = await call("test", { source });
          setProbe({ id: source.id, ok: value.ok, text: value.ok ? `连接成功（${value.elapsedMs}ms）` : (value.error || "连接失败") });
        } catch (failure) {
          setProbe({ id: source.id, ok: false, text: failure instanceof Error ? failure.message : String(failure) });
        } finally {
          setBusyId(null);
        }
      };

      const remove = async (source) => {
        if (confirmId !== source.id) {
          setConfirmId(source.id);
          return;
        }
        setConfirmId(null);
        setBusyId(source.id);
        try {
          await call("delete", { id: source.id });
          bumpRevision();
          notify(`已删除「${source.name}」`, true);
        } catch (failure) {
          notify(failure instanceof Error ? failure.message : String(failure), false);
        } finally {
          setBusyId(null);
        }
      };

      const sources = state.sources;
      return React.createElement(
        "div",
        { className: "dsh-db-section" },
        React.createElement(
          "div",
          { className: "dsh-db-head" },
          React.createElement("h3", null, "数据库"),
          React.createElement(
            "button",
            {
              type: "button",
              className: "dsh-db-btn is-primary",
              onClick: () => setDraft({ mode: "new", value: emptyDraft() })
            },
            "添加数据源"
          )
        ),
        React.createElement(
          "div",
          { className: "dsh-db-meta" },
          "数据源在这里维护；模型通过 db_connections / db_query / db_schema / db_exec 使用它们。密码存在 DSH 凭据库。",
          state.path === "" ? "" : ` 配置文件：${state.path}`
        ),
        state.status === "loading"
          ? React.createElement("div", { className: "dsh-db-empty" }, "读取中…")
          : state.status === "error"
            ? React.createElement("div", { className: "dsh-db-error", role: "alert" }, state.error)
            : sources.length === 0
              ? React.createElement("div", { className: "dsh-db-empty" }, "还没有数据源。点右上角「添加数据源」加一个。")
              : React.createElement(
                  "div",
                  { className: "dsh-db-list" },
                  sources.map((source) => React.createElement(
                    "div",
                    { className: "dsh-db-row", key: source.id },
                    React.createElement(
                      "div",
                      { className: "dsh-db-row-main" },
                      React.createElement(
                        "div",
                        { className: "dsh-db-row-title" },
                        React.createElement("span", null, source.name),
                        React.createElement(
                          "span",
                          { className: source.mode === "write" ? "dsh-db-badge is-write" : "dsh-db-badge is-read" },
                          source.mode === "write" ? "可写" : "只读"
                        ),
                        source.hasPassword === false
                          ? React.createElement("span", { className: "dsh-db-badge is-warn" }, "无密码")
                          : null
                      ),
                      React.createElement(
                        "div",
                        { className: "dsh-db-row-sub" },
                        `${dialectLabel(source.dialect)} · ${where(source)}`
                      ),
                      probe !== null && probe.id === source.id
                        ? React.createElement(
                            "div",
                            { className: probe.ok ? "dsh-db-ok" : "dsh-db-error", role: "status" },
                            probe.text
                          )
                        : null
                    ),
                    React.createElement(
                      "div",
                      { className: "dsh-db-row-actions" },
                      React.createElement(
                        "button",
                        {
                          type: "button",
                          className: "dsh-db-btn is-link",
                          disabled: busyId !== null,
                          onClick: () => test(source)
                        },
                        busyId === source.id ? "测试中…" : "测试"
                      ),
                      React.createElement(
                        "button",
                        {
                          type: "button",
                          className: "dsh-db-btn is-link",
                          disabled: busyId !== null,
                          onClick: () => setDraft({ mode: "edit", value: draftOf(source) })
                        },
                        "编辑"
                      ),
                      React.createElement(
                        "button",
                        {
                          type: "button",
                          className: confirmId === source.id ? "dsh-db-btn is-danger" : "dsh-db-btn is-link",
                          disabled: busyId !== null,
                          onClick: () => remove(source),
                          onBlur: () => setConfirmId(null)
                        },
                        confirmId === source.id ? "确认删除？" : "删除"
                      )
                    )
                  ))
                ),
        draft === null
          ? null
          : React.createElement(Editor, {
              draft: draft.value,
              editing: draft.mode === "edit",
              onClose: () => setDraft(null)
            })
      );
    }

    function apply(ctx) {
      ctxRef = ctx;
      mountReady = ctx.remote.$mount(REMOTE);
      const slots = ctx.get("slots");
      if (slots === undefined) return;
      ctx.effect(() => ensureStyle());
      slots.inject("settings.section", () =>
        slots.register({ name: "settings.section", id: "db-sources", order: 42, label: () => "数据库" }, DbSection)
      );
    }

    exports.apply = apply;
    exports.inject = ["slots", "remote"];
    return module.exports;
  }
});
