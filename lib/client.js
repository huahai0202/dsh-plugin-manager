// dsh-plugin-manager — client half.
// Registers a "Plugin Manager" section in the Web Settings page that lists the
// user-installed plugins of the active profile and offers update / update-all /
// remove actions backed by the host's /plugin-manager/api routes.

window.__ModuleLoader__.load({
  id: "dsh-plugin-manager",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");

    var inject = ["slots", "locale"];

    var LOCALE_NS = "settings.pluginManager";
    var localeService = undefined;

    var zh = {
      nav: "插件管理",
      loading: "正在读取插件…",
      error: "读取失败",
      retry: "重试",
      refresh: "检查更新",
      checking: "正在检查更新…",
      updateAll: "全部更新",
      installed: "已安装",
      latest: "最新",
      update: "更新",
      remove: "删除",
      confirmTitle: "删除插件",
      confirm: "确定",
      cancel: "取消",
      confirmRemove: "确定要删除该插件吗？删除后需重启 dsh 才会生效。",
      hasUpdate: "有更新",
      upToDate: "已是最新",
      notChecked: "未检查",
      fixedRef: "已固定引用",
      checkUnavailable: "无法检查",
      unsupportedGit: "不支持检测",
      currentCommit: "当前提交",
      remoteCommit: "远端提交",
      profile: "Profile",
      restartNote: "更新 / 删除操作在重启 dsh 后生效。",
      empty: "当前 profile 未安装额外插件。",
      updated: "已更新",
      noChanges: "已经是最新，无需更新",
      removed: "已删除",
      unknown: "—",
    };

    var en = {
      nav: "Plugin Manager",
      loading: "Reading plugins…",
      error: "Failed to read plugins",
      retry: "Retry",
      refresh: "Check updates",
      checking: "Checking for updates…",
      updateAll: "Update all",
      installed: "Installed",
      latest: "Latest",
      update: "Update",
      remove: "Remove",
      confirmTitle: "Remove plugin",
      confirm: "Confirm",
      cancel: "Cancel",
      confirmRemove: "Remove this plugin? It takes effect after restarting dsh.",
      hasUpdate: "Update available",
      upToDate: "Up to date",
      notChecked: "Not checked",
      fixedRef: "Fixed reference",
      checkUnavailable: "Check unavailable",
      unsupportedGit: "Unsupported source",
      currentCommit: "Current commit",
      remoteCommit: "Remote commit",
      profile: "Profile",
      restartNote: "Updates / removals take effect after restarting dsh.",
      empty: "No extra plugins are installed in this profile.",
      updated: "Updated",
      noChanges: "Already up to date",
      removed: "Removed",
      unknown: "—",
    };

    function activeLocale() {
      return localeService.getSnapshot().active;
    }

    function dict() {
      return activeLocale().toLowerCase().startsWith("zh") ? zh : en;
    }

    function useLocaleRevision() {
      var revisionState = React.useState(function () {
        return localeService.getSnapshot().revision;
      });
      React.useEffect(function () {
        return localeService.subscribe(function () {
          revisionState[1](function (value) { return value + 1; });
        });
      }, []);
      return revisionState[0];
    }

    var styles = {
      section: { width: "100%", maxWidth: "none", color: "var(--dsw-alias-label-primary)", display: "flex", flexDirection: "column", gap: 12, boxSizing: "border-box" },
      header: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, paddingBottom: 2 },
      title: { margin: 0, fontSize: 15, fontWeight: 600, lineHeight: "20px", letterSpacing: "-0.1px" },
      actions: { display: "flex", gap: 6, flexShrink: 0 },
      profileLine: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, lineHeight: "18px", margin: 0 },
      note: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, lineHeight: "18px", margin: 0 },
      message: { color: "var(--dsw-alias-state-business-primary)", fontSize: 13, lineHeight: "20px", margin: 0 },
      list: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 },
      card: { border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-3)", borderRadius: 8, padding: "10px 12px", display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto auto", alignItems: "center", gap: 14, minWidth: 0 },
      cardMain: { display: "flex", flexDirection: "column", gap: 3, minWidth: 0 },
      cardTitle: { fontSize: 13, fontWeight: 600, lineHeight: "18px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      cardDesc: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, lineHeight: "18px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      versions: { display: "flex", flexWrap: "nowrap", gap: 7, alignItems: "center", minWidth: 0, overflow: "hidden", whiteSpace: "nowrap" },
      version: { color: "var(--dsw-alias-label-tertiary)", fontSize: 11, lineHeight: "16px", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" },
      versionNew: { color: "var(--dsw-alias-state-business-primary)", fontSize: 11, lineHeight: "16px", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" },
      badge: { color: "var(--dsw-alias-state-business-primary)", border: "1px solid var(--dsw-alias-state-business-primary)", borderRadius: 5, fontSize: 10, lineHeight: "15px", padding: "0 5px", whiteSpace: "nowrap" },
      tag: { color: "var(--dsw-alias-label-tertiary)", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 5, fontSize: 10, lineHeight: "15px", padding: "0 5px", whiteSpace: "nowrap" },
      cardActions: { display: "flex", gap: 6, flexShrink: 0 },
      button: { border: "1px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-primary)", background: "transparent", font: "inherit", cursor: "pointer", borderRadius: 5, padding: "3px 9px", fontSize: 12, lineHeight: "18px", whiteSpace: "nowrap" },
      buttonPrimary: { border: "1px solid var(--dsw-alias-state-business-primary)", color: "var(--dsw-alias-state-business-primary)", background: "transparent", font: "inherit", cursor: "pointer", borderRadius: 5, padding: "3px 9px", fontSize: 12, lineHeight: "18px", whiteSpace: "nowrap" },
      buttonDanger: { border: "1px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))", background: "transparent", font: "inherit", cursor: "pointer", borderRadius: 5, padding: "3px 9px", fontSize: 12, lineHeight: "18px", whiteSpace: "nowrap" },
      overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 },
      dialog: { background: "var(--dsw-alias-bg-layer-3)", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 12, padding: 20, minWidth: 360, maxWidth: 480, display: "flex", flexDirection: "column", gap: 14, boxShadow: "var(--dsw-shadow-lv1)", color: "var(--dsw-alias-label-primary)" },
      dialogTitle: { margin: 0, fontSize: 14, fontWeight: 600, lineHeight: "20px" },
      dialogBody: { margin: 0, fontSize: 13, lineHeight: "20px" },
      dialogFooter: { display: "flex", justifyContent: "flex-end", gap: 8 },
      links: { display: "flex", flexWrap: "nowrap", gap: 6, alignItems: "center", whiteSpace: "nowrap" },
      link: { color: "var(--dsw-alias-state-business-primary)", textDecoration: "none", fontSize: 12, lineHeight: "18px", cursor: "pointer" },
      linkSep: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, lineHeight: "18px" },
    };

    function disabledStyle(base, off) {
      return off ? Object.assign({}, base, { opacity: 0.45, cursor: "default" }) : base;
    }

    function apiCall(method, payload) {
      return fetch("/plugin-manager/api/" + method, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload || {}),
      }).then(function (res) {
        return res.text().then(function (text) {
          var data = null;
          if (text && text.trim() !== "") {
            try { data = JSON.parse(text); } catch (_e) { /* fall through */ }
          }
          if (data && data.ok) return data;
          var message = (data && data.error && data.error.message) ? data.error.message : ("HTTP " + res.status + (text && text.trim() !== "" ? "" : " (empty response)"));
          throw new Error(message);
        });
      });
    }

    function hasUpdate(plugin) {
      var registryUpdate = plugin.registry && plugin.latest && plugin.installed && plugin.latest !== plugin.installed;
      var gitUpdate = plugin.gitInfo && plugin.gitInfo.state === "available";
      return Boolean(registryUpdate || gitUpdate);
    }

    function shortCommit(value) {
      return typeof value === "string" && value !== "" ? value.slice(0, 7) : "—";
    }

    function GitStatus(props) {
      var info = props.info;
      var t = props.t;
      if (!info) return null;
      var stateLabel = info.state === "available" ? t.hasUpdate
        : info.state === "current" ? t.upToDate
          : info.state === "fixed" ? t.fixedRef
            : info.state === "unavailable" ? t.checkUnavailable
              : info.state === "unsupported" ? t.unsupportedGit : t.notChecked;
      var stateStyle = info.state === "available" ? styles.badge : styles.tag;
      return React.createElement(React.Fragment, null,
        info.installedCommit ? React.createElement("span", { style: info.state === "available" ? styles.versionNew : styles.version }, t.currentCommit + ": " + shortCommit(info.installedCommit)) : null,
        info.remoteCommit ? React.createElement("span", { style: info.state === "available" ? styles.versionNew : styles.version }, t.remoteCommit + ": " + shortCommit(info.remoteCommit)) : null,
        React.createElement("span", { style: stateStyle }, stateLabel)
      );
    }

    function ConfirmDialog(props) {
      return React.createElement("div", { style: styles.overlay, onClick: props.onCancel },
        React.createElement("div", {
          style: styles.dialog,
          role: "dialog",
          "aria-modal": true,
          onClick: function (event) { event.stopPropagation(); },
        },
          React.createElement("h3", { style: styles.dialogTitle }, props.title),
          React.createElement("p", { style: styles.dialogBody },
            React.createElement("strong", { style: { display: "block", wordBreak: "break-all", marginBottom: 4 } }, props.name),
            props.detail
          ),
          React.createElement("div", { style: styles.dialogFooter },
            React.createElement("button", { type: "button", style: styles.buttonDanger, onClick: props.onConfirm }, props.confirmLabel),
            React.createElement("button", { type: "button", style: styles.button, onClick: props.onCancel }, props.cancelLabel)
          )
        )
      );
    }

    function PluginManagerSettings() {
      useLocaleRevision();
      var t = dict();
      var stateRef = React.useState({ status: "loading" });
      var state = stateRef[0];
      var setState = stateRef[1];
      var busyRef = React.useState(false);
      var busy = busyRef[0];
      var setBusy = busyRef[1];
      var messageRef = React.useState(null);
      var message = messageRef[0];
      var setMessage = messageRef[1];
      var requestRef = React.useState({ id: 0, refresh: false });
      var request = requestRef[0];
      var setRequest = requestRef[1];
      var confirmRef = React.useState(null);
      var confirmPlugin = confirmRef[0];
      var setConfirmPlugin = confirmRef[1];

      React.useEffect(function () {
        var current = true;
        setState({ status: "loading" });
        apiCall("list", { refresh: request.refresh }).then(function (result) {
          if (!current) return;
          if (result && result.ok) setState({ status: "ready", snapshot: result.value });
          else setState({ status: "error", error: result && result.error ? result.error.message : t.error });
        }, function (error) {
          if (current) setState({ status: "error", error: String((error && error.message) || error) });
        });
        return function () { current = false; };
      }, [request]);

      function reload(refresh) {
        setRequest(function (value) { return { id: value.id + 1, refresh: refresh === true }; });
      }

      function checkUpdates() {
        setMessage(null);
        reload(true);
      }

      function run(method, payload, successText) {
        setBusy(true);
        setMessage(null);
        return apiCall(method, payload).then(function (result) {
          setBusy(false);
          if (result && result.ok) {
            setMessage(result.value && result.value.changed === false ? t.noChanges : successText);
            reload(false);
          } else {
            setMessage(result && result.error ? result.error.message : t.error);
          }
        }, function (error) {
          setBusy(false);
          setMessage(String((error && error.message) || error));
        });
      }

      function onUpdate(plugin) {
        run("update", { name: plugin.name }, t.updated);
      }

      function onUpdateAll() {
        run("updateAll", {}, t.updated);
      }

      function onRemove(plugin) {
        setConfirmPlugin(plugin);
      }

      function doRemove() {
        var plugin = confirmPlugin;
        setConfirmPlugin(null);
        if (plugin) run("remove", { name: plugin.name }, t.removed);
      }

      function cancelRemove() {
        setConfirmPlugin(null);
      }

      var snapshot = state.status === "ready" ? state.snapshot : null;
      var plugins = snapshot ? snapshot.plugins : [];
      var anyUpdate = plugins.some(hasUpdate);

      return React.createElement("div", { style: styles.section },
        React.createElement("div", { style: styles.header },
          React.createElement("h3", { style: styles.title }, t.nav),
          React.createElement("div", { style: styles.actions },
            React.createElement("button", { type: "button", style: disabledStyle(styles.button, busy || state.status !== "ready"), disabled: busy || state.status !== "ready", onClick: checkUpdates }, t.refresh),
            React.createElement("button", { type: "button", style: disabledStyle(styles.buttonPrimary, busy || state.status !== "ready" || !anyUpdate), disabled: busy || state.status !== "ready" || !anyUpdate, onClick: onUpdateAll }, t.updateAll)
          )
        ),
        snapshot ? React.createElement("p", { style: styles.profileLine }, t.profile + ": " + snapshot.profile) : null,
        React.createElement("p", { style: styles.note }, t.restartNote),
        message ? React.createElement("p", { style: styles.message, role: "status" }, message) : null,
        state.status === "loading" ? React.createElement("p", { style: styles.note, "aria-busy": true }, request.refresh ? t.checking : t.loading) : null,
        state.status === "error" ? React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
          React.createElement("p", { style: styles.note, role: "alert" }, t.error + ": " + state.error),
          React.createElement("div", null, React.createElement("button", { type: "button", style: styles.button, onClick: function () { reload(request.refresh); } }, t.retry))
        ) : null,
        state.status === "ready" && plugins.length === 0 ? React.createElement("p", { style: styles.note }, t.empty) : null,
        plugins.length > 0 ? React.createElement("ul", { style: styles.list }, plugins.map(function (plugin) {
          var pluginUpdate = hasUpdate(plugin);
          var canUpdate = pluginUpdate;
          return React.createElement("li", { key: plugin.name, style: styles.card },
            React.createElement("div", { style: styles.cardMain },
              React.createElement("strong", { style: styles.cardTitle }, plugin.name),
              plugin.description ? React.createElement("span", { style: styles.cardDesc }, plugin.description) : null,
              React.createElement("span", { style: styles.versions },
                React.createElement("span", { style: styles.version }, t.installed + ": " + (plugin.installed || t.unknown)),
                plugin.registry && plugin.latest && pluginUpdate ? React.createElement("span", { style: styles.versionNew }, t.latest + ": " + plugin.latest) : null,
                plugin.registry && pluginUpdate ? React.createElement("span", { style: styles.badge }, t.hasUpdate) : null,
                plugin.registry && plugin.latest && !pluginUpdate ? React.createElement("span", { style: styles.tag }, t.upToDate) : null,
                plugin.git ? React.createElement(GitStatus, { info: plugin.gitInfo, t: t }) : null
              )
            ),
            React.createElement("span", { style: styles.links },
              plugin.github ? React.createElement("a", { href: plugin.github, target: "_blank", rel: "noopener noreferrer", style: styles.link }, "GitHub") : null,
              plugin.github && plugin.npm ? React.createElement("span", { style: styles.linkSep }, "·") : null,
              plugin.npm ? React.createElement("a", { href: plugin.npm, target: "_blank", rel: "noopener noreferrer", style: styles.link }, "npm") : null
            ),
            React.createElement("div", { style: styles.cardActions },
              React.createElement("button", { type: "button", style: disabledStyle(styles.button, busy || !canUpdate), disabled: busy || !canUpdate, onClick: function () { onUpdate(plugin); } }, t.update),
              React.createElement("button", { type: "button", style: disabledStyle(styles.buttonDanger, busy), disabled: busy, onClick: function () { onRemove(plugin); } }, t.remove)
            )
          );
        })) : null,
        confirmPlugin ? React.createElement(ConfirmDialog, {
          title: t.confirmTitle,
          name: confirmPlugin.name,
          detail: t.confirmRemove,
          confirmLabel: t.confirm,
          cancelLabel: t.cancel,
          onConfirm: doRemove,
          onCancel: cancelRemove,
        }) : null
      );
    }

    function apply(ctx) {
      var locale = ctx.get("locale");
      localeService = locale;
      ctx.effect(function () {
        var offZh = locale.register(LOCALE_NS, "zh", zh);
        var offEn = locale.register(LOCALE_NS, "en", en);
        return function () { offZh(); offEn(); };
      }, "dsh-plugin-manager: locale dictionaries");
      ctx.effect(function () {
        return function () { if (localeService === locale) localeService = undefined; };
      }, "dsh-plugin-manager: locale detach");
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register(
          { name: "settings.section", id: "plugin-manager", order: 16, label: function () { return dict().nav; }, locale: LOCALE_NS },
          function () { return React.createElement(PluginManagerSettings); }
        );
      });
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
