/*
 * Auditoria: percorre os módulos do índice e lista os que têm problema.
 * Só LÊ (Drive e Foundry); não altera nada.
 *
 *   rapida   : confere se o pack de cada módulo existe e se dá para lê-lo
 *   profunda : lê os packs e confere a imagem de fundo e a miniatura de cada cena
 *   completa : confere também todos os outros arquivos usados pelas cenas
 */
import { MAX_PACK_BYTES, LARGE_FILE_BYTES, DATA_ROOT } from "./config.js";
import { AuthError } from "./auth.js";
import { DriveTree, isFolder, relativeToModule } from "./drive.js";
import { ModuleLoader } from "./moduleLoader.js";
import { collectAssets } from "./importer.js";
import * as FS from "./foundryFs.js";

const norm = s => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const flat = s => norm(s).replace(/[^a-z0-9]/g, "");
const mb = n => `${(Number(n) / 1e6).toFixed(0)} MB`;
const isStop = e => e instanceof AuthError || e?.name === "AbortError";

export const EXPLICACOES = {
  PACK_CAMINHO_INVALIDO: "O module.json aponta para um pack com caminho que não dá para usar.",
  PACK_AUSENTE: "O pack de cenas citado no module.json não está na pasta do módulo no Drive.",
  PACK_VAZIO: "A pasta do pack existe, mas está sem os arquivos de dados.",
  PACK_GRANDE: "O pack é grande demais para ser lido pelo navegador.",
  PACK_ILEGIVEL: "O pack existe, mas o módulo não conseguiu ler as cenas dele.",
  PACK_COM_AVISO: "Um dos packs do módulo não pôde ser lido (os outros foram).",
  SEM_CENAS: "O módulo tem pack de cenas, mas nenhuma cena foi encontrada.",
  MODULE_JSON_INVALIDO: "O arquivo module.json não é um JSON válido.",
  PASTA_DESCONHECIDA: "Não se sabe qual é a pasta do módulo.",
  PASTA_DIFERENTE_DO_ID: "O nome da pasta no Drive é diferente do id do módulo (normalmente inofensivo).",
  ID_DUPLICADO: "Mais de uma pasta tem módulo com o mesmo id (versões ou cópias diferentes).",
  FUNDO_AUSENTE: "A imagem de fundo de uma cena não está no Drive. A cena NÃO será importada.",
  FUNDO_FORA_DO_MODULO: "O caminho do fundo aponta para fora do módulo (outro módulo, mundo ou link). A cena NÃO será importada.",
  FUNDO_VAZIO: "A cena não tem imagem de fundo (pode ser um mapa montado com peças).",
  MINIATURA_AUSENTE: "A miniatura original da cena não está no Drive (o Foundry gera outra ao importar).",
  MINIATURA_FORA_DO_MODULO: "O caminho da miniatura aponta para fora do módulo (o Foundry gera outra ao importar).",
  ID_DO_CAMINHO_DIFERENTE: "Os caminhos das cenas citam outro nome de módulo, mas o arquivo existe na pasta deste módulo.",
  ARQUIVO_GRANDE: "Há arquivo acima do limite de confirmação (50 MB).",
  ARQUIVO_AUSENTE: "Arquivos usados pela cena (peças, sons etc.) não estão no Drive.",
  ERRO_INTERNO: "A auditoria deste módulo falhou por um erro inesperado."
};

/** Classifica o caminho de um arquivo citado numa cena. */
export function classifyPath(path, moduleId) {
  const raw = String(path ?? "").split(/[?#]/)[0].replace(/\\/g, "/").replace(/^\.?\//, "");
  if (!raw) return { kind: "vazio" };
  if (/^data:/i.test(raw)) return { kind: "embutido" };
  if (/^https?:/i.test(raw)) return { kind: "url" };
  const m = /^modules\/([^/]+)\/(.+)$/i.exec(raw);
  if (m) return m[1].toLowerCase() === String(moduleId).toLowerCase()
    ? { kind: "dentro", rel: m[2] } : { kind: "outro-modulo", other: m[1], rest: m[2] };
  if (/^worlds\//i.test(raw)) return { kind: "mundo" };
  if (/^(systems|icons|ui|fonts|sounds)\//i.test(raw)) return { kind: "nucleo" };
  return { kind: "relativo", rel: raw };
}

/** Junta os achados do mesmo tipo de um módulo numa linha só (quantidade + 3 exemplos). */
function collector(rec) {
  const map = new Map();
  return {
    add(sev, code, detail) {
      const e = map.get(code) ?? { sev, n: 0, samples: [] };
      if (sev === "erro") e.sev = "erro";
      e.n++;
      if (e.samples.length < 3) e.samples.push(detail);
      map.set(code, e);
    },
    done() {
      return [...map].map(([code, e]) => ({
        modulo: rec.title ?? rec.id ?? "(sem título)", id: rec.id ?? null, gravidade: e.sev, codigo: code, quantidade: e.n,
        detalhe: e.samples.join(" | ") + (e.n > e.samples.length ? ` (+${e.n - e.samples.length})` : "")
      }));
    }
  };
}

/* ---------- auditoria rápida ---------- */
export async function auditQuick(rec, { tree, signal }) {
  const c = collector(rec);
  if (!rec.parent) { c.add("erro", "PASTA_DESCONHECIDA", "sem pasta"); return c.done(); }
  try {
    const nome = await tree.folderName(rec.parent, { signal });
    if (nome && flat(nome) !== flat(rec.id)) c.add("aviso", "PASTA_DIFERENTE_DO_ID", `pasta "${nome}" / id "${rec.id}"`);
  } catch (e) { if (isStop(e)) throw e; }

  for (const pack of rec.packs) {
    const type = pack.type.toLowerCase();
    if (type !== "scene" && type !== "adventure") continue;
    const rel = relativeToModule(pack.path, rec.id);
    if (!rel) { c.add("erro", "PACK_CAMINHO_INVALIDO", `pack "${pack.name}": ${pack.path}`); continue; }
    const node = (await tree.resolve(rec.parent, rel, { signal })) ?? (await tree.resolve(rec.parent, `${rel}.db`, { signal }));
    if (!node) { c.add("erro", "PACK_AUSENTE", `pack "${pack.name}" (${pack.path})`); continue; }
    if (isFolder(node)) {
      const kids = (await tree.listChildren(node.id, { signal })).filter(k => /\.(ldb|sst|log)$/i.test(k.name));
      if (!kids.length) { c.add("erro", "PACK_VAZIO", `pack "${pack.name}"`); continue; }
      const total = kids.reduce((s, k) => s + (Number(k.size) || 0), 0);
      if (total > MAX_PACK_BYTES) c.add("erro", "PACK_GRANDE", `pack "${pack.name}": ${mb(total)}`);
    } else if (Number(node.size) > MAX_PACK_BYTES) c.add("erro", "PACK_GRANDE", `pack "${pack.name}": ${mb(node.size)}`);
  }
  return c.done();
}

/* ---------- auditoria profunda / completa ---------- */
async function checkField(rec, tree, scene, label, path, sevMissing, c, signal) {
  const cls = classifyPath(path, rec.id);
  const where = `cena "${scene.name}"`;
  if (cls.kind === "embutido" || cls.kind === "nucleo") return;
  if (cls.kind === "vazio") {
    if (label === "FUNDO") c.add("aviso", "FUNDO_VAZIO", where);
    return;
  }
  if (cls.kind === "dentro" || cls.kind === "relativo") {
    const node = await tree.resolve(rec.parent, cls.rel, { signal });
    if (!node || isFolder(node)) c.add(sevMissing, `${label}_AUSENTE`, `${where}: ${path}`);
    else if (Number(node.size) > LARGE_FILE_BYTES) c.add("aviso", "ARQUIVO_GRANDE", `${where}: ${label.toLowerCase()} de ${mb(node.size)}`);
    return;
  }
  if (cls.kind === "outro-modulo") {
    const node = await tree.resolve(rec.parent, cls.rest, { signal });
    if (node && !isFolder(node)) c.add("aviso", "ID_DO_CAMINHO_DIFERENTE", `${where}: caminho usa "modules/${cls.other}/", módulo é "${rec.id}"`);
    else c.add(sevMissing, `${label}_FORA_DO_MODULO`, `${where}: ${path}`);
    return;
  }
  c.add(sevMissing, `${label}_FORA_DO_MODULO`, `${where}: ${path}`);
}

export async function auditDeep(rec, { tree, loader, store, signal, full }) {
  const c = collector(rec);
  const cached = await store.getScenes(rec.key);
  if (cached?.error) await store.deleteScenes(rec.key);          // conserto no Drive: tenta de novo
  let sc;
  try { sc = await loader.loadScenes(rec, { signal }); }
  catch (e) { if (isStop(e)) throw e; c.add("erro", "PACK_ILEGIVEL", e.message); return c.done(); }
  if (sc.error) { c.add("erro", "PACK_ILEGIVEL", sc.error); return c.done(); }
  for (const n of sc.notes ?? []) c.add("aviso", "PACK_COM_AVISO", n);
  if (!sc.scenes.length) { c.add("erro", "SEM_CENAS", "nenhuma cena nos packs"); return c.done(); }

  for (const s of sc.scenes) {
    await checkField(rec, tree, s, "FUNDO", s.bgPath, "erro", c, signal);
    if (!s.thumbReady) await checkField(rec, tree, s, "MINIATURA", s.thumbPath, "aviso", c, signal);
  }

  if (full) {
    const docs = await loader.readFullScenes(rec, sc.scenes.map(s => s.id), { signal });
    for (const [id, doc] of docs) {
      doc.tokens = [];                                 // os tokens não são importados
      const name = sc.scenes.find(s => s.id === id)?.name ?? id;
      const missing = [], big = [];
      const scene = sc.scenes.find(x => x.id === id);
      for (const orig of collectAssets(doc, rec.id)) {
        if (orig === doc.thumb || orig === scene?.thumbPath || orig === scene?.bgPath) continue;   // já conferidos acima
        const cls = classifyPath(orig, rec.id);
        const node = await tree.resolve(rec.parent, cls.rel, { signal });
        if (!node || isFolder(node)) missing.push(orig.split("/").pop());
        else if (Number(node.size) > LARGE_FILE_BYTES) big.push(`${orig.split("/").pop()} (${mb(node.size)})`);
      }
      if (missing.length) c.add("aviso", "ARQUIVO_AUSENTE", `cena "${name}": ${missing.length} (${missing.slice(0, 2).join(", ")})`);
      if (big.length) c.add("aviso", "ARQUIVO_GRANDE", `cena "${name}": ${big.slice(0, 2).join(", ")}`);
    }
  }
  return c.done();
}

/* ---------- relatório ---------- */
const csvCell = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
export function toCsv(problemas) {
  const head = ["gravidade", "codigo", "modulo", "id", "quantidade", "detalhe", "explicacao"];
  const rows = problemas.map(p => [p.gravidade, p.codigo, p.modulo, p.id, p.quantidade, p.detalhe, EXPLICACOES[p.codigo] ?? ""]);
  return [head, ...rows].map(r => r.map(csvCell).join(",")).join("\r\n");
}

function download(name, text, type) {
  const blob = new Blob(["\ufeff", text], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");

async function saveReport(report) {
  const name = `auditoria-${report.modo}-${stamp()}`;
  const out = { csv: null, foundry: null };
  try { download(`drive-maps-${name}.csv`, toCsv(report.problemas), "text/csv;charset=utf-8"); out.csv = `drive-maps-${name}.csv`; }
  catch (e) { console.warn("Drive Maps | download do relatório", e); }
  try {
    const dir = `${DATA_ROOT}/reports`;
    await FS.ensureDir(dir);
    out.foundry = await FS.upload(dir, new Blob([JSON.stringify(report, null, 1)], { type: "application/json" }), `${name}.json`);
  } catch (e) { console.warn("Drive Maps | relatório dentro do Foundry", e); }
  return out;
}

/* ---------- execução ---------- */
export async function runAudit({ store, opts = {}, signal }) {
  const modo = opts.modo ?? "rapida";
  if (!["rapida", "profunda", "completa"].includes(modo)) throw new Error('modo deve ser "rapida", "profunda" ou "completa"');
  const concurrency = Math.max(1, Math.min(8, opts.concorrencia ?? 4));
  const all = await store.all();
  const withScenes = all.filter(r => r.hasScenes);

  let list = withScenes;
  if (opts.filtro) { const t = norm(opts.filtro); list = list.filter(r => norm(`${r.title} ${r.id}`).includes(t)); }
  if (opts.somenteSuspeitos) {
    const prev = await store.getMeta("audit:rapida");
    const bad = new Set(Object.entries(prev?.feitos ?? {}).filter(([, f]) => f.some(x => x.gravidade === "erro")).map(([k]) => k));
    list = list.filter(r => bad.has(r.key));
  }

  const stateKey = `audit:${modo}`;
  let state = opts.retomar ? await store.getMeta(stateKey) : null;
  state = state ?? { iniciou: Date.now(), feitos: {} };
  const todo = list.filter(r => !state.feitos[r.key]);
  console.info(`Drive Maps | auditoria ${modo}: ${todo.length} módulo(s) para conferir${state && Object.keys(state.feitos).length ? ` (${list.length - todo.length} já feitos)` : ""}.`);

  let next = 0, done = 0, paused = null;
  const t0 = Date.now();
  const worker = async () => {
    while (!paused && !signal?.aborted) {
      const i = next++;
      if (i >= todo.length) return;
      const rec = todo[i];
      try {
        const tree = new DriveTree();
        const loader = new ModuleLoader(store, tree, { concurrency: 2 });
        state.feitos[rec.key] = modo === "rapida"
          ? await auditQuick(rec, { tree, signal })
          : await auditDeep(rec, { tree, loader, store, signal, full: modo === "completa" });
      } catch (e) {
        if (e instanceof AuthError) { paused = "A sessão do Google expirou (dura cerca de 1 hora). Clique em Conectar e rode de novo com { retomar: true }."; return; }
        if (e?.name === "AbortError") { paused = "Auditoria cancelada."; return; }
        console.warn("Drive Maps | auditoria", rec.id, e);
        state.feitos[rec.key] = [{ modulo: rec.title ?? rec.id, id: rec.id, gravidade: "erro", codigo: "ERRO_INTERNO", quantidade: 1, detalhe: String(e?.message ?? e).slice(0, 200) }];
      }
      done++;
      if (done % 25 === 0) {
        await store.setMeta(stateKey, state);
        const falta = Math.round(((Date.now() - t0) / done) * (todo.length - done) / 60000);
        console.info(`Drive Maps | auditoria ${modo}: ${done}/${todo.length} · faltam cerca de ${falta} min`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, todo.length)) }, worker));
  if (signal?.aborted && !paused) paused = "Auditoria cancelada.";
  await store.setMeta(stateKey, state);

  const inList = new Set(list.map(r => r.key));
  const problemas = Object.entries(state.feitos).filter(([k]) => inList.has(k)).flatMap(([, f]) => f);

  if (modo === "rapida" && !opts.filtro) {
    for (const r of all.filter(x => x.error)) problemas.push({ modulo: r.title ?? "(sem título)", id: r.id ?? null, gravidade: "erro", codigo: "MODULE_JSON_INVALIDO", quantidade: 1, detalhe: r.error });
  }
  const byId = new Map();
  for (const r of withScenes) { const k = String(r.id).toLowerCase(); byId.set(k, [...(byId.get(k) ?? []), r]); }
  for (const group of byId.values()) {
    if (group.length < 2 || (opts.filtro && !group.some(r => inList.has(r.key)))) continue;
    for (const r of group) problemas.push({ modulo: r.title, id: r.id, gravidade: "aviso", codigo: "ID_DUPLICADO", quantidade: group.length, detalhe: `${group.length} pastas com o id "${r.id}"` });
  }

  const ordem = { erro: 0, aviso: 1 };
  problemas.sort((a, b) => ordem[a.gravidade] - ordem[b.gravidade] || a.codigo.localeCompare(b.codigo) || String(a.modulo).localeCompare(String(b.modulo)));

  const porCodigo = {};
  for (const p of problemas) porCodigo[`${p.gravidade}: ${p.codigo}`] = (porCodigo[`${p.gravidade}: ${p.codigo}`] ?? 0) + 1;
  const feitos = Object.keys(state.feitos).filter(k => inList.has(k)).length;
  const report = {
    modo, geradoEm: new Date().toISOString(), modulosNoEscopo: list.length, modulosConferidos: feitos,
    comErro: new Set(problemas.filter(p => p.gravidade === "erro").map(p => p.id ?? p.modulo)).size,
    comAviso: new Set(problemas.filter(p => p.gravidade === "aviso").map(p => p.id ?? p.modulo)).size,
    porCodigo, pausada: paused, duracaoMin: +((Date.now() - t0) / 60000).toFixed(1), problemas
  };

  console.info(`Drive Maps | auditoria ${modo} ${paused ? "PAUSADA: " + paused : "concluída"} · ${feitos}/${list.length} módulos · ${report.comErro} com erro · ${report.comAviso} com aviso`);
  console.table(porCodigo);
  console.table(problemas.slice(0, 60).map(p => ({ gravidade: p.gravidade, codigo: p.codigo, modulo: p.modulo, detalhe: String(p.detalhe).slice(0, 110) })));
  if (opts.baixar !== false) report.arquivos = await saveReport(report);
  if (report.arquivos) console.info("Drive Maps | relatório:", report.arquivos);
  return report;
}

export async function lastAudit(store, modo = "rapida") {
  const st = await store.getMeta(`audit:${modo}`);
  return st ? { modo, feitos: Object.keys(st.feitos).length, problemas: Object.values(st.feitos).flat() } : null;
}
