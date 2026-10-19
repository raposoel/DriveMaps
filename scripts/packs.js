import { readLevelDb } from "./leveldb.js";

const td = new TextDecoder();
const isStr = v => typeof v === "string" && v.length > 0;

/** NeDB (.db, formato antigo): um JSON por linha; linhas mais novas substituem as antigas. */
export function parseNedb(text) {
  const docs = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (!d || d._id == null) continue;
    if (d.$$deleted) docs.delete(d._id); else docs.set(d._id, d);
  }
  return [...docs.values()];
}

/** Resumo leve de uma cena (sem paredes, luzes, etc.). */
export function summarizeScene(doc) {
  const bg = doc.background?.src
    ?? (isStr(doc.img) ? doc.img : null)
    ?? (Array.isArray(doc.levels) ? doc.levels[0]?.background?.src : null)
    ?? null;
  const thumb = isStr(doc.thumb) ? doc.thumb : null;
  return {
    id: doc._id ?? doc.id ?? null,
    name: doc.name ?? "(sem nome)",
    thumbData: thumb && thumb.startsWith("data:") ? thumb : null,
    thumbPath: thumb && !thumb.startsWith("data:") ? thumb : null,
    bgPath: isStr(bg) ? bg : null
  };
}

const scenesOf = (docs, packType) =>
  (packType === "adventure" ? docs.flatMap(d => Array.isArray(d.scenes) ? d.scenes : []) : docs)
    .map(summarizeScene)
    .filter(s => s.id);

export function scenesFromNedb(text, packType) {
  return scenesOf(parseNedb(text), packType);
}

/** files: [{ name, bytes }] de uma pasta LevelDB */
export function scenesFromLevel(files, packType) {
  const map = readLevelDb(files);
  const prefix = packType === "adventure" ? "!adventures!" : "!scenes!";
  const docs = [];
  for (const [k, v] of map) {
    if (!k.startsWith(prefix)) continue;
    try { docs.push(JSON.parse(td.decode(v))); } catch { /* ignora entrada ilegível */ }
  }
  return scenesOf(docs, packType);
}

/* ---------- Cenas completas (para importar) ---------- */
const EMBEDDED = ["drawings", "tokens", "lights", "notes", "sounds", "regions", "templates", "tiles", "walls", "levels"];

/** Nos packs LevelDB, paredes, luzes etc. ficam em chaves separadas; a cena só guarda os ids. Aqui juntamos tudo. */
function assemble(doc, map) {
  for (const field of EMBEDDED) {
    const ids = doc[field];
    if (!Array.isArray(ids) || !ids.length || typeof ids[0] !== "string") continue;
    const out = [];
    for (const id of ids) {
      const v = map.get(`!scenes.${field}!${doc._id}.${id}`);
      if (!v) continue;
      try { out.push(JSON.parse(td.decode(v))); } catch { /* ignora */ }
    }
    doc[field] = out;
  }
  return doc;
}

const fullOf = (docs, packType) =>
  (packType === "adventure" ? docs.flatMap(d => Array.isArray(d.scenes) ? d.scenes : []) : docs)
    .filter(d => d && (d._id ?? d.id))
    .map(d => ({ id: d._id ?? d.id, doc: d }));

export function fullScenesFromNedb(text, packType) {
  return fullOf(parseNedb(text), packType);
}

export function fullScenesFromLevel(files, packType) {
  const map = readLevelDb(files);
  const prefix = packType === "adventure" ? "!adventures!" : "!scenes!";
  const docs = [];
  for (const [k, v] of map) {
    if (!k.startsWith(prefix)) continue;
    try {
      const d = JSON.parse(td.decode(v));
      docs.push(packType === "adventure" ? d : assemble(d, map));
    } catch { /* ignora entrada ilegível */ }
  }
  return fullOf(docs, packType);
}
