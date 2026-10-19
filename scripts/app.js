import { MODULE_ID, PAGE_SIZE } from "./config.js";
import * as Auth from "./auth.js";
import { getUser, DriveTree } from "./drive.js";
import { Store } from "./store.js";
import { runIndex } from "./indexer.js";
import { ModuleLoader } from "./moduleLoader.js";
import { planImport, runImport } from "./importer.js";
import { runAudit, lastAudit } from "./audit.js";
import { LARGE_FILE_BYTES } from "./config.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const norm = s => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const fmtDate = ts => ts ? new Date(ts).toLocaleString("pt-BR") : "nunca";
const quiet = e => e?.name === "AbortError" || e?.name === "SkippedError";
const fmtSize = n => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)} MB`;

export class DriveMapsApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "drive-maps",
    classes: ["drive-maps"],
    window: { title: "Drive Maps", resizable: true },
    position: { width: 880, height: 660 },
    actions: {
      connect: DriveMapsApp.connectAction,
      index: DriveMapsApp.indexAction,
      cancel: DriveMapsApp.cancelAction,
      clear: DriveMapsApp.clearAction,
      rethumb: DriveMapsApp.rethumbAction,
      prev: DriveMapsApp.prevAction,
      next: DriveMapsApp.nextAction,
      open: DriveMapsApp.openAction,
      back: DriveMapsApp.backAction,
      import: DriveMapsApp.importAction,
      selall: DriveMapsApp.selallAction,
      selnone: DriveMapsApp.selnoneAction,
      selcancel: DriveMapsApp.selcancelAction,
      selok: DriveMapsApp.selokAction
    }
  };

  static PARTS = { main: { template: `modules/${MODULE_ID}/templates/app.hbs` } };

  store = null;
  tree = null;
  loader = null;
  account = null;
  records = [];
  byKey = new Map();
  filtered = [];
  page = 0;
  query = "";
  lastIndexed = null;
  indexing = false;
  abort = null;
  life = null;              // cancela o carregamento de miniaturas quando a janela fecha
  statusText = "";
  statusBad = false;
  statusKeep = false;
  progress = null;          // { done, total }
  booted = false;
  view = "list";            // "list" | "module"
  current = null;
  gen = 0;                  // muda a cada redesenho; trabalhos antigos são ignorados
  pending = 0;
  urls = [];
  observer = null;
  auditAbort = null;
  imp = null;               // caixa de acompanhamento da importação
  sel = { on: false, checked: new Set() };   // seleção de cenas nos cartões
  moduleScenes = null;

  /* ---------- auditoria (uso pelo console ou macro) ---------- */
  async ensureReady() {
    if (this.store) return;
    const last = game.settings.get(MODULE_ID, "lastAccount");
    if (last) await this.useAccount(last);
  }

  async audit(opts = {}) {
    await this.ensureReady();
    if (!this.store) throw new Error("Não há índice guardado. Abra o Drive Maps, conecte e clique em Indexar o Drive.");
    if (!Auth.isConnected()) throw new Error("Conecte ao Google primeiro: abra o Drive Maps e clique em Conectar.");
    if (this.auditAbort) throw new Error("Já há uma auditoria em andamento. Use api.auditCancel() para cancelar.");
    this.auditAbort = new AbortController();
    try { return await runAudit({ store: this.store, opts, signal: this.auditAbort.signal }); }
    finally { this.auditAbort = null; this.refreshUI(); }      // mostra o botão Conectar de novo se o login venceu
  }

  auditCancel() { this.auditAbort?.abort(); }

  async auditLast(modo = "rapida") {
    await this.ensureReady();
    return this.store ? lastAudit(this.store, modo) : null;
  }

  /* ---------- ciclo de vida da janela ---------- */
  async _onRender(context, options) {
    await super._onRender?.(context, options);
    this.life ??= new AbortController();
    const input = this.element.querySelector("input[name=q]");
    input.value = this.query;
    let timer;
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => { this.query = input.value; this.page = 0; this.applyFilter(); }, 150);
    });

    const grid = this.element.querySelector(".dms-grid");
    if (!grid.dataset.bound) {
      grid.dataset.bound = "1";
      grid.addEventListener("click", ev => {
        if (!this.sel.on) return;
        const card = ev.target.closest(".dms-card[data-scene]");
        if (card) this.toggleScene(card);
      });
    }

    if (!this.booted) {
      this.booted = true;
      const last = game.settings.get(MODULE_ID, "lastAccount");
      if (last) {
        try { await this.useAccount(last); }
        catch (e) { console.error(e); this.setStatus(`Não consegui abrir o índice guardado: ${e.message}`, true); }
      }
    }
    this.refreshUI();
  }

  async _onClose(options) {
    this.abort?.abort();
    this.life?.abort();
    this.life = null;
    this.imp?.abort?.abort();
    this.observer?.disconnect();
    this.revokeUrls();
    return super._onClose?.(options);
  }

  /* ---------- dados ---------- */
  async useAccount(email) {
    if (this.store && this.account === email) return;
    this.store?.close();
    this.account = email;
    this.store = await Store.open(email);
    this.tree = new DriveTree();
    this.loader = new ModuleLoader(this.store, this.tree);
    await game.settings.set(MODULE_ID, "lastAccount", email);
    await this.reload();
  }

  async reload() {
    const all = await this.store.all();
    this.records = all
      .filter(r => r.hasScenes)
      .map(r => ({ ...r, _s: norm(`${r.title} ${r.id} ${r.description ?? ""}`) }))
      .sort((a, b) => a.title.localeCompare(b.title, "pt-BR", { numeric: true, sensitivity: "base" }));
    this.byKey = new Map(this.records.map(r => [r.key, r]));
    this.lastIndexed = await this.store.getMeta("lastIndexed");
    this.applyFilter();
  }

  applyFilter() {
    const terms = norm(this.query).split(/\s+/).filter(Boolean);
    this.filtered = terms.length ? this.records.filter(r => terms.every(t => r._s.includes(t))) : this.records;
    const pages = Math.max(1, Math.ceil(this.filtered.length / PAGE_SIZE));
    this.page = Math.min(this.page, pages - 1);
    this.refreshUI();
  }

  /* ---------- desenho ---------- */
  setStatus(text, bad = false) {
    this.statusText = text;
    this.statusBad = bad;
    const el = this.element?.querySelector(".dms-status");
    if (el) { el.textContent = text; el.classList.toggle("dms-bad", bad); }
  }

  setProgress(done, total) {
    this.progress = total ? { done, total } : null;
    const bar = this.element?.querySelector(".dms-progress");
    if (!bar) return;
    bar.hidden = !this.progress;
    if (this.progress) { bar.max = total; bar.value = done; }
  }

  updatePending() {
    const el = this.element?.querySelector(".dms-load");
    if (!el) return;
    el.hidden = this.pending <= 0;
    el.textContent = this.pending > 0 ? `Carregando miniaturas: ${this.pending}` : "";
  }

  defaultStatus() {
    const n = this.records.length;
    const stale = this.lastIndexed && Date.now() - this.lastIndexed > 30 * 86400000
      ? " Pode estar desatualizado." : "";
    if (Auth.isConnected()) {
      if (!this.lastIndexed) return `Conectado como ${this.account}. Clique em "Indexar o Drive" (a primeira vez demora alguns minutos).`;
      return `Conectado como ${this.account}. ${n} módulos com cenas (índice de ${fmtDate(this.lastIndexed)}).${stale}`;
    }
    if (this.account && this.lastIndexed) {
      return `Mostrando o índice guardado de ${this.account} (${fmtDate(this.lastIndexed)}). Conecte para atualizar.${stale}`;
    }
    return "Clique em Conectar para entrar no Google.";
  }

  refreshUI() {
    const root = this.element;
    if (!root) return;
    const connected = Auth.isConnected();
    const inModule = this.view === "module";

    root.querySelector(".dms-connect").hidden = connected;
    const btnIndex = root.querySelector(".dms-index");
    btnIndex.hidden = this.indexing;
    btnIndex.disabled = !connected || inModule;
    btnIndex.querySelector("span").textContent = this.lastIndexed ? "Atualizar o índice" : "Indexar o Drive";
    root.querySelector(".dms-cancel").hidden = !this.indexing;
    root.querySelector(".dms-clear").disabled = this.indexing || !this.store;
    root.querySelector(".dms-rethumb").disabled = this.indexing || !this.store;
    root.querySelector("input[name=q]").disabled = inModule;
    root.querySelector(".dms-modhead").hidden = !inModule;
    if (!inModule) { this.sel = { on: false, checked: new Set() }; if (this.imp) this.closeImport(); }

    if (!this.indexing) {
      this.setStatus(this.statusKeep ? this.statusText : this.defaultStatus(), this.statusKeep ? this.statusBad : false);
    }
    this.setProgress(this.progress?.done ?? 0, this.progress?.total ?? 0);

    if (inModule) this.renderModule(); else this.renderList();
  }

  revokeUrls() {
    for (const u of this.urls) URL.revokeObjectURL(u);
    this.urls = [];
  }

  /** Observa os cartões e só carrega a miniatura dos que aparecem na tela. */
  watchCards(handler) {
    const grid = this.element.querySelector(".dms-grid");
    this.observer?.disconnect();
    this.observer = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        this.observer.unobserve(e.target);
        handler(e.target);
      }
    }, { root: grid, rootMargin: "240px" });
    grid.querySelectorAll(".dms-card").forEach(c => this.observer.observe(c));
  }

  renderList() {
    const root = this.element;
    const grid = root.querySelector(".dms-grid");
    this.gen++;
    this.pending = 0;
    this.updatePending();
    this.revokeUrls();
    const pages = Math.max(1, Math.ceil(this.filtered.length / PAGE_SIZE));
    const slice = this.filtered.slice(this.page * PAGE_SIZE, (this.page + 1) * PAGE_SIZE);

    if (!this.records.length) {
      grid.innerHTML = `<p class="dms-empty">${this.lastIndexed
        ? "Nenhum módulo com cenas foi encontrado no seu Drive."
        : "O índice está vazio."}</p>`;
    } else if (!slice.length) {
      grid.innerHTML = `<p class="dms-empty">Nenhum módulo combina com a busca.</p>`;
    } else {
      grid.innerHTML = slice.map(r => {
        const kinds = [...new Set(r.packs.map(p => p.type.toLowerCase()))]
          .map(t => t === "adventure" ? "Aventura" : t === "scene" ? "Cenas" : "").filter(Boolean).join(", ");
        const tip = [r.title, `${r.id}${r.version ? ` · v${r.version}` : ""}`, kinds,
          r.requires?.length ? `requer: ${r.requires.join(", ")}` : ""].filter(Boolean).join("\n");
        return `
        <figure class="dms-card" data-action="open" data-key="${esc(r.key)}" title="${esc(tip)}">
          <div class="dms-ph"><i class="fa-solid fa-map"></i></div>
          <figcaption>${esc(r.title)}</figcaption>
        </figure>`;
      }).join("");
    }
    grid.scrollTop = 0;
    this.watchCards(card => this.loadCard(card));

    const pager = root.querySelector(".dms-pager");
    pager.hidden = this.filtered.length <= PAGE_SIZE;
    pager.querySelector(".dms-page").textContent =
      `Página ${this.page + 1} de ${pages} · ${this.filtered.length} módulo(s)`;
    pager.querySelector("[data-action=prev]").disabled = this.page === 0;
    pager.querySelector("[data-action=next]").disabled = this.page >= pages - 1;
  }

  /* ---------- miniaturas ---------- */
  loadCard(card) {
    const rec = this.byKey.get(card.dataset.key);
    if (!rec || !this.loader) return;
    const gen = this.gen;
    const wanted = () => gen === this.gen && card.isConnected;
    card.classList.add("dms-loading");
    this.pending++;
    this.updatePending();
    this.loader.cardThumb(rec, { wanted, signal: this.life?.signal })
      .then(res => { if (wanted()) this.applyThumb(card, res); })
      .catch(e => {
        if (quiet(e)) return;
        if (e instanceof Auth.AuthError) return;              // sem login: fica esperando
        console.warn("Drive Maps |", rec.id, e);
        if (wanted()) this.applyThumb(card, { error: e.message });
      })
      .finally(() => {
        card.classList.remove("dms-loading");
        if (gen === this.gen) { this.pending = Math.max(0, this.pending - 1); this.updatePending(); }
      });
  }

  applyThumb(card, res) {
    const ph = card.querySelector(".dms-ph");
    if (res.blob || res.remoteUrl) {
      const img = new Image();
      img.alt = "";
      img.decoding = "async";
      let url = res.remoteUrl;
      if (res.blob) { url = URL.createObjectURL(res.blob); this.urls.push(url); }
      else img.referrerPolicy = "no-referrer";
      img.onload = () => { ph.replaceChildren(img); card.classList.add("dms-has-img"); };
      img.onerror = () => this.markFail(card, "a imagem não carregou");
      img.src = url;
    } else {
      this.markFail(card, res.error ?? "sem miniatura");
    }
  }

  markFail(card, reason) {
    card.classList.add("dms-fail");
    card.querySelector(".dms-ph").innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i>`;
    card.title = `${card.title}\n⚠ ${reason}`;
  }

  /* ---------- módulo aberto ---------- */
  async openModule(key) {
    const rec = this.byKey.get(key);
    if (!rec) return;
    this.view = "module";
    this.current = rec;
    this.statusKeep = false;
    this.refreshUI();
  }

  async renderModule() {
    const root = this.element;
    const rec = this.current;
    const grid = root.querySelector(".dms-grid");
    root.querySelector(".dms-pager").hidden = true;
    root.querySelector(".dms-modtitle").textContent = rec.title;
    this.moduleScenes = null;
    this.sel = { on: false, checked: new Set() };
    this.updateSelUI();
    const info = root.querySelector(".dms-modinfo");
    info.textContent = "Lendo os packs do módulo no Drive...";
    grid.innerHTML = "";
    this.gen++;
    this.pending = 0;
    this.updatePending();
    this.revokeUrls();
    const gen = this.gen;
    const wanted = () => gen === this.gen && this.view === "module";

    let sc;
    try {
      sc = await this.loader.loadScenes(rec, { wanted, signal: this.life?.signal });
    } catch (e) {
      if (quiet(e) || !wanted()) return;
      info.textContent = e instanceof Auth.AuthError
        ? "Conecte ao Google para ler este módulo."
        : `Erro: ${Auth.friendlyError(e)}`;
      return;
    }
    if (!wanted()) return;

    const warn = [];
    if (rec.requires?.length) warn.push(`Usa outros módulos (${rec.requires.join(", ")}): algumas automações podem não funcionar sem eles.`);
    if (sc.notes?.length) warn.push(...sc.notes.map(n => `⚠ ${n}`));
    info.textContent = sc.error
      ? `Não consegui ler as cenas: ${sc.error}`
      : [`${sc.scenes.length} cena(s)`, ...warn].join(" · ");

    grid.innerHTML = sc.scenes.map(s => `
      <figure class="dms-card" data-scene="${esc(s.id)}" title="${esc(s.name)}">
        <span class="dms-chk"></span>
        <div class="dms-ph"><i class="fa-solid fa-map"></i></div>
        <figcaption>${esc(s.name)}</figcaption>
      </figure>`).join("");
    this.moduleScenes = sc.error ? null : sc.scenes;
    this.updateSelUI();
    const byId = new Map(sc.scenes.map(s => [s.id, s]));
    this.watchCards(card => {
      const scene = byId.get(card.dataset.scene);
      if (!scene) return;
      card.classList.add("dms-loading");
      this.loader.sceneThumb(rec, scene, { wanted, signal: this.life?.signal })
        .then(res => { if (wanted()) this.applyThumb(card, res); })
        .catch(e => {
          if (quiet(e) || e instanceof Auth.AuthError) return;
          console.warn("Drive Maps |", scene.name, e);
          if (wanted()) this.applyThumb(card, { error: e.message });
        })
        .finally(() => card.classList.remove("dms-loading"));
    });
  }


  /* ---------- importar cenas: seleção direto nos cartões ---------- */
  startSelecting() {
    if (!this.current || !this.moduleScenes?.length) return;
    this.sel = { on: true, checked: new Set() };
    this.updateSelUI();
  }

  stopSelecting() {
    this.sel = { on: false, checked: new Set() };
    this.updateSelUI();
  }

  toggleScene(card) {
    const id = card.dataset.scene;
    this.sel.checked.has(id) ? this.sel.checked.delete(id) : this.sel.checked.add(id);
    this.updateSelUI();
  }

  updateSelUI() {
    const root = this.element;
    if (!root) return;
    const on = this.sel.on && this.view === "module";
    root.querySelector(".dms-grid").classList.toggle("dms-selecting", on);
    root.querySelector(".dms-selbar").hidden = !on;
    root.querySelector(".dms-import").hidden = on || !this.moduleScenes?.length;
    root.querySelectorAll(".dms-card[data-scene]").forEach(c =>
      c.classList.toggle("dms-checked", on && this.sel.checked.has(c.dataset.scene)));
    root.querySelector(".dms-selcount").textContent = `${this.sel.checked.size} selecionada(s)`;
    root.querySelector("[data-action=selok]").disabled = this.sel.checked.size === 0;
  }

  closeImport() {
    this.imp?.abort?.abort();
    this.imp = null;
    this.element?.querySelector(".dms-modal")?.remove();
  }

  renderImport() {
    const root = this.element;
    const imp = this.imp;
    if (!root || !imp) return;
    let ov = root.querySelector(".dms-modal");
    if (!ov) {
      ov = document.createElement("div");
      ov.className = "dms-modal";
      ov.addEventListener("click", ev => this.onImportClick(ev));
      root.querySelector(".dms-wrap").append(ov);
    }
    const title = esc(imp.rec.title);
    let body = "";
    if (imp.step === "planning") {
      body = `<h3>Importar: ${title}</h3><p>Calculando os arquivos necessários...</p>
        <div class="dms-dlg-foot"><span></span><button type="button" data-act="close">Cancelar</button></div>`;
    } else if (imp.step === "confirm") {
      const p = imp.plan;
      body = `<h3>Arquivos grandes</h3>
        <p class="dms-bad">⚠ ${p.large.length} arquivo(s) acima de ${fmtSize(LARGE_FILE_BYTES)}:</p>
        <ul class="dms-dlg-sum">${p.large.slice(0, 6).map(a => `<li>${esc(a.local)} (${fmtSize(a.size)})</li>`).join("")}${p.large.length > 6 ? "<li>...</li>" : ""}</ul>
        <p>Total a baixar: <b>${fmtSize(p.needBytes)}</b> em ${p.needCount} arquivo(s).</p>
        <div class="dms-dlg-foot"><span></span><button type="button" data-act="close">Cancelar</button><button type="button" data-act="run" class="dms-primary">Importar mesmo assim</button></div>`;
    } else if (imp.step === "run") {
      body = `<h3>Importando: ${title}</h3>
        <progress class="dms-imp-bar" value="0" max="1"></progress>
        <p class="dms-imp-file"></p>
        <div class="dms-imp-log"></div>
        <div class="dms-dlg-foot"><span></span><button type="button" data-act="abort">Cancelar</button></div>`;
    } else if (imp.step === "done") {
      const ok = imp.results.filter(r => r.ok).length;
      const bad = imp.results.length - ok;
      body = `<h3>Importação concluída</h3>
        <p class="${bad ? "dms-bad" : ""}">${ok} de ${imp.results.length} cena(s) criada(s) na pasta de cenas “${title}”.${bad ? " Veja os erros abaixo; detalhes no Console (F12)." : ""}</p>
        <div class="dms-imp-log">${imp.log.map(l => `<div class="${/^✖/.test(l) ? "dms-bad" : ""}">${esc(l)}</div>`).join("")}</div>
        <div class="dms-dlg-foot"><span></span><button type="button" data-act="close" class="dms-primary">Fechar</button></div>`;
    } else if (imp.step === "error") {
      body = `<h3>Importar: ${title}</h3><p class="dms-bad">${esc(imp.error)}</p>
        <div class="dms-dlg-foot"><span></span><button type="button" data-act="close" class="dms-primary">Fechar</button></div>`;
    }
    ov.innerHTML = `<div class="dms-dialog">${body}</div>`;
    if (imp.step === "run") this.paintImportLog();
  }

  paintImportLog() {
    const el = this.element?.querySelector(".dms-modal .dms-imp-log");
    if (el && this.imp) {
      el.innerHTML = this.imp.log.map(l => `<div class="${/^✖/.test(l) ? "dms-bad" : ""}">${esc(l)}</div>`).join("");
      el.scrollTop = el.scrollHeight;
    }
  }

  onImportClick(ev) {
    const act = ev.target.closest("[data-act]")?.dataset.act;
    const imp = this.imp;
    if (!act || !imp) return;
    if (act === "close") { this.closeImport(); if (imp.step === "done") this.stopSelecting(); }
    else if (act === "run") this.doImportRun();
    else if (act === "abort") imp.abort?.abort();
  }

  /** Botão OK: calcula o que baixar; só pergunta de novo se houver arquivo grande. */
  async startImport() {
    if (this.imp || !this.sel.checked.size || !this.current) return;
    const rec = this.current;
    const ids = (this.moduleScenes ?? []).filter(s => this.sel.checked.has(s.id)).map(s => s.id);
    const imp = this.imp = { rec, step: "planning", plan: null, log: [], results: [], abort: new AbortController() };
    this.renderImport();
    try {
      imp.plan = await planImport({ loader: this.loader, tree: this.tree, record: rec, sceneIds: ids, names: Object.fromEntries((this.moduleScenes ?? []).map(sc => [sc.id, sc.name])), signal: imp.abort.signal });
      imp.plan.folderName = rec.title;              // as cenas vão para uma pasta de cenas com o nome do módulo
    } catch (e) {
      if (this.imp !== imp || e?.name === "AbortError") return;
      console.error(e);
      imp.step = "error";
      imp.error = e instanceof Auth.AuthError ? "Conecte ao Google (botão Conectar) para ler este módulo e tente de novo."
        : `Erro: ${Auth.friendlyError(e)}`;
      return this.renderImport();
    }
    if (imp.plan.large.length) { imp.step = "confirm"; this.renderImport(); }
    else this.doImportRun();
  }

  async doImportRun() {
    const imp = this.imp;
    imp.step = "run";
    imp.log = [];
    imp.abort = new AbortController();
    this.renderImport();
    const ov = () => this.element?.querySelector(".dms-modal");
    try {
      const out = await runImport(imp.plan, {
        tree: this.tree,
        signal: imp.abort.signal,
        onProgress: p => {
          const bar = ov()?.querySelector(".dms-imp-bar");
          if (bar) { bar.max = Math.max(1, p.total); bar.value = p.doneBytes; }
          const f = ov()?.querySelector(".dms-imp-file");
          if (f) f.textContent = p.file ? `Arquivo ${p.index} de ${p.count}: ${p.file}` : "Criando as cenas...";
        },
        onLog: l => { imp.log.push(l); this.paintImportLog(); }
      });
      imp.results = out.results;
      imp.step = "done";
      this.statusKeep = true;
      this.setStatus(`Importação concluída: ${out.results.filter(r => r.ok).length} de ${out.results.length} cena(s) de "${imp.rec.title}".`, out.results.some(r => !r.ok));
    } catch (e) {
      if (this.imp !== imp) return;
      const aborted = e?.name === "AbortError";
      if (!aborted && !(e instanceof Auth.AuthError)) console.error(e);
      imp.step = "error";
      imp.error = e instanceof Auth.AuthError ? "A sessão do Google expirou. Conecte de novo e repita a importação: o que já foi baixado não será baixado outra vez."
        : aborted ? "Importação cancelada. Os arquivos já baixados ficam guardados." : `Erro: ${Auth.friendlyError(e)}`;
    }
    if (this.imp === imp) this.renderImport();
  }

  /* ---------- ações ---------- */
  async doConnect() {
    try {
      this.statusKeep = false;
      this.setStatus("Abrindo o login do Google...");
      await Auth.connect();
      let email = "conta-desconhecida";
      try { email = (await getUser())?.emailAddress ?? email; } catch (e) { console.warn(e); }
      await this.useAccount(email);
      this.refreshUI();                 // redesenha e retoma as miniaturas que esperavam o login
    } catch (e) {
      console.error(e);
      this.statusKeep = true;
      this.setStatus(`Erro: ${Auth.friendlyError(e)}`, true);
    }
  }

  async doIndex() {
    if (!Auth.isConnected() || !this.store || this.indexing) return;
    this.abort = new AbortController();
    this.indexing = true;
    this.statusKeep = false;
    this.refreshUI();
    let msg, bad = false;
    try {
      const s = await runIndex(this.store, {
        signal: this.abort.signal,
        onStatus: t => this.setStatus(t),
        onProgress: (d, t) => this.setProgress(d, t)
      });
      await this.reload();
      msg = `Pronto. ${s.listed} arquivos module.json (${s.unique} diferentes). ${this.records.length} têm cenas; ` +
        `${s.read} lidos agora${s.alreadyIndexed ? `, ${s.alreadyIndexed} já estavam no índice` : ""}` +
        `${s.removed ? `, ${s.removed} removidos` : ""}${s.badJson ? `, ${s.badJson} com JSON inválido` : ""}` +
        `${s.failed ? `. ${s.failed} falharam: clique em Atualizar o índice para tentar de novo` : ""}.`;
      bad = s.failed > 0;
    } catch (e) {
      await this.reload().catch(() => {});
      if (e instanceof Auth.AuthError) msg = "A sessão do Google expirou. Clique em Conectar e depois em Atualizar o índice: ele continua de onde parou.";
      else if (e?.name === "AbortError") msg = "Indexação cancelada. O que já foi lido ficou guardado.";
      else { console.error(e); msg = `Erro: ${Auth.friendlyError(e)}`; }
      bad = !(e?.name === "AbortError");
    } finally {
      this.indexing = false;
      this.abort = null;
      this.progress = null;
      this.statusKeep = true;
      this.setStatus(msg, bad);
      this.refreshUI();
    }
  }

  /** Confirmação dentro da janela (o confirm() do navegador é bloqueado em alguns aplicativos, como o FLC). */
  askConfirm(text, yes = "Continuar") {
    return new Promise(resolve => {
      const root = this.element?.querySelector(".dms-wrap");
      if (!root) return resolve(false);
      const ov = document.createElement("div");
      ov.className = "dms-modal dms-confirm";
      ov.innerHTML = `<div class="dms-dialog"><p>${esc(text)}</p><div class="dms-dlg-foot"><span></span><button type="button" data-ans="no">Cancelar</button><button type="button" data-ans="yes" class="dms-primary">${esc(yes)}</button></div></div>`;
      ov.addEventListener("click", ev => {
        const a = ev.target.closest("[data-ans]")?.dataset.ans;
        if (!a) return;
        ov.remove();
        resolve(a === "yes");
      });
      root.append(ov);
    });
  }

  async doClear() {
    if (!this.store) return;
    if (!await this.askConfirm("Apagar o índice, as cenas e as miniaturas guardados neste navegador? Dá para refazer depois, mas leva alguns minutos.", "Apagar")) return;
    await this.store.clear();
    this.loader = new ModuleLoader(this.store, this.tree);
    this.statusKeep = false;
    this.view = "list"; this.current = null;
    await this.reload();
  }

  async doRethumb() {
    if (!this.store) return;
    if (!await this.askConfirm("Apagar só as miniaturas e a lista de cenas guardadas, e ler tudo de novo? O índice dos módulos é mantido.", "Apagar")) return;
    await this.store.clearDerived();
    this.loader = new ModuleLoader(this.store, this.tree);
    this.refreshUI();
  }

  static connectAction() { return this.doConnect(); }
  static indexAction() { return this.doIndex(); }
  static cancelAction() { this.abort?.abort(); }
  static clearAction() { return this.doClear(); }
  static rethumbAction() { return this.doRethumb(); }
  static prevAction() { this.page = Math.max(0, this.page - 1); this.renderList(); }
  static nextAction() { this.page += 1; this.renderList(); }
  static openAction(event, target) { return this.openModule(target.closest("[data-key]")?.dataset.key); }
  static importAction() { this.startSelecting(); }
  static selallAction() { (this.moduleScenes ?? []).forEach(sc => this.sel.checked.add(sc.id)); this.updateSelUI(); }
  static selnoneAction() { this.sel.checked.clear(); this.updateSelUI(); }
  static selcancelAction() { this.stopSelecting(); }
  static selokAction() { return this.startImport(); }
  static backAction() { this.view = "list"; this.current = null; this.statusKeep = false; this.refreshUI(); }
}
