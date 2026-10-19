/*
 * Tudo que mexe no Foundry (arquivos e documentos) fica aqui.
 * Assim o resto do módulo não precisa saber qual versão está rodando.
 */
import { normalizeLights } from "./legacy.js";

const FP = () => foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
const decode = s => { try { return decodeURIComponent(s); } catch { return s; } };

const knownDirs = new Set();
const listings = new Map();
const sleep = ms => new Promise(r => setTimeout(r, ms));

let dirQueue = Promise.resolve();

/** Garante que a pasta existe dentro de Data/. Um pedido de cada vez, para não haver corrida entre dois envios. */
export function ensureDir(path) {
  const run = dirQueue.then(() => ensureDirNow(path));
  dirQueue = run.catch(() => {});
  return run;
}

async function ensureDirNow(path) {
  let cur = "";
  for (const part of path.split("/").filter(Boolean)) {
    cur = cur ? `${cur}/${part}` : part;
    if (knownDirs.has(cur)) continue;
    let exists = true;
    try { await FP().browse("data", cur); } catch { exists = false; }
    if (!exists) {
      try { await FP().createDirectory("data", cur); }
      catch (e) {
        // EEXIST / EISDIR: a pasta apareceu enquanto tentávamos criá-la. Confere de novo antes de desistir.
        let nowExists = true;
        try { await FP().browse("data", cur); } catch { nowExists = false; }
        if (!nowExists && !/exist|EEXIST|EISDIR/i.test(String(e?.message ?? e))) throw e;
      }
    }
    knownDirs.add(cur);
  }
}

function forgetDir(path) {
  let cur = "";
  for (const part of path.split("/").filter(Boolean)) { cur = cur ? `${cur}/${part}` : part; knownDirs.delete(cur); }
}

/** Nomes dos arquivos que já estão numa pasta (sem erro se a pasta não existir). */
export async function listDir(path) {
  if (listings.has(path)) return listings.get(path);
  let names = new Set();
  try {
    const r = await FP().browse("data", path);
    names = new Set((r.files ?? []).map(f => decode(f.split("/").pop())));
  } catch { /* pasta ainda não existe */ }
  listings.set(path, names);
  return names;
}

export function forgetListing(path) { listings.delete(path); }

/** Envia um arquivo e devolve o caminho em que o Foundry realmente o guardou. Tenta de novo uma vez. */
export async function upload(dir, blob, name) {
  const file = new File([blob], name, { type: blob.type || undefined });
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await FP().upload("data", dir, file, {}, { notify: false });
      if (!res?.path) throw new Error("o Foundry não confirmou o envio do arquivo");
      listings.get(dir)?.add(name);
      return res.path;
    } catch (e) {
      lastErr = e;
      if (/extension|not allowed|permission/i.test(String(e?.message ?? e))) break;   // repetir não adianta
      forgetDir(dir);
      await sleep(400);
      await ensureDir(dir);
    }
  }
  throw lastErr;
}

export async function readJson(path) {
  const r = await fetch(path.split("/").map(encodeURIComponent).join("/"));
  if (!r.ok) throw new Error(`não consegui ler ${path}`);
  return r.json();
}

/** Pasta de cenas do mundo com esse nome (cria se não existir). */
export async function sceneFolder(name) {
  const hit = game.folders?.find(f => f.type === "Scene" && f.name === name && !f.folder);
  if (hit) return hit.id;
  return (await Folder.create({ name, type: "Scene" })).id;
}

const EMBEDDED = {
  drawings: "Drawing", tokens: "Token", lights: "AmbientLight", notes: "Note", sounds: "AmbientSound",
  regions: "Region", templates: "MeasuredTemplate", tiles: "Tile", walls: "Wall"
};
const brief = e => e ? String(e.message ?? e).replace(/\s+/g, " ").slice(0, 300) : "";

/** Valores aceitos por um campo de parede nesta versão do Foundry (ou null se não der para saber). */
function wallChoices(field) {
  try {
    const schema = foundry.documents.WallDocument?.schema;
    const f = schema?.getField?.(field) ?? schema?.fields?.[field];
    let c = f?.choices ?? f?.options?.choices;
    if (typeof c === "function") c = c.call(f);
    if (c) return new Set((Array.isArray(c) ? c : Object.keys(c)).map(Number));
  } catch { /* cai no plano B */ }
  return null;
}

/**
 * Paredes de módulos antigos (v9) usam move=1 e sense/sound 0, 1, 2. O Foundry atual espera
 * move 0/20 e light/sight/sound 0/10/20/... Aqui convertemos: 1 vira "normal" e 2 vira "limitado".
 */
export function normalizeWalls(walls) {
  const C = globalThis.CONST ?? {};
  const M = ("EDGE_MOVEMENT_TYPES" in C ? C.EDGE_MOVEMENT_TYPES : C.WALL_MOVEMENT_TYPES) ?? {};
  const S = ("EDGE_SENSE_TYPES" in C ? C.EDGE_SENSE_TYPES : C.WALL_SENSE_TYPES) ?? {};
  const NONE = S.NONE ?? 0, LIMITED = S.LIMITED ?? 10, NORMAL = S.NORMAL ?? 20;
  const MOVE_NONE = M.NONE ?? 0, MOVE_NORMAL = M.NORMAL ?? 20;
  const valid = Object.fromEntries(["move", "light", "sight", "sound"].map(f => [f, wallChoices(f)]));
  const sense = v => v === 0 ? NONE : v === 2 ? LIMITED : NORMAL;
  let fixed = 0;
  const out = walls.map(w => {
    const n = { ...w };
    let changed = false;
    if ("sense" in n) {
      const v = sense(n.sense);
      if (!("sight" in n)) n.sight = v;
      if (!("light" in n)) n.light = v;
      delete n.sense;
      changed = true;
    }
    for (const f of ["move", "light", "sight", "sound"]) {
      if (!(f in n)) continue;
      const v = n[f];
      const legacy = f === "move" ? v === 1 : (v === 1 || v === 2);
      const bad = valid[f] ? !valid[f].has(v) : legacy;
      if (!bad) continue;
      n[f] = f === "move" ? (v ? MOVE_NORMAL : MOVE_NONE) : sense(v);
      changed = true;
    }
    if (changed) fixed++;
    return n;
  });
  return { walls: out, fixed };
}

/** Separa os itens que esta versão do Foundry aceita dos que ela recusaria. */
function dropInvalid(type, docs) {
  const Cls = globalThis.CONFIG?.[type]?.documentClass;
  if (!Cls) return { docs, dropped: 0 };
  const ok = [];
  let dropped = 0;
  for (const d of docs) {
    try { new Cls(structuredClone(d)); ok.push(d); } catch { dropped++; }
  }
  return { docs: ok, dropped };
}

function probe(Scene, data) {
  try { new Scene(structuredClone(data)); return null; } catch (e) { return brief(e); }
}

/**
 * Cria a cena. Importante: quando o Foundry recusa os dados, ele mostra o erro na tela e devolve
 * "nada" (sem lançar erro). Por isso conferimos o resultado.
 * Devolve { scene, warnings }.
 */
export async function createScene(data, backgroundPath) {
  const Scene = globalThis.getDocumentClass?.("Scene") ?? CONFIG.Scene.documentClass;
  const warnings = [];
  const work = structuredClone(data);

  if (Array.isArray(work.lights) && work.lights.length) {
    const r = normalizeLights(work.lights);
    work.lights = r.lights;
    if (r.fixed) warnings.push(`${r.fixed} luz(es) convertidas do formato antigo`);
  }
  if (Array.isArray(work.walls) && work.walls.length) {
    const r = normalizeWalls(work.walls);
    work.walls = r.walls;
    if (r.fixed) warnings.push(`${r.fixed} parede(s) convertidas do formato antigo`);
  }
  for (const [k, type] of Object.entries(EMBEDDED)) {
    if (!Array.isArray(work[k]) || !work[k].length) continue;
    const r = dropInvalid(type, work[k]);
    if (r.dropped) {
      warnings.push(`${r.dropped} de ${work[k].length} item(ns) de "${k}" eram inválidos nesta versão do Foundry e foram ignorados`);
      work[k] = r.docs;
    }
  }

  let scene = null, thrown = null;
  try { scene = await Scene.create(work); } catch (e) { thrown = e; }

  if (!scene) {
    const reason = brief(thrown) || probe(Scene, work) || "";
    console.error("Drive Maps | o Foundry recusou a cena completa:", reason, thrown ?? "");
    const base = { ...work };
    const parts = {};
    for (const k of Object.keys(EMBEDDED)) {
      if (Array.isArray(base[k]) && base[k].length) parts[k] = base[k];
      delete base[k];
    }
    try { scene = await Scene.create(base); } catch (e) { thrown = e; }
    if (!scene) throw new Error(reason || brief(thrown) || "o Foundry recusou os dados da cena (veja a mensagem em vermelho na tela)");
    warnings.push(`criada sem paredes, luzes etc. porque o Foundry recusou a cena completa (${reason || "motivo desconhecido"})`);
    for (const [k, docs] of Object.entries(parts)) {
      let made = [];
      try { made = await scene.createEmbeddedDocuments(EMBEDDED[k], docs, { keepId: true }); } catch (e) { console.warn(e); }
      if (made?.length) warnings.push(`"${k}": ${made.length} de ${docs.length} acrescentados depois`);
      else warnings.push(`não consegui acrescentar "${k}" (${docs.length})`);
    }
  }

  try {
    const level = scene.levels?.contents?.[0];
    if (level && backgroundPath && !level.background?.src) await level.update({ background: { src: backgroundPath } });
  } catch (e) { console.warn("Drive Maps | ajuste do fundo (v14)", e); }
  if (!work.thumb && backgroundPath && !/\.(webm|mp4|m4v|ogv)$/i.test(backgroundPath)) {
    try {
      const t = await scene.createThumbnail?.();
      if (t?.thumb) await scene.update({ thumb: t.thumb });
    } catch (e) { console.warn("Drive Maps | miniatura da cena", e); }
  }
  if (game.scenes && !game.scenes.get(scene.id)) warnings.push("a cena foi criada, mas não aparece na lista de cenas do mundo");
  return { scene, warnings };
}
