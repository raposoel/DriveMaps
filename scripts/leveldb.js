/*
 * Leitor mínimo de LevelDB (o formato dos packs novos do Foundry), para rodar no navegador.
 * Lê arquivos .ldb/.sst (tabelas) e .log (registro recente) e junta tudo,
 * ficando sempre com a versão mais nova de cada chave.
 */
const td = new TextDecoder();

function varint(b, i) {
  let r = 0, mul = 1, c;
  do { c = b[i++]; r += (c & 0x7f) * mul; mul *= 128; } while (c & 0x80);
  return [r, i];
}

export function snappyDecompress(src) {
  let [len, i] = varint(src, 0);
  const out = new Uint8Array(len);
  let o = 0;
  while (i < src.length) {
    const tag = src[i++];
    const kind = tag & 3;
    if (kind === 0) {
      let l = tag >> 2;
      if (l < 60) l += 1;
      else {
        const nb = l - 59;
        l = 0;
        for (let k = 0; k < nb; k++) l += src[i + k] * 2 ** (8 * k);
        l += 1; i += nb;
      }
      out.set(src.subarray(i, i + l), o); i += l; o += l;
    } else {
      let l, off;
      if (kind === 1) { l = ((tag >> 2) & 7) + 4; off = ((tag >> 5) << 8) | src[i++]; }
      else if (kind === 2) { l = (tag >> 2) + 1; off = src[i] | (src[i + 1] << 8); i += 2; }
      else { l = (tag >> 2) + 1; off = (src[i] | (src[i + 1] << 8) | (src[i + 2] << 16) | (src[i + 3] << 24)) >>> 0; i += 4; }
      if (off === 0 || off > o) throw new Error("Snappy: referência inválida");
      if (off >= l) { out.copyWithin(o, o - off, o - off + l); o += l; }
      else for (let k = 0; k < l; k++, o++) out[o] = out[o - off];
    }
  }
  if (o !== len) throw new Error("Snappy: tamanho inesperado");
  return out;
}

function* blockEntries(blk) {
  const dv = new DataView(blk.buffer, blk.byteOffset, blk.byteLength);
  const nRestarts = dv.getUint32(blk.length - 4, true);
  const end = blk.length - 4 - 4 * nRestarts;
  let i = 0;
  let key = new Uint8Array(0);
  while (i < end) {
    let shared, nonShared, vlen;
    [shared, i] = varint(blk, i);
    [nonShared, i] = varint(blk, i);
    [vlen, i] = varint(blk, i);
    const nk = new Uint8Array(shared + nonShared);
    nk.set(key.subarray(0, shared));
    nk.set(blk.subarray(i, i + nonShared), shared);
    key = nk; i += nonShared;
    yield [key, blk.subarray(i, i + vlen)];
    i += vlen;
  }
}

function readBlock(bytes, off, size) {
  const raw = bytes.subarray(off, off + size);
  const ctype = bytes[off + size];
  if (ctype === 0) return raw;
  if (ctype === 1) return snappyDecompress(raw);
  throw new Error(`Compressão de bloco não suportada (${ctype})`);
}

const MAGIC = [0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb];

/** Lê um arquivo de tabela (.ldb / .sst). */
export function readTable(bytes) {
  if (bytes.length < 48) throw new Error("Arquivo de tabela pequeno demais");
  const f = bytes.length - 48;
  for (let k = 0; k < 8; k++) if (bytes[bytes.length - 8 + k] !== MAGIC[k]) throw new Error("Não é um arquivo LevelDB");
  let i = f, io, isz;
  [, i] = varint(bytes, i);
  [, i] = varint(bytes, i);
  [io, i] = varint(bytes, i);
  [isz, i] = varint(bytes, i);

  const out = [];
  for (const [, handle] of blockEntries(readBlock(bytes, io, isz))) {
    const [off, j] = varint(handle, 0);
    const [size] = varint(handle, j);
    for (const [ik, v] of blockEntries(readBlock(bytes, off, size))) {
      const n = ik.length - 8;
      const dv = new DataView(ik.buffer, ik.byteOffset + n, 8);
      const lo = dv.getUint32(0, true), hi = dv.getUint32(4, true);
      out.push({
        key: td.decode(ik.subarray(0, n)),
        seq: (lo >>> 8) + hi * 2 ** 24,
        type: lo & 0xff,          // 1 = valor, 0 = apagado
        value: (lo & 0xff) === 1 ? v : null
      });
    }
  }
  return out;
}

function parseBatch(b, out) {
  if (b.length < 12) return;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const seq = dv.getUint32(0, true) + dv.getUint32(4, true) * 2 ** 32;
  const count = dv.getUint32(8, true);
  let i = 12;
  for (let n = 0; n < count && i < b.length; n++) {
    const tag = b[i++];
    let kl;
    [kl, i] = varint(b, i);
    const key = td.decode(b.subarray(i, i + kl)); i += kl;
    if (tag === 1) {
      let vl;
      [vl, i] = varint(b, i);
      out.push({ key, seq: seq + n, type: 1, value: b.subarray(i, i + vl) }); i += vl;
    } else out.push({ key, seq: seq + n, type: 0, value: null });
  }
}

const concat = parts => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

/** Lê um arquivo de registro (.log), que guarda as gravações mais recentes. */
export function readLog(bytes) {
  const out = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0, frag = null;
  while (pos + 7 <= bytes.length) {
    const left = 32768 - (pos % 32768);
    if (left < 7) { pos += left; continue; }
    const len = dv.getUint16(pos + 4, true);
    const type = bytes[pos + 6];
    if (type === 0 && len === 0) { pos += left; continue; }
    if (pos + 7 + len > bytes.length) break;            // gravação cortada no fim: ignora
    const data = bytes.subarray(pos + 7, pos + 7 + len);
    pos += 7 + len;
    if (type === 1) { parseBatch(data, out); frag = null; }
    else if (type === 2) frag = [data];
    else if (type === 3) frag?.push(data);
    else if (type === 4 && frag) { frag.push(data); parseBatch(concat(frag), out); frag = null; }
  }
  return out;
}

/** Junta as entradas de vários arquivos: vale a de maior número de sequência; apagadas somem. */
export function mergeEntries(entries) {
  const best = new Map();
  for (const e of entries) {
    const cur = best.get(e.key);
    if (!cur || e.seq > cur.seq) best.set(e.key, e);
  }
  const live = new Map();
  for (const [k, e] of best) if (e.type === 1) live.set(k, e.value);
  return live;
}

/** files: [{ name, bytes }]  ->  Map(chave -> bytes do valor) */
export function readLevelDb(files) {
  const entries = [];
  for (const f of files) {
    if (/\.log$/i.test(f.name)) entries.push(...readLog(f.bytes));
    else if (/\.(ldb|sst)$/i.test(f.name)) entries.push(...readTable(f.bytes));
  }
  return mergeEntries(entries);
}
