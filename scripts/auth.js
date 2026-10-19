import { BRIDGE_URL, BRIDGE_ORIGIN } from "./config.js";

/* O acesso fica só na memória. Vale cerca de 1 hora. */
let token = null;
let tokenExp = 0;

export class AuthError extends Error {
  constructor() { super("AUTH"); this.name = "AuthError"; }
}

/* crypto.randomUUID() só existe em https/localhost; getRandomValues funciona em qualquer endereço. */
function randomState() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

export const isConnected = () => !!token && Date.now() < tokenExp;

export function getToken() {
  if (!isConnected()) { token = null; throw new AuthError(); }
  return token;
}

export function markExpired() { token = null; }

/**
 * Abre a página-ponte numa janela e espera o Google entregar o acesso.
 * IMPORTANTE: precisa ser chamada direto de um clique, sem "await" antes,
 * senão o navegador bloqueia a janela.
 */
export function connect() {
  return new Promise((resolve, reject) => {
    const state = randomState();
    const url = `${BRIDGE_URL}?origin=${encodeURIComponent(location.origin)}&state=${state}`;
    const popup = window.open(url, "drive-maps-login", "width=520,height=660");
    if (!popup) {
      reject(new Error("O navegador bloqueou a janela de login. Permita pop-ups para este endereço e tente de novo."));
      return;
    }

    let finished = false;
    const finish = (fn, value) => {
      if (finished) return;
      finished = true;
      window.removeEventListener("message", onMessage);
      clearInterval(timer);
      fn(value);
    };

    const onMessage = ev => {
      if (ev.origin !== BRIDGE_ORIGIN) return;
      const d = ev.data;
      if (!d || d.source !== "drive-maps-bridge" || d.state !== state) return;
      if (d.error) return finish(reject, new Error(d.error));
      token = d.access_token;
      tokenExp = Date.now() + (Number(d.expires_in) - 60) * 1000;
      finish(resolve, token);
    };
    window.addEventListener("message", onMessage);

    const timer = setInterval(() => {
      if (popup.closed) finish(reject, new Error("popup_closed"));
    }, 600);
  });
}

export function friendlyError(e) {
  const m = String(e?.message ?? e);
  if (m === "AUTH") return "A sessão do Google expirou. Clique em Conectar.";
  if (m.includes("popup_closed")) return "A janela de login foi fechada antes de terminar.";
  if (m.includes("popup_failed_to_open")) return "O navegador bloqueou a janela de login. Permita pop-ups e tente de novo.";
  if (m.includes("access_denied")) return "O Google negou o acesso. O seu e-mail está na lista de usuários de teste?";
  return m;
}
