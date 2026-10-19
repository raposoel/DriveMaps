/*
 * Conversão de cenas do formato antigo (v9 e anteriores) para o formato atual.
 * São funções puras (sem Foundry), para poderem ser testadas com os módulos reais.
 */

/** Converte os campos soltos de grade, imagem, escuridão e névoa. Altera e devolve { doc, notes }. */
export function normalizeScene(d) {
  const notes = [];

  // grade: antes era um número solto (grid: 140) com gridType, gridColor etc. ao lado
  if (typeof d.grid === "number") {
    const grid = { size: d.grid };
    const map = { gridType: "type", gridColor: "color", gridAlpha: "alpha", gridDistance: "distance", gridUnits: "units" };
    for (const [old, now] of Object.entries(map)) if (d[old] != null) grid[now] = d[old];
    d.grid = grid;
  }
  for (const k of ["gridType", "gridColor", "gridAlpha", "gridDistance", "gridUnits"]) delete d[k];

  // imagem de fundo: img -> background.src
  if (typeof d.img === "string" && d.img && !d.background?.src) d.background = { ...(d.background ?? {}), src: d.img };
  delete d.img;

  // escuridão e luz global -> environment
  const envKeys = ["darkness", "globalLight", "globalLightThreshold"].filter(k => k in d);
  if (envKeys.length) {
    const env = { ...(d.environment ?? {}) };
    if (typeof d.darkness === "number" && env.darknessLevel === undefined) env.darknessLevel = d.darkness;
    if (typeof d.globalLight === "boolean" || "globalLightThreshold" in d) {
      const gl = { ...(env.globalLight ?? {}) };
      if (typeof d.globalLight === "boolean" && gl.enabled === undefined) gl.enabled = d.globalLight;
      if (!gl.darkness) gl.darkness = { min: 0, max: typeof d.globalLightThreshold === "number" ? d.globalLightThreshold : 1 };
      env.globalLight = gl;
    }
    d.environment = env;
    for (const k of envKeys) delete d[k];
  }

  // névoa -> fog
  const fogMap = { fogExploration: ["exploration"], fogReset: ["reset"], fogOverlay: ["overlay"],
    fogExploredColor: ["colors", "explored"], fogUnexploredColor: ["colors", "unexplored"] };
  if (Object.keys(fogMap).some(k => k in d)) {
    const fog = { ...(d.fog ?? {}), colors: { ...(d.fog?.colors ?? {}) } };
    for (const [old, path] of Object.entries(fogMap)) {
      if (!(old in d)) continue;
      if (path.length === 1) { if (fog[path[0]] === undefined) fog[path[0]] = d[old]; }
      else if (fog.colors[path[1]] === undefined) fog.colors[path[1]] = d[old];
      delete d[old];
    }
    d.fog = fog;
  }

  if ((d.shiftX || d.shiftY)) notes.push("a cena tem deslocamento de grade (shiftX/shiftY), que não foi convertido");
  delete d.shiftX; delete d.shiftY;
  delete d.permission;                 // v9: permission (o atual é ownership)
  return { doc: d, notes };
}

/** Luz no formato mais antigo (dim, bright, tintColor...) -> formato atual (config). */
export function normalizeLight(l) {
  if (l.config || !("dim" in l || "bright" in l || "tintColor" in l)) return l;
  const { t, dim, bright, angle, tintColor, tintAlpha, lightAnimation, darknessThreshold, darkness, ...rest } = l;
  return {
    ...rest,
    walls: t !== "u",
    vision: false,
    config: {
      dim: dim ?? 0, bright: bright ?? 0, angle: angle ?? 360,
      color: tintColor ?? null, alpha: tintAlpha ?? 0.5,
      animation: lightAnimation ?? { type: null, speed: 5, intensity: 5, reverse: false },
      darkness: { min: darknessThreshold ?? 0, max: 1 },
      coloration: 1, luminosity: 0.5, gradual: true, saturation: 0, contrast: 0, shadows: 0
    }
  };
}

export function normalizeLights(lights) {
  let fixed = 0;
  const out = lights.map(l => { const n = normalizeLight(l); if (n !== l) fixed++; return n; });
  return { lights: out, fixed };
}
