// Discord Rich Presence: arată în profilul Discord că utilizatorul e în launcher + tab-ul curent.
// Necesită aplicația Discord desktop pornită (comunică local, prin IPC). Dacă Discord nu rulează, reîncearcă din 15 în 15 secunde, fără erori vizibile.
// Se trimite doar numele tab-ului; nimic despre fișiere, căi sau cont.
let RPC = null;
try { RPC = require('discord-rpc'); } catch { /* modul lipsă: npm i discord-rpc */ }

const TABS = {
  home: 'RMS System Info', downloads: 'RMS Download', autoinstall: 'RMS Auto Install', optional: 'RMS Optional',
  about: 'RMS Actualizări', cache: 'FiveM Cache Cleaner', settings: 'Setări', mods: 'Dezinstalare Moduri', perf: 'RMS Performanță', fixes: 'RMS Fix-uri & Probleme'
};
// Linia de sus (details), în funcție de tab-ul deschis
const DETAILS = {
  home: 'Verifică performanța PC-ului', downloads: 'Descarcă pachetul RMS Graphics', autoinstall: 'Instalează RMS Graphics',
  optional: 'Explorează pachetele opționale', about: 'Citește noutățile și update-urile', cache: 'Curăță cache-ul FiveM', settings: 'Personalizează launcherul', mods: 'Gestionează modurile din FiveM', perf: 'Optimizează performanța PC-ului', fixes: 'Rezolvă probleme și fix-uri'
};
// Linia de jos (state), în funcție de rang
const RANKS = { ceo: '👑 C.E.O', admin: '🛡️ Admin', dev: '💻 Developer', beta: '🧪 RMS Beta Acces', member: '✨ RMS Graphics' };
const RANK_NAME = { ceo: 'C.E.O', admin: 'Admin', dev: 'Developer', beta: 'RMS Beta Acces', member: 'RMS Graphics' };
let cfg = null, client = null, ready = false, retry = null, push_t = null, stopped = false, getInfo = () => ({});
const startedAt = new Date();
let tab = 'home';
// Progresul live al unei instalări (RMS principal sau pachet opțional), alimentat din main.js (presenceFromPhase -> progress()).
// „prog” se ignoră automat dacă nu mai e proaspăt (peste 20 s) sau dacă nu mai suntem „busy”, ca să nu rămână un procent vechi agățat.
let prog = null;   // { kind, pct, etaSec, ts }
const PROGRESS_LABEL = { install: 'Instalează RMS Graphics', opt_install: 'Instalează pachet opțional', extract: 'Extrage arhiva RMS Graphics' };
function fmtEta(s) {
  if (!Number.isFinite(s) || s <= 0) return '';
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return m > 0 ? ' · ~' + m + 'm ' + r + 's rămase' : ' · ~' + r + 's rămase';
}
function progress(kind, info) {
  const pct = info && Number.isFinite(info.pct) ? Math.max(0, Math.min(100, info.pct)) : null;
  prog = pct === null ? null : { kind: String(kind || ''), pct, etaSec: info && Number.isFinite(info.etaSec) ? info.etaSec : null, ts: Date.now() };
  push();
}

// Fără butoane în Rich Presence (nu mai apare „Intră pe serverul RMS” / butonul de join către server).
function buttons() { return []; }
function activity() {
  let info = {}; try { info = getInfo() || {}; } catch {}
  const rank = RANKS[info.rank] ? info.rank : '';
  const live = info.busy && prog && Date.now() - prog.ts < 20000 ? prog : null;   // progres proaspăt, doar cât timp chiar instalează
  const details = live ? (PROGRESS_LABEL[live.kind] || 'Instalează RMS Graphics') + ' — ' + Math.round(live.pct) + '%' : (DETAILS[tab] || 'În launcher');
  const a = {
    details: details.slice(0, 128),
    state: (live ? '⏳ Instalare în curs…' + fmtEta(live.etaSec) : info.busy ? '⏳ Instalare în curs…' : RANKS[rank] ? RANKS[rank] + (info.name ? ' - ' + info.name : '') : 'RMS GRAPHICS · Premium Launcher').slice(0, 128),
    startTimestamp: startedAt,
    largeImageKey: cfg.RICH_PRESENCE_IMAGE || 'logo',
    largeImageText: ('RMS GRAPHICS Launcher' + (info.version ? ' · v' + info.version : '') + ' · Made by ' + (cfg.CREATOR || 'fNKje')).slice(0, 128),
    instance: false
  };
  const small = cfg.RICH_PRESENCE_SMALL && cfg.RICH_PRESENCE_SMALL[rank];
  if (small) { a.smallImageKey = String(small); a.smallImageText = RANK_NAME[rank]; }
  const bt = buttons(); if (bt.length) a.buttons = bt;
  return a;
}
let lastSend = 0, fails = 0, log = () => {};
let level = 0;   // 0 = complet, 1 = fără butoane, 2 = minim: dacă Discord refuză activitatea, coborâm treptat până când e acceptată
function send() {
  if (!ready || !client) return;
  lastSend = Date.now();
  const act = activity();
  if (level >= 1) delete act.buttons;
  if (level >= 2) { delete act.smallImageKey; delete act.smallImageText; delete act.largeImageText; }
  client.setActivity(act, process.pid).then(() => { fails = 0; log('Presence: trimis (nivel ' + level + ') → ' + (TABS[tab] || tab)); }).catch(e => {
    log('Presence: setActivity a eșuat (nivel ' + level + '): ' + String((e && e.message) || e).slice(0, 150));
    if (level < 2) { level++; clearTimeout(push_t); push_t = setTimeout(send, 1500); return; }   // reîncercăm imediat cu o variantă mai simplă
    if (++fails >= 3) { fails = 0; level = 0; drop(); schedule(); }          // conexiune „moartă": o refacem
  });
}
function push() {                                                // prima actualizare imediat, următoarele cel mult la ~4 s (limita Discord: 5 / 20 s)
  clearTimeout(push_t);
  const wait = Math.max(0, 4000 - (Date.now() - lastSend));
  push_t = setTimeout(send, wait);
}
let beat = null, wd = null;
function drop() { clearInterval(beat); clearTimeout(wd); ready = false; const c = client; client = null; try { c && c.destroy().catch(() => {}); } catch {} }
function schedule() { clearTimeout(retry); if (!stopped) retry = setTimeout(connect, 15000); }
function connect() {
  if (client || stopped || !RPC || !cfg || !/^\d{15,25}$/.test(String(cfg.CLIENT_ID || ''))) return;
  const c = new RPC.Client({ transport: 'ipc' }); client = c;
  level = 0;
  clearTimeout(wd); wd = setTimeout(() => { if (client === c && !ready) { log('Presence: conexiunea nu a răspuns în 25 s, reîncerc'); drop(); schedule(); } }, 25000);   // protecție dacă Discord nu răspunde la handshake
  c.on('ready', () => { clearTimeout(wd); ready = true; log('Presence: conectat la Discord'); push(); clearInterval(beat); beat = setInterval(send, 15000); });   // retrimite la 15 s: se autorepară dacă o actualizare s-a pierdut
  c.on('disconnected', () => { drop(); schedule(); });
  c.login({ clientId: String(cfg.CLIENT_ID) }).catch(e => { log('Presence: login eșuat: ' + String((e && e.message) || e).slice(0, 120)); drop(); schedule(); });
}
function init(config, logger, infoFn) {
  if (typeof logger === 'function') log = logger;
  if (!RPC) log('Presence: modulul discord-rpc LIPSEȘTE (npm i discord-rpc)'); cfg = config; if (typeof infoFn === 'function') getInfo = infoFn; if (typeof logger === 'function') log = logger; stopped = false; connect(); }
function setTab(t) { tab = String(t || 'home').slice(0, 30); log('Presence: tab primit → ' + tab + (ready ? '' : ' (încă neconectat)')); push(); }
function stop() { stopped = true; clearTimeout(retry); clearTimeout(push_t); clearInterval(beat); try { client && client.clearActivity().catch(() => {}); } catch {} drop(); }
module.exports = { init, setTab, stop, progress };