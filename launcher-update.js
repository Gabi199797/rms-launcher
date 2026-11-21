// Actualizarea launcherului prin electron-updater (GitHub Releases), cu banner în interfață.
// Flux: la pornire se verifică; dacă există versiune nouă, utilizatorul e ÎNTREBAT (Descarcă / Mai târziu) -> descărcare cu progres -> cât timp nu rulează
// o descărcare/instalare de pachet, pornește un numărător de 10 s -> se instalează silențios și launcherul repornește.
// - „Repornește acum” sare peste numărătoare; „Mai târziu” amână instalarea până la următoarea închidere a launcherului.
// - dacă manifestul online (gist) conține "minLauncherVersion" mai mare decât versiunea instalată, actualizarea e OBLIGATORIE (fără „Mai târziu”).
// Merge doar în aplicația instalată (NSIS), nu în `npm start` și nu în varianta portable.
const { app, ipcMain } = require('electron');

let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch { /* modulul lipsește: npm i electron-updater */ }

let ctx = { getWin: () => null, isBusy: () => false, getMin: () => '' };
let ready = false, checking = false, downloading = false, downloaded = false, installing = false;
let timer = null, version = '', lastPct = -1, state = null, dismissed = false;
let log = () => {};   // setat din init() (c.log); dacă lipsește, erorile de verificare tot nu se văd nicăieri — mai bine să fie mereu dat

const parse = v => String(v || '0').split('.').map(n => parseInt(n, 10) || 0);
function isOlder(a, b) {            // true dacă a < b
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); }
  return false;
}
const forced = () => { const m = ctx.getMin(); return !!m && isOlder(app.getVersion(), m); };
const base = () => ({ version, current: app.getVersion(), forced: forced() });
const send = s => {
  state = s;
  const w = ctx.getWin();
  if (w && !w.isDestroyed()) { try { w.webContents.send('launcher-update', s); } catch {} }
};
const progress = p => { const w = ctx.getWin(); if (w && !w.isDestroyed()) { try { w.setProgressBar(p); } catch {} } };

// mesajul arătat în fereastra de update: fără linkuri (GitHub/URL-uri) — detaliile complete rămân doar în log
function safeMsg(err) {
  const raw = String((err && err.message) || err || '');
  const st = /status\s*(?:code)?\s*[:=]?\s*(\d{3})/i.exec(raw) || /\bHTTP\s*(\d{3})/i.exec(raw);
  const clean = raw.replace(/https?:\/\/\S+/gi, '').replace(/\bCannot download\s*""?[,:]?/i, '').replace(/[\s"“”:,]+$/g, '').replace(/\s+/g, ' ').trim();
  if (st) return 'Cod eroare: ' + st[1];
  return clean.slice(0, 120);
}

function startDownload() {
  if (downloading || downloaded) return;
  downloading = true; lastPct = -1;
  send({ ...base(), state: 'downloading', percent: 0 });
  autoUpdater.downloadUpdate().catch(err => {
    downloading = false; progress(-1);
    try { log('LauncherUpdate: descărcare eșuată: ' + String((err && err.message) || err).slice(0, 300)); } catch {}
    send({ ...base(), state: 'error', message: safeMsg(err) });
  });
}

function installNow() {
  if (installing || !downloaded) return;
  installing = true; clearInterval(timer);
  send({ ...base(), state: 'installing' });
  setTimeout(() => { try { autoUpdater.quitAndInstall(true, true); } catch { installing = false; } }, 400);   // instalare silențioasă + repornire
}

function countdown() {
  clearInterval(timer);
  let left = 10;
  const tick = () => {
    if (ctx.isBusy()) { left = 10; send({ ...base(), state: 'waiting' }); return; }   // nu întrerupem un pachet în lucru
    send({ ...base(), state: 'ready', seconds: left });
    if (left-- <= 0) installNow();
  };
  tick();
  timer = setInterval(tick, 1000);
}

function later() {
  if (forced() || installing) return;
  clearInterval(timer);
  dismissed = true;
  if (downloaded) autoUpdater.autoInstallOnAppQuit = true;     // deja descărcată: se instalează la următoarea închidere
  send({ ...base(), state: 'later' });
}

ipcMain.handle('app-version', () => app.getVersion());
ipcMain.handle('launcher-update-state', () => state);
ipcMain.on('launcher-update-download', () => { if (ready && autoUpdater && !downloaded) startDownload(); });
ipcMain.on('launcher-update-now', () => { installNow(); });
ipcMain.on('launcher-update-later', () => { later(); });
ipcMain.on('launcher-update-retry', () => { downloading = false; checking = false; check(); });

function init(c) {
  ctx = { ...ctx, ...c };
  if (typeof c.log === 'function') log = c.log;
  if (ready || !autoUpdater || !app.isPackaged || process.env.PORTABLE_EXECUTABLE_FILE) {
    log('LauncherUpdate: dezactivat (' + (!autoUpdater ? 'modul electron-updater lipsă' : !app.isPackaged ? 'nu rulează ca aplicație instalată (npm start / dev)' : process.env.PORTABLE_EXECUTABLE_FILE ? 'variantă portable' : 'deja inițializat') + ')');
    return;
  }
  ready = true;
  autoUpdater.autoDownload = false;            // pornim noi descărcarea, doar când nu rulează un pachet
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => log('LauncherUpdate: verific GitHub Releases pentru o versiune nouă…'));
  autoUpdater.on('update-not-available', info => log('LauncherUpdate: nicio versiune nouă (curent ' + app.getVersion() + ', ultima publicată ' + (info && info.version) + ')'));
  autoUpdater.on('update-available', info => {
    version = info.version;
    log('LauncherUpdate: versiune nouă găsită → v' + info.version);
    if (downloading || downloaded) return;
    if (dismissed && !forced()) return;            // a ales „Mai târziu”: nu mai întrebăm până la următoarea pornire
    send({ ...base(), state: 'available', busy: !!ctx.isBusy() });   // întrebăm utilizatorul; descărcarea pornește doar la „Descarcă”
  });
  autoUpdater.on('download-progress', p => {
    const pct = Math.max(0, Math.min(100, Math.round(p.percent || 0)));
    progress(pct / 100);
    if (pct !== lastPct || true) { lastPct = pct; send({ ...base(), state: 'downloading', percent: pct, transferred: p.transferred || 0, total: p.total || 0, bps: p.bytesPerSecond || 0 }); }
  });
  autoUpdater.on('update-downloaded', () => { downloading = false; downloaded = true; progress(-1); countdown(); });
  autoUpdater.on('error', err => {
    // înainte: erorile din afara unei descărcări active erau înghițite complet, fără niciun semn — dacă verificarea
    // propriu-zisă eșua (ex. latest.yml lipsă/corupt pe release-ul publicat pe GitHub, release marcat draft/prerelease,
    // 404 etc.), launcherul rămânea pur și simplu tăcut, fără buton de update și fără nicio urmă în log.
    log('LauncherUpdate: eroare (' + (downloading ? 'descărcare' : 'verificare') + '): ' + String((err && err.message) || err).slice(0, 300));
    if (downloading) { downloading = false; progress(-1); send({ ...base(), state: 'error', message: safeMsg(err) }); }
  });
}

function check() {
  if (!ready || checking || downloading || downloaded || ctx.isBusy()) return;
  checking = true;
  Promise.resolve(autoUpdater.checkForUpdates())
    .catch(err => log('LauncherUpdate: checkForUpdates() a eșuat: ' + String((err && err.message) || err).slice(0, 300)))
    .finally(() => { checking = false; });
}

module.exports = { init, check };