import { CONCURRENCY } from "./config.js";
import { AuthError } from "./auth.js";
import * as driveApi from "./drive.js";

const SCENE_TYPES = new Set(["scene", "adventure"]);
const stripTags = s => String(s ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

/** Transforma o texto de um module.json no registro que guardamos no índice. */
export function buildRecord(key, f, text) {
  const base = {
    key,
    fileId: f.id,
    parent: f.parents?.[0] ?? null,
    md5: f.md5Checksum ?? null,
    indexedAt: Date.now()
  };

  let j;
  try { j = JSON.parse(String(text).replace(/^\uFEFF/, "")); }
  catch { return { ...base, hasScenes: false, error: "JSON inválido" }; }
  if (!j || typeof j !== "object") return { ...base, hasScenes: false, error: "JSON inválido" };

  const packs = (Array.isArray(j.packs) ? j.packs : []).map(p => ({
    name: p.name ?? null,
    label: p.label ?? p.name ?? null,
    type: String(p.type ?? p.entity ?? ""),
    path: p.path ?? null
  }));
  const hasScenes = packs.some(p => SCENE_TYPES.has(p.type.toLowerCase()));
  if (!hasScenes) return { ...base, hasScenes: false };

  const id = j.id ?? j.name ?? null;
  const requires = (j.relationships?.requires ?? []).map(x => x?.id).filter(Boolean);
  const legacy = (j.dependencies ?? []).map(x => x?.name).filter(Boolean);

  return {
    ...base,
    hasScenes: true,
    id,
    title: j.title ?? id ?? "(sem título)",
    version: j.version ?? null,
    description: stripTags(j.description).slice(0, 400),
    packs,
    requires: requires.length ? requires : legacy
  };
}

/**
 * Lê o Drive e atualiza o índice.
 * - Duplicados (module.json com o mesmo conteúdo) viram uma entrada só.
 * - Só lê os arquivos novos ou alterados.
 * - Cada registro é gravado assim que lido, então se for interrompida,
 *   a próxima vez continua de onde parou.
 */
export async function runIndex(store, { signal, onStatus = () => {}, onProgress = () => {}, api = driveApi } = {}) {
  onStatus("Listando os module.json do Drive...");
  const remote = await api.listModuleJsons({
    signal,
    onPage: n => onStatus(`Listando os module.json do Drive... ${n}`)
  });

  const byKey = new Map();
  let duplicates = 0;
  for (const f of remote) {
    const key = f.md5Checksum || f.id;
    if (byKey.has(key)) { duplicates++; continue; }
    byKey.set(key, f);
  }

  const local = new Map((await store.all()).map(r => [r.key, r]));

  const removed = [...local.keys()].filter(k => !byKey.has(k));
  for (const k of removed) await store.delete(k);

  const todo = [];
  for (const [key, f] of byKey) {
    const r = local.get(key);
    if (!r) { todo.push([key, f]); continue; }
    const parent = f.parents?.[0] ?? null;
    if (r.fileId !== f.id || r.parent !== parent) await store.put({ ...r, fileId: f.id, parent });
  }

  const stats = {
    listed: remote.length,
    unique: byKey.size,
    duplicates,
    removed: removed.length,
    read: 0,
    failed: 0,
    badJson: 0,
    alreadyIndexed: byKey.size - todo.length
  };

  let next = 0;
  let stopped = null;
  onProgress(0, todo.length);
  if (todo.length) onStatus(`Lendo ${todo.length} module.json...`);

  const worker = async () => {
    while (!stopped && !signal?.aborted) {
      const idx = next++;
      if (idx >= todo.length) return;
      const [key, f] = todo[idx];
      try {
        const text = await api.getText(f.id, { signal });
        const rec = buildRecord(key, f, text);
        if (rec.error) stats.badJson++;
        await store.put(rec);
        stats.read++;
      } catch (e) {
        if (e?.name === "AbortError" || e instanceof AuthError) { stopped = e; return; }
        stats.failed++;            // não grava: da próxima vez tenta de novo
        console.warn("Drive Maps | falha ao ler", f.id, e);
      }
      onProgress(stats.read + stats.failed, todo.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));

  if (stopped) throw stopped;
  if (signal?.aborted) throw new DOMException("Cancelado", "AbortError");

  await store.setMeta("lastIndexed", Date.now());
  return stats;
}
