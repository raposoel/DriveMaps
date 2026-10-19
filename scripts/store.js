/*
 * Onde os dados ficam guardados: no navegador (IndexedDB), um banco por conta Google.
 * Só este arquivo conhece o armazenamento. Para trocar por arquivos no Foundry
 * (opções A ou B), basta reescrever esta classe com os mesmos métodos.
 *
 *  modules : índice dos module.json (Etapa 1)
 *  scenes  : lista de cenas de cada módulo, sem as imagens (Etapa 2)
 *  thumbs  : miniaturas pequenas (Etapa 2)
 */
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = tx => new Promise((res, rej) => {
  tx.oncomplete = () => res();
  tx.onerror = () => rej(tx.error);
  tx.onabort = () => rej(tx.error);
});

export class Store {
  constructor(db) { this.db = db; }

  static async open(account) {
    const open = indexedDB.open(`drive-maps:${account}`, 2);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains("modules")) db.createObjectStore("modules", { keyPath: "key" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      if (!db.objectStoreNames.contains("scenes")) db.createObjectStore("scenes", { keyPath: "key" });
      if (!db.objectStoreNames.contains("thumbs")) db.createObjectStore("thumbs");
    };
    return new Store(await req(open));
  }

  _put(store, value, key) {
    const tx = this.db.transaction(store, "readwrite");
    tx.objectStore(store).put(value, ...(key === undefined ? [] : [key]));
    return done(tx);
  }

  /* índice de módulos */
  all() { return req(this.db.transaction("modules").objectStore("modules").getAll()); }
  put(rec) { return this._put("modules", rec); }
  delete(key) {
    const tx = this.db.transaction("modules", "readwrite");
    tx.objectStore("modules").delete(key);
    return done(tx);
  }
  getMeta(k) { return req(this.db.transaction("meta").objectStore("meta").get(k)); }
  setMeta(k, v) { return this._put("meta", v, k); }

  /* cenas e miniaturas */
  getScenes(key) { return req(this.db.transaction("scenes").objectStore("scenes").get(key)); }
  putScenes(rec) { return this._put("scenes", rec); }
  deleteScenes(key) {
    const tx = this.db.transaction("scenes", "readwrite");
    tx.objectStore("scenes").delete(key);
    return done(tx);
  }
  getThumb(id) { return req(this.db.transaction("thumbs").objectStore("thumbs").get(id)); }
  putThumb(id, blob) { return this._put("thumbs", blob, id); }

  clearDerived() {
    const tx = this.db.transaction(["scenes", "thumbs"], "readwrite");
    tx.objectStore("scenes").clear();
    tx.objectStore("thumbs").clear();
    return done(tx);
  }

  clear() {
    const tx = this.db.transaction(["modules", "meta", "scenes", "thumbs"], "readwrite");
    for (const s of ["modules", "meta", "scenes", "thumbs"]) tx.objectStore(s).clear();
    return done(tx);
  }

  close() { this.db.close(); }
}
