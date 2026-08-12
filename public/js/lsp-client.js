/* ============================================================
   pancode · 前端轻量 LSP 客户端（浏览器侧）
   ------------------------------------------------------------
   设计：不依赖需要重写 Monaco 的 monaco-languageclient。
   只做「最小 LSP 客户端」：
   - 通过独立 WS(/lsp) 与后端桥接的真实语言服务器对话（JSON-RPC 透传）
   - 把 LSP 结果翻译喂给 Monaco 的 marker / completion / hover / definition API
   - Monaco 模型是 inmemory://，但 LSP 要真实 file:// URI，因此在边界翻译路径。
   注意：本脚本在 index.html 中先于 app.js、且先于 Monaco AMD 加载完成执行，
   所以**模块顶层绝不能访问 window.monaco**，必须延迟到构造/调用时读取。
   ============================================================ */
(function (global) {
  "use strict";
  const getM = () => global.monaco;

  const toLspPos = (p) => ({ line: p.lineNumber - 1, character: p.column - 1 });
  const fromLspRange = (r) => {
    const M = getM();
    return new M.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);
  };

  function md(contents) {
    if (!contents) return "";
    if (typeof contents === "string") return contents;
    if (Array.isArray(contents)) return contents.map((c) => (typeof c === "string" ? c : c.value || "")).join("\n\n");
    if (contents.kind === "markdown" || contents.kind === "plaintext") return contents.value || "";
    if (contents.value) return contents.value;
    return "";
  }

  class LspClient {
    constructor(opts) {
      const M = getM();
      this.M = M;
      this.language = opts.language;
      this.rootUri = opts.rootUri;
      this.getToken = opts.getToken;
      this.host = location.host;
      this.secure = location.protocol === "https:";
      this.models = new Map();
      this.pending = new Map();
      this.nextId = 1;
      this.ready = false;
      this.disposed = false;
      this._providers = [];
      this.ws = null;
      // LSP DiagnosticSeverity -> Monaco MarkerSeverity
      this.SEV = { 1: M.MarkerSeverity.Error, 2: M.MarkerSeverity.Warning, 3: M.MarkerSeverity.Info, 4: M.MarkerSeverity.Hint };
      // LSP CompletionItemKind -> Monaco
      this.KIND = {
        1: M.languages.CompletionItemKind.Text, 2: M.languages.CompletionItemKind.Method, 3: M.languages.CompletionItemKind.Function,
        4: M.languages.CompletionItemKind.Constructor, 5: M.languages.CompletionItemKind.Field, 6: M.languages.CompletionItemKind.Variable,
        7: M.languages.CompletionItemKind.Class, 8: M.languages.CompletionItemKind.Interface, 9: M.languages.CompletionItemKind.Module,
        10: M.languages.CompletionItemKind.Property, 11: M.languages.CompletionItemKind.Unit, 12: M.languages.CompletionItemKind.Value,
        13: M.languages.CompletionItemKind.Enum, 14: M.languages.CompletionItemKind.Keyword, 15: M.languages.CompletionItemKind.Snippet,
        16: M.languages.CompletionItemKind.Color, 17: M.languages.CompletionItemKind.File, 18: M.languages.CompletionItemKind.Reference,
        19: M.languages.CompletionItemKind.Folder, 20: M.languages.CompletionItemKind.EnumMember, 21: M.languages.CompletionItemKind.Constant,
        22: M.languages.CompletionItemKind.Struct, 23: M.languages.CompletionItemKind.Event, 24: M.languages.CompletionItemKind.Operator,
        25: M.languages.CompletionItemKind.TypeParameter,
      };
    }

    _url() {
      const q = new URLSearchParams({ lang: this.language, root: this.rootUri, token: this.getToken() });
      return (this.secure ? "wss://" : "ws://") + this.host + "/lsp?" + q.toString();
    }

    connect() {
      if (this.ws || this.disposed) return;
      let ws;
      try { ws = new WebSocket(this._url()); } catch (e) { return; }
      this.ws = ws;
      ws.onopen = () => this._initialize();
      ws.onmessage = (e) => this._onMessage(e);
      ws.onclose = () => { this.ready = false; };
      ws.onerror = () => {};
    }

    _send(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: "lsp.send", msg: obj })); }

    _initialize() {
      this.request("initialize", {
        processId: null,
        rootUri: this.rootUri,
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: true, didSave: true },
            completion: { contextSupport: true, completionItem: { snippetSupport: true, documentationFormat: ["markdown"] } },
            hover: { contentFormat: ["markdown"] },
            definition: {}, references: {}, documentSymbol: {}, formatting: {},
          },
          workspace: { workspaceFolders: true, didChangeConfiguration: { dynamicRegistration: true } },
        },
        initializationOptions: {},
      }).then(() => {
        this.ready = true;
        this._send({ jsonrpc: "2.0", method: "initialized", params: {} });
        this._registerProviders();
      }).catch((err) => { if (global.toast) global.toast("LSP(" + this.language + ") 初始化失败: " + err.message); this.dispose(); });
    }

    request(method, params) {
      return new Promise((resolve, reject) => {
        const id = this.nextId++;
        this.pending.set(id, {
          resolve, reject,
          timer: setTimeout(() => { this.pending.delete(id); reject(new Error("LSP 请求超时")); }, 8000),
        });
        this._send({ jsonrpc: "2.0", id, method, params });
      });
    }

    _onMessage(e) {
      let env; try { env = JSON.parse(e.data); } catch (err) { return; }
      if (env.type === "lsp.ready") return;
      if (env.type === "lsp.error") { if (global.toast) global.toast("LSP(" + (env.language || this.language) + "): " + env.message); this.dispose(); return; }
      if (env.type === "lsp.exit") { return; }
      if (env.type !== "lsp.msg" || !env.msg) return;
      const msg = env.msg;
      if (msg.id !== undefined && msg.id !== null && (msg.result !== undefined || msg.error !== undefined)) {
        const p = this.pending.get(msg.id);
        if (p) { clearTimeout(p.timer); this.pending.delete(msg.id); msg.error ? p.reject(new Error((msg.error.message) || "LSP error")) : p.resolve(msg.result); }
        return;
      }
      if (msg.method === "textDocument/publishDiagnostics") this._onDiagnostics(msg.params);
    }

    _onDiagnostics(params) {
      let model = null;
      for (const [, v] of this.models) if (v.uri === params.uri) { model = v.model; break; }
      if (!model) return;
      const markers = (params.diagnostics || []).map((d) => ({
        severity: this.SEV[d.severity] || this.M.MarkerSeverity.Info,
        message: d.message,
        startLineNumber: d.range.start.line + 1, startColumn: d.range.start.character + 1,
        endLineNumber: d.range.end.line + 1, endColumn: d.range.end.character + 1,
        source: d.source || "lsp",
      }));
      this.M.editor.setModelMarkers(model, "lsp-" + this.language, markers);
    }

    openModel(relPath, model) {
      const uri = this.rootUri + "/" + relPath.replace(/\\/g, "/");
      this.models.set(relPath, { model, uri, version: 1 });
      this._send({
        jsonrpc: "2.0", method: "textDocument/didOpen",
        params: { textDocument: { uri, languageId: this.language, version: 1, text: model.getValue() } },
      });
    }

    changeModel(relPath) {
      const v = this.models.get(relPath); if (!v) return;
      v.version++;
      this._send({
        jsonrpc: "2.0", method: "textDocument/didChange",
        params: { textDocument: { uri: v.uri, version: v.version }, contentChanges: [{ text: v.model.getValue() }] },
      });
    }

    closeModel(relPath) {
      const v = this.models.get(relPath); if (!v) return;
      this._send({ jsonrpc: "2.0", method: "textDocument/didClose", params: { textDocument: { uri: v.uri } } });
      this.models.delete(relPath);
    }

    _modelOf(model) { for (const [, v] of this.models) if (v.model === model) return v; return null; }

    _registerProviders() {
      const M = this.M, lang = this.language, self = this;
      this._providers.push(M.languages.registerCompletionItemProvider(lang, {
        provideCompletionItems(model, position) {
          const v = self._modelOf(model); if (!v) return { suggestions: [] };
          return self.request("textDocument/completion", { textDocument: { uri: v.uri }, position: toLspPos(position) })
            .then((res) => ({ suggestions: self._mapCompletions(res) })).catch(() => ({ suggestions: [] }));
        },
      }));
      this._providers.push(M.languages.registerHoverProvider(lang, {
        provideHover(model, position) {
          const v = self._modelOf(model); if (!v) return null;
          return self.request("textDocument/hover", { textDocument: { uri: v.uri }, position: toLspPos(position) })
            .then((res) => (res && res.contents ? { contents: [{ value: md(res.contents) }] } : null)).catch(() => null);
        },
      }));
      this._providers.push(M.languages.registerDefinitionProvider(lang, {
        provideDefinition(model, position) {
          const v = self._modelOf(model); if (!v) return null;
          return self.request("textDocument/definition", { textDocument: { uri: v.uri }, position: toLspPos(position) })
            .then((res) => self._mapLocations(res)).catch(() => null);
        },
      }));
    }

    _mapCompletions(res) {
      const M = this.M;
      const items = Array.isArray(res) ? res : (res && res.items) || [];
      return items.map((it) => {
        const item = {
          label: it.label,
          kind: this.KIND[it.kind] || M.languages.CompletionItemKind.Text,
          detail: it.detail,
          documentation: it.documentation ? (it.documentation.value || it.documentation) : undefined,
          insertText: it.insertText || it.label,
          sortText: it.sortText, filterText: it.filterText,
        };
        if (it.textEdit) { item.range = fromLspRange(it.textEdit.range); item.insertText = it.textEdit.newText; }
        return item;
      });
    }

    _mapLocations(res) {
      const M = this.M;
      const locs = Array.isArray(res) ? res : (res ? [res] : []);
      return locs
        .filter((l) => l && l.uri && l.range)
        .map((l) => ({ uri: M.Uri.parse(l.uri), range: fromLspRange(l.range) }));
    }

    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      try { this.request("shutdown", null).catch(() => {}); } catch (e) {}
      try { this._send({ jsonrpc: "2.0", method: "exit", params: null }); } catch (e) {}
      this._providers.forEach((d) => { try { d.dispose(); } catch (e) {} });
      this._providers = [];
      if (this.ws) try { this.ws.close(); } catch (e) {}
      this.ws = null;
    }
  }

  global.LspClient = LspClient;
})(window);
