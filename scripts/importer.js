import { DATA_ROOT, LARGE_FILE_BYTES, UPLOAD_CONCURRENCY, IMPORT_VERSION } from "./config.js";
import { normalizeScene } from "./legacy.js";
import { AuthError } from "./auth.js";
import { isFolder } from "./drive.js";
import * as FS from "./foundryFs.js";

export const cacheDir = moduleId => `${DATA_ROOT}/cache/${moduleId}`;

const safeDecode = s => { try { return decodeURIComponent(s); } catch { return s; } };
const escapeRx = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const cleanSeg = s => s.replace(/[^\w.\-]+/g, "_");
const dirname = p => p.split("/").slice(0, -1).join("/");
const basename = p => p.split("/").pop();
const safeId = s => String(s).replace(/[^\w.\-]+/g, "_");

/** "modules/<id>/maps/a.jpg" -> "maps/a.jpg". Devolve null se o arquivo não for deste módulo. */
function moduleRel(value, moduleId) {
  if (typeof value !== "string") return null;
  const m = new RegExp(`^modules/${escapeRx(moduleId)}/(.+)$`, "i").exec(value.split(/[?#]/)[0]);
  return m ? m[1] : null;
}

/** Todos os caminhos de arquivo deste módulo usados dentro da cena (fundo, tiles, sons, fichas...). */
export function collectAssets(doc, moduleId) {
  const found = new Set();
  (function walk(v) {
    if (typeof v === "string") { if (moduleRel(v, moduleId)) found.add(v); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  })(doc);
  return found;
}

function rewrite(doc, mapping) {
  const walk = v => {
    if (typeof v === "string") return mapping.get(v) ?? v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(doc);
}

/** Nome do arquivo no Foundry: sem espaços e símbolos; evita dois arquivos com o mesmo nome. */
function localName(rel, taken) {
  const p = rel.split("/").map(s => cleanSeg(safeDecode(s))).filter(Boolean).join("/");
  let name = p, n = 2;
  while (taken.has(name.toLowerCase()) && taken.get(name.toLowerCase()) !== rel) {
    name = p.replace(/(\.[^./]*)?$/, `_${n++}$1`);
  }
  taken.set(name.toLowerCase(), rel);
  return name;
}

function prepare(doc, folderId, moduleId) {
  const d = structuredClone(doc);
  const { notes } = normalizeScene(d);
  for (const k of ["_id", "_stats", "ownership", "sort"]) delete d[k];
  d.tokens = [];                                     // os atores não existem no mundo: ficam só o mapa e o resto
  // miniatura que não foi baixada (ou que aponta para outro lugar, como a pasta de um mundo do criador): o Foundry gera outra
  if (typeof d.thumb === "string" && !d.thumb.startsWith("data:") && !d.thumb.startsWith(`${DATA_ROOT}/`)) d.thumb = null;
  d.folder = folderId ?? null;
  d.active = false;
  d.navigation = false;
  for (const k of ["playlist", "playlistSound", "journal", "journalEntryPage"]) if (k in d) d[k] = null;
  return { data: d, notes };
}

/** Caminhos de imagem de fundo e primeiro plano da cena (os que fazem o mapa existir). */
function mapPaths(doc, moduleId) {
  const out = new Set();
  const add = v => { if (typeof v === "string" && moduleRel(v, moduleId)) out.add(v); };
  add(doc.background?.src); add(doc.img); add(doc.foreground);
  for (const l of Array.isArray(doc.levels) ? doc.levels : []) { add(l?.background?.src); add(l?.foreground?.src ?? l?.foreground); }
  return [...out];
}

const prettyName = p => { try { return decodeURIComponent(String(p).split("/").pop()); } catch { return String(p).split("/").pop(); } };

/**
 * Descobre o que precisa ser baixado, sem baixar nada.
 * Cenas que já foram importadas antes vêm do cache e não precisam do Drive.
 */
export async function planImport({ loader, tree, record, sceneIds, names = {}, signal }) {
  const plan = {
    record, scenes: [], assets: new Map(), missing: [], large: [],
    needBytes: 0, needCount: 0, haveCount: 0, folderName: null
  };
  const tag = String(record.md5 ?? "x").slice(0, 8);
  const cached = await FS.listDir(`${cacheDir(record.id)}/_scenes`);
  for (const id of sceneIds) {
    const jsonName = `${safeId(id)}.${tag}.v${IMPORT_VERSION}.json`;
    plan.scenes.push({ id, jsonName, label: names[id] ?? id, cached: cached.has(jsonName) });
  }

  const uncached = plan.scenes.filter(s => !s.cached).map(s => s.id);
  if (uncached.length) {
    const docs = await loader.readFullScenes(record, uncached, { signal });
    for (const s of plan.scenes) {
      if (s.cached) continue;
      s.doc = docs.get(s.id);
      if (!s.doc) { s.error = "cena não encontrada no pack"; continue; }
      s.removedTokens = Array.isArray(s.doc.tokens) ? s.doc.tokens.length : 0;
      s.doc.tokens = [];
    }
  }

  const taken = new Map();
  for (const s of plan.scenes) {
    if (!s.doc) continue;
    for (const orig of collectAssets(s.doc, record.id)) {
      if (plan.assets.has(orig)) continue;
      const rel = moduleRel(orig, record.id);
      const node = await tree.resolve(record.parent, rel, { signal });
      if (!node || isFolder(node)) { plan.missing.push(orig); plan.assets.set(orig, { orig, missing: true }); continue; }
      plan.assets.set(orig, { orig, rel, node, size: Number(node.size) || 0, local: localName(rel, taken) });
    }
  }

  for (const a of plan.assets.values()) {
    if (a.missing) continue;
    const have = await FS.listDir(`${cacheDir(record.id)}/${dirname(a.local)}`);
    a.have = have.has(basename(a.local));
    if (a.have) { plan.haveCount++; continue; }
    plan.needBytes += a.size;
    plan.needCount++;
    if (a.size > LARGE_FILE_BYTES) plan.large.push(a);
  }
  return plan;
}

/** Baixa o que falta, guarda no Foundry e cria as cenas. */
export async function runImport(plan, { tree, signal, onProgress = () => {}, onLog = () => {} }) {
  const { record } = plan;
  const root = cacheDir(record.id);
  const mapping = new Map();
  const failed = new Map();
  let stop = null, doneBytes = 0;

  const all = [...plan.assets.values()].filter(a => !a.missing);
  for (const a of all) if (a.have) mapping.set(a.orig, `${root}/${a.local}`);
  const need = all.filter(a => !a.have);

  let next = 0;
  const worker = async () => {
    while (!stop && !signal?.aborted) {
      const i = next++;
      if (i >= need.length) return;
      const a = need[i];
      onProgress({ file: a.local, doneBytes, total: plan.needBytes, index: i + 1, count: need.length });
      try {
        const dir = `${root}/${dirname(a.local)}`;
        await FS.ensureDir(dir);
        const blob = await tree.downloadBlob(a.node.id, { signal });
        mapping.set(a.orig, await FS.upload(dir, blob, basename(a.local)));
      } catch (e) {
        if (e instanceof AuthError || e?.name === "AbortError") { stop = e; return; }
        failed.set(a.orig, e.message);
        onLog(`⚠ ${a.local}: ${e.message}`);
      }
      doneBytes += a.size;
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, need.length) }, worker));
  if (stop) throw stop;
  if (signal?.aborted) throw new DOMException("Cancelado", "AbortError");
  onProgress({ file: "", doneBytes: plan.needBytes, total: plan.needBytes, index: need.length, count: need.length });

  const folderId = plan.folderName ? await FS.sceneFolder(plan.folderName) : null;
  const results = [];
  let jsonWarned = false;

  for (const s of plan.scenes) {
    let doc = null;
    try {
      if (s.cached) {
        try { doc = await FS.readJson(`${root}/_scenes/${s.jsonName}`); }
        catch {
          FS.forgetListing(`${root}/_scenes`);
          throw new Error("o cache desta cena não foi encontrado (foi apagado?). Feche e abra o Drive Maps e importe de novo.");
        }
      } else if (s.doc) {
        const lacking = mapPaths(s.doc, record.id).filter(p => !mapping.has(p));
        if (lacking.length) {
          const why = failed.get(lacking[0]) ?? (plan.missing.includes(lacking[0]) ? "o arquivo não existe no Drive" : "o arquivo não foi baixado");
          throw new Error(`a imagem do mapa não foi guardada (${prettyName(lacking[0])}: ${why}). A cena NÃO foi criada; importe de novo.`);
        }
        doc = rewrite(s.doc, mapping);
      } else throw new Error(s.error ?? "cena indisponível");

      const stillMissing = [...collectAssets(doc, record.id)];
      const thumbMissing = typeof doc.thumb === "string" && stillMissing.includes(doc.thumb);
      const unresolved = stillMissing.filter(u => u !== doc.thumb);     // a miniatura sozinha não impede nada
      if (!s.cached && !unresolved.length) {          // só guarda a cena no cache se estiver completa
        try {
          await FS.ensureDir(`${root}/_scenes`);
          await FS.upload(`${root}/_scenes`, new Blob([JSON.stringify(doc)], { type: "application/json" }), s.jsonName);
        } catch (e) {
          if (!jsonWarned) { onLog(`⚠ não consegui guardar a cena no cache (${e.message}). A cena será criada mesmo assim.`); jsonWarned = true; }
        }
      }
      const prepared = prepare(doc, folderId, record.id);
      const bg = prepared.data.background?.src ?? null;
      const { warnings } = await FS.createScene(prepared.data, bg);
      const notes = [...prepared.notes];
      if (thumbMissing) notes.unshift("a miniatura original não está no Drive; o Foundry vai gerar outra");
      if (s.removedTokens) notes.unshift(`${s.removedTokens} token(s) removidos`);
      if (unresolved.length) {
        const names = [...new Set(unresolved.map(prettyName))];
        warnings.unshift(`${unresolved.length} arquivo(s) não encontrados no Drive: ${names.slice(0, 4).join(", ")}${names.length > 4 ? "..." : ""}`);
      }
      results.push({ id: s.id, name: doc.name, ok: true, unresolved, warnings });
      onLog(`✔ ${doc.name}`);
      for (const n of notes) onLog(`   ℹ ${n}`);
      for (const w of warnings) onLog(`   ⚠ ${w}`);
    } catch (e) {
      const name = doc?.name ?? s.doc?.name ?? s.label ?? s.id;
      console.error("Drive Maps | falha ao criar a cena", name, e);
      results.push({ id: s.id, name, ok: false, error: e.message });
      onLog(`✖ ${name}: ${String(e.message || "motivo desconhecido (veja o Console, F12)").replace(/\s+/g, " ").slice(0, 300)}`);
    }
  }
  return { results, failed: [...failed] };
}
