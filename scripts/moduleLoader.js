import { PIPELINE_VERSION, MAX_PACK_BYTES, MAX_THUMB_DOWNLOAD, MAX_BG_DOWNLOAD, THUMB_WIDTH } from "./config.js";
import { AuthError } from "./auth.js";
import { relativeToModule, isFolder } from "./drive.js";
import { scenesFromNedb, scenesFromLevel, fullScenesFromNedb, fullScenesFromLevel } from "./packs.js";

const RETRY_ERROR_MS = 10 * 60 * 1000;     // erro guardado há mais de 10 min é tentado de novo (o Drive pode ter sido corrigido)
const VIDEO_EXT = /\.(webm|mp4|m4v|ogv)$/i;
const mb = n => (n / 1048576).toFixed(0);
const thumbKey = (moduleKey, sceneId) => `${moduleKey}|${sceneId}`;
const byName = (a, b) => a.name.localeCompare(b.name, "pt-BR", { numeric: true, sensitivity: "base" });

export class SkippedError extends Error {
  constructor() { super("Skipped"); this.name = "SkippedError"; }
}
const rethrowable = e => e instanceof AuthError || e?.name === "AbortError" || e?.name === "SkippedError";

function createLimiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { fn, res, rej } = queue.shift();
    fn().then(res, rej).finally(() => { active--; next(); });
  };
  return fn => new Promise((res, rej) => { queue.push({ fn, res, rej }); next(); });
}

function dataUriToBlob(uri) {
  const [meta, b64] = uri.split(",");
  const type = /data:([^;]+)/.exec(meta)?.[1] ?? "image/webp";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** Reduz a imagem para uma miniatura leve. Se não der, devolve o original quando for pequeno. */
async function downscale(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, THUMB_WIDTH / bmp.width);
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    const out = await new Promise(res => canvas.toBlob(res, "image/webp", 0.82));
    return out ?? (blob.size <= MAX_THUMB_DOWNLOAD ? blob : null);
  } catch {
    return blob.size <= MAX_THUMB_DOWNLOAD ? blob : null;
  }
}

/**
 * Lê os packs de cada módulo no Drive e prepara as miniaturas das cenas.
 * Tudo que é lido fica guardado no navegador para não repetir o trabalho.
 */
export class ModuleLoader {
  constructor(store, tree, { concurrency = 3 } = {}) {
    this.store = store;
    this.tree = tree;
    this.limit = createLimiter(concurrency);
    this.jobs = new Map();
  }

  /** Executa só uma vez por chave; só começa se alguém ainda quiser o resultado. */
  _job(key, wanted, fn) {
    let job = this.jobs.get(key);
    if (job) {
      job.wanted.add(wanted ?? (() => true));
      return job.promise;
    }
    job = { wanted: new Set([wanted ?? (() => true)]), promise: null };
    this.jobs.set(key, job);
    job.promise = this.limit(async () => {
      if (![...job.wanted].some(w => w())) throw new SkippedError();
      return fn();
    });
    job.promise.then(() => this.jobs.delete(key), () => this.jobs.delete(key));
    return job.promise;
  }

  /* ---------- cenas do módulo ---------- */
  async loadScenes(record, { signal, wanted } = {}) {
    const cached = await this.store.getScenes(record.key);
    if (cached?.v === PIPELINE_VERSION && !(cached.error && Date.now() - cached.at > RETRY_ERROR_MS)) return cached;
    return this._job(`m:${record.key}`, wanted, () => this._readModule(record, signal));
  }

  async _readModule(record, signal) {
    if (!record.parent) throw new Error("pasta do módulo desconhecida");
    const found = [];
    const notes = [];
    for (const pack of record.packs) {
      const type = pack.type.toLowerCase();
      if (type !== "scene" && type !== "adventure") continue;
      try {
        found.push(...await this._readPack(record, pack, type, signal));
      } catch (e) {
        if (rethrowable(e)) throw e;
        notes.push(`${pack.label || pack.name}: ${e.message}`);
      }
    }

    const byId = new Map();
    for (const s of found) if (!byId.has(s.id)) byId.set(s.id, s);
    const scenes = [...byId.values()].sort(byName);

    for (const s of scenes) {                      // miniaturas que já vinham dentro do pack
      if (s.thumbData) {
        try { await this.store.putThumb(thumbKey(record.key, s.id), dataUriToBlob(s.thumbData)); s.thumbReady = true; }
        catch (e) { console.warn("Drive Maps | miniatura embutida", e); }
      }
    }

    const rec = {
      key: record.key,
      v: PIPELINE_VERSION,
      at: Date.now(),
      scenes: scenes.map(s => ({ id: s.id, name: s.name, thumbPath: s.thumbPath, bgPath: s.bgPath, thumbReady: !!s.thumbReady })),
      notes,
      error: scenes.length ? null : (notes[0] ?? "nenhuma cena encontrada nos packs")
    };
    await this.store.putScenes(rec);
    return rec;
  }

  async _readPack(record, pack, type, signal, full = false) {
    const rel = relativeToModule(pack.path, record.id);
    if (!rel) throw new Error("caminho do pack inválido");
    let node = await this.tree.resolve(record.parent, rel, { signal });
    if (!node) node = await this.tree.resolve(record.parent, `${rel}.db`, { signal });
    if (!node) throw new Error(`pack não encontrado no Drive (${pack.path})`);

    if (isFolder(node)) {
      const kids = (await this.tree.listChildren(node.id, { signal })).filter(k => /\.(ldb|sst|log)$/i.test(k.name));
      if (!kids.length) throw new Error("pasta do pack sem arquivos de dados");
      const total = kids.reduce((s, k) => s + (Number(k.size) || 0), 0);
      if (total > MAX_PACK_BYTES) throw new Error(`pack grande demais (${mb(total)} MB)`);
      const files = await Promise.all(kids.map(async k => ({
        name: k.name,
        bytes: new Uint8Array(await this.tree.downloadBytes(k.id, { signal }))
      })));
      return (full ? fullScenesFromLevel : scenesFromLevel)(files, type);
    }
    if (Number(node.size) > MAX_PACK_BYTES) throw new Error(`pack grande demais (${mb(node.size)} MB)`);
    return (full ? fullScenesFromNedb : scenesFromNedb)(await this.tree.downloadText(node.id, { signal }), type);
  }

  /** Lê de novo os packs e devolve as cenas completas pedidas: Map(id -> documento). */
  async readFullScenes(record, ids, { signal } = {}) {
    const want = new Set(ids);
    const got = new Map();
    for (const pack of record.packs) {
      const type = pack.type.toLowerCase();
      if (type !== "scene" && type !== "adventure") continue;
      for (const s of await this._readPack(record, pack, type, signal, true)) {
        if (want.has(s.id) && !got.has(s.id)) got.set(s.id, s.doc);
      }
      if (got.size === want.size) break;
    }
    return got;
  }

  /* ---------- miniaturas ---------- */
  /** Miniatura da primeira cena (em ordem alfabética) do módulo, para o cartão. */
  async cardThumb(record, opts = {}) {
    const sc = await this.loadScenes(record, opts);
    if (sc.error) return { error: sc.error };
    return this.sceneThumb(record, sc.scenes[0], opts);
  }

  /** Devolve { blob } ou { remoteUrl } ou { error }. */
  async sceneThumb(record, scene, { signal, wanted } = {}) {
    const id = thumbKey(record.key, scene.id);
    const hit = await this.store.getThumb(id);
    if (hit) return { blob: hit };
    const res = await this._job(`t:${id}`, wanted, () => this._fetchThumb(record, scene, signal));
    if (res.blob) await this.store.putThumb(id, res.blob).catch(e => console.warn("Drive Maps | guardar miniatura", e));
    return res;
  }

  async _fetchThumb(record, scene, signal) {
    const errors = [];
    const candidates = [];
    if (scene.thumbPath) candidates.push({ kind: "thumb", path: scene.thumbPath });
    if (scene.bgPath) candidates.push({ kind: "fundo", path: scene.bgPath });

    for (const c of candidates) {
      const rel = relativeToModule(c.path, record.id);
      if (!rel) { errors.push(`${c.kind}: caminho fora do módulo`); continue; }
      const node = await this.tree.resolve(record.parent, rel, { signal });
      if (!node) { errors.push(`${c.kind}: arquivo não encontrado no Drive`); continue; }

      const size = Number(node.size) || 0;
      const video = VIDEO_EXT.test(node.name);
      const download = async limit => {
        if (video || size > limit) return null;
        return downscale(await this.tree.downloadBlob(node.id, { signal }));
      };

      const steps = c.kind === "thumb"
        ? [() => download(MAX_THUMB_DOWNLOAD), () => this._drivePreview(node, signal), () => download(MAX_BG_DOWNLOAD)]
        : [() => this._drivePreview(node, signal), () => download(MAX_BG_DOWNLOAD)];

      for (const step of steps) {
        try {
          const out = await step();
          if (out?.blob || out?.remoteUrl) return out;
          if (out instanceof Blob) return { blob: out };
        } catch (e) {
          if (rethrowable(e)) throw e;
          errors.push(`${c.kind}: ${e.message}`);
        }
      }
      errors.push(`${c.kind}: sem prévia (${video ? "vídeo" : `${mb(size)} MB`})`);
    }
    return { error: errors.join("; ") || "a cena não tem imagem" };
  }

  /**
   * Prévia pequena gerada pelo próprio Google Drive, sem baixar o arquivo original.
   * O Google não permite ler essa imagem por código (CORS), então ela só é mostrada direto na tela.
   */
  async _drivePreview(node) {
    if (!node.thumbnailLink) return null;
    return { remoteUrl: node.thumbnailLink.replace(/=s\d+$/, "=s400") };
  }
}
