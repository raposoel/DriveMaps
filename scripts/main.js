import { MODULE_ID } from "./config.js";
import { DriveMapsApp } from "./app.js";

let app = null;
const getApp = () => (app ??= new DriveMapsApp());
const open = () => getApp().render({ force: true });

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "lastAccount", {
    scope: "client", config: false, type: String, default: ""
  });
});

Hooks.once("ready", () => {
  game.modules.get(MODULE_ID).api = {
    open,
    /** Auditoria dos módulos do índice. Ex.: await game.modules.get("drive-maps").api.audit({ modo: "rapida" }) */
    audit: opts => getApp().audit(opts),
    auditCancel: () => app?.auditCancel(),
    auditUltima: modo => getApp().auditLast(modo)
  };
});

Hooks.on("renderSceneDirectory", (directory, html) => {
  if (!game.user.isGM) return;
  const el = html instanceof HTMLElement ? html : html?.[0];
  if (!el || el.querySelector(".dms-open")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "dms-open";
  btn.innerHTML = `<i class="fa-brands fa-google-drive"></i> Drive Maps`;
  btn.addEventListener("click", open);
  (el.querySelector(".header-actions") ?? el.querySelector("header"))?.append(btn);
});
