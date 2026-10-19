import { getToken, markExpired, AuthError } from "./auth.js";

const API = "https://www.googleapis.com/drive/v3";
const sleep = ms => new Promise(r => setTimeout(r, ms));

export class DriveError extends Error {
  constructor(status, reason) {
    super(`O Drive respondeu com erro ${status}${reason ? ` (${reason})` : ""}.`);
    this.name = "DriveError";
    this.status = status;
  }
}

/** fetch no Drive com o acesso do usuário. Tenta de novo se o Google pedir calma. */
export async function gfetch(url, { signal, retries = 5 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const token = getToken();
    let r;
    try {
      r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal });
    } catch (e) {
      if (e.name === "AbortError") throw e;
      if (attempt >= retries) throw new Error("Falha de rede ao falar com o Drive.");
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (r.ok) return r;
    if (r.status === 401) { markExpired(); throw new AuthError(); }

    let reason = "";
    try { reason = (await r.clone().json())?.error?.errors?.[0]?.reason ?? ""; } catch { /* sem corpo */ }
    const retryable = r.status === 429 || r.status >= 500
      || (r.status === 403 && /rateLimit|quota/i.test(reason));
    if (retryable && attempt < retries) {
      await sleep(Math.min(8000, 700 * 2 ** attempt) + Math.random() * 300);
      continue;
    }
    throw new DriveError(r.status, reason);
  }
}

export async function getUser() {
  const r = await gfetch(`${API}/about?fields=user(emailAddress,displayName)`);
  return (await r.json()).user;
}

/** Todos os arquivos chamados module.json que o usuário enxerga (inclusive nas pastas compartilhadas). */
export async function listModuleJsons({ signal, onPage } = {}) {
  const out = [];
  let pageToken = null;
  do {
    const p = new URLSearchParams({
      q: "name = 'module.json' and trashed = false",
      pageSize: "1000",
      fields: "nextPageToken,files(id,md5Checksum,parents)",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      corpora: "allDrives"
    });
    if (pageToken) p.set("pageToken", pageToken);
    const data = await (await gfetch(`${API}/files?${p}`, { signal })).json();
    out.push(...(data.files ?? []));
    pageToken = data.nextPageToken ?? null;
    onPage?.(out.length);
  } while (pageToken);
  return out;
}

export async function getText(fileId, { signal } = {}) {
  const r = await gfetch(`${API}/files/${fileId}?alt=media&supportsAllDrives=true`, { signal });
  return r.text();
}

/* ---------- Navegação por pastas ---------- */
export const FOLDER = "application/vnd.google-apps.folder";
export const isFolder = n => n?.mimeType === FOLDER;
const safeDecode = s => { try { return decodeURIComponent(s); } catch { return s; } };

/** Caminho de um arquivo do módulo ("modules/<id>/maps/x.jpg") -> caminho dentro da pasta do módulo ("maps/x.jpg"). */
export function relativeToModule(path, moduleId) {
  let p = String(path ?? "").split(/[?#]/)[0].replace(/\\/g, "/").replace(/^\.?\//, "");
  if (!p || /^(https?:|data:)/i.test(p)) return null;
  const prefix = `modules/${moduleId}/`;
  if (p.toLowerCase().startsWith(prefix.toLowerCase())) return p.slice(prefix.length);
  if (/^(modules|worlds|systems)\//i.test(p)) return null;     // aponta para fora do módulo
  return p;
}

const pickByName = (kids, seg) => {
  const names = [seg, safeDecode(seg)];
  for (const n of names) { const k = kids.find(x => x.name === n); if (k) return k; }
  const low = names.map(n => n.toLowerCase());
  return kids.find(x => low.includes(x.name.toLowerCase())) ?? null;
};

export class DriveTree {
  constructor() { this.cache = new Map(); }

  /** Conteúdo de uma pasta (guardado em memória durante a sessão). */
  listChildren(id, { signal } = {}) {
    let p = this.cache.get(id);
    if (!p) {
      p = this._fetchChildren(id, signal);
      this.cache.set(id, p);
      p.catch(() => this.cache.delete(id));
    }
    return p;
  }

  async _fetchChildren(id, signal) {
    const out = [];
    let pageToken = null;
    do {
      const p = new URLSearchParams({
        q: `'${id}' in parents and trashed = false`,
        pageSize: "1000",
        fields: "nextPageToken,files(id,name,mimeType,size,thumbnailLink)",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
        corpora: "allDrives"
      });
      if (pageToken) p.set("pageToken", pageToken);
      const data = await (await gfetch(`${API}/files?${p}`, { signal })).json();
      out.push(...(data.files ?? []));
      pageToken = data.nextPageToken ?? null;
    } while (pageToken);
    return out;
  }

  /** Acha um arquivo ou pasta pelo caminho a partir de uma pasta. Devolve null se não existir. */
  async resolve(rootId, relPath, { signal } = {}) {
    let node = { id: rootId, mimeType: FOLDER };
    for (const seg of String(relPath).split("/").filter(s => s && s !== ".")) {
      if (!isFolder(node)) return null;
      node = pickByName(await this.listChildren(node.id, { signal }), seg);
      if (!node) return null;
    }
    return node;
  }

  async folderName(id, { signal } = {}) {
    const r = await gfetch(`${API}/files/${id}?fields=name&supportsAllDrives=true`, { signal });
    return (await r.json()).name ?? null;
  }

  async downloadBytes(id, { signal } = {}) {
    return (await gfetch(`${API}/files/${id}?alt=media&supportsAllDrives=true`, { signal })).arrayBuffer();
  }
  async downloadText(id, { signal } = {}) {
    return (await gfetch(`${API}/files/${id}?alt=media&supportsAllDrives=true`, { signal })).text();
  }
  async downloadBlob(id, { signal } = {}) {
    return (await gfetch(`${API}/files/${id}?alt=media&supportsAllDrives=true`, { signal })).blob();
  }
}
