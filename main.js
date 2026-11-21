const { app, BrowserWindow, ipcMain, shell, safeStorage, dialog, clipboard, screen, net, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { Transform } = require('stream');
const { Worker } = require('worker_threads');
const { execFile } = require('child_process');
const { pipeline } = require('stream/promises');
const presence = require('./discord-presence');
// Pornește un worker din conținutul unui fișier (citit prin fs, deci merge și când main.js rulează
// din interiorul app.asar), nu dintr-un fișier real de pe disc: fișierul de worker nu mai trebuie
// scos din asar (asarUnpack), deci nu rămâne ca fișier .js vizibil separat după instalare.
function spawnWorkerFromFile(relFile, workerData) {
  const src = fs.readFileSync(path.join(__dirname, relFile), 'utf8');
  return new Worker(src, { eval: true, workerData });
}
// Alimentează Discord Rich Presence cu progresul real al unei instalări/extrageri (procent + timp rămas estimat),
// pornind de la aceleași obiecte „d” trimise deja către interfață (phase: 'download' | 'extract' | 'finalize').
// Nu schimbă ce vede userul în launcher — doar oglindește, opțional, aceleași numere și în profilul Discord.
function presenceFromPhase(kind, d) {
  try {
    if (!d || !d.phase) return;
    if (d.phase === 'download') {
      const total = Number(d.total) || 0, recv = Number(d.received) || 0, speed = Number(d.speed) || 0;
      presence.progress(kind, { pct: total > 0 ? (recv / total) * 100 : null, etaSec: speed > 0 && total > recv ? (total - recv) / speed : null });
    } else if (d.phase === 'extract') {
      const total = Number(d.total) || 0, done = Number(d.done) || 0;
      presence.progress(kind === 'download' ? 'extract' : kind, { pct: total > 0 ? (done / total) * 100 : null, etaSec: null });
    } else if (d.phase === 'finalize') {
      presence.progress(kind, { pct: 100, etaSec: null });
    }
  } catch {}
}
const launcherUpdate = require('./launcher-update');
// linkurile Google Drive nu apar în clar nicăieri în cod: stau criptate (AES-256-GCM, ca și parola arhivei) și se
// decriptează doar în memorie, în procesul principal — oricine deschide sursa launcherului nu le poate citi direct.
function embeddedUrl(blob) {
  try {
    const key = crypto.createHash('sha256').update('rms.gfx/url/v1').digest();
    const b = Buffer.from(blob, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch { return ''; }
}
const cfg = { ...require('./config') };   // copie modificabilă: valorile pot fi suprascrise de manifestul online
if (cfg.PACK_URL_BLOB) cfg.PACK_URL = embeddedUrl(cfg.PACK_URL_BLOB) || cfg.PACK_URL || '';   // linkul principal (RMS GRAPHICS), decriptat din config.js — Google Drive / MediaFire / orice link direct https, nu mai e specific MEGA

// pornit automat de Windows la login (vezi setAutostart mai jos): fără fereastră, doar verificarea anti-deblocare + alertele Discord continuă
const WATCHDOG = process.argv.includes('--rms-watchdog');

// Evită erorile Chromium „Unable to move/create cache” / „Gpu Cache Creation failed”: cache-ul HTTP merge în %TEMP%, iar cache-ul de shadere GPU de pe disc e oprit.
// (nu atinge userData, deci setările și datele salvate rămân neschimbate)
app.commandLine.appendSwitch('disk-cache-dir', path.join(os.tmpdir(), 'rms-launcher-cache'));
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
// watchdog-ul (fără fereastră, pornit automat după instalare) nu desenează NIMIC — dar fiind tot un proces Electron,
// pornește oricum motorul Chromium/GPU, care folosește ACELAȘI folder de cache GPU (userData) ca și launcherul cu
// fereastră, dacă rulează amândouă în același timp. Rezultatul: „Failed to open persistent cache files ... used by
// another process” spamat în consolă, de câte ori cele 2 procese se calcă pe picioare pe același fișier de cache
// GPUPersistentCache\DawnGraphiteCache. Soluție: oprim accelerarea hardware complet pentru procesul watchdog — nu
// are niciodată nevoie de ea, deci nu mai atinge deloc acel cache.
if (WATCHDOG) app.disableHardwareAcceleration();

const API = 'https://discord.com/api/v10';
let win;
let cachedGuildId = cfg.GUILD_ID || null;
let cachedUser = null;

/* ---------------- Manifest online (GitHub): link arhivă / dată / versiune fără build nou ---------------- */
// rms-pack.json: { "version": 2, "updateDate": "20.10.2026", "packUrl": "https://drive.usercontent.google.com/download?id=...", "sizeGb": 6, "filename": "RMS_GRAPHICS.rar", "password": "..." }
// ("megaUrl" rămâne acceptat ca alias vechi, pentru manifeste online mai vechi care încă folosesc acel nume de câmp)
// Toate câmpurile sunt opționale; ce lipsește rămâne din config.js. "version" crește la fiecare pachet nou.
cfg.PACK_VERSION = 0;
cfg.MIN_LAUNCHER_VERSION = '';   // din manifest: "minLauncherVersion": "2.5.0" → actualizarea launcherului devine obligatorie sub această versiune
// Pachete opționale (tab-ul „RMS Optional”): config.js -> OPTIONAL_PACKS și/sau manifest: "optional": { "minimap": { "packUrl": "...", "sizeGb": 0.1, "version": 1, "updateDate": "..." } }
const OPT_IDS = ['minimap', 'christmas', 'milkyway', 'motion_blur', 'graphics_beta', 'gas_station', 'rainbow'];
const OPT_UI_IDS = ['minimap'];                                   // aceste pachete opționale folosesc trucul frontend.xml (fără arhivă proprie)
const OPT_FIVEM_ONLY = new Set(['christmas', 'milkyway', 'motion_blur', 'gas_station', 'rainbow']);        // arhiva acestor pachete se instalează DOAR în FiveM (folderul „mods”), niciodată în GTA V
// „graphics_beta” (tab separat „RMS Graphics BETA”) NU e în OPT_FIVEM_ONLY — se instalează exact ca pachetul
// principal, în AMBELE foldere (GTA V + FiveM), pentru că e o variantă beta a aceluiași pachet complet, nu un
// mic add-on cosmetic ca celelalte. Numele implicit ('RMS_' + id.toUpperCase() + '.rar') dă exact 'RMS_GRAPHICS_BETA.rar'.
const BETA_PACK_OPT_ID = 'graphics_beta';
// Gas Station LED Pack: arhiva are 12 foldere de culori, fiecare cu RMS_GasStation.rpf; se instalează DOAR culoarea aleasă, în <FiveM>\mods
const GAS_STATION_ID = 'gas_station';
const GAS_FILE = 'RMS_GasStation.rpf';
const GAS_COLORS = ['AQUA_BLUE', 'ELECTRIC_BLUE', 'GOLD', 'GREEN_STYLE_HOOD', 'MAGENTA', 'MIDNIGHT_BLUE', 'MIDNIGHT_PURPLE', 'NEON_ORANGE', 'Neon_Pink', 'ORANGE', 'PINK', 'RANDOM_EDITION', 'RDR2', 'RED', 'VERT', 'WHITE', 'YELLOW'];
let optPick = null;
let optInstalling = false;   // true cât timp rulează „Download & Install” dintr-un pachet RMS Optional
const OPT_ARCHIVE_IDS = OPT_IDS.filter(id => !OPT_UI_IDS.includes(id));
const URL_RE = /^https:\/\/\S+/;   // orice link direct https (descărcare HTTP) — Google Drive, MediaFire sau orice alt host direct
const OPT_URL_BLOB = {
  rainbow: 'ar/EP/hu9Upga9x2T+eEiD8EgtTltotSTIX1ZLLM0iRBM0+gKltDViDxCSCbKcftOWIZA5n01xVbuY5WXmt51c33vh/v2tPO3oe2Ssb6nJKqAVvYb17lhNQTBVI/lXs=',
  gas_station: 'TNUd1wVL9bK8wSQkI5vRWrAZ5IzayOTu/N1JOKcojgnMMUCO/6wvmLzHJyy7tmLWmuuFZk5jOh66MheEX9QCBEFwKJK/vGYWHBwJtKX9l3YE8QKZPngUaOoaxVx3tVKHnBoMhlcVv9o=',
  christmas: 'DDrs62E+qY1qBjw+39lxl4eyXxHZ2upYjUT+V5ckJyK1i3llN8W16l3GEAV2PmAeAvVtVoh0XYM9o5TGgUGcrvZKjNV+2EPtRi0NuTN4tpa2WjiXXe16xZ7mR0gVZn8f4A==',
  motion_blur: 'Ria88uUMVBCHUOgAtShTBl9yDCOWXZzFsCCsoKit4r7IUDlKA5BetkqeGPGuxqLfSezeY9bVqxM+uWOab+jqEZPfGoLnWagOfUz5qp99fu8kugTp+czHB+soRrUFAfugyIIn',
  milkyway: 'xRpx6dQXYZDpT2ZCCJmu2updgLFuEhmXwXRkgy5UbRv+VHEV8uXftMBud7/iLg18xkpCA1n/Dv/4C2S+Ewjyguzw/ulIYiaDhCt26JC5BGB6cVSe6Ejn0oWFY4ndPwaMGXt9RKU='
};
// valori implicite pentru pachetele opționale noi (se pot suprascrie din config.js -> OPTIONAL_PACKS sau din manifest)
const OPT_BUILTIN = {
  rainbow: { packUrl: embeddedUrl(OPT_URL_BLOB.rainbow), filename: 'RMS_Rainbow.rar', sizeGb: 0.1, version: 1 },
  gas_station: { packUrl: embeddedUrl(OPT_URL_BLOB.gas_station), filename: 'RMS_GAS_STATION_PACK.rar', sizeGb: 0.1, version: 1 },
  christmas: { packUrl: embeddedUrl(OPT_URL_BLOB.christmas), filename: 'RMS_CHRISTMAS.rar', sizeGb: 0.3, version: 1 },
  motion_blur: { packUrl: embeddedUrl(OPT_URL_BLOB.motion_blur), filename: 'RMS_Motion_Blur.rar', sizeGb: 61408 / 1073741824, version: 1 },   // 61 408 octeți = mărimea exactă a RMS_Motion_Blur.rar primit; se autocorectează oricum live, prin ensureOptSizeProbed(), dacă arhiva de la link se schimbă
  milkyway: { packUrl: embeddedUrl(OPT_URL_BLOB.milkyway), filename: 'RMS_MILKYWAY.rar', sizeGb: 0.1, version: 1 }
};
cfg.OPTIONAL = {};
for (const id of OPT_IDS) cfg.OPTIONAL[id] = { packUrl: '', filename: 'RMS_' + id.toUpperCase() + '.rar', password: '', sizeGb: 0.1, version: 1, updateDate: '', ...(OPT_BUILTIN[id] || {}), ...(((cfg.OPTIONAL_PACKS || {})[id]) || {}) };
if (!/^\d{5,}$/.test(String(cfg.BETA_ROLE_ID || ''))) cfg.BETA_ROLE_ID = '1560609671054893147';   // rol Discord „RMS Graphics Beta”
// fereastra de acces public pentru pachetele opționale: cei cu rolul Beta pot descărca oricând; restul, doar în interval
//  - pachetele din „RMS Optional” (inclusiv Christmas) sunt acum publice pentru toți, oricând — fără rol Beta, fără interval
const OPT_BETA_GATE = {
  // RMS Graphics BETA: niciodată public — fereastra publică „începe” într-un viitor foarte îndepărtat, deci
  // optBetaGateInfo() rămâne mereu în faza 'early' (blocat) pentru oricine NU are rolul Beta, fără limită de timp
  graphics_beta: { from: Date.parse('2099-01-01T00:00:00Z') }
};
// BUG găsit: funcția citea DOAR statusMem/lastOkStatus, ambele populate exclusiv după ce s-a terminat o verificare
// Discord în sesiunea curentă. La pornirea aplicației, înainte ca acel apel să se termine, ambele sunt goale —
// deci hasBeta ieșea mereu fals, chiar dacă utilizatorul avea rolul, iar tab-ul Opțional (Halloween/Christmas)
// și insigna „RMS Beta Acces” din profil citeau acest fals negativ. Adăugat și fallback pe cache-ul de pe disc,
// ca să nu mai depindă strict de ce s-a întâmplat deja în sesiunea curentă.
function currentHasBeta() { const st = (statusMem && statusMem.value) || lastOkStatus || readStatusDisk() || {}; return !!st.hasBeta; }
// { locked, phase: ''|'early'|'closed', from, until } — „early” = încă nu s-a deschis publicului, „closed” = accesul public s-a încheiat
function optBetaGateInfo(id) {
  const g = OPT_BETA_GATE[id];
  if (!g || currentHasBeta()) return { locked: false, phase: '', from: 0, until: 0 };
  const now = Date.now();
  if (g.from && now < g.from) return { locked: true, phase: 'early', from: g.from, until: g.until || 0 };
  if (g.until && now >= g.until) return { locked: true, phase: 'closed', from: g.from || 0, until: g.until };
  return { locked: false, phase: '', from: g.from || 0, until: g.until || 0 };
}
function optBetaLocked(id) { return optBetaGateInfo(id).locked; }
// fereastra brută (din configurare), independentă de rolul Beta sau de starea instalată — folosită doar pentru a afișa în UI cui/cand se aplică regula
function optGateWindow(id) { const g = OPT_BETA_GATE[id]; return { from: (g && g.from) || 0, until: (g && g.until) || 0 }; }
cfg.CHANGELOG = null;   // listă de versiuni din manifest ("changelog"); null = se folosește cea din index.html
cfg.PACK_VERSION_NAME = '';   // text afișat în interfață (opțional în manifest: "versionName": "1.2"); altfel se afișează „v" + version
const packLabel = () => cfg.PACK_VERSION_NAME || (cfg.PACK_VERSION ? 'v' + cfg.PACK_VERSION : '');
const remoteCacheFile = () => path.join(app.getPath('userData'), 'remote-config.json');
const packStateFile = () => path.join(app.getPath('userData'), 'pack-state.json');
function readPackState() {
  try {
    const j = JSON.parse(fs.readFileSync(packStateFile(), 'utf8'));
    const nm = typeof j.currentName === 'string' ? j.currentName : (typeof j.installedName === 'string' ? j.installedName : '');
    const current = Number(j.current ?? j.installed) || 0;
    const currentUpdated = typeof j.currentUpdated === 'string' ? j.currentUpdated : '';
    // instVer/instUpdated = versiunea CHIAR instalată în folderele jocului (nu doar descărcată pe disc). E separată
    // de „current” (care înseamnă „am arhiva asta”) special ca packLocked() să nu blocheze fals Auto Install imediat
    // după o redescărcare de update, înainte să fi rulat efectiv instalarea. Fișierele vechi (dinainte de distincția
    // asta) nu au deloc acest câmp — migrăm o singură dată presupunând „am descărcat” == „am instalat”, ca userii
    // deja la zi să nu pară brusc neinstalați.
    const hasInstField = j.instVer !== undefined;
    const instVer = hasInstField ? (Number(j.instVer) || 0) : current;
    const instUpdated = hasInstField ? (typeof j.instUpdated === 'string' ? j.instUpdated : '') : currentUpdated;
    return { current, currentName: nm, currentUpdated, archive: Number(j.archive) || 0, instVer, instUpdated };
  } catch { return { current: 0, currentName: '', currentUpdated: '', archive: 0, instVer: 0, instUpdated: '' }; }
}
function setPackState(patch) {
  try { fs.writeFileSync(packStateFile(), JSON.stringify({ ...readPackState(), ...patch })); } catch {}
}
// folosit atât de changelog-ul pachetului principal, cât și de changelog-ul propriu al unui pachet opțional
// (ex. „graphics_beta”: istoric versiuni Beta, separat de changelog-ul pachetului principal)
function sanitizeChangelog(arr) {
  if (!Array.isArray(arr)) return null;
  const K = new Set(['new', 'imp', 'fix']);
  const str = (x, n) => typeof x === 'string' ? x.slice(0, n) : '';
  const cl = arr.slice(0, 30).map(e => ({
    v: str(e && e.v, 20), date: str(e && e.date, 32),
    items: (Array.isArray(e && e.items) ? e.items : []).slice(0, 40)
      .filter(it => it && K.has(it.k))
      .map(it => ({ k: it.k, ro: str(it.ro, 600), en: str(it.en || it.ro, 600) }))
  })).filter(e => e.v && e.items.length);
  return cl.length ? cl : null;
}
function applyRemote(r) {
  if (!r || typeof r !== 'object') return false;
  const before = cfg.PACK_URL + '|' + cfg.PACK_VERSION + '|' + cfg.PACK_VERSION_NAME + '|' + cfg.UPDATE_DATE + '|' + JSON.stringify(cfg.OPTIONAL) + '|' + JSON.stringify(cfg.CHANGELOG);
  // Linkul/parola arhivei principale din manifest (gist) NU mai au voie să suprascrie cfg.PACK_URL/PACK_PASSWORD
  // cât timp Worker-ul (PACK_ACCESS_URL) e configurat — altfel manifestul (care poate avea încă linkul public
  // vechi la "packUrl"/"megaUrl") ar rescrie exact linkul temporar proaspăt venit de la Worker, la fiecare
  // reîmprospătare a manifestului (pornire / la 8s / la 3 minute), inclusiv în timp ce o descărcare tocmai pornea.
  const rPackUrl = (typeof r.packUrl === 'string' && r.packUrl) || (typeof r.megaUrl === 'string' && r.megaUrl) || '';   // "megaUrl" = alias vechi, tot acceptat
  if (!cfg.PACK_ACCESS_URL && rPackUrl && URL_RE.test(rPackUrl.trim())) cfg.PACK_URL = rPackUrl.trim();
  if (typeof r.updateDate === 'string' && r.updateDate.length <= 32) cfg.UPDATE_DATE = r.updateDate;
  if (Number(r.sizeGb) > 0) cfg.DOWNLOAD_SIZE_GB = Number(r.sizeGb);
  if (typeof r.filename === 'string' && /^[\w][\w. -]{0,80}\.rar$/i.test(r.filename)) cfg.DOWNLOAD_FILENAME = r.filename;
  if (!cfg.PACK_ACCESS_URL && typeof r.password === 'string' && r.password) cfg.PACK_PASSWORD = r.password;
  if (Number.isFinite(Number(r.version))) cfg.PACK_VERSION = Number(r.version);
  cfg.MIN_LAUNCHER_VERSION = typeof r.minLauncherVersion === 'string' ? r.minLauncherVersion.trim().slice(0, 20) : '';
  cfg.PACK_VERSION_NAME = typeof r.versionName === 'string' ? r.versionName.trim().slice(0, 20) : '';
  if (r.optional && typeof r.optional === 'object') {
    for (const id of OPT_IDS) {
      const o = r.optional[id], t = cfg.OPTIONAL[id];
      if (!o || typeof o !== 'object') continue;
      const oPackUrl = (typeof o.packUrl === 'string' && o.packUrl) || (typeof o.megaUrl === 'string' && o.megaUrl) || '';
      if (oPackUrl && URL_RE.test(oPackUrl.trim())) t.packUrl = oPackUrl.trim();
      if (typeof o.filename === 'string' && /^[\w][\w. -]{0,80}\.rar$/i.test(o.filename)) t.filename = o.filename;
      if (typeof o.password === 'string') t.password = o.password;
      if (Number(o.sizeGb) > 0) t.sizeGb = Number(o.sizeGb);
      if (Number.isFinite(Number(o.version))) t.version = Number(o.version);
      if (typeof o.updateDate === 'string' && o.updateDate.length <= 32) t.updateDate = o.updateDate;
      if (Array.isArray(o.changelog)) t.changelog = sanitizeChangelog(o.changelog);
    }
  }
  if (Array.isArray(r.changelog)) cfg.CHANGELOG = sanitizeChangelog(r.changelog);
  // link nou => dimensiunea reținută în memorie nu mai e valabilă
  try { packSize = null; } catch {}
  return before !== (cfg.PACK_URL + '|' + cfg.PACK_VERSION + '|' + cfg.PACK_VERSION_NAME + '|' + cfg.UPDATE_DATE + '|' + JSON.stringify(cfg.OPTIONAL) + '|' + JSON.stringify(cfg.CHANGELOG));
}
let remoteOk = false;
async function refreshRemote() {
  if (!cfg.MANIFEST_URL || /\/USER\/REPO\//.test(cfg.MANIFEST_URL)) return false;
  try {
    const res = await fetch(cfg.MANIFEST_URL + (cfg.MANIFEST_URL.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error('http_' + res.status);
    const j = await res.json();
    const changed = applyRemote(j);
    try { fs.writeFileSync(remoteCacheFile(), JSON.stringify(j)); } catch {}
    remoteOk = true;
    ilog('Manifest online: citit OK | versiune pachet ' + cfg.PACK_VERSION + ' | noutăți: ' + (cfg.CHANGELOG ? cfg.CHANGELOG.length + ' versiuni, prima ' + cfg.CHANGELOG[0].v : 'lipsesc din gist') + ' | schimbat: ' + changed);
    return changed;
  } catch (e) { remoteOk = false; ilog('Manifest online: EȘUAT -> ' + String((e && e.message) || e).slice(0, 200)); return false; }   // fără internet / GitHub căzut: rămân valorile din cache sau din config.js
}
let autoCheck = true;   // „Actualizări automate” din tab-ul Descărcări: verificare periodică + notificare
ipcMain.on('set-auto-update', (_e, on) => { autoCheck = !!on; });
let cfgReady = Promise.resolve();
const startRemote = () => {
  try { applyRemote(JSON.parse(fs.readFileSync(remoteCacheFile(), 'utf8'))); } catch {}   // ultima valoare cunoscută, instant
  cfgReady = refreshRemote();
  cfgReady.then(() => {
    try { maybeNotifyPackUpdate(); } catch {}
    // dacă prima citire a eșuat (internet lent la pornire), reîncercăm singuri după 8 s; interfața se actualizează fără restart
    if (!remoteOk) setTimeout(async () => {
      if (await refreshRemote() && win && !win.isDestroyed()) win.webContents.send('pack-meta-changed');
      try { maybeNotifyPackUpdate(); } catch {}
    }, 8000);
  });
};

/* ---------------- Fereastra principală ---------------- */
function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 800,
    minHeight: 560,
    frame: false,
    backgroundColor: '#0c0805',
    title: 'RMS GRAPHICS Launcher',
    icon: path.join(__dirname, 'icon1.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',   // sunetul de final trebuie să meargă și fără click recent
      backgroundThrottling: false
    }
  });

  win.setMenuBarVisibility(false);

  // F5 / Ctrl+R reîncarcă aplicația (fereastra nu are meniu, deci nu există altfel)
  win.webContents.on('before-input-event', (event, input) => {
    const key = String(input.key || '').toLowerCase();
    if (input.type === 'keyDown' && (key === 'f5' || ((input.control || input.meta) && key === 'r'))) {
      event.preventDefault();
      win.webContents.reload();
    }
  });
  win.loadFile('index.html');

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  // dacă Windows nu arată bannerul notificării (dezactivat de user / Focus Assist), clipirea iconiței din
  // taskbar e un fallback care NU depinde de setarea de notificări — se oprește singură când revii în fereastră
  win.on('focus', () => { try { win.flashFrame(false); } catch {} });
}

app.whenReady().then(() => {
  // identitate nouă (v2): Windows a cache-uit o iconiță greșită pe vechea identitate ("com.rmsgraphics.launcher"),
  // din momentul testării notificărilor native — cache-ul ăla ține de sistemul de notificări/jump list al Windows,
  // nu de IconCache.db, deci nu se curăță la restart Explorer/reboot. O identitate nouă, nefolosită, nu are cache vechi.
  if (process.platform === 'win32') app.setAppUserModelId('com.rmsgraphics.launcher.v2');   // iconița corectă în taskbar + grupare shortcut
  if (WATCHDOG) {
    // mod fără fereastră, pornit de Windows la login SAU imediat după instalare (vezi launchWatchdogNow): verificarea
    // anti-deblocare + alertele Discord + verificarea manifestului pentru notificarea de update pe desktop, cât timp RMS e instalat
    try { if (!isRmsInstalled() && !OPT_ARCHIVE_IDS.some(id => { const m = readOptManifest(id); return (m.touched || []).length || (m.topDirs || []).length; })) { app.exit(0); return; } } catch {}
    // dacă mai există deja un watchdog pornit (de la o logare anterioară, de la o instalare anterioară etc.), nu mai pornim altul în paralel
    if (watchdogAlreadyRunning()) { app.exit(0); return; }
    try { fs.writeFileSync(watchdogPidFile(), String(process.pid)); } catch {}
    app.on('will-quit', () => { try { if (Number(fs.readFileSync(watchdogPidFile(), 'utf8')) === process.pid) fs.unlinkSync(watchdogPidFile()); } catch {} });
    try { lockManifest(readManifest()); for (const id of OPT_ARCHIVE_IDS) lockManifest(readOptManifest(id)); } catch {}
    rehideTick();
    setInterval(rehideTick, 10000);
    // altfel notificarea de update la pachet nu ajungea niciodată dacă userul nu deschidea manual aplicația
    // (watchdog-ul rula în fundal, dar nimeni nu citea manifestul online cât timp nu exista nicio fereastră)
    startRemote();
    setInterval(async () => {
      try {
        const changed = await refreshRemote();
        if (changed) { try { maybeNotifyPackUpdate(); } catch {} }
      } catch {}
    }, 3 * 60 * 1000);
    return;
  }
  // arhive RMS_GRAPHICS.rar care erau blocate la instalarea anterioară + folderele de lucru rămase (închidere în timpul instalării etc.)
  // + plasă de siguranță: dacă pachetul e deja instalat dar a mai rămas arhiva descărcată manual (Descărcări etc.),
  // de la o ștergere care a eșuat atunci (fișier ocupat), o ștergem acum, la pornire
  processPendingDeletes()
    .then(() => purgeStaleManualArchive())
    .then(() => purgeWorkDir(packDir()))
    .then(() => purgeWorkDir(optDir()))
    .catch(() => {});
  restoreNightBright().catch(() => {});   // curăță Night Bright rămas de la versiuni vechi (fișiere ENB din GTA V)
  if (cfg.RICH_PRESENCE !== false) presence.init(cfg, m => ilog(m), () => {
    const st = (statusMem && statusMem.value) || lastOkStatus || {};
    return { name: st.name || '', rank: st.isCeo ? 'ceo' : st.isAdmin ? 'admin' : st.isDev ? 'dev' : st.hasBeta ? 'beta' : st.state === 'ok' ? 'member' : '', busy: !!downloadBusy, version: app.getVersion() };
  });
  startRemote();
  createWindow();
  // actualizarea launcherului: verificare la prima intrare (după ce interfața e gata), apoi la 30 de minute
  try {
    launcherUpdate.init({ getWin: () => win, isBusy: () => !!downloadBusy || isBusyLocked(), getMin: () => cfg.MIN_LAUNCHER_VERSION || '', log: m => ilog(m) });
    setTimeout(() => { try { launcherUpdate.check(); } catch {} }, 4000);
    setInterval(() => { try { launcherUpdate.check(); } catch {} }, 30 * 60 * 1000);
  } catch (e) { ilog('Actualizare launcher indisponibilă: ' + ((e && e.message) || e)); }
  setInterval(pollRole, ROLE_POLL_MS);   // verificare rapidă a rolului (+ dezinstalare automată la pierderea lui)
  // plasă de siguranță: dacă o operație (instalare/dezinstalare/descărcare) rămâne „busy” anormal de mult timp —
  // de obicei un PowerShell (ACL/attrib) care a rămas agățat, blocat de un antivirus etc., fără să mai arunce
  // eroare — TOATE butoanele din launcher rămâneau blocate la nesfârșit („Altă descărcare sau instalare rulează
  // deja”), fără nicio cale de recuperare în afară de restart manual. Verificăm periodic și resetăm automat
  // starea „busy” dacă a trecut pragul (același prag folosit și pentru lacătul de pe disc, vezi mai sus).
  setInterval(autoClearStaleBusy, 60 * 1000);
  // verifică din nou manifestul din 3 în 3 minute (doar când nu rulează o descărcare / instalare): update-ul din gist ajunge repede la toți
  setInterval(async () => {
    if (downloadBusy || !autoCheck) return;
    const changed = await refreshRemote();
    if (changed) {
      if (win && !win.isDestroyed()) win.webContents.send('pack-meta-changed');
      try { maybeNotifyPackUpdate(); } catch {}
    }
  }, 3 * 60 * 1000);
  // la pornire: ștergem eventualele resturi .rms-* rămase în folderele GTA V / FiveM de la o instalare întreruptă
  setTimeout(() => { try { const p = currentPaths(); purgeLeftoverFolders([p.gta, p.fivem]); } catch {} }, 3000);
  // instalările făcute înainte de această versiune primesc și ele blocarea; apoi verificare la 10 s că fișierele rămân ascunse
  setTimeout(() => { try { if (!downloadBusy) { lockManifest(readManifest()); for (const id of OPT_ARCHIVE_IDS) lockManifest(readOptManifest(id)); } } catch {} }, 8000);
  setTimeout(() => { try { rehideTick(); } catch {} }, 8000);   // prima verificare imediat, nu abia după 10s de la pornire
  // plasă de siguranță: dacă watchdog-ul de fundal a murit între timp (închis manual din Task Manager etc.), se
  // repornește la fiecare pornire a launcherului, ca protecția să rămână activă și dacă îl închizi imediat după
  setTimeout(() => { try { if (isRmsInstalled()) launchWatchdogNow(); } catch {} }, 8000);
  setInterval(rehideTick, 10000);
});

ipcMain.on('win-minimize', () => win && win.minimize());
ipcMain.on('win-maximize', () => {
  if (!win) return;
  win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.on('win-close', () => win && win.close());
// mutarea ferestrei "manual" (folosită când tema are cursor tematic: zona -webkit-app-region:drag ignoră cursorul CSS)
let winDragTimer = null;
function winDragStop() { if (winDragTimer) { clearInterval(winDragTimer); winDragTimer = null; } }
ipcMain.on('win-drag-start', () => {
  if (!win || win.isDestroyed() || win.isMaximized() || win.isFullScreen()) return;
  winDragStop();
  const c0 = screen.getCursorScreenPoint(), b0 = win.getBounds();
  winDragTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return winDragStop();
    const c = screen.getCursorScreenPoint();
    win.setBounds({ x: b0.x + c.x - c0.x, y: b0.y + c.y - c0.y, width: b0.width, height: b0.height });
  }, 8);
  setTimeout(winDragStop, 120000);   // plasă de siguranță
});
ipcMain.on('win-drag-end', winDragStop);
// Repornește aplicația (în varianta portable folosim exe-ul original, nu cel dezarhivat în temp)
ipcMain.on('app-restart', () => {
  const portable = process.env.PORTABLE_EXECUTABLE_FILE;
  if (portable) app.relaunch({ execPath: portable });
  else app.relaunch();
  app.exit(0);
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { try { presence.stop(); } catch {} });
ipcMain.on('presence-tab', (_e, t) => { try { presence.setTab(t); } catch {} });

/* ---------------- Jurnal de instalare (depanare) ---------------- */
// Fișierul se află în %APPDATA%\<numele aplicației>\install-log.txt
const logFile = () => path.join(app.getPath('userData'), 'install-log.txt');
let logUnhidden = false;   // install-log.txt NU mai este ascuns; la prima scriere se scoate atributul Hidden rămas de la versiunile vechi
const ilog = m => {
  const f = logFile(), line = new Date().toISOString() + '  ' + m + '\n';
  if (!logUnhidden && process.platform === 'win32') { logUnhidden = true; try { require('child_process').execFileSync('attrib', ['-h', f], { windowsHide: true }); } catch {} }
  try { fs.appendFileSync(f, line); } catch {}
};

/* ---------------- Token Discord (salvat criptat) ---------------- */
const tokenFile = () => path.join(app.getPath('userData'), 'discord-token.json');

function saveToken(token, expiresIn) {
  const raw = JSON.stringify({ token, exp: Date.now() + expiresIn * 1000 });
  const enc = safeStorage.isEncryptionAvailable();
  const data = enc ? safeStorage.encryptString(raw).toString('base64')
                   : Buffer.from(raw).toString('base64');
  fs.writeFileSync(tokenFile(), JSON.stringify({ enc, data }));
  cachedUser = null;
  clearStatusDisk();
}

function loadToken() {
  try {
    const { enc, data } = JSON.parse(fs.readFileSync(tokenFile(), 'utf8'));
    const buf = Buffer.from(data, 'base64');
    const raw = enc ? safeStorage.decryptString(buf) : buf.toString('utf8');
    const { token, exp } = JSON.parse(raw);
    if (Date.now() > exp) return null;
    return token;
  } catch { return null; }
}

function clearToken() {
  try { fs.unlinkSync(tokenFile()); } catch {}
}

/* ---------------- Discord helpers ---------------- */
const isId = v => /^\d{5,}$/.test(String(v || ''));

async function getGuildId() {
  if (cachedGuildId) return cachedGuildId;
  const r = await fetch(`${API}/invites/${cfg.INVITE_CODE}`);
  if (!r.ok) throw new Error('invite');
  const j = await r.json();
  cachedGuildId = j.guild && j.guild.id;
  if (!cachedGuildId) throw new Error('guild');
  return cachedGuildId;
}

// Bannerul / culoarea profilului Discord (afișate ca fundal în cardul din „RMS System Info”).
// Prioritate: bannerul din profilul de server -> bannerul global -> culoarea de accent.
function bannerUrl(user, member, guildId) {
  try {
    const gif = h => String(h).startsWith('a_') ? 'gif' : 'png';
    if (member && member.banner && guildId) return `https://cdn.discordapp.com/guilds/${guildId}/users/${user.id}/banners/${member.banner}.${gif(member.banner)}?size=1024`;
    if (user && user.banner) return `https://cdn.discordapp.com/banners/${user.id}/${user.banner}.${gif(user.banner)}?size=1024`;
  } catch {}
  return null;
}
const accentHex = u => (u && Number.isInteger(u.accent_color)) ? '#' + u.accent_color.toString(16).padStart(6, '0') : null;
// obiectul „user” din /guilds/{id}/member nu conține mereu banner/accent: îl cerem separat din /users/@me (păstrat 1 min, ca bannerul animat să se schimbe repede)
let profileCache = null;
async function fullUser(headers, user) {
  try {
    if (profileCache && profileCache.id === user.id && Date.now() - profileCache.ts < 60000) return profileCache.user;
    const u = await fetchUser(headers);
    if (u && u.id === user.id) { profileCache = { id: user.id, ts: Date.now(), user: u }; return u; }
  } catch {}
  return user;
}

// Avatar sincronizat cu Discord: avatarul de server (dacă există) -> avatarul global; hash-ul „a_” = animat (GIF)
function avatarUrl(user, member, guildId) {
  const ext = h => String(h).startsWith('a_') ? 'gif' : 'png';
  if (member && member.avatar && guildId) return `https://cdn.discordapp.com/guilds/${guildId}/users/${user.id}/avatars/${member.avatar}.${ext(member.avatar)}?size=64`;
  if (user.avatar) return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext(user.avatar)}?size=64`;
  const idx = Number((BigInt(user.id) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
}

let lastOkStatus = null;     // ultimul status cu rol confirmat (folosit doar pentru jurnalul de descărcări)

// Verificare simplă, o singură dată (la pornire / după login): are utilizatorul rolul sau nu.
// Cerere rapidă către Discord: timeout 5s; la 429 (limită) așteptăm cât cere, dar maxim 2s, de cel mult 2 ori.
// O cerere către Discord: mai întâi prin rețeaua Chromium (net.fetch: respectă proxy / VPN / setările sistemului);
// dacă nu răspunde în 2,5 s (sau eșuează), pornește în paralel și fetch-ul Node. Câștigă primul răspuns.
function dFetchOnce(url, headers) {
  const fns = [];
  if (net && typeof net.fetch === 'function') fns.push(net.fetch.bind(net));
  fns.push(fetch);
  return new Promise((resolve, reject) => {
    let done = false, started = 0, failed = 0, lastErr = null, timer = null;
    const jobs = [];
    const startNext = () => {
      if (done || started >= fns.length) return;
      const f = fns[started++];
      const c = new AbortController(); jobs.push(c);
      const signal = AbortSignal.any([c.signal, AbortSignal.timeout(7000)]);
      let p; try { p = Promise.resolve(f(url, { headers, cache: 'no-store', signal })); } catch (e) { p = Promise.reject(e); }
      p.then(r => { if (done) return; done = true; clearTimeout(timer); jobs.forEach(x => { if (x !== c) x.abort(); }); resolve(r); },
             e => { lastErr = e; failed++; if (done) return; if (started < fns.length) startNext(); else if (failed >= started) { done = true; clearTimeout(timer); reject(lastErr); } });
      if (started < fns.length) { clearTimeout(timer); timer = setTimeout(startNext, 3500); }
    };
    startNext();
  });
}
async function dFetch(url, headers) {
  for (let i = 0; ; i++) {
    const r = await dFetchOnce(url, headers);
    if (r.status !== 429 || i >= 3) return r;
    let wait = 1000;
    try { const j = await r.json(); wait = Math.min(4000, Math.max(300, (Number(j.retry_after) || 1) * 1000)); }
    catch { const h = Number(r.headers.get('retry-after')); if (h) wait = Math.min(4000, h * 1000); }
    await new Promise(res => setTimeout(res, wait));
  }
}

async function fetchUser(headers) {
  const r = await dFetch(`${API}/users/@me`, headers);
  if (r.status === 401) return null;
  if (!r.ok) throw new Error('user');
  return r.json();
}

// Data la care launcherul a văzut prima dată utilizatorul cu rolul (Discord nu expune data primirii rolului)
function firstSeenFor(id) {
  try {
    const f = path.join(app.getPath('userData'), 'first-seen.json');
    let j = {};
    try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
    if (!j[id]) { j[id] = new Date().toISOString(); fs.writeFileSync(f, JSON.stringify(j)); }
    return j[id];
  } catch { return null; }
}

// Verificarea rolului: rapidă și rezistentă la limita Discord (429).
//  - un singur apel către Discord odată (apelurile simultane împart același răspuns) + rezultat păstrat 20 s în memorie;
//  - rolul confirmat se salvează pe disc: la pornire aplicația se deschide imediat, iar verificarea reală rulează în fundal
//    (dacă între timp s-a pierdut rolul, interfața se blochează singură după câteva secunde);
//  - dacă Discord răspunde cu 429 / eroare de rețea, se folosește ultimul rol confirmat (max. 14 zile) în loc de „Acces restricționat”.
const statusCacheFile = () => path.join(app.getPath('userData'), 'status-cache.json');
const STATUS_DISK_TTL = 14 * 24 * 3600 * 1000, STATUS_MEM_TTL = 4000;
function readStatusDisk() {
  try { const j = JSON.parse(fs.readFileSync(statusCacheFile(), 'utf8')); if (j && j.out && j.out.state === 'ok' && j.out.v === 4 && 'banner' in j.out && Date.now() - j.ts < STATUS_DISK_TTL) return j.out; } catch {}
  return null;
}
function writeStatusDisk(out) { try { fs.writeFileSync(statusCacheFile(), JSON.stringify({ ts: Date.now(), out })); } catch {} }
function clearStatusDisk() { try { fs.unlinkSync(statusCacheFile()); } catch {} statusMem = null; }
let statusMem = null, statusInflight = null, statusFirstCall = true;

function liveStatus() {
  if (statusInflight) return statusInflight;
  statusInflight = (async () => {
    let s = await getStatusOnce();
    if (s && s.state === 'error') { await new Promise(r => setTimeout(r, 1200)); s = await getStatusOnce(); }
    if (s && s.state === 'error') {                                   // 429 / rețea: nu blocăm un utilizator cu rol confirmat recent
      const d = readStatusDisk();
      if (d && loadToken()) s = { ...d, cached: true };
    }
    if (s && !s.cached) {
      if (s.state === 'ok') writeStatusDisk(s);
      else if (s.state === 'no_role' || s.state === 'logged_out') clearStatusDisk();
      if (s.state !== 'error') {
        statusMem = { ts: Date.now(), value: s };
        // notificarea de rol Beta nu mai așteaptă următorul tick din pollRole() (la 5 s): reacționăm imediat
        // ce avem un răspuns proaspăt de la Discord (la pornire, la refresh-ul din 3 în 3 minute etc.), ca
        // notificarea să apară practic instant după ce rolul a fost acordat, nu „după ceva timp”
        try { processRoleStatus(s, statusMem.ts); } catch {}
      }
    }
    return s;
  })().finally(() => { statusInflight = null; });
  return statusInflight;
}
async function getStatus() {
  if (statusMem && Date.now() - statusMem.ts < STATUS_MEM_TTL) return statusMem.value;
  if (statusFirstCall) {
    statusFirstCall = false;
    const d = readStatusDisk();
    if (d && loadToken()) { liveStatus().catch(() => {}); return { ...d, cached: true }; }   // răspuns imediat, verificare în fundal
  }
  return liveStatus();
}
async function getStatusOnce() {
  if (!isId(cfg.CLIENT_ID) || !isId(cfg.ROLE_ID)) {
    return { state: 'config_error', message: 'Completează CLIENT_ID și ROLE_ID în config.js' };
  }
  const token = loadToken();
  if (!token) return { state: 'logged_out' };

  try {
    const headers = { Authorization: `Bearer ${token}` };
    const guildId = await getGuildId();
    const mRes = await dFetch(`${API}/users/@me/guilds/${guildId}/member`, headers);
    if (mRes.status === 401) { clearToken(); return { state: 'logged_out' }; }

    if (mRes.status === 404 || mRes.status === 403) {
      const user = await fetchUser(headers);
      if (!user) { clearToken(); return { state: 'logged_out' }; }
      return { state: 'no_role', name: user.global_name || user.username, avatar: avatarUrl(user), id: user.id, username: user.username, banner: bannerUrl(user, null, guildId), accent: accentHex(user) };
    }
    if (!mRes.ok) return { state: 'error', detail: 'HTTP ' + mRes.status };

    const member = await mRes.json();
    const user = member.user || await fetchUser(headers);
    if (!user) { clearToken(); return { state: 'logged_out' }; }

    const roles = Array.isArray(member.roles) ? member.roles : [];
    const hasRole = roles.includes(cfg.ROLE_ID);
    const prof = await fullUser(headers, user);
    const out = {
      v: 4,
      state: hasRole ? 'ok' : 'no_role',
      name: member.nick || user.global_name || user.username,
      avatar: avatarUrl(user, member, guildId), id: user.id, username: user.username,
      banner: bannerUrl(prof, member, guildId), accent: accentHex(prof),
      joinedAt: member.joined_at || null,
      betaKnown: isId(cfg.BETA_ROLE_ID),
      hasBeta: isId(cfg.BETA_ROLE_ID) && roles.includes(cfg.BETA_ROLE_ID),
      firstSeen: hasRole ? firstSeenFor(user.id) : null,
      isCeo: isId(cfg.CEO_ROLE_ID) && roles.includes(cfg.CEO_ROLE_ID),
      isAdmin: isId(cfg.ADMIN_ROLE_ID) && roles.includes(cfg.ADMIN_ROLE_ID),
      isDev: isId(cfg.DEV_ROLE_ID) && roles.includes(cfg.DEV_ROLE_ID)
    };
    if (hasRole) lastOkStatus = out;
    return out;
  } catch (e) {
    return { state: 'error', message: 'Nu m-am putut conecta la Discord.', detail: String((e && e.message) || e).slice(0, 80) };
  }
}

/* Login în browserul implicit: pornim un server local pe 127.0.0.1 care primește
   redirect-ul de la Discord. Token-ul (flux implicit) vine în #fragment, care nu
   ajunge la server, așa că pagina /callback îl citește în browser și îl trimite
   înapoi la /token. */
let loginInProgress = null;
let cancelLogin = null;

function discordLogin(theme) {
  if (loginInProgress) return loginInProgress;

  // culorile de accent din aplicație (alese de utilizator în Setări), trecute și pe pagina din browser;
  // validate strict (#rrggbb) înainte să ajungă în HTML/CSS, altfel rămânem pe valorile implicite ale brandului
  const hex6 = v => /^#[0-9a-fA-F]{6}$/.test(String(v || '')) ? String(v) : null;
  const themeA1 = hex6(theme && theme.a1) || '#7c3aed';
  const themeA2 = hex6(theme && theme.a2) || '#a855f7';

  loginInProgress = new Promise(resolve => {
    const redirect = new URL(cfg.REDIRECT_URI);
    const port = Number(redirect.port) || 80;
    const state = crypto.randomBytes(16).toString('hex');   // anti-CSRF
    let finished = false;
    let server;
    let timer;

    const finish = ok => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { server.close(); if (server.closeAllConnections) server.closeAllConnections(); } catch {}
      loginInProgress = null;
      cancelLogin = null;
      if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
      resolve(ok);
    };
    cancelLogin = () => finish(false);

    const favicon = 'data:image/svg+xml,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0" stop-color="${themeA1}"/><stop offset="1" stop-color="${themeA2}"/></linearGradient></defs>` +
      `<rect width="64" height="64" rx="16" fill="url(#g)"/>` +
      `<path d="M32 10l17 8v10c0 11-7.3 17.8-17 20-9.7-2.2-17-9-17-20V18l17-8z" fill="none" stroke="#fff" stroke-width="3.4" stroke-linejoin="round"/>` +
      `<path d="M25 31l5 5 10-10" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
    );

    const page = (title, msg, script = '') => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title><link rel="icon" href="${favicon}">
<style>
  :root { --a1:${themeA1}; --a2:${themeA2}; }
  * { box-sizing:border-box; }
  html, body { height:100%; }
  body { margin:0; display:flex; align-items:center; justify-content:center; font-family:"Segoe UI",Arial,sans-serif; text-align:center;
    background:#07070b; color:#fff; overflow:hidden; position:relative; }
  .orb { position:fixed; width:520px; height:520px; border-radius:50%; filter:blur(14px); pointer-events:none; opacity:.55; }
  .orb.a { top:-16%; left:-12%; background:radial-gradient(circle, var(--a1), transparent 70%); animation:orbMove 9s ease-in-out infinite alternate; }
  .orb.b { bottom:-18%; right:-10%; background:radial-gradient(circle, var(--a2), transparent 70%); animation:orbMove 11s ease-in-out infinite alternate-reverse; }
  @keyframes orbMove { from { transform:translate(0,0) scale(1); } to { transform:translate(6%,5%) scale(1.14); } }
  .card { position:relative; z-index:1; padding:46px 52px; border-radius:24px; min-width:320px;
    background:linear-gradient(165deg, rgba(255,255,255,.05), rgba(255,255,255,0) 60%), #111119;
    border:1px solid rgba(255,255,255,.09); box-shadow:0 24px 60px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.05);
    animation:cardIn .5s cubic-bezier(.16,1,.3,1); transition:box-shadow .4s, border-color .4s; }
  @keyframes cardIn { from { opacity:0; transform:translateY(10px) scale(.97); } to { opacity:1; transform:none; } }
  .logo { width:62px; height:62px; margin:0 auto 16px; border-radius:17px; background:linear-gradient(135deg, var(--a1), var(--a2));
    display:flex; align-items:center; justify-content:center; box-shadow:0 10px 26px rgba(0,0,0,.4); }
  .logo svg { width:28px; height:28px; }
  .brand { font-size:11px; font-weight:700; letter-spacing:.18em; text-transform:uppercase; color:#71717a; margin-bottom:24px; }
  .brand b { color:#fff; } .brand i { color:var(--a1); font-style:normal; }
  .spin { width:38px; height:38px; margin:0 auto 20px; border-radius:50%; border:3px solid rgba(255,255,255,.12); border-top-color:var(--a1); animation:spin .85s linear infinite; }
  @keyframes spin { to { transform:rotate(360deg); } }
  .state-ic { width:50px; height:50px; margin:0 auto 18px; display:none; animation:popIn .35s cubic-bezier(.34,1.56,.64,1); }
  @keyframes popIn { from { opacity:0; transform:scale(.5); } to { opacity:1; transform:none; } }
  h1 { font-size:20px; margin:0 0 8px; font-weight:800; transition:color .3s; }
  p { margin:0; color:#a1a1aa; font-size:13.5px; line-height:1.5; }
  .card.ok { border-color:rgba(74,222,128,.4); box-shadow:0 24px 60px rgba(0,0,0,.55), 0 0 40px rgba(74,222,128,.18); }
  .card.ok h1 { color:#4ade80; } .card.ok .ok-ic { display:block; }
  .card.err { border-color:rgba(248,113,113,.4); box-shadow:0 24px 60px rgba(0,0,0,.55), 0 0 40px rgba(248,113,113,.18); }
  .card.err h1 { color:#f87171; } .card.err .err-ic { display:block; }
</style></head>
<body>
  <span class="orb a"></span><span class="orb b"></span>
  <div class="card" id="card">
    <div class="logo"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 4v5c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V7l8-4z"/></svg></div>
    <div class="brand"><b>RMS</b> <i>GRAPHICS</i></div>
    <div class="spin" id="spin"></div>
    <svg class="state-ic ok-ic" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>
    <svg class="state-ic err-ic" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
    <h1>${title}</h1>
    <p id="m">${msg}</p>
  </div>
${script}</body></html>`;

    server = require('http').createServer((req, res) => {
      const u = new URL(req.url, `http://127.0.0.1:${port}`);

      if (u.pathname === redirect.pathname) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(page('RMS Launcher', 'Se finalizează conectarea...', `<script>
          const h = new URLSearchParams(location.hash.slice(1));
          const t = h.get('access_token');
          const ok = t && h.get('state') === ${JSON.stringify(state)};
          history.replaceState(null, '', location.pathname);
          const card = document.getElementById('card'), spin = document.getElementById('spin');
          if (!ok) {
            card.classList.add('err'); if (spin) spin.style.display = 'none';
            document.querySelector('h1').textContent = 'Conectare eșuată';
            document.getElementById('m').textContent = 'Poți închide această fereastră și reîncerca din launcher.';
            fetch('/fail', { method: 'POST' });
          } else {
            fetch('/token', { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ access_token: t, expires_in: h.get('expires_in') }) })
              .then(() => {
                card.classList.add('ok'); if (spin) spin.style.display = 'none';
                document.querySelector('h1').textContent = 'Conectat cu succes';
                document.getElementById('m').textContent = 'Poți închide această fereastră și reveni în launcher.';
              });
          }
        <\/script>`));
        return;
      }

      if (u.pathname === '/token' && req.method === 'POST') {
        let body = '';
        req.on('data', c => { body += c; if (body.length > 10000) req.destroy(); });
        req.on('end', () => {
          let ok = false;
          try {
            const j = JSON.parse(body);
            if (j.access_token) {
              saveToken(j.access_token, Number(j.expires_in) || 604800);
              ok = true;
            }
          } catch {}
          res.writeHead(ok ? 200 : 400); res.end();
          finish(ok);
        });
        return;
      }

      if (u.pathname === '/fail' && req.method === 'POST') {
        res.writeHead(200); res.end();
        finish(false);
        return;
      }

      res.writeHead(404); res.end();
    });

    server.on('error', () => finish(false));   // ex: portul e ocupat

    server.listen(port, '127.0.0.1', () => {
      const url = 'https://discord.com/oauth2/authorize?' + new URLSearchParams({
        client_id: cfg.CLIENT_ID,
        response_type: 'token',
        redirect_uri: cfg.REDIRECT_URI,
        scope: 'identify guilds.members.read',
        state
      });
      shell.openExternal(url).catch(() => finish(false));
      timer = setTimeout(() => finish(false), 3 * 60 * 1000);   // renunță după 3 minute
    });
  });

  return loginInProgress;
}


/* ---------------- Jurnal in Discord (webhook) ---------------- */
const COLORS = { ok: 0xf97316, no_role: 0xf59e0b, not_member: 0xef4444 };
const lastSent = {};

const pad2 = n => String(n).padStart(2, '0');
function roTime(d) {      // „16.10.2026 · 14:32:10” (ora României)
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('ro-RO', { timeZone: 'Europe/Bucharest', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(d).map(x => [x.type, x.value]));
    return `${p.day}.${p.month}.${p.year} · ${p.hour}:${p.minute}:${p.second}`;
  } catch { return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()} · ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; }
}

function sendLog(event, st, extra = {}) {
  const url = cfg.LOG_WEBHOOK_URL || '';
  if (!/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/.+/.test(url)) return;
  if (!st || !st.id) return;

  const key = event + st.id;                       // anti-spam: max 1 log / 5 sec / eveniment
  if (Date.now() - (lastSent[key] || 0) < 5000) return;
  lastSent[key] = Date.now();

  const now = new Date();
  const ts = Math.floor(now.getTime() / 1000);
  const name = String(st.name || st.username || '-').slice(0, 100);
  const roleText = { ok: '✅  **Are rol RMS**', no_role: '⚠️  **Fără rol**', not_member: '❌  **Nu e pe server**' }[st.state] || String(st.state);
  const avatar = st.avatar ? String(st.avatar).replace('size=64', 'size=256') : undefined;
  const body = {
    username: 'RMS GRAPHICS • Logs',
    allowed_mentions: { parse: [] },               // nu pinguieste pe nimeni
    embeds: [{
      author: { name: 'RMS GRAPHICS  ·  DOWNLOAD LOG', icon_url: avatar },
      title: '📥  ' + event,
      description: '▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰\n**' + name + '** a descărcat pachetul **RMS GRAPHICS**.\n▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰',
      color: COLORS[st.state] || 0x888888,
      thumbnail: avatar ? { url: avatar } : undefined,
      fields: [
        { name: '👤  Utilizator', value: `<@${st.id}>\n**${name}**`, inline: true },
        { name: '🪪  ID Discord', value: '`' + st.id + '`', inline: true },
        { name: '🛡️  Status', value: roleText, inline: true },
        { name: '🕒  Data și ora', value: `**${roTime(now)}**\n<t:${ts}:R>`, inline: true }
      ],
      footer: { text: 'RMS GRAPHICS  ·  Premium Launcher' },
      timestamp: now.toISOString()
    }]
  };
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
}

// Alertă în Discord (pe canal SEPARAT, doar pentru securitate) când rehideTick găsește foldere/fișiere RMS pe care
// cineva le-a „dezascuns” manual (attrib, Explorer etc.), sau atribute schimbate pe GTA V / FiveM.
// Contorul e salvat pe disc (nu în memorie): ține și între GUI + watchdog (două procese separate) și între reporniri.
const tamperStateFile = () => path.join(app.getPath('userData'), 'tamper-state.json');
function readTamperState() { try { return JSON.parse(fs.readFileSync(tamperStateFile(), 'utf8')) || {}; } catch { return {}; } }
function writeTamperState(s) { try { fs.writeFileSync(tamperStateFile(), JSON.stringify(s)); } catch {} }
function resetTamperCount() { try { fs.unlinkSync(tamperStateFile()); } catch {} }
// în ce zonă e o cale: „GTA V”, „FiveM” sau „-” (dacă nu se poate determina, ex. foldere rădăcină nu mai există)
function areaOf(p, cp) {
  try {
    const low = path.resolve(p).toLowerCase();
    if (cp.gta && low.startsWith(path.resolve(cp.gta).toLowerCase() + path.sep)) return 'GTA V';
    if (cp.fivem && low.startsWith(path.resolve(cp.fivem).toLowerCase() + path.sep)) return 'FiveM';
  } catch {}
  return '-';
}
// Lacăt scurt (pe disc) pentru contorul de tentative: GUI și watchdog sunt DOUĂ procese separate și pot detecta
// aceeași rafală de fișiere redevenite vizibile aproape simultan (ex. verificarea de integritate a jocului din
// Steam/Rockstar/FiveM, un antivirus etc., care ating sute de fișiere deodată) — fără acest lacăt, ambele procese
// citeau același total vechi înainte ca celălalt să apuce să scrie, și trimiteau fiecare propria alertă cu
// „Total tentative: 1”, de două ori, în loc să se incrementeze corect (1, apoi 2).
async function acquireTamperLock() {
  const lockPath = tamperStateFile() + '.lock';
  for (let i = 0; i < 25; i++) {
    try { fs.writeFileSync(lockPath, String(Date.now()), { flag: 'wx' }); return true; } catch {}
    try { const t = Number(fs.readFileSync(lockPath, 'utf8')); if (!t || Date.now() - t > 5000) { try { fs.unlinkSync(lockPath); } catch {} } } catch {}
    await new Promise(r => setTimeout(r, 30 + Math.floor(Math.random() * 40)));
  }
  return false;   // nu s-a eliberat la timp: continuăm oricum, mai bine un total ușor inexact decât o alertă pierdută
}
function releaseTamperLock() { try { fs.unlinkSync(tamperStateFile() + '.lock'); } catch {} }

async function sendTamperLog(paths, kind) {
  const url = cfg.SECURITY_WEBHOOK_URL || '';
  if (!/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/.+/.test(url)) return;

  // trimite pe Discord la FIECARE tentativă detectată, fără bundling/prag de timp — doar contorul total rămas pe
  // disc (ține între GUI + watchdog și între reporniri), ca informație, nu ca filtru pentru dacă se trimite sau nu
  const locked = await acquireTamperLock();
  const s0 = readTamperState();
  const total = (s0.total || 0) + 1;
  writeTamperState({ total, lastReportTs: Date.now() });
  if (locked) releaseTamperLock();

  // identitatea ultimului utilizator cunoscut: din memorie dacă launcherul rulează acum, altfel din cache-ul de pe disc
  // (scris la ultimul login Discord) — ca să se vadă cine e, chiar dacă nu e logat/deschis în acest moment
  const st = (statusMem && statusMem.value) || lastOkStatus || readStatusDisk() || {};
  const name = String(st.name || st.username || 'Necunoscut').slice(0, 100);
  const id = st.id ? '`' + st.id + '`' : '`-`';
  const avatar = st.avatar ? String(st.avatar).replace('size=64', 'size=256') : undefined;
  const isRoot = kind === 'root';

  // mesaj SIMPLU, dar cu numărul REAL per zonă (nu doar „GTA V + FiveM” fără context) — altfel pare greșit când
  // cineva testează doar pe GTA V, dar apare și FiveM cu câteva fișiere rămase neascunse dintr-un test anterior
  const cp = currentPaths();
  const byArea = { 'GTA V': 0, FiveM: 0, '-': 0 };
  for (const p of (paths || [])) byArea[areaOf(p, cp)]++;
  const areaParts = Object.entries(byArea).filter(([, n]) => n > 0).map(([a, n]) => a + ': **' + n + '**');
  const areaLabel = areaParts.length ? areaParts.join('  ·  ') : '-';
  const areasOnly = Object.keys(byArea).filter(a => a !== '-' && byArea[a] > 0);
  const totalFiles = (paths || []).length;
  // o rafală MARE (zeci/sute de fișiere deodată) nu e, de regulă, cineva care umblă manual fișier cu fișier — e mai
  // degrabă un proces automat (verificare integritate joc din Steam/Rockstar/FiveM, antivirus, backup) care a atins
  // tot folderul deodată. Mesajul separă clar cele 2 cazuri, ca să nu mai pară o alertă „aiurea”/alarmistă degeaba.
  const isBulk = !isRoot && totalFiles >= 25;
  const title = isRoot
    ? '⚠️  Atribute schimbate pe folderul principal'
    : isBulk
      ? '📦  Rafală mare de fișiere redevenite vizibile'
      : '⚠️  Tentativă de deblocare a fișierelor protejate';
  const desc = isRoot
    ? 'S-au schimbat atributele folderului principal (**' + (areasOnly.join(' + ') || 'GTA V / FiveM') + '**) față de cum erau la instalare. Folderul rămâne vizibil normal (nu se ascunde), dar e bine de verificat ce s-a modificat.'
    : isBulk
      ? '**' + totalFiles + ' fișiere** au devenit vizibile deodată — e puțin probabil să fie cineva care umblă manual, fișier cu fișier. Verifică mai degrabă o verificare de integritate a jocului (Steam/Rockstar/FiveM) sau un antivirus care a atins tot folderul. ✅ Au fost re-ascunse automat de launcher.'
      : 'Cineva a încercat să vadă/deblocheze fișierele protejate. ✅ Au fost re-ascunse automat de launcher.';
  const now = new Date();
  const body = {
    username: 'RMS GRAPHICS • Security',
    allowed_mentions: { parse: [] },
    embeds: [{
      author: { name: (isBulk ? '📦  RMS GRAPHICS  ·  SECURITY MONITOR' : '🛑  RMS GRAPHICS  ·  SECURITY ALERT'), icon_url: avatar },
      title,
      description: desc,
      color: isBulk ? 0xf59e0b : 0xdc2626,
      thumbnail: avatar ? { url: avatar } : undefined,
      fields: [
        { name: '👤  Nume Discord', value: '**' + name + '**', inline: true },
        { name: '🪪  ID Discord', value: id, inline: true },
        { name: '💻  Calculator', value: '`' + os.hostname() + '`', inline: true },
        { name: '📍  Pe zonă (' + (isRoot ? 'foldere' : 'fișiere/foldere') + ')', value: areaLabel, inline: false },
        { name: '📊  Total tentative', value: '**' + total + '** de la instalare', inline: false }
      ],
      // Discord afișează singur data + ora locale ale fiecărui viewer sub embed, pornind de la acest timestamp —
      // mai simplu și mai sigur decât construit manual din roTime()
      footer: { text: 'RMS GRAPHICS  ·  Security Monitor' },
      timestamp: now.toISOString()
    }]
  };
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
}

// Jurnal la FINALIZAREA unei descărcări: status luat din nou de la Discord (rol da/nu), cu rezervă pe ultimul status cunoscut.
async function downloadLog(method) {
  try {
    let st = null;
    try { st = await getStatus(); } catch {}
    if (!st || !st.id) st = lastOkStatus;
    if (st && st.id) sendLog('Descărcare finalizată', st, { method });
  } catch {}
}

function logState(event, st) {
  if (['ok', 'no_role', 'not_member'].includes(st.state)) sendLog(event, st);
}

// Jurnalul pe canal se trimite DOAR la descărcare (vezi 'download-start' mai jos),
// nu la deschiderea aplicației sau la conectare.
ipcMain.handle('discord-status', () => getStatus());

// ---- Fundal personalizat pentru „RMS System Info” (imagine / GIF / video din calculator) ----
// Fișierul ales se copiază în userData/custom-bg (un singur fișier), ca să meargă și dacă originalul e mutat sau șters.
const BG_MAX = 150 * 1024 * 1024;
const BG_IMG = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'apng', 'avif', 'bmp'];
const BG_VID = ['mp4', 'mov', 'webm', 'm4v'];            // video acceptat ca fundal (se redă direct în Electron)
const BG_VID_BAD = ['mkv', 'avi', 'wmv', 'flv'];        // formate pe care Electron nu le redă: refuzate
const BG_VID_MAX = 400 * 1024 * 1024;
const bgDir = () => path.join(app.getPath('userData'), 'custom-bg');
const bgKind = f => { const e = path.extname(f).slice(1).toLowerCase(); return BG_IMG.includes(e) ? 'image' : BG_VID.includes(e) ? 'video' : null; };
const bgIsVidExt = f => [...BG_VID, ...BG_VID_BAD].includes(path.extname(String(f).split(/[?#]/)[0]).slice(1).toLowerCase());
// recunoaște video după conținut (MP4/MOV/WebM/MKV redenumite în .gif / .png etc.)
const looksVideo = b => !!b && b.length > 12 && ((b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 && !/^avi[fs]$/.test(b.slice(8, 12).toString('latin1'))) || (b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) || b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'AVI ');
function bgCurrent() {
  try {
    const f = fs.readdirSync(bgDir()).find(n => bgKind(n));
    if (!f) return null;
    let name = f;
    try { name = JSON.parse(fs.readFileSync(path.join(bgDir(), 'meta.json'), 'utf8')).name || f; } catch {}
    return { ok: true, url: require('url').pathToFileURL(path.join(bgDir(), f)).href, kind: bgKind(f), name };
  } catch { return null; }
}
ipcMain.handle('bg-info', () => bgCurrent());
ipcMain.handle('bg-pick', async () => {
  const pick = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Imagini / GIF / Video', extensions: [...BG_IMG, ...BG_VID] }] });
  if (pick.canceled || !pick.filePaths[0]) return { ok: false, error: 'canceled' };
  const src = pick.filePaths[0];
  if (BG_VID_BAD.includes(path.extname(src).slice(1).toLowerCase())) return { ok: false, error: 'video' };
  const kind = bgKind(src);
  if (!kind) return { ok: false, error: 'type' };
  let st; try { st = fs.statSync(src); } catch { return { ok: false, error: 'read' }; }
  if (st.size > (kind === 'video' ? BG_VID_MAX : BG_MAX)) return { ok: false, error: 'too_big' };
  if (kind === 'image') try { const fd = fs.openSync(src, 'r'), hb = Buffer.alloc(16); fs.readSync(fd, hb, 0, 16, 0); fs.closeSync(fd); if (looksVideo(hb)) return { ok: false, error: 'video' }; } catch {}
  try {
    fs.mkdirSync(bgDir(), { recursive: true });
    for (const n of fs.readdirSync(bgDir())) { try { fs.unlinkSync(path.join(bgDir(), n)); } catch {} }
    fs.copyFileSync(src, path.join(bgDir(), 'bg-' + Date.now() + path.extname(src).toLowerCase()));
    fs.writeFileSync(path.join(bgDir(), 'meta.json'), JSON.stringify({ name: path.basename(src) }));
    return bgCurrent() || { ok: false, error: 'copy' };
  } catch { return { ok: false, error: 'copy' }; }
});
// octeții fundalului (fișier local sau link extern) pentru mărirea la 4K din interfață; linkurile se descarcă aici ca să nu depindem de CORS
ipcMain.handle('bg-bytes', async (_e, req) => {
  try {
    if (req && req.local) {
      const f = fs.readdirSync(bgDir()).find(n => bgKind(n) === 'image');   // video-ul se citește direct din fișier, nu prin octeți
      if (!f) return { ok: false, error: 'none' };
      return { ok: true, data: fs.readFileSync(path.join(bgDir(), f)) };
    }
    const u = String((req && req.url) || '');
    if (!/^https?:\/\//i.test(u)) return { ok: false, error: 'url' };
    if (bgIsVidExt(u)) return { ok: false, error: 'video' };
    const r = await net.fetch(u, { signal: AbortSignal.timeout(25000) });
    if (!r.ok) return { ok: false, error: 'http' };
    const ct = String(r.headers.get('content-type') || '').toLowerCase();
    if (ct.startsWith('video/')) return { ok: false, error: 'video' };
    if (ct && !ct.startsWith('image/') && !ct.startsWith('application/octet-stream')) return { ok: false, error: 'notimage' };
    if (Number(r.headers.get('content-length') || 0) > BG_MAX) return { ok: false, error: 'too_big' };
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > BG_MAX) return { ok: false, error: 'too_big' };
    if (looksVideo(buf)) return { ok: false, error: 'video' };
    return { ok: true, data: buf };
  } catch { return { ok: false, error: 'fetch' }; }
});
ipcMain.handle('bg-clear', () => {
  try { fs.rmSync(bgDir(), { recursive: true, force: true }); } catch {}
  return { ok: true };
});

/* ---------------- Verificare rapidă a rolului (la 5 s) + dezinstalare automată când se pierde rolul ---------------- */
// Dacă între două verificări starea se schimbă (rol primit / pierdut), interfața e anunțată imediat ('discord-changed').
// Dezinstalarea automată pornește doar după 2 verificări consecutive „fără rol” confirmate LIVE de Discord (nu din cache, nu la erori de rețea / 429),
// și doar pentru un utilizator care a avut rolul cândva (first-seen.json), ca un cont nou, fără rol încă, să nu își piardă launcherul.
const ROLE_POLL_MS = 5000;
let lastRoleKey = null, noRoleStreak = 0, autoUninstalling = false, lastAutoTry = 0, lastProcessedTs = 0;
const roleKey = st => st ? [st.state, st.hasBeta, st.isCeo, st.isAdmin, st.isDev, st.name, st.avatar, st.banner, st.accent].join('|') : '';
const roleEverHeld = id => { try { return !!JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'first-seen.json'), 'utf8'))[id]; } catch { return false; } };
const toRenderer = (ch, d) => { if (win && !win.isDestroyed()) { try { win.webContents.send(ch, d); } catch {} } };

// Notificare „ai primit acces la RMS Beta”: ținem starea anterioară pe disc (nu doar în memorie, ca să supraviețuiască
// restart-urilor launcherului) și anunțăm interfața DOAR la tranziția reală fals -> adevărat. Dacă cineva pierde rolul
// Beta și îl recapătă mai târziu, se notifică din nou (nu e un mesaj „o singură dată în viață”, ci „de fiecare dată
// când chiar primești accesul”). La prima citire vreodată (fișierul nu există încă) doar stabilim starea, fără să
// notificăm — altfel toți cei care au deja Beta ar primi mesajul „ai primit acces” la primul update al launcherului.
const betaStateFile = () => path.join(app.getPath('userData'), 'beta-state.json');
function readHadBeta() { try { const j = JSON.parse(fs.readFileSync(betaStateFile(), 'utf8')); return typeof j.hadBeta === 'boolean' ? j.hadBeta : null; } catch { return null; } }
function writeHadBeta(v) { try { fs.writeFileSync(betaStateFile(), JSON.stringify({ hadBeta: !!v })); } catch {} }

// Logica efectivă de verificare rol/Beta, separată de pollRole() ca să poată fi apelată și direct din liveStatus()
// (vezi mai sus), imediat ce apare un răspuns proaspăt de la Discord, nu doar la următorul tick de 5 s.
// „ts" e marca de timp a răspunsului (statusMem.ts); dacă pollRole() ajunge să vadă exact același răspuns deja
// procesat (ex: chiar cel declanșat de liveStatus() cu o clipă în urmă), nu îl mai procesăm a doua oară — altfel
// am număra de două ori „fără rol" (dezinstalare automată prematură) sau am putea trimite notificarea de două ori.
function processRoleStatus(st, ts) {
  if (ts) { if (ts === lastProcessedTs) return; lastProcessedTs = ts; }
  try {
    if (!st || st.cached || !['ok', 'no_role', 'logged_out'].includes(st.state)) return;   // eroare / limită Discord: nu schimbăm nimic
    const k = roleKey(st);
    if (lastRoleKey !== null && k !== lastRoleKey) toRenderer('discord-changed');
    lastRoleKey = k;
    if (st.state === 'no_role') {
      if (++noRoleStreak >= 2 && cfg.AUTO_UNINSTALL_ON_ROLE_LOSS !== false && st.id && roleEverHeld(st.id)) autoUninstallOnRoleLoss();
    } else noRoleStreak = 0;
    const prevBeta = readHadBeta();
    if (prevBeta === null) writeHadBeta(st.hasBeta);
    else if (st.hasBeta && !prevBeta) { writeHadBeta(true); toRenderer('beta-granted'); ilog('Acces RMS Beta primit — notificare trimisă.'); }
    else if (!st.hasBeta && prevBeta) writeHadBeta(false);   // a pierdut Beta: resetăm, ca să notificăm din nou dacă îl recapătă
  } catch {}
}
async function pollRole() {
  try {
    const st = await getStatus();
    processRoleStatus(st, statusMem && statusMem.value === st ? statusMem.ts : 0);
  } catch {}
}

async function autoUninstallOnRoleLoss() {
  if (autoUninstalling || Date.now() - lastAutoTry < 60000) return;
  autoUninstalling = true; lastAutoTry = Date.now();
  try {
    const hasStuff = isRmsInstalled() || !!readUiState().dest || !!readNbState().gta || !!manualPackPath();
    ilog('=== Rol pierdut: dezinstalare automată === (instalat: ' + hasStuff + ')');
    if (hasStuff) {
      toRenderer('role-lost', { phase: 'start' });
      if (downloadBusy) {                                  // o descărcare / instalare în curs se oprește întâi
        if (!finalizing) { installCancelled = true; if (activeDownload) activeDownload.abort(); if (installWorker) installWorker.terminate(); }
        for (let i = 0; i < 180 && downloadBusy; i++) await new Promise(r => setTimeout(r, 500));
      }
      const r = await runUninstall();
      await purgeAllPackArchives();
      ilog('Dezinstalare automată: ' + JSON.stringify(r));
      toRenderer('role-lost', { phase: 'done', ok: !!(r && (r.ok || r.error === 'nothing')), left: (r && r.left) || 0 });
      if (r && r.error === 'partial') return;              // fișiere blocate (GTA V / FiveM pornite): reîncercăm peste 60 s, launcherul rămâne
    }
    if (cfg.AUTO_REMOVE_LAUNCHER !== false) selfUninstall();
  } catch (e) { ilog('Dezinstalarea automată a eșuat: ' + ((e && e.message) || e)); }
  finally { autoUninstalling = false; }
}

// arhiva din datele aplicației + arhiva descărcată manual (oriunde) + copiile lor din Coșul de reciclare
async function purgeAllPackArchives() {
  try {
    const names = new Set([cfg.DOWNLOAD_FILENAME || 'RMS_GRAPHICS.rar']);
    for (const id of OPT_IDS) names.add(cfg.OPTIONAL[id].filename);
    const files = [];
    const m = manualPackPath(); if (m) { files.push(m); names.add(path.basename(m)); }
    for (const d of [packDir(), optDir()]) { try { for (const f of fs.readdirSync(d)) { files.push(path.join(d, f)); names.add(f); } } catch {} }
    for (const f of files) { for (let i = 0; i < 5 && fs.existsSync(f); i++) { try { await fs.promises.unlink(f); } catch (e) { if (e && e.code === 'ENOENT') break; await new Promise(r => setTimeout(r, 250)); } } }
    try { fs.unlinkSync(manualPackFile()); } catch {}
    const bin = await purgeFromRecycleBin([...names]);
    ilog('Arhive șterse: ' + files.length + ' | scoase din Recycle Bin: ' + bin);
  } catch (e) { ilog('Ștergerea arhivelor a eșuat: ' + ((e && e.message) || e)); }
}

// Dezinstalează launcherul însuși (doar varianta instalată NSIS; nu în `npm start` și nu în portable). Dezinstalatorul șterge definitiv, fără Coș de reciclare.
function selfUninstall() {
  try {
    if (process.platform !== 'win32' || !app.isPackaged || process.env.PORTABLE_EXECUTABLE_FILE) { ilog('Auto-dezinstalare launcher: indisponibilă (dev / portable)'); return false; }
    const dir = path.dirname(process.execPath);
    const un = fs.readdirSync(dir).find(f => /^uninstall.*\.exe$/i.test(f));
    if (!un) { ilog('Auto-dezinstalare launcher: dezinstalatorul nu a fost găsit în ' + dir); return false; }
    ilog('Auto-dezinstalare launcher: pornesc ' + un);
    require('child_process').spawn(path.join(dir, un), ['/S'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    setTimeout(() => app.exit(0), 400);   // dezinstalatorul are nevoie ca aplicația să fie închisă
    return true;
  } catch (e) { ilog('Auto-dezinstalare launcher eșuată: ' + ((e && e.message) || e)); return false; }
}

// Statistici rol "RMS Graphics": câți au rolul și câți dintre ei sunt online.
// Numerele vin de la mini-botul din stats-bot.js (JSON la STATS_URL), cu cache de 60 secunde.
// Nu punem token de bot în aplicație: ar putea fi extras de oricine din launcher.
let statsCache = { t: 0, v: null };
ipcMain.handle('discord-stats', async () => {
  if (statsCache.v && Date.now() - statsCache.t < 60000) return statsCache.v;
  // 1) preferat: numărătoarea pe rolul RMS Graphics, de la stats-bot.js (dacă STATS_URL e setat)
  if (cfg.STATS_URL) {
    try {
      const r = await fetch(cfg.STATS_URL, { cache: 'no-store', signal: AbortSignal.timeout(6000) });
      if (r.ok) {
        const j = await r.json();
        const v = { ok: true, role: true, online: Number(j.role_online) || 0, members: Number(j.role_members) || 0 };
        statsCache = { t: Date.now(), v };
        return v;
      }
    } catch {}
  }
  // 2) rezervă: numerele întregului server, din invitația publică
  try {
    const r = await fetch(`${API}/invites/${cfg.INVITE_CODE}?with_counts=true`, { cache: 'no-store', signal: AbortSignal.timeout(6000) });
    if (!r.ok) return statsCache.v || { ok: false };
    const j = await r.json();
    const v = { ok: true, role: false, online: Number(j.approximate_presence_count) || 0, members: Number(j.approximate_member_count) || 0 };
    statsCache = { t: Date.now(), v };
    return v;
  } catch { return statsCache.v || { ok: false }; }
});

/* ---------------- Componente PC + estimare FPS (RMS Graphics cu / fără ENB) ---------------- */
// Scor relativ al plăcii video (GTX 1060 6GB = 100). Estimarea e prudentă (marjă în minus) și orientativă.
const GPU_SCORE = {
  gt710: 8, gt730: 12, gt1030: 35, gtx750: 35, gtx750ti: 42, gtx950: 50, gtx960: 62, gtx970: 85, gtx980: 105, gtx980ti: 140,
  gtx1050: 55, gtx1050ti: 70, gtx1060: 100, gtx1070: 135, gtx1070ti: 160, gtx1080: 180, gtx1080ti: 230,
  gtx1650: 85, gtx1650super: 110, gtx1660: 130, gtx1660super: 150, gtx1660ti: 155,
  rtx2060: 160, rtx2060super: 185, rtx2070: 200, rtx2070super: 225, rtx2080: 250, rtx2080super: 265, rtx2080ti: 310,
  rtx3050: 125, rtx3060: 180, rtx3060ti: 235, rtx3070: 270, rtx3070ti: 295, rtx3080: 350, rtx3080ti: 390, rtx3090: 410, rtx3090ti: 450,
  rtx4050: 190, rtx4060: 225, rtx4060ti: 265, rtx4070: 320, rtx4070super: 365, rtx4070ti: 400, rtx4070tisuper: 440, rtx4080: 520, rtx4080super: 540, rtx4090: 720,
  rtx5050: 215, rtx5060: 270, rtx5060ti: 320, rtx5070: 400, rtx5070ti: 500, rtx5080: 600, rtx5090: 850,
  rx550: 30, rx560: 50, rx570: 90, rx580: 105, rx590: 120, rx5500xt: 105, rx5600xt: 150, rx5700: 165, rx5700xt: 190,
  rx6400: 70, rx6500xt: 90, rx6600: 175, rx6600xt: 200, rx6650xt: 210, rx6700xt: 260, rx6750xt: 275, rx6800: 330, rx6800xt: 370, rx6900xt: 410, rx6950xt: 430,
  rx7600: 215, rx7600xt: 230, rx7700xt: 295, rx7800xt: 345, rx7900gre: 400, rx7900xt: 460, rx7900xtx: 520,
  rx9060xt: 290, rx9070: 390, rx9070xt: 460,
  a380: 70, a580: 140, a750: 190, a770: 215, b570: 230, b580: 250
};
function gpuScoreOf(name) {
  const n = String(name || '');
  let m = /(gtx|rtx|gt)\s*-?(\d{3,4})(?:\s*(ti))?(?:\s*(super))?/i.exec(n);
  if (m) {
    const base = m[1].toLowerCase() + m[2];
    const key = base + (m[3] ? 'ti' : '') + (m[4] ? 'super' : '');
    if (GPU_SCORE[key]) return { score: GPU_SCORE[key], known: true, integrated: false };
    if (GPU_SCORE[base]) return { score: GPU_SCORE[base], known: true, integrated: false };
  }
  m = /\brx\s*(\d{3,4})\s*(xtx|xt|gre)?/i.exec(n);
  if (m) {
    const base = 'rx' + m[1], key = base + (m[2] ? m[2].toLowerCase() : '');
    if (GPU_SCORE[key]) return { score: GPU_SCORE[key], known: true, integrated: false };
    if (GPU_SCORE[base]) return { score: GPU_SCORE[base], known: true, integrated: false };
  }
  m = /arc.*?\b([ab]\d{3})\b/i.exec(n);
  if (m && GPU_SCORE[m[1].toLowerCase()]) return { score: GPU_SCORE[m[1].toLowerCase()], known: true, integrated: false };
  if (/radeon\s*[78]\d0m/i.test(n)) return { score: 75, known: true, integrated: true };
  if (/iris/i.test(n)) return { score: 30, known: true, integrated: true };
  if (/uhd|hd graphics/i.test(n)) return { score: 18, known: true, integrated: true };
  if (/radeon.*graphics|vega/i.test(n)) return { score: 35, known: true, integrated: true };
  return { score: 50, known: false, integrated: false };
}
function estimateFps(sys) {
  const g = gpuScoreOf(sys.gpu.name);
  const w = sys.res.w, h = sys.res.h;
  const resF = Math.min(1.5, Math.max(0.25, Math.pow(2073600 / (w * h), 0.85)));
  const lapF = sys.laptop && !g.integrated ? 0.8 : 1;
  const ramF = sys.ramGb < 6 ? 0.55 : sys.ramGb < 8 ? 0.65 : sys.ramGb < 12 ? 0.8 : sys.ramGb < 16 ? 0.92 : 1;
  const cpuScore = Math.min(sys.cpu.threads, 16) * Math.max(sys.cpu.ghz, 2);
  const cpuCap = 45 + cpuScore * 2.4;
  const comb = (gpuFps, cap) => Math.pow(Math.pow(gpuFps, -3) + Math.pow(cap, -3), -1 / 3);
  const gpuFps = g.score * 0.62 * resF * lapF;
  const enbF = 0.5 + 0.22 * Math.min(1, g.score / 350);
  const mk = fps => { const typ = Math.max(5, Math.round(fps * ramF)); return { min: Math.max(4, Math.round(typ * 0.85)), typ }; };
  const noenb = mk(comb(gpuFps, cpuCap));
  const enb = mk(comb(gpuFps * enbF, cpuCap * 0.92));
  const verdict = enb.min >= 60 ? 'great' : enb.min >= 40 ? 'ok' : enb.min >= 28 ? 'low' : 'no';
  return { noenb, enb, verdict, known: g.known };
}
let sysCache = null;
ipcMain.handle('sys-info', async () => {
  if (sysCache) return sysCache;
  if (process.platform !== 'win32') return { ok: false };
  try {
    const os = require('os');
    const ps = "$g=@(Get-CimInstance Win32_VideoController|Select-Object Name,AdapterRAM);" +
      "$c=@(Get-CimInstance Win32_Processor|Select-Object Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed)[0];" +
      "$m=(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory;$b=@(Get-CimInstance Win32_Battery).Count;" +
      "@{gpu=$g;cpu=$c;ram=$m;bat=$b}|ConvertTo-Json -Depth 4 -Compress";
    const r = await winRun('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
    const j = JSON.parse(r.out);
    const gpus = (Array.isArray(j.gpu) ? j.gpu : [j.gpu]).filter(x => x && x.Name && !/microsoft basic|virtual|parsec|remote|vmware|citrix|displaylink/i.test(x.Name));
    gpus.sort((a, b) => gpuScoreOf(b.Name).score - gpuScoreOf(a.Name).score);
    const c = j.cpu || {};
    const d = screen.getPrimaryDisplay();
    const sys = {
      ok: true,
      gpu: { name: String((gpus[0] && gpus[0].Name) || 'GPU necunoscut').replace(/\(R\)|\(TM\)/gi, '').replace(/\s+/g, ' ').trim() },
      cpu: {
        name: String(c.Name || os.cpus()[0].model).replace(/\(R\)|\(TM\)|CPU|Processor/gi, '').replace(/\s+/g, ' ').trim(),
        cores: Number(c.NumberOfCores) || os.cpus().length,
        threads: Number(c.NumberOfLogicalProcessors) || os.cpus().length,
        ghz: (Number(c.MaxClockSpeed) || os.cpus()[0].speed || 3000) / 1000
      },
      ramGb: Math.round((Number(j.ram) || os.totalmem()) / 1073741824),
      laptop: Number(j.bat) > 0 || /laptop|mobile|max-q/i.test(gpus[0] ? gpus[0].Name : ''),
      res: { w: Math.round(d.size.width * d.scaleFactor), h: Math.round(d.size.height * d.scaleFactor) }
    };
    sys.fps = estimateFps(sys);
    sysCache = sys;
    return sys;
  } catch { return { ok: false }; }
});

/* ---------------- RMS Fix-uri: dungile galbene ale străzilor = Anisotropic Filtering x16 ---------------- */
// 1) Joc: %APPDATA%\CitizenFX\gta5_settings.xml -> <AnisotropicFiltering value="16" /> (16 = x16, maximul din FiveM / GTA V).
//    Originalul se salvează o singură dată ca gta5_settings.xml.rms-backup (pentru „Anulează”).
// 2) Driver (setări globale), în funcție de placa video:
//    - NVIDIA (FĂRĂ fereastra de administrator): prin nvapi64.dll (instalat cu driverul): profilul global -> Filtrare anizotropă
//      „definit de utilizator” + nivel 16x, apoi se citește înapoi valoarea ca verificare; dacă driverul refuză -> pașii manuali;
//    - AMD (CU fereastra de administrator / UAC): registrul driverului (…\Class\{4d36e968-…}\000X\UMD\AnisoDegree = "16"),
//      pentru fiecare placă AMD, cu verificare;
//    - Intel / altele: nu există o metodă sigură -> se afișează pașii pentru setarea manuală.
const AF_LEVEL = 16;
const cfxSettingsFile = () => path.join(app.getPath('appData'), 'CitizenFX', 'gta5_settings.xml');
const afBackupFile = () => cfxSettingsFile() + '.rms-backup';
const AF_RE = /<AnisotropicFiltering\s+value="(\d+)"\s*\/>/i;
function afRead() {
  try { const x = fs.readFileSync(cfxSettingsFile(), 'utf8'); const m = x.match(AF_RE); return { exists: true, xml: x, value: m ? Number(m[1]) : null }; }
  catch { return { exists: false, xml: '', value: null }; }
}
async function gpuName() {
  if (sysCache && sysCache.gpu) return sysCache.gpu.name;
  if (process.platform !== 'win32') return '';
  const r = await winRun('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name) -join "|"']);
  const all = r.out.trim().split('|').filter(n => n && !/microsoft basic|virtual|parsec|remote|vmware|citrix|displaylink/i.test(n));
  return all.find(n => /nvidia|geforce|rtx|gtx/i.test(n)) || all.find(n => /amd|radeon/i.test(n)) || all[0] || '';
}
const gpuVendor = n => /nvidia|geforce|rtx|gtx|quadro/i.test(n) ? 'nvidia' : /amd|radeon/i.test(n) ? 'amd' : /intel|arc|iris|uhd/i.test(n) ? 'intel' : 'other';
// Scriptul scrie rezultatul în -Out (JSON). Intrare: -Vendor nvidia (rulat normal) | amd (rulat ca administrator).
const AF_PS = String.raw`param([string]$Out, [string]$Vendor, [string]$Mode = 'apply', [string]$Backup = '')
$ErrorActionPreference = 'Stop'
$res = @{ vendor = $Vendor; mode = $Mode }
$bk = $null
if ($Mode -eq 'undo' -and $Backup -and (Test-Path -LiteralPath $Backup)) { $bk = Get-Content -LiteralPath $Backup -Raw -Encoding UTF8 | ConvertFrom-Json }
if ($Vendor -eq 'nvidia') {
  try {
    $cs = @'
using System; using System.Runtime.InteropServices;
public static class RmsNvAf {
  [DllImport("nvapi64.dll", EntryPoint = "nvapi_QueryInterface", CallingConvention = CallingConvention.Cdecl)] static extern IntPtr QI(uint id);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int FInit();
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int FCreate(out IntPtr s);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int FSess(IntPtr s);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int FProf(IntPtr s, out IntPtr p);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int FSet(IntPtr s, IntPtr p, IntPtr st);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int FGet(IntPtr s, IntPtr p, uint id, IntPtr st);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int FDel(IntPtr s, IntPtr p, uint id);
  static T Fn<T>(uint id) where T : class { IntPtr p = QI(id); if (p == IntPtr.Zero) throw new Exception("nvapi 0x" + id.ToString("X8")); return Marshal.GetDelegateForFunctionPointer(p, typeof(T)) as T; }
  // NVDRS_SETTING_V1: 12320 octeți; settingId @4100, settingType @4104, valoarea curentă (u32) @8220
  const int SZ = 12320;
  static IntPtr Setting(uint id, uint val) {
    IntPtr b = Marshal.AllocHGlobal(SZ); for (int i = 0; i < SZ; i += 4) Marshal.WriteInt32(b, i, 0);
    Marshal.WriteInt32(b, 0, (int)(12320u | (1u << 16))); Marshal.WriteInt32(b, 4100, (int)id); Marshal.WriteInt32(b, 8220, (int)val); return b;
  }
  static void Ok(int r, string w) { if (r != 0) throw new Exception(w + " = " + r); }
  static long Read(IntPtr s, IntPtr p, uint id) { IntPtr b = Setting(0, 0); try { return Fn<FGet>(0x73BF8338)(s, p, id, b) == 0 ? (long)(uint)Marshal.ReadInt32(b, 8220) : -1; } finally { Marshal.FreeHGlobal(b); } }
  // Revine la valoarea de dinainte de fix: valoare salvată -> se pune la loc; setare care nu exista -> se șterge (revine la implicit)
  static void Restore1(IntPtr s, IntPtr p, uint id, long v) {
    if (v >= 0) {
      IntPtr b = Setting(id, (uint)v);
      try { Ok(Fn<FSet>(0x577DD202)(s, p, b), "SetSetting(restore)"); } finally { Marshal.FreeHGlobal(b); }
      return;
    }
    int r;
    try { r = Fn<FDel>(0xE4A26362)(s, p, id); }
    catch { r = -1; if (id == 0x10D2BB16) { IntPtr b = Setting(id, 0); try { Ok(Fn<FSet>(0x577DD202)(s, p, b), "SetSetting(app-controlled)"); } finally { Marshal.FreeHGlobal(b); } r = 0; } }
    if (r != 0 && r != -160) throw new Exception("DeleteProfileSetting = " + r);   // -160 = setarea nu exista deja
  }
  public static string Restore(long modeBefore, long levelBefore) {
    Ok(Fn<FInit>(0x0150E828)(), "Initialize");
    IntPtr s; Ok(Fn<FCreate>(0x0694D52E)(out s), "CreateSession");
    try {
      Ok(Fn<FSess>(0x375DBD6B)(s), "LoadSettings");
      IntPtr p; if (Fn<FProf>(0x617BFF9F)(s, out p) != 0) Ok(Fn<FProf>(0xDA8466A0)(s, out p), "GetBaseProfile");
      Restore1(s, p, 0x101E61A9, levelBefore);
      Restore1(s, p, 0x10D2BB16, modeBefore);
      Ok(Fn<FSess>(0xFCBC7E14)(s), "SaveSettings");
      return Read(s, p, 0x10D2BB16) + "|" + Read(s, p, 0x101E61A9);
    } finally { Fn<FSess>(0xDAD9CFF8)(s); }
  }
  public static string Apply(uint level) {
    Ok(Fn<FInit>(0x0150E828)(), "Initialize");
    IntPtr s; Ok(Fn<FCreate>(0x0694D52E)(out s), "CreateSession");
    try {
      Ok(Fn<FSess>(0x375DBD6B)(s), "LoadSettings");
      IntPtr p; if (Fn<FProf>(0x617BFF9F)(s, out p) != 0) Ok(Fn<FProf>(0xDA8466A0)(s, out p), "GetBaseProfile");   // profilul global curent (implicit „Base Profile”)
      long modeBefore = Read(s, p, 0x10D2BB16);
      long before = Read(s, p, 0x101E61A9);
      IntPtr a = Setting(0x10D2BB16, 1), b = Setting(0x101E61A9, level);   // ANISO_MODE_SELECTOR = utilizator, ANISO_MODE_LEVEL = 16x
      try { Ok(Fn<FSet>(0x577DD202)(s, p, a), "SetSetting(mode)"); Ok(Fn<FSet>(0x577DD202)(s, p, b), "SetSetting(level)"); }
      finally { Marshal.FreeHGlobal(a); Marshal.FreeHGlobal(b); }
      Ok(Fn<FSess>(0xFCBC7E14)(s), "SaveSettings");
      return before + ">" + Read(s, p, 0x101E61A9) + ">" + modeBefore;
    } finally { Fn<FSess>(0xDAD9CFF8)(s); }
  }
}
'@
    Add-Type -TypeDefinition $cs -Language CSharp
    if ($Mode -eq 'undo') {
      $m0 = -1; $l0 = -1
      if ($bk) { if ($null -ne $bk.m0) { $m0 = [long]$bk.m0 }; if ($null -ne $bk.l0) { $l0 = [long]$bk.l0 } }
      $r = ([RmsNvAf]::Restore($m0, $l0)).Split('|')
      $res.ok = $true; $res.mode0 = $r[0]; $res.level0 = $r[1]
    } else {
      $r = ([RmsNvAf]::Apply(16)).Split('>')
      $res.ok = ($r[1] -eq '16'); $res.before = $r[0]; $res.after = $r[1]; $res.l0 = [long]$r[0]; $res.m0 = [long]$r[2]
    }
  } catch { $res.ok = $false; $res.err = $_.Exception.Message }
}
elseif ($Vendor -eq 'amd') {
  try {
    $cls = 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}'
    $n = 0; $bytes = [Text.Encoding]::Unicode.GetBytes('16'); $items = @()
    foreach ($k in (Get-ChildItem -LiteralPath $cls -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -match '^\d{4}$' })) {
      $p = Get-ItemProperty -LiteralPath $k.PSPath -ErrorAction SilentlyContinue
      if (-not $p) { continue }
      if ("$($p.ProviderName) $($p.DriverDesc)" -notmatch 'Advanced Micro Devices|AMD|Radeon') { continue }
      $umd = Join-Path $k.PSPath 'UMD'
      if ($Mode -eq 'undo') {
        # revenire: valoarea veche se pune la loc, iar dacă nu exista, se șterge
        $it = $null; if ($bk -and $bk.items) { $it = @($bk.items) | Where-Object { $_.key -eq $k.PSChildName } | Select-Object -First 1 }
        if (-not (Test-Path -LiteralPath $umd)) { $n++; continue }
        if ($it -and $it.had) { New-ItemProperty -LiteralPath $umd -Name 'AnisoDegree' -PropertyType Binary -Value ([Convert]::FromBase64String($it.b64)) -Force | Out-Null }
        else { Remove-ItemProperty -LiteralPath $umd -Name 'AnisoDegree' -ErrorAction SilentlyContinue }
        $n++
        continue
      }
      $old = $null; if (Test-Path -LiteralPath $umd) { $old = (Get-ItemProperty -LiteralPath $umd -Name 'AnisoDegree' -ErrorAction SilentlyContinue).AnisoDegree }
      $items += @{ key = $k.PSChildName; had = ($null -ne $old); b64 = $(if ($null -ne $old) { [Convert]::ToBase64String([byte[]]$old) } else { '' }) }
      if (-not (Test-Path -LiteralPath $umd)) { New-Item -Path $umd -Force | Out-Null }
      New-ItemProperty -LiteralPath $umd -Name 'AnisoDegree' -PropertyType Binary -Value $bytes -Force | Out-Null
      $v = (Get-ItemProperty -LiteralPath $umd -Name 'AnisoDegree').AnisoDegree
      if ([Text.Encoding]::Unicode.GetString([byte[]]$v).Trim([char]0) -eq '16') { $n++ }
    }
    $res.ok = ($n -gt 0); $res.count = $n; $res.items = $items; if ($n -eq 0) { $res.err = 'nicio placa AMD in registru' }
  } catch { $res.ok = $false; $res.err = $_.Exception.Message }
}
($res | ConvertTo-Json -Compress) | Set-Content -LiteralPath $Out -Encoding UTF8
`;
// NVIDIA: rulează AF_PS ca utilizator normal (fără fereastră). AMD: ca administrator (apare fereastra UAC).
// Rezultat: applied | denied | failed | manual
const afDrvBackupFile = () => path.join(app.getPath('userData'), 'af-driver-backup.json');
async function driverAf16(vendor) { return driverAf(vendor, 'apply', null); }
// mode: 'apply' (pune 16x și întoarce valorile vechi) | 'undo' (pune la loc valorile din backup; backupObj = conținutul salvat)
async function driverAf(vendor, mode, backupObj) {
  if (process.platform !== 'win32' || (vendor !== 'nvidia' && vendor !== 'amd')) return { status: 'manual' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rms-af-'));
  const ps1 = path.join(dir, 'af16.ps1'), out = path.join(dir, 'result.json'), bkf = path.join(dir, 'backup.json');
  try {
    fs.writeFileSync(ps1, '\ufeff' + AF_PS.replace(/\r?\n/g, '\r\n'), 'utf8');
    if (backupObj) fs.writeFileSync(bkf, '\ufeff' + JSON.stringify(backupObj), 'utf8');
    if (vendor === 'nvidia') {
      await winRun('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Out', out, '-Vendor', 'nvidia', '-Mode', mode, '-Backup', bkf]);
    } else {
    const q = x => "'" + String(x).replace(/'/g, "''") + "'";
    const arg = x => "('\"' + " + q(x) + " + '\"')";   // fiecare cale între ghilimele (pot avea spații)
    const cmd = "try { Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File'," +
      arg(ps1) + ",'-Out'," + arg(out) + ",'-Vendor','" + vendor + "','-Mode','" + mode + "','-Backup'," + arg(bkf) + "); 'started' } catch { 'denied' }";
    const r = await winRun('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd]);
    if (/denied/.test(r.out)) { ilog('Fix AF driver ' + vendor + ': cererea de administrator a fost refuzată'); return { status: 'denied' }; }
    }
    let j = null; try { j = JSON.parse(fs.readFileSync(out, 'utf8').replace(/^\ufeff/, '')); } catch {}
    ilog('Fix AF driver ' + vendor + ': ' + (j ? JSON.stringify(j) : 'fără rezultat'));
    if (!j) return { status: 'failed', err: 'no_result' };
    return j.ok ? { status: 'applied', before: j.before, count: j.count, prev: vendor === 'nvidia' ? { vendor, m0: j.m0, l0: j.l0 } : { vendor, items: j.items || [] } } : { status: 'failed', err: j.err || 'unknown' };
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
}
ipcMain.handle('fix-af-status', async () => {
  const st = afRead(), name = await gpuName().catch(() => '');
  return { exists: st.exists, value: st.value, target: AF_LEVEL, backup: fs.existsSync(afBackupFile()) || fs.existsSync(afDrvBackupFile()), gpu: name, vendor: gpuVendor(name) };
});
ipcMain.handle('fix-af-apply', async () => {
  try {
    if (await fivemRunning()) return { ok: false, error: 'running' };   // FiveM rescrie fișierul la închidere
    const f = cfxSettingsFile(), st = afRead();
    if (!st.exists) return { ok: false, error: 'no_settings' };
    let x = st.xml;
    if (AF_RE.test(x)) x = x.replace(AF_RE, '<AnisotropicFiltering value="' + AF_LEVEL + '" />');
    else if (/<\/graphics>/i.test(x)) x = x.replace(/(\r?\n?)([ \t]*)<\/graphics>/i, (m, nl, ind) => (nl || '\r\n') + ind + '  <AnisotropicFiltering value="' + AF_LEVEL + '" />' + (nl || '\r\n') + ind + '</graphics>');
    else return { ok: false, error: 'bad_settings' };
    if (!fs.existsSync(afBackupFile())) fs.copyFileSync(f, afBackupFile());
    try { await attribMany('-r', [f]); } catch {}
    fs.writeFileSync(f, x, 'utf8');
    const after = afRead().value;
    if (after !== AF_LEVEL) return { ok: false, error: 'write_failed' };
    const name = await gpuName().catch(() => ''), vendor = gpuVendor(name);
    ilog('Fix AF x' + AF_LEVEL + ': gta5_settings.xml ' + st.value + ' -> ' + after + ' | GPU: ' + name);
    const drv = await driverAf16(vendor);   // setarea globală din driver (NVIDIA / AMD), ca administrator
    // valorile de dinainte din driver se salvează o singură dată (prima aplicare), ca „Anulează” să poată reveni exact la ele
    try { if (drv.status === 'applied' && drv.prev && !fs.existsSync(afDrvBackupFile())) fs.writeFileSync(afDrvBackupFile(), JSON.stringify(drv.prev)); } catch {}
    return { ok: true, before: st.value, after, gpu: name, vendor, driver: drv.status, driverErr: drv.err || '' };
  } catch (e) { return { ok: false, error: String((e && e.code) || (e && e.message) || e) }; }
});
ipcMain.handle('fix-af-undo', async () => {
  try {
    if (await fivemRunning()) return { ok: false, error: 'running' };
    const hasX = fs.existsSync(afBackupFile()), hasD = fs.existsSync(afDrvBackupFile());
    if (!hasX && !hasD) return { ok: false, error: 'no_backup' };
    if (hasX) {
      try { await attribMany('-r', [cfxSettingsFile()]); } catch {}
      fs.copyFileSync(afBackupFile(), cfxSettingsFile()); fs.unlinkSync(afBackupFile());
    }
    // driver: valorile din NVIDIA / AMD revin exact la cele de dinainte de fix (sau la implicit dacă nu exista setarea)
    const name = await gpuName().catch(() => ''), vendor = gpuVendor(name);
    let drv = { status: 'none' };
    let bk = null; try { bk = JSON.parse(fs.readFileSync(afDrvBackupFile(), 'utf8')); } catch {}
    if (!bk && hasX && vendor === 'nvidia') bk = { vendor: 'nvidia', m0: -1, l0: -1 };   // fix aplicat de o versiune veche, fără backup: revine la implicit
    if (bk && bk.vendor === vendor && (vendor === 'nvidia' || vendor === 'amd')) {
      drv = await driverAf(vendor, 'undo', bk);
      ilog('Anulare fix AF driver ' + vendor + ': ' + drv.status + (drv.err ? ' [' + drv.err + ']' : ''));
      if (drv.status === 'applied') { try { fs.unlinkSync(afDrvBackupFile()); } catch {} }
    }
    return { ok: true, value: afRead().value, driver: drv.status, driverErr: drv.err || '', vendor, gpu: name };
  } catch (e) { return { ok: false, error: String((e && e.code) || e) }; }
});

/* ---------------- Curățare cache FiveM ---------------- */
// Se curăță DOAR conținutul din: cache, server-cache, server-cache-priv (în %LOCALAPPDATA%\FiveM\FiveM.app\data).
// Subfolderul "game" (fișierele GTA V) din cache și server-cache NU se șterge niciodată. Nu se atinge nimic altceva (mods, plugins, citizen, setări).
const CACHE_GROUPS = {
  cache:   [{ rel: ['cache'], keep: ['game'] }],
  servers: [{ rel: ['server-cache'], keep: ['game'] }],
  priv:    [{ rel: ['server-cache-priv'], keep: [] }]
};
function fivemDataDir() {
  const la = process.env.LOCALAPPDATA || '';
  const base = currentPaths().fivem;
  const c = [];
  if (base) c.push(path.join(base, 'data'), path.join(base, 'FiveM.app', 'data'), path.join(path.dirname(base), 'FiveM.app', 'data'));
  if (la) c.push(path.join(la, 'FiveM', 'FiveM.app', 'data'));
  return c.find(isDir) || null;
}
async function dirBytes(p) {
  let total = 0;
  let ents = [];
  try { ents = await fs.promises.readdir(p, { withFileTypes: true }); } catch { return 0; }
  for (const e of ents) {
    const f = path.join(p, e.name);
    try {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) total += await dirBytes(f);
      else total += (await fs.promises.stat(f)).size;
    } catch {}
  }
  return total;
}
async function groupBytes(dataDir, id) {
  let total = 0;
  for (const t of CACHE_GROUPS[id]) {
    const root = path.join(dataDir, ...t.rel);
    let ents = [];
    try { ents = await fs.promises.readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (t.keep.includes(e.name.toLowerCase()) || e.isSymbolicLink()) continue;
      const f = path.join(root, e.name);
      try { total += e.isDirectory() ? await dirBytes(f) : (await fs.promises.stat(f)).size; } catch {}
    }
  }
  return total;
}
async function fivemRunning() {
  if (process.platform !== 'win32') return false;
  const r = await new Promise(res => execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 1 << 24 }, (err, out) => res(String(out || ''))));
  return r.split(/\r?\n/).some(l => /^"(fivem|citizenfx)/i.test(l));
}
// Data ultimei curățări manuale reușite a cache-ului FiveM, ca userul să vadă singur „acum X zile” în tab,
// fără să mai fie nevoie de o curățare automată impusă.
const cacheCleanFile = () => path.join(app.getPath('userData'), 'cache-clean.json');
function getLastCacheClean() { try { return Number(JSON.parse(fs.readFileSync(cacheCleanFile(), 'utf8')).ts) || 0; } catch { return 0; } }
function setLastCacheClean() { try { fs.writeFileSync(cacheCleanFile(), JSON.stringify({ ts: Date.now() })); } catch {} }
async function cacheScan() {
  const dir = fivemDataDir();
  const running = await fivemRunning();
  if (!dir) return { ok: false, error: 'no_fivem', running, lastCleaned: getLastCacheClean() };
  const groups = {};
  for (const id of Object.keys(CACHE_GROUPS)) groups[id] = await groupBytes(dir, id);
  return { ok: true, running, groups, total: Object.values(groups).reduce((a, b) => a + b, 0), lastCleaned: getLastCacheClean() };
}
ipcMain.handle('cache-scan', () => cacheScan());
// Logica efectivă de curățare, separată de handler-ul IPC ca să poată fi refolosită și automat
// (după o instalare/actualizare reușită), fără verificarea downloadBusy a butonului manual (în timpul
// instalării downloadBusy e oricum true, deci handler-ul manual s-ar bloca singur).
async function doCacheClean(dir, ids) {
  const sel = (Array.isArray(ids) ? ids : []).filter(id => CACHE_GROUPS[id]);
  if (!sel.length) return { ok: false, error: 'nothing' };
  const before = {};
  for (const id of sel) before[id] = await groupBytes(dir, id);
  let failed = 0;
  for (const id of sel) {
    for (const t of CACHE_GROUPS[id]) {
      const root = path.join(dir, ...t.rel);
      let ents = [];
      try { ents = await fs.promises.readdir(root, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        if (t.keep.includes(e.name.toLowerCase())) continue;
        const f = path.join(root, e.name);
        if (path.relative(dir, f).startsWith('..')) continue;          // siguranță: niciodată în afara folderului data
        try { await fs.promises.rm(f, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }); } catch { failed++; }
      }
      try { await fs.promises.rmdir(root); } catch {}   // folderul gol se șterge și el (FiveM îl recreează)
    }
  }
  let after = 0;
  for (const id of sel) after += await groupBytes(dir, id);
  const freed = Math.max(0, Object.values(before).reduce((a, b) => a + b, 0) - after);
  const scan = await cacheScan();
  return { ok: true, freed, failed: after > 0 && failed > 0 ? failed : 0, scan };
}
ipcMain.handle('cache-clean', async (_e, ids) => {
  try {
    if (downloadBusy) return { ok: false, error: 'busy' };
    const dir = fivemDataDir();
    if (!dir) return { ok: false, error: 'no_fivem' };
    if (await fivemRunning()) return { ok: false, error: 'running' };
    const r = await doCacheClean(dir, ids);
    if (r && r.ok) setLastCacheClean();
    if (r && r.scan) r.scan.lastCleaned = getLastCacheClean();
    return r;
  } catch (e) { return { ok: false, error: 'fail' }; }
});
// Curățarea automată a cache-ului FiveM după instalare a fost eliminată la cerere — cache-ul FiveM nu se mai
// atinge automat; rămâne disponibilă doar curățarea manuală din tab-ul „FiveM Cache Cleaner”.

/* ---------------- Tab „RMS Performanță”: fișiere inutile Windows + cache placă video ---------------- */
// NU are legătură cu FiveM / GTA V. Se șterg doar fișiere (folderele rădăcină rămân); fișierele folosite chiar acum
// sau fără drepturi (unele foldere din C:\Windows cer administrator) se sar.
// Fișierele temporare se șterg doar dacă sunt mai vechi de PERF_TEMP_HOURS ore (ca să nu stricăm un program care rulează acum),
// iar folderul launcherului (cache + varianta portable dezarhivată în Temp) nu se atinge niciodată.
const PERF_TEMP_HOURS = 24;
function perfGroups() {
  const la = process.env.LOCALAPPDATA || '', pd = process.env.ProgramData || '', win = process.env.SystemRoot || process.env.windir || '';
  const temp = process.env.TEMP || os.tmpdir();
  const J = (...a) => (a[0] ? path.join(...a) : '');
  const own = [path.join(os.tmpdir(), 'rms-launcher-cache'), path.dirname(process.execPath)].map(x => path.resolve(x).toLowerCase());
  const notOwn = f => { const x = path.resolve(f).toLowerCase(); return !own.some(o => x === o || x.startsWith(o + path.sep)); };
  const age = st => Date.now() - Math.max(st.mtimeMs || 0, st.birthtimeMs || 0);   // fișierele abia create / dezarhivate au birthtime nou
  const oldTemp = (f, st) => notOwn(f) && age(st) > PERF_TEMP_HOURS * 3600000;
  const dmp = f => /\.(dmp|mdmp|hdmp)$/i.test(f);
  const thumb = f => /^(thumbcache|iconcache)_.*\.db$/i.test(path.basename(f));
  return {
    temp:    [{ dir: temp, filter: oldTemp, noPrune: true }, { dir: J(win, 'Temp'), filter: oldTemp, noPrune: true }],
    wer:     [{ dir: J(la, 'CrashDumps'), filter: dmp }, { dir: J(la, 'Microsoft', 'Windows', 'WER') }, { dir: J(pd, 'Microsoft', 'Windows', 'WER', 'ReportArchive') }, { dir: J(pd, 'Microsoft', 'Windows', 'WER', 'ReportQueue') }],
    wupdate: [{ dir: J(win, 'SoftwareDistribution', 'Download'), filter: (f, st) => age(st) > 86400000 }],
    thumbs:  [{ dir: J(la, 'Microsoft', 'Windows', 'Explorer'), filter: thumb, noPrune: true, flat: true }],
    nvidia:  [{ dir: J(la, 'NVIDIA', 'DXCache') }, { dir: J(la, 'NVIDIA', 'GLCache') }, { dir: J(la ? la + 'Low' : '', 'NVIDIA', 'PerDriverVersion', 'DXCache') }, { dir: J(pd, 'NVIDIA Corporation', 'NV_Cache') }],
    amd:     [{ dir: J(la, 'AMD', 'DxCache') }, { dir: J(la, 'AMD', 'DxcCache') }, { dir: J(la, 'AMD', 'GLCache') }, { dir: J(la, 'AMD', 'VkCache') }],
    dx:      [{ dir: J(la, 'D3DSCache') }]
  };
}
async function perfWalk(root, g, out, ctx, depth = 0) {
  let ents;
  try { ents = await fs.promises.readdir(root, { withFileTypes: true }); }
  catch (e) { if (e && (e.code === 'EPERM' || e.code === 'EACCES')) ctx.denied = true; return; }
  for (const e of ents) {
    if (e.isSymbolicLink()) continue;
    const f = path.join(root, e.name);
    if (e.isDirectory()) { if (!g.flat) await perfWalk(f, g, out, ctx, depth + 1); }
    else { try { const st = await fs.promises.stat(f); if (!g.filter || g.filter(f, st)) out.push([f, st.size]); } catch {} }
  }
}
async function perfGroupFiles(list, ctx = {}) {
  const out = [];
  for (const g of list) if (g.dir && isDir(g.dir)) await perfWalk(g.dir, g, out, ctx);
  return out;
}
async function perfScan() {
  const groups = {}, G = perfGroups();
  for (const [id, list] of Object.entries(G)) {
    const ctx = {}, files = await perfGroupFiles(list, ctx);
    groups[id] = { bytes: files.reduce((a, x) => a + x[1], 0), files: files.length, found: list.some(g => g.dir && isDir(g.dir)), admin: !!ctx.denied };
  }
  return { ok: true, groups, total: Object.values(groups).reduce((a, g) => a + g.bytes, 0), tempHours: PERF_TEMP_HOURS };
}
async function pruneEmptyDirs(d, root) {
  let ents; try { ents = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
  for (const e of ents) if (e.isDirectory() && !e.isSymbolicLink()) await pruneEmptyDirs(path.join(d, e.name), root);
  if (d !== root) { try { await fs.promises.rmdir(d); } catch {} }
}
ipcMain.handle('perf-scan', () => perfScan());
ipcMain.handle('perf-clean', async (_e, ids) => {
  try {
    const G = perfGroups(), sel = (Array.isArray(ids) ? ids : []).filter(id => G[id]);
    if (!sel.length) return { ok: false, error: 'nothing' };
    let freed = 0, failed = 0;
    for (const id of sel) {
      for (const [f, size] of await perfGroupFiles(G[id])) {
        try { await fs.promises.unlink(f); freed += size; } catch (e) { if (!e || e.code !== 'ENOENT') failed++; }   // în uz / fără drepturi: rămâne
      }
      for (const g of G[id]) if (g.dir && !g.noPrune && isDir(g.dir)) await pruneEmptyDirs(g.dir, g.dir);
    }
    ilog('Curățare Windows / placă video (' + sel.join(', ') + '): eliberat ' + freed + ' B | fișiere sărite (în uz / fără drepturi): ' + failed);
    return { ok: true, freed, failed, scan: await perfScan() };
  } catch (e) { return { ok: false, error: 'fail' }; }
});

ipcMain.handle('discord-login', async (_e, theme) => {
  if (!isId(cfg.CLIENT_ID) || !isId(cfg.ROLE_ID)) return getStatus();
  await discordLogin(theme);
  return getStatus();
});
ipcMain.on('discord-login-cancel', () => { if (cancelLogin) cancelLogin(); });
ipcMain.handle('discord-logout', () => { clearToken(); clearStatusDisk(); cachedUser = null; return { state: 'logged_out' }; });
ipcMain.on('discord-join', () => shell.openExternal(cfg.INVITE_URL));

/* ---------------- Curățare la oprire / eșec ---------------- */
// Ținem evidența a ce a creat instalarea curentă. Dacă nu se termină cu succes (eșec, Anulează sau închiderea aplicației),
// se șterg fișierele NOI copiate, folderele temporare și descărcarea incompletă (.part). Fișierele care existau deja
// (și au fost înlocuite) nu se șterg, ca să nu strici jocul. O arhivă descărcată complet rămâne, ca să nu se descarce din nou.
const journal = { finals: [], all: [], newDirs: [], topDirs: [], roots: [], stages: [], tmp: null };
const sleepSync = ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };
function rmRetry(p, dir) {
  for (let i = 0; i < 5; i++) {
    try { if (dir) fs.rmSync(p, { recursive: true, force: true }); else fs.unlinkSync(p); return; }
    catch (e) { if (e && e.code === 'ENOENT') return; sleepSync(250); }
  }
}
function cleanupInstall() {
  try {
    const parents = new Set();
    for (const f of journal.finals) { rmRetry(f, false); parents.add(path.dirname(f)); }
    for (const s of journal.stages) rmRetry(s, true);
    if (journal.tmp) rmRetry(journal.tmp, false);
    // scoate folderele rămase goale (doar în interiorul folderelor FiveM / GTA alese)
    const roots = journal.roots.map(r => path.resolve(r).toLowerCase());
    const dirs = [...parents].sort((a, b) => b.length - a.length);
    for (let d of dirs) {
      while (true) {
        const low = path.resolve(d).toLowerCase();
        if (roots.includes(low) || !roots.some(r => low.startsWith(r + path.sep))) break;
        try { fs.rmdirSync(d); } catch { break; }
        d = path.dirname(d);
      }
    }
  } catch {}
  journal.finals = []; journal.all = []; journal.newDirs = []; journal.topDirs = []; journal.tmp = null;
}

// la închiderea aplicației în timpul unei descărcări / instalări: oprim procesele, ștergem ce e incomplet și abia apoi ieșim
let quitting = false;
app.on('before-quit', e => {
  if (quitting || !downloadBusy) return;
  quitting = true; e.preventDefault();
  installCancelled = true;
  try { if (activeDownload) activeDownload.abort(); } catch {}
  let t; try { t = installWorker && installWorker.terminate(); } catch {}
  const finish = () => { cleanupInstall(); app.exit(0); };
  Promise.resolve(t).catch(() => {}).then(() => new Promise(r => setTimeout(r, 900))).then(finish);
  setTimeout(finish, 6000);
});

/* ---------------- Descărcare arhivă (Google Drive / MediaFire / orice link direct https) ---------------- */
let downloadBusy = false;
// Lacăt pe disc (valabil ÎNTRE PROCESE): launcherul cu fereastră și watchdog-ul fără fereastră (pornit la login prin
// Scheduled Task, vezi WATCHDOG mai jos) sunt DOUĂ procese separate, fiecare cu propria variabilă downloadBusy în
// memorie — una nu știe de cealaltă. Fără lacătul ăsta, watchdog-ul putea „prinde” o instalare/dezinstalare în curs
// (care face temporar vizibile fișierele, ca să le poată muta/șterge — normal, nu e nicio tentativă de deblocare) și
// o trata greșit ca tamper: re-ascundea fișiere exact cât erau mutate și trimitea alertă falsă pe Discord. Același
// risc exista și ÎN ACELAȘI proces: rehideTick() rulează la fiecare 30s, iar PowerShell-ul pe care îl așteaptă poate
// dura; dacă o instalare pornește chiar în acel interval de așteptare, rezultatul citit e deja depășit.
const busyLockFile = () => path.join(app.getPath('userData'), 'rms-busy.lock');
const BUSY_LOCK_MAX_AGE_MS = 20 * 60 * 1000;   // lacăt „înțepenit” (proces oprit brusc, fără cleanup) ignorat după 20 min
// Numărăm operațiile active (nu doar true/false): dacă 2+ operații rulează suprapus (ex. mai multe clickuri rapide pe
// „Dezinstalare”/„Instalează” la module diferite), prima care termină nu mai are voie să ridice lacătul cât timp
// altă operație e încă în curs — altfel apărea exact fereastra în care watchdog-ul prindea o alertă falsă de tamper.
let busyCount = 0;
// Marcaj de timp al ULTIMEI activități reale (progres descărcare/extragere) cât timp busyCount > 0 — NU doar
// momentul de start. O descărcare mare, legitimă, poate dura mult mai mult decât BUSY_LOCK_MAX_AGE_MS, dar tot
// trimite progres constant, deci watchdog-ul de mai jos n-o va atinge; doar o operație cu adevărat „agățată”
// (ex. un PowerShell ACL/attrib care n-a mai răspuns niciodată) rămâne fără nicio activitate atât de mult timp.
let busySince = 0;
function setBusy(v) {
  busyCount = Math.max(0, busyCount + (v ? 1 : -1));
  downloadBusy = busyCount > 0;
  busySince = downloadBusy ? (busySince || Date.now()) : 0;
  try { if (downloadBusy) fs.writeFileSync(busyLockFile(), String(Date.now())); else fs.unlinkSync(busyLockFile()); } catch {}
}
function touchBusy() { if (downloadBusy) busySince = Date.now(); }
function isBusyLocked() {
  try {
    const t = Number(fs.readFileSync(busyLockFile(), 'utf8'));
    if (!t || Date.now() - t > BUSY_LOCK_MAX_AGE_MS) return false;
    return true;
  } catch { return false; }
}
// plasă de siguranță: dacă starea „busy” rămâne ridicată, FĂRĂ niciun progres de descărcare/extragere, mai mult
// de BUSY_LOCK_MAX_AGE_MS, se resetează automat — altfel toate butoanele din launcher rămâneau blocate pe
// „Altă descărcare sau instalare rulează deja” la nesfârșit, fără nicio cale de recuperare în afară de restart
// manual al aplicației. Apelată periodic (vezi setInterval la pornire).
function autoClearStaleBusy() {
  if (downloadBusy && busySince && Date.now() - busySince > BUSY_LOCK_MAX_AGE_MS) {
    ilog('⚠ Stare „busy” blocată fără progres de peste ' + Math.round(BUSY_LOCK_MAX_AGE_MS / 60000) + ' min — resetată automat.');
    busyCount = 0; downloadBusy = false; busySince = 0;
    try { fs.unlinkSync(busyLockFile()); } catch {}
  }
}
let activeDownload = null;
let lastDownloadPath = null;

const estimatedTotal = () => Math.round((Number(cfg.DOWNLOAD_SIZE_GB) || 0) * 1073741824);

const packConfigured = () => URL_RE.test(String(cfg.PACK_URL || ''));

// Citește dimensiunea reală a arhivei principale (doar metadate, fără descărcare) — același motor (HEAD/GET,
// cu ocolirea paginii de avertisment Google Drive) folosit și pentru pachetele opționale (probeRemoteSize mai jos).
async function probePackSize() {
  await resolvePackAccess();
  if (!packConfigured()) throw new Error('no_meta');
  const bytes = await probeRemoteSize(cfg.PACK_URL);
  if (!bytes) throw new Error('no_meta');
  return bytes;
}

// Traduce erorile de descărcare în coduri scurte pe care le înțelege interfața.
function downloadError(e) {
  if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR')) return e;
  const msg = String((e && (e.message || e.code)) || e);
  // \b403\b prinde și refuzul MediaFire (anti-leech/link expirat) — tratat ca „încearcă mai târziu", la fel ca o cotă
  if (/quota|too\s+many\s+users|download\s+limit|bandwidth|transfer.*limit|\b429\b|\b509\b|\b403\b/i.test(msg)) return new Error('pack_quota');
  if (/ENOENT|not\s*found|\b404\b|\b410\b|deleted|drive_nolink/i.test(msg)) return new Error('pack_notfound');
  return e instanceof Error ? e : new Error(msg.slice(0, 120));
}

async function downloadArchive(filePath, send, o) {
  const ctrl = new AbortController();
  activeDownload = ctrl;
  const tmp = filePath + '.part';
  journal.tmp = tmp;
  try {
    if (installCancelled) ctrl.abort();
    ctrl.signal.throwIfAborted();
    // Descărcarea + decriptarea rulează într-un worker thread: procesul principal rămâne liber, deci aplicația răspunde normal.
    await new Promise((resolve, reject) => {
      const w = spawnWorkerFromFile('download-worker.js', { url: (o && o.url) || cfg.PACK_URL, tmp, knownSize: o ? 0 : (packSize || 0), estimated: o ? (o.estimated || 0) : estimatedTotal() });
      let settled = false;
      const onAbort = () => {
        try { w.postMessage('abort'); } catch {}
        w.terminate().catch(() => {});   // oprire imediată (fără așteptare): fișierul .part se șterge după
      };
      const end = fn => {
        if (settled) return;
        settled = true;
        ctrl.signal.removeEventListener('abort', onAbort);
        setTimeout(() => { w.terminate().catch(() => {}); }, 200);
        fn();
      };
      ctrl.signal.addEventListener('abort', onAbort);
      w.on('message', m => {
        if (m.type === 'progress') { touchBusy(); send({ received: m.received, total: m.total, speed: m.speed }); }
        else if (m.type === 'done') end(() => resolve(m));
        else if (m.type === 'error') {
          // mesajul REAL, înainte de clasificarea în pack_quota/pack_notfound — altfel în log apare doar codul scurt
          // (ex. „pack_quota”), fără să se vadă ce eroare concretă a dat (HTTP 403, link negăsit pe MediaFire etc.)
          ilog('Descărcare eșuată: ' + String(m.message || '').slice(0, 200));
          end(() => reject(downloadError(Object.assign(new Error(m.message), { name: m.name || 'Error', code: m.code }))));
        }
      });
      w.on('error', e => { ilog('Descărcare eșuată (worker): ' + String((e && e.message) || e).slice(0, 200)); end(() => reject(downloadError(e))); });
      w.on('exit', code => setTimeout(() => end(() => reject(ctrl.signal.aborted ? Object.assign(new Error('aborted'), { name: 'AbortError' }) : new Error('worker_exit_' + code))), 400));
    });

    try { fs.unlinkSync(filePath); } catch {}
    fs.renameSync(tmp, filePath);
    const size = (() => { try { return fs.statSync(filePath).size; } catch { return 0; } })();
    send({ received: size, total: size, speed: 0 });
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  } finally {
    activeDownload = null;
  }
}

// Citește dimensiunea reală a arhivei principale (doar metadate, fără descărcare).
let packSize = null;
ipcMain.handle('pack-refresh', async () => { await refreshRemote(); return true; });
ipcMain.handle('changelog', async () => { await cfgReady; return cfg.CHANGELOG; });

// După o instalare reușită (Auto Install) la ultima versiune, arhiva se șterge, iar Auto Install și „Descarcă din nou” rămân blocate
// până apare un update al pachetului sau până se dezinstalează RMS.
function packLocked() {
  try {
    const st = readPackState();
    // folosește instVer/instUpdated (versiunea CHIAR instalată), nu current (versiunea arhivei descărcate) — altfel
    // o redescărcare de update blochează fals Auto Install imediat, înainte să fi apucat să ruleze instalarea
    if (!(isRmsInstalled() && st.instVer > 0 && Number(cfg.PACK_VERSION) <= st.instVer)) return false;
    // aceeași versiune (numărul nu s-a schimbat), dar arhiva a fost reîmprospătată pe server (data/ora din manifest
    // s-a schimbat): nu mai blocăm Auto Install, ca să poată fi reinstalată arhiva nouă
    if (cfg.UPDATE_DATE && st.instUpdated && String(cfg.UPDATE_DATE) !== String(st.instUpdated)) return false;
    return true;
  } catch { return false; }
}

// Dacă mod-ul e instalat de launcher, dar versiunea nu s-a salvat (ex. instalat cât manifestul online încă nu se încărcase → versiune 0),
// o deducem: instalarea făcută la/după data ultimului update al pachetului = versiunea curentă. Se salvează, deci apare normal și la restart.
function healPackState(st) {
  try {
    if (st.current > 0 || !isRmsInstalled() || !(Number(cfg.PACK_VERSION) > 0)) return st;
    // Versiunea instalată nu a fost niciodată salvată (instalare mai veche / date resetate): nu o putem afla exact.
    // Folosim versiunea curentă din manifest ca punct de plecare, ca să nu apară „Necunoscută”; la următorul update din gist se anunță normal.
    setPackState({ current: cfg.PACK_VERSION, currentName: packLabel(), currentUpdated: cfg.UPDATE_DATE, instVer: cfg.PACK_VERSION, instUpdated: cfg.UPDATE_DATE });
    return readPackState();
  } catch {}
  return st;
}

// folosit atât de 'pack-meta', cât și de notificarea de mai jos — ca „updateAvailable” să însemne mereu același lucru
function packUpdateAvailable() {
  const st = healPackState(readPackState());
  const hasPack = isRmsInstalled() || st.current > 0;
  return hasPack && (cfg.PACK_VERSION > st.current || (st.current > 0 && !!cfg.UPDATE_DATE && !!st.currentUpdated && String(cfg.UPDATE_DATE) !== String(st.currentUpdated)));
}

// Notificare nativă pe desktop (Windows) când apare un update nou de pachet în manifest — utilă când launcherul
// rulează minimizat / în fundal (ex. cât timp joci), la fel cum Windows arată o notificare la finalul unei descărcări.
// Se trimite o singură dată per update (identificat prin versiune + data din manifest, ca un refresh de arhivă fără
// bump de versiune să conteze tot ca „nou”); dacă update-ul dispare (a fost instalat), cheia se resetează, ca un
// eventual update viitor cu aceleași valori să poată notifica din nou.
const packNotifyFile = () => path.join(app.getPath('userData'), 'pack-notify.json');
function readPackNotifyKey() { try { return String(JSON.parse(fs.readFileSync(packNotifyFile(), 'utf8')).key || ''); } catch { return ''; } }
function writePackNotifyKey(key) { try { fs.writeFileSync(packNotifyFile(), JSON.stringify({ key })); } catch {} }
// construiește + arată notificarea nativă (folosită atât de verificarea reală, cât și de butonul de preview din Setări)
function showPackUpdateNotification() {
  if (!Notification.isSupported()) return false;
  const n = new Notification({
    title: 'RMS GRAPHICS Launcher',
    body: 'RMS GRAPHICS a primit un update nou' + (packLabel() ? ' (' + packLabel() + ')' : '') + '! Deschide tab-ul „RMS Actualizări” din launcher ca să-l descarci.',
    icon: path.join(__dirname, 'icon1.ico')
  });
  n.on('click', () => {
    try {
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      win.flashFrame(false);
    } catch {}
  });
  n.show();
  // fallback: dacă Windows are notificările oprite pentru launcher (sau Focus Assist pornit), Electron nu are cum
  // să afle — nu există API care să forțeze afișarea lor fără acordul userului din Windows. Clipim în schimb
  // iconița din taskbar, care funcționează indiferent de acea setare, cât timp fereastra nu e deja în prim-plan.
  try { if (win && !win.isDestroyed() && !win.isFocused()) win.flashFrame(true); } catch {}
  return true;
}
function maybeNotifyPackUpdate() {
  try {
    if (!packUpdateAvailable()) { if (readPackNotifyKey()) writePackNotifyKey(''); return; }
    const key = String(cfg.PACK_VERSION) + '|' + String(cfg.UPDATE_DATE || '');
    if (readPackNotifyKey() === key) return;
    writePackNotifyKey(key);
    showPackUpdateNotification();
  } catch {}
}
ipcMain.handle('pack-meta', async () => {
  await cfgReady;
  const st = healPackState(readPackState());
  // „are pachetul” = instalat prin Auto Install SAU descărcat din tab-ul Descărcări
  const hasPack = isRmsInstalled() || st.current > 0;
  return {
    updated: String(cfg.UPDATE_DATE || ''),
    changelog: cfg.CHANGELOG,   // lista de noutăți din gist (null = se folosește cea din index.html); trece prin canalul „pack-meta” deja existent
    version: cfg.PACK_VERSION, versionLabel: packLabel(),                // cea mai nouă (din manifest)
    installed: hasPack, installedVersion: st.current, installedLabel: hasPack ? (st.currentName || (st.current ? 'v' + st.current : '')) : '',
    updateAvailable: packUpdateAvailable(),
    locked: packLocked()
  };
});

// Notificare „e un update nou” (insignă NEW pe tab-ul Descărcări + redirecționare automată acolo) — NUMAI o dată
// pe pornire de aplicație, nu la fiecare reîmprospătare periodică a pack-meta. Ciclul de viață cerut:
//  - update nou apărut în manifest, nevăzut încă de user => la URMĂTOAREA pornire a launcherului: insignă + redirect
//  - a doua pornire după aceea (tot fără să fi actualizat) => insigna dispare, fără redirect
//  - identitatea „update-ului” e (versiune + data din manifest), ca o arhivă reîmprospătată fără bump de versiune
//    să conteze tot ca update nou
const packBadgeFile = () => path.join(app.getPath('userData'), 'pack-badge.json');
function readPackBadge() { try { const j = JSON.parse(fs.readFileSync(packBadgeFile(), 'utf8')); return { key: String(j.key || ''), shown: !!j.shown }; } catch { return { key: '', shown: false }; } }
function writePackBadge(v) { try { fs.writeFileSync(packBadgeFile(), JSON.stringify(v)); } catch {} }
ipcMain.handle('pack-update-notice', async () => {
  await cfgReady;
  const updateAvailable = packUpdateAvailable();
  const badge = readPackBadge();
  if (!updateAvailable) {
    if (badge.key || badge.shown) writePackBadge({ key: '', shown: false });   // s-a actualizat / nu mai e nimic de anunțat
    return { showBadge: false, autoGoDownloads: false };
  }
  const key = String(cfg.PACK_VERSION) + '|' + String(cfg.UPDATE_DATE || '');
  if (badge.key !== key) { writePackBadge({ key, shown: true }); return { showBadge: true, autoGoDownloads: true }; }   // prima pornire cu acest update
  if (!badge.shown) { writePackBadge({ key, shown: true }); return { showBadge: true, autoGoDownloads: true }; }
  return { showBadge: false, autoGoDownloads: false };   // a doua pornire (sau mai mult) cu același update: nu mai anunțăm
});

ipcMain.handle('download-info', async () => {
  await cfgReady;
  if (packSize) return { ok: true, size: packSize };
  if (!(await packReady())) return { ok: false };
  try {
    const size = await Promise.race([
      probePackSize(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000))
    ]);
    if (size > 1024 * 1024) { packSize = size; return { ok: true, size }; }
    return { ok: false };
  } catch { return { ok: false }; }
});

ipcMain.handle('download-start', async () => {
  await cfgReady;
  if (packLocked()) return { ok: false, error: 'up_to_date' };
  if (downloadBusy) return { ok: false, error: 'busy' };
  if (!(await packReady())) return { ok: false, error: 'config' };
  setBusy(true);
  try {
    // Rolul a fost deja verificat la intrarea în aplicație: descărcarea pornește direct, fără fereastra
    // „Alege unde se salvează" — arhiva merge în același folder ascuns din datele aplicației pe care îl
    // folosește și Auto Install (packDir()), ca Auto Install s-o preia automat de-acolo, fără re-descărcare.
    const dir = packDir();
    fs.mkdirSync(dir, { recursive: true });
    await hideOnWin(dir);
    const filePath = path.join(dir, cfg.DOWNLOAD_FILENAME || 'RMS_GRAPHICS.rar');

    const send = d => {
      if (win && !win.isDestroyed()) win.webContents.send('download-progress', d);
      try {
        const total = Number(d && d.total) || 0, recv = Number(d && d.received) || 0, speed = Number(d && d.speed) || 0;
        const pct = total > 0 ? (recv / total) * 100 : null;
        const etaSec = speed > 0 && total > recv ? (total - recv) / speed : null;
        presence.progress('download', { pct, etaSec });
      } catch {}
    };
    send({ received: 0, total: estimatedTotal(), speed: 0 });

    await downloadArchive(filePath, send);
    try { presence.clearProgress(); } catch {}
    downloadLog('Manual');
    await hideOnWin(filePath);   // fișierul descărcat rămâne ascuns
    lastDownloadPath = filePath;
    try { fs.writeFileSync(manualPackFile(), JSON.stringify({ path: filePath, version: cfg.PACK_VERSION })); } catch {}
    setNeedRedownload(false);   // modul a fost descărcat din nou: Auto Install e deblocat
    // archive = cfg.PACK_VERSION: Auto Install (ensurePack) găsește arhiva deja completă în packDir() și o
    // preia direct, fără să mai descarce nimic.
    setPackState({ archive: cfg.PACK_VERSION, current: cfg.PACK_VERSION, currentName: packLabel(), currentUpdated: cfg.UPDATE_DATE });
    return { ok: true, path: filePath };
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR')) return { ok: false, canceled: true, aborted: true };
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    setBusy(false);
    try { presence.clearProgress(); } catch {}
  }
});

ipcMain.on('download-cancel', () => { if (activeDownload) activeDownload.abort(); });

/* ---------------- Auto Install ---------------- */
// Locațiile alese (GTA V + FiveM) se salvează în userData și rămân până la dezinstalarea aplicației
// (nsis.deleteAppDataOnUninstall = true în package.json).
const pathsFile = () => path.join(app.getPath('userData'), 'install-paths.json');
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
// GTA V Legacy = GTA5.exe; ediția Enhanced (GTA5_Enhanced.exe) nu e acceptată
const isLegacyGta = dir => hasFile(dir, 'GTA5.exe') && !hasFile(dir, 'GTA5_Enhanced.exe');
const hasFile = (dir, name) => { try { return fs.readdirSync(dir).some(f => f.toLowerCase() === name.toLowerCase()); } catch { return false; } };

function currentPaths() {
  let j = {};
  try { j = JSON.parse(fs.readFileSync(pathsFile(), 'utf8')); } catch {}
  return {
    gta: j.gta && isLegacyGta(j.gta) ? j.gta : null,
    fivem: j.fivem && isDir(j.fivem) ? j.fivem : null
  };
}
function savePaths(p) { try { fs.writeFileSync(pathsFile(), JSON.stringify(p)); } catch {} }

// Acceptă direct „FiveM Application Data”, dar și folderul FiveM (%LOCALAPPDATA%\FiveM) sau FiveM.app
const FIVEM_DATA_RE = /^fivem[\s\u00a0_-]*application[\s\u00a0_-]*data$/i;
// Windows afișează folderul „FiveM.app” ca „FiveM Application Data” (desktop.ini, LocalizedResourceName); numele real pe disc e FiveM.app
const FIVEM_APP_RE = /^fivem\.app$/i;
const isFivemName = n => { n = String(n).normalize('NFKC').trim(); return FIVEM_DATA_RE.test(n) || FIVEM_APP_RE.test(n); };
function resolveFivem(sel, strict) {
  sel = path.resolve(sel);
  const norm = n => String(n).normalize('NFKC').trim();
  const looksLikeData = d => isFivemName(norm(path.basename(d)));
  const listDirs = d => { try { return fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory() || e.isSymbolicLink()).map(e => e.name); } catch { return []; } };

  // 1) folderul ales chiar este „FiveM Application Data”
  if (looksLikeData(sel) && isDir(sel)) return sel;

  // 2) folderul ales conține „FiveM Application Data” (ex: ...\AppData\Local\FiveM)
  const child = listDirs(sel).find(n => isFivemName(norm(n)));
  if (child) return path.join(sel, child);

  // 3) a ales FiveM.app (sau un folder din el): căutăm „FiveM Application Data” în părinți
  let up = sel;
  for (let i = 0; i < 3; i++) {
    up = path.dirname(up);
    const c = listDirs(up).find(n => isFivemName(norm(n)));
    if (c) return path.join(up, c);
  }

  if (strict) return null;   // la alegerea manuală nu ghicim după conținut
  // 4) nume diferit, dar conținut tipic FiveM Application Data (citizen / cache / mods / plugins)
  const kids = listDirs(sel).map(n => n.toLowerCase());
  if (kids.includes('citizen') || (kids.includes('cache') && (kids.includes('mods') || kids.includes('plugins')))) return sel;
  return null;
}

ipcMain.handle('install-paths', () => currentPaths());

ipcMain.handle('install-reset', () => {
  if (downloadBusy) return { ok: false, error: 'busy' };
  try { fs.unlinkSync(pathsFile()); } catch {}
  try { fs.writeFileSync(pathsFile(), '{}'); } catch {}          // dacă ștergerea a eșuat, golim fișierul
  const p = currentPaths();
  return { ok: !p.gta && !p.fivem, error: (p.gta || p.fivem) ? 'reset_failed' : undefined, paths: p };
});

ipcMain.handle('install-pick', async (_e, kind) => {
  const isGta = kind === 'gta';
  const cur = currentPaths();
  if (cur[isGta ? 'gta' : 'fivem']) return { ok: false, error: 'locked', paths: cur };   // locația corectă nu se mai schimbă
  const pick = await dialog.showOpenDialog(win, {
    title: isGta ? 'Alege folderul „Grand Theft Auto V Legacy” (cel cu GTA5.exe; ediția Enhanced nu e acceptată)'
                 : 'Alege folderul „FiveM Application Data”',
    defaultPath: isGta ? undefined : path.join(process.env.LOCALAPPDATA || app.getPath('home'), 'FiveM'),
    properties: ['openDirectory']
  });
  if (pick.canceled || !pick.filePaths[0]) return { ok: false, canceled: true };

  const sel = pick.filePaths[0];
  // Blocăm ediția Enhanced în două moduri, ca să nu conteze cum arată instalarea pe disc la fiecare utilizator:
  // 1) după conținut — fișierul GTA5_Enhanced.exe, dacă există;
  // 2) după numele folderului — dacă userul și-a numit (sau Steam/Epic a numit) folderul cu „enhanced” în el
  //    (ex: „Grand Theft Auto V Enhanced”), îl respingem direct, chiar dacă înăuntru mai există și un GTA5.exe
  //    „moștenit” care l-ar fi făcut să treacă drept Legacy.
  if (isGta && (hasFile(sel, 'GTA5_Enhanced.exe') || /enhanced/i.test(path.basename(sel)))) return { ok: false, error: 'enhanced_gta' };
  // FiveM se acceptă DOAR exact folderul „FiveM Application Data” (sau „FiveM”/FiveM.app, care îl conțin).
  // GTA V: nu mai cerem ca folderul să se numească exact „Grand Theft Auto V” — Steam/Epic Games permit biblioteci
  // cu nume custom (ex: „GTA5”, „GTAV”, „GTA”) — dar trebuie să fie EXACT folderul ales de utilizator, verificat
  // strict pe conținut (GTA5.exe prezent, GTA5_Enhanced.exe absent). NU căutăm recursiv prin subfoldere: un folder
  // Enhanced poate avea pe undeva, în interior, un GTA5.exe „moștenit” (fișiere de compatibilitate), iar o căutare
  // recursivă ar accepta greșit folderul Enhanced ca fiind Legacy — exact asta nu trebuie să se întâmple niciodată.
  let resolved = null;
  if (isGta) { if (isLegacyGta(sel)) resolved = sel; }
  else resolved = resolveFivem(sel, true);   // acceptă „FiveM Application Data”, dar și folderul „FiveM” (care îl conține) sau FiveM.app
  if (!resolved) return { ok: false, error: isGta ? 'bad_gta' : 'bad_fivem' };

  const p = currentPaths();
  p[isGta ? 'gta' : 'fivem'] = resolved;
  savePaths(p);
  return { ok: true, paths: p };
});

/* ---------------- Detectare automată a locațiilor (FiveM + GTA V Legacy) ---------------- */
// Butonul „Detectează automat” din Setări: caută singur folderele corecte și le salvează exact ca la alegerea manuală
// (aceleași verificări: Legacy = GTA5.exe fără GTA5_Enhanced.exe, nume fără „enhanced”; FiveM = „FiveM Application Data”/FiveM.app).
// Locația deja salvată și corectă NU se schimbă (la fel ca la „install-pick”).
const regQuery = (key, val) => new Promise(res => {
  if (process.platform !== 'win32') return res('');
  execFile('reg', ['query', key, '/v', val], { windowsHide: true }, (err, out) => {
    if (err) return res('');
    const mm = String(out).match(new RegExp('\\s' + val + '\\s+REG_\\w+\\s+(.+)', 'i'));
    res(mm ? mm[1].trim() : '');
  });
});
const gtaNameOk = d => !/enhanced/i.test(path.basename(d));
const gtaValid = d => !!d && isDir(d) && gtaNameOk(d) && isLegacyGta(d);

function detectFivem() {
  const bases = [];
  if (process.env.LOCALAPPDATA) bases.push(path.join(process.env.LOCALAPPDATA, 'FiveM'));
  bases.push(path.join(app.getPath('home'), 'AppData', 'Local', 'FiveM'));
  for (const b of bases) {
    if (!isDir(b)) continue;
    const r = resolveFivem(b, true);
    if (r && isDir(r)) return r;
  }
  return null;
}

// scanare limitată (adâncime + timp) a rădăcinilor discurilor, doar prin foldere cu nume tipice de jocuri
function scanForGta(roots, maxDepth, deadline) {
  const hint = /(gta|grand|rockstar|steam|epic|game|joc|program files)/i;
  const skip = /^(windows|\$recycle\.bin|system volume information|node_modules|appdata|programdata)$/i;
  const walk = (dir, depth) => {
    if (Date.now() > deadline) return null;
    if (gtaValid(dir)) return dir;
    if (depth >= maxDepth) return null;
    let kids = [];
    try { kids = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && !skip.test(e.name)).map(e => e.name); } catch { return null; }
    for (const k of kids) {
      if (depth === 0 && !hint.test(k)) continue;   // la rădăcină intrăm doar în foldere cu nume tipice
      const r = walk(path.join(dir, k), depth + 1);
      if (r) return r;
    }
    return null;
  };
  for (const root of roots) { const r = walk(root, 0); if (r) return r; }
  return null;
}

async function detectGta() {
  const cands = [];
  const add = p => { if (p) { const n = path.normalize(String(p).trim().replace(/^"|"$/g, '')); if (!cands.includes(n)) cands.push(n); } };
  const roots = [];
  if (process.platform === 'win32') for (let c = 67; c <= 90; c++) { const r = String.fromCharCode(c) + ':\\'; if (isDir(r)) roots.push(r); }

  // 1) Rockstar Games Launcher / ediția retail — cheia de registru a ediției Legacy
  for (const k of ['HKLM\\SOFTWARE\\WOW6432Node\\Rockstar Games\\Grand Theft Auto V', 'HKLM\\SOFTWARE\\Rockstar Games\\Grand Theft Auto V'])
    add(await regQuery(k, 'InstallFolder'));

  // 2) Steam: folderul Steam + toate bibliotecile din libraryfolders.vdf
  const steamRoots = [];
  for (const [k, v] of [['HKCU\\Software\\Valve\\Steam', 'SteamPath'], ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'], ['HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath']]) {
    const p = await regQuery(k, v); if (p) steamRoots.push(path.normalize(p));
  }
  const libs = [...steamRoots];
  for (const sr of steamRoots) {
    try {
      const vdf = fs.readFileSync(path.join(sr, 'steamapps', 'libraryfolders.vdf'), 'utf8');
      for (const mm of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.push(mm[1].replace(/\\\\/g, '\\'));
    } catch {}
  }
  for (const lib of libs) {
    add(path.join(lib, 'steamapps', 'common', 'Grand Theft Auto V'));
    try {   // numele real al folderului, din manifestul aplicației Steam 271590 (GTA V)
      const acf = fs.readFileSync(path.join(lib, 'steamapps', 'appmanifest_271590.acf'), 'utf8');
      const d = acf.match(/"installdir"\s+"([^"]+)"/);
      if (d) add(path.join(lib, 'steamapps', 'common', d[1]));
    } catch {}
  }

  // 3) Epic Games: manifestele .item
  try {
    const dir = path.join(process.env.ProgramData || 'C:\\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
    for (const f of fs.readdirSync(dir).filter(x => /\.item$/i.test(x))) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (/grand theft auto v/i.test(String(j.DisplayName || '')) && !/enhanced/i.test(String(j.DisplayName || ''))) add(j.InstallLocation);
      } catch {}
    }
  } catch {}

  // 4) locații uzuale, pe toate discurile
  const rels = ['Program Files\\Rockstar Games\\Grand Theft Auto V', 'Program Files (x86)\\Rockstar Games\\Grand Theft Auto V', 'Rockstar Games\\Grand Theft Auto V',
    'Program Files (x86)\\Steam\\steamapps\\common\\Grand Theft Auto V', 'Program Files\\Steam\\steamapps\\common\\Grand Theft Auto V', 'Steam\\steamapps\\common\\Grand Theft Auto V',
    'SteamLibrary\\steamapps\\common\\Grand Theft Auto V', 'Program Files\\Epic Games\\GTAV', 'Epic Games\\GTAV', 'Games\\Grand Theft Auto V', 'Grand Theft Auto V', 'GTAV', 'GTA5'];
  for (const r of roots) for (const rel of rels) add(path.join(r, rel));

  const hit = cands.find(gtaValid);
  if (hit) return hit;
  // 5) ultima șansă: scanare limitată (max. 6 s, adâncime 4) — acoperă foldere cu nume custom (ex. „D:\Jocuri\GTA5\Grand Theft Auto V Legacy”)
  return scanForGta(roots, 4, Date.now() + 6000);
}

ipcMain.handle('install-autodetect', async () => {
  if (downloadBusy) return { ok: false, error: 'busy' };
  const p = currentPaths();
  const found = { gta: '', fivem: '' };
  try {
    if (!p.fivem) { const f = detectFivem(); if (f) { p.fivem = f; found.fivem = f; } }
    if (!p.gta) { const g = await detectGta(); if (g) { p.gta = g; found.gta = g; } }
  } catch (e) { ilog('Detectare automată locații: eroare ' + ((e && e.message) || e)); }
  if (found.gta || found.fivem) savePaths(p);
  ilog('Detectare automată locații: GTA V ' + (found.gta || (p.gta ? '(deja setat)' : 'negăsit')) + ' | FiveM ' + (found.fivem || (p.fivem ? '(deja setat)' : 'negăsit')));
  const now = currentPaths();
  return { ok: !!(now.gta && now.fivem), paths: now, found: { gta: !!found.gta, fivem: !!found.fivem }, missing: { gta: !now.gta, fivem: !now.fivem } };
});

/* Pachetul se descarcă automat într-un folder ascuns din datele aplicației și rămâne acolo. */
const packDir = () => path.join(app.getPath('userData'), 'pack');
// Ascunde un fișier/folder și VERIFICĂ rezultatul (attrib fără parametri afișează atributele). Dacă attrib nu reușește,
// încearcă PowerShell. Rezultatul intră în install-log.txt.
const hideOnWin = async p => {
  if (process.platform !== 'win32') return true;
  const run = (cmd, args, env) => new Promise(res => execFile(cmd, args, { windowsHide: true, env: env || process.env }, (err, out) => res({ err, out: String(out || '') })));
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const isHidden = async () => { const r = await run('attrib', [p]); return /H/.test(r.out.split(/[A-Za-z]:\\/)[0]); };
  for (let i = 0; i < 3; i++) {
    await run('attrib', ['+h', p]);
    if (await isHidden()) { ilog('Ascuns: ' + p); return true; }
    await wait(400);
  }
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$i = Get-Item -LiteralPath $env:RMS_HIDE_PATH -Force; $i.Attributes = $i.Attributes -bor [IO.FileAttributes]::Hidden'],
    { ...process.env, RMS_HIDE_PATH: p });
  const ok = await isHidden();
  ilog(ok ? 'Ascuns (PowerShell): ' + p : 'NU am putut ascunde: ' + p);
  return ok;
};

const showOnWin = p => new Promise(res => {
  if (process.platform !== 'win32') return res();
  execFile('attrib', ['-h', p], () => res());
});

const manualPackFile = () => path.join(app.getPath('userData'), 'manual-pack.json');
// După dezinstalare, Auto Install e blocat până când modul se descarcă din nou din tab-ul Descărcări.
const redownloadFile = () => path.join(app.getPath('userData'), 'need-redownload.json');
const needRedownload = () => fs.existsSync(redownloadFile());
function setNeedRedownload(on) {
  try { if (on) fs.writeFileSync(redownloadFile(), JSON.stringify({ since: Date.now() })); else fs.unlinkSync(redownloadFile()); } catch {}
}
// steag separat: instalarea curentă (manifestul) e cunoscută ca incompletă (ex. o restaurare din backup local a ieșit
// cu fișiere lipsă din GTA V). Cât timp e activ, „Dezinstalare” NU mai creează un nou backup local din acest manifest
// (ar fi tot incomplet) — fișierele se șterg direct, ca următoarea instalare să fie obligată să extragă din arhivă.
// Se stinge automat la o extragere reală reușită din arhivă.
const backupIncompleteFile = () => path.join(app.getPath('userData'), 'backup-incomplete.json');
const isBackupIncomplete = () => fs.existsSync(backupIncompleteFile());
function setBackupIncomplete(on) {
  try { if (on) fs.writeFileSync(backupIncompleteFile(), JSON.stringify({ since: Date.now() })); else fs.unlinkSync(backupIncompleteFile()); } catch {}
}
function manualPackPath() {
  try { const j = JSON.parse(fs.readFileSync(manualPackFile(), 'utf8')); return j && j.path ? String(j.path) : null; } catch { return null; }
}
function manualPackVersion() {
  try { return Number(JSON.parse(fs.readFileSync(manualPackFile(), 'utf8')).version) || 0; } catch { return 0; }
}
const isPackComplete = f => {
  try { const st = fs.statSync(f); return st.size > 1024 * 1024 && (!packSize || st.size === packSize); } catch { return false; }
};

async function ensurePack(send) {
  const dir = packDir();
  fs.mkdirSync(dir, { recursive: true });
  await hideOnWin(dir);
  if (installCancelled) throw new Error('cancelled');

  const name = cfg.DOWNLOAD_FILENAME || 'RMS_GRAPHICS.rar';
  const file = path.join(dir, name);

  // șterge versiuni vechi ale arhivei (alt nume în config) și resturi de descărcări întrerupte
  for (const f of fs.readdirSync(dir)) { if (f !== name) { try { fs.unlinkSync(path.join(dir, f)); } catch {} } }

  // aflăm dimensiunea reală (rapid), ca să putem verifica dacă arhiva existentă e completă
  if (!packSize) {
    try {
      const size = await Promise.race([probePackSize(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))]);
      if (size > 1024 * 1024) packSize = size;
    } catch {}
  }

  if (installCancelled) throw new Error('cancelled');
  if (isPackComplete(file) && readPackState().archive === cfg.PACK_VERSION) { ilog('Arhiva existentă refolosită: ' + file); return file; }
  if (fs.existsSync(file)) ilog('Arhiva existentă e de la altă versiune a pachetului: se descarcă din nou');

  // arhiva descărcată manual din tab-ul Downloads (dacă există și e completă) se refolosește, fără descărcare nouă
  const manual = manualPackPath();
  if (manual && manualPackVersion() === cfg.PACK_VERSION && isPackComplete(manual)) { ilog('Arhiva manuală refolosită: ' + manual); return manual; }

  try { fs.unlinkSync(file); } catch {}
  await resolvePackAccess();   // link + parolă proaspete (Worker), chiar dacă verificarea de mai sus a fost sărită
  ilog('Descarc arhiva în: ' + file);
  await downloadArchive(file, d => send({ phase: 'download', ...d }));
  setPackState({ archive: cfg.PACK_VERSION });
  await hideOnWin(file);
  return file;
}

// Încearcă mai întâi UnRAR.exe (mai rapid, dacă există în folderul bin); dacă lipsește sau eșuează, folosește node-unrar-js.
let packPassOverride = null;   // setat de resolvePackAccess() (Worker) sau, pentru pachetele opționale, cât rulează instalarea lor

// ---- Arhiva principală: link + parolă prin Cloudflare Worker (nu mai stau deloc în launcher) --------------------
// Worker-ul (vezi worker/pack-worker.js) verifică EL ÎNSUȘI, direct la Discord, rolul utilizatorului — launcherul
// trimite doar jetonul de login (același folosit și pentru verificarea de rol obișnuită), niciodată parola sau
// linkul real. Rezultatul (link temporar, 10 minute + parola) e ținut în memorie puțin timp, sub durata jetonului,
// ca să nu se repete cererea de fiecare dată când probePackSize()/ensurePack() au nevoie de el în același flux.
let packAccessCache = null;      // { url, password, ts }
const PACK_ACCESS_TTL_MS = 4 * 60 * 1000;
async function resolvePackAccess() {
  if (!cfg.PACK_ACCESS_URL) return;   // Worker neconfigurat: se folosește vechiul PACK_URL/PACK_PASSWORD (plasă de siguranță)
  if (packAccessCache && Date.now() - packAccessCache.ts < PACK_ACCESS_TTL_MS) {
    cfg.PACK_URL = packAccessCache.url;
    packPassOverride = packAccessCache.password;
    return;
  }
  const token = loadToken();
  if (!token) throw new Error('not_logged_in');
  const base = String(cfg.PACK_ACCESS_URL).replace(/\/+$/, '');
  // Jetonul merge și ca parametru în link ("auth"), nu doar ca header Authorization: la unele cereri din
  // launcher, header-ul nu ajunge la Worker (motiv neclar), iar Worker-ul acceptă oricare din cele două.
  const r = await dFetch(base + '/pack-info?auth=' + encodeURIComponent(token), { Authorization: `Bearer ${token}` });
  if (r.status === 401) throw new Error('not_logged_in');
  if (r.status === 403) throw new Error('pack_no_role');
  if (r.status === 429) throw new Error('pack_rate_limited');   // Discord e temporar limitat — nu înseamnă "fără rol"
  if (!r.ok) throw new Error('pack_access_failed');
  const j = await r.json().catch(() => null);
  if (!j || !j.ok || !j.downloadUrl) throw new Error('pack_access_failed');
  packAccessCache = { url: j.downloadUrl, password: String(j.password || ''), ts: Date.now() };
  cfg.PACK_URL = packAccessCache.url;
  packPassOverride = packAccessCache.password;
}
// Variantă „sigură" a packConfigured(): dacă e setat PACK_ACCESS_URL, cfg.PACK_URL e gol până se cere
// Worker-ului un link — deci orice verificare de tip „e configurat pachetul?" trebuie să încerce mai
// întâi rezolvarea, altfel ar respinge mereu descărcarea (nelogat/fără rol = eroare normală, nu lipsă config).
async function packReady() {
  try { await resolvePackAccess(); } catch {}
  return packConfigured();
}

// Parola arhivei nu apare în clar nicăieri: stă criptată (AES-256-GCM, ca și linkul) și se decriptează doar în memorie,
// în procesul principal. Dacă trebuie schimbată parola, spune-mi noua parolă și îți dau alt PW_BLOB.
const PW_BLOB = 'Y8eqLMh1XAdpDmUG0SYKdiUPR5rfJWq8W+UQQ4FHR1htz9UXUvQX/VpyzzujV6Jt';
function embeddedPw() {
  try {
    const key = crypto.createHash('sha256').update('rms.gfx/pw/v1').digest();
    const b = Buffer.from(PW_BLOB, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch { return ''; }
}
const packPassword = () => String(packPassOverride !== null ? packPassOverride : (embeddedPw() || cfg.PACK_PASSWORD || ''));
// „Copiere” doar în interiorul aplicației: jetonul e criptat cu o cheie aleatoare din această sesiune și nu ajunge niciodată în clipboardul sistemului.
const pwSessionKey = crypto.randomBytes(32);
let pwUnlocked = false;
ipcMain.handle('pw-copy', () => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', pwSessionKey, iv);
  const ct = Buffer.concat([c.update(embeddedPw(), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
});
ipcMain.handle('pw-check', (_e, token) => {
  pwUnlocked = false;
  try {
    const b = Buffer.from(String(token || ''), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', pwSessionKey, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    const pw = Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
    pwUnlocked = !!pw && pw === embeddedPw();
  } catch {}
  return pwUnlocked;
});


// Progres separat pe destinații: fivem (RMS Graphics, folderul mods) și gta (RMS ENB, folderul GTA V). Citit de pe disc, din locul final sau din folderul temporar.
async function makeDestProgress(native, exe, archive, p) {
  try {
    const list = await native.planSizes({ exe, archive, password: packPassword() });
    if (!list.length) return null;
    const dirs = { fivem: p.fivem, gta: p.gta };
    const tot = { fivem: 0, gta: 0 }, got = { fivem: 0, gta: 0 };
    const pend = list.map(f => {
      tot[f.dest] += f.size;
      return { f, cand: [
        path.join(dirs[f.dest], ...f.rel.split('/')),
        path.join(dirs[f.dest], '.rms-stage-' + f.dest, ...f.name.split(/[\\/]/)),
        path.join(p.gta, '.rms-stage-js', ...f.name.split(/[\\/]/))
      ] };
    });
    let todo = pend;
    return { read() {
      const next = []; const cur = { fivem: 0, gta: 0 };
      for (const e of todo) {
        let best = 0;
        for (const c of e.cand) { try { const s = fs.statSync(c).size; if (s > best) best = s; } catch {} }
        if (best >= e.f.size) got[e.f.dest] += e.f.size; else { next.push(e); cur[e.f.dest] += Math.min(best, e.f.size); }
      }
      todo = next;
      return { fivem: { done: got.fivem + cur.fivem, total: tot.fivem }, gta: { done: got.gta + cur.gta, total: tot.gta } };
    } };
  } catch (e) { ilog('Progres pe destinații indisponibil: ' + ((e && e.message) || e)); return null; }
}
async function extractPack(archive, p, send0) {
  if (installCancelled) throw new Error('cancelled');
  const native = require('./native-unrar');
  const exe = native.findUnrarExe();
  let dp = null;
  if (exe && !optPick) dp = await makeDestProgress(native, exe, archive, p);
  const send = d => { touchBusy(); send0(dp && d && d.phase === 'extract' ? { ...d, parts: dp.read() } : d); };
  ilog('UnRAR.exe: ' + (exe || 'LIPSEȘTE (folosesc node-unrar-js)'));
  if (exe) {
    try {
      const r = await native.nativeExtract({
        exe, archive, password: packPassword(), fivemDir: p.fivem, gtaDir: p.gta, pick: optPick,
        onProgress: m => send({ phase: 'extract', done: m.done, total: m.total, name: m.name }),
        registerAbort: fn => { installWorker = { terminate: fn }; if (installCancelled) fn(); },
        onPlan: async (finals, all, info) => {
          journal.finals = finals; setPlan(all); if (info) ilog('Plan UnRAR.exe: ' + info);
          // pachet opțional reinstalat peste o versiune existentă: fișierele .rpf din „mods” sunt ascunse + blocate (ACL) → fără deblocare apare EPERM la scriere
          if (optInstalling) {
            const ex = existing(all);
            if (ex.length) {
              try { await unlockPaths([...ex, ...lockedUnder(path.join(p.fivem, 'mods')), path.join(p.fivem, 'mods')]); } catch (e) { ilog('Deblocare fișiere existente eșuată: ' + ((e && e.message) || e)); }
              try { await attribMany('-h', ex); } catch {}
              for (const f of ex) { try { fs.chmodSync(f, 0o666); } catch {} }
              ilog('Înlocuire automată: ' + ex.length + ' fișier(e) existente deblocate');
            }
          }
        }
      });
      ilog('UnRAR.exe: gata, fișiere copiate: ' + (r && r.files) + (r && r.mode ? ' (' + r.mode + ')' : ''));
      return r;
    } catch (e) {
      ilog('UnRAR.exe a eșuat: ' + (e && e.message) + (e && e.detail ? ' [' + e.detail + ']' : ''));
      cleanupInstall();   // ce a apucat să scrie varianta nativă se șterge înainte de încercarea cu node-unrar-js
      if (installCancelled || (e && e.message === 'bad_password')) throw e;
      console.warn('UnRAR.exe a eșuat, folosesc node-unrar-js:', e && e.message);
    }
  }
  return extractWithWorker(archive, p, send);
}

function extractWithWorker(archive, p, send) {
  return new Promise((resolve, reject) => {
    // node-unrar-js (dependență nativă) rămâne scos din asar (vezi asarUnpack în package.json);
    // worker-ul propriu-zis pornește din sursă (spawnWorkerFromFile), fără fișier .js separat pe disc.
    const w = spawnWorkerFromFile('unrar-worker.js', { archive, password: packPassword(), fivemDir: p.fivem, gtaDir: p.gta, pick: optPick });
    installWorker = w;
    let settled = false;
    let curPath = null, lastDone = 0, lastTotal = 0;
    // progres și în timpul unui fișier mare: citim dimensiunea fișierului care se scrie acum
    let disk = null;
    const poll = setInterval(() => {
      if (!lastTotal) return;
      let v = lastDone;
      if (disk) v = Math.max(v, disk.read());
      else if (curPath) { try { v = lastDone + fs.statSync(curPath).size; } catch { return; } }
      send({ phase: 'extract', done: Math.min(lastTotal, v), total: lastTotal, name: '' });
    }, 400);
    const end = fn => { if (!settled) { settled = true; clearInterval(poll); fn(); } };

    w.on('message', msg => {
      if (msg.type === 'current') curPath = msg.path;
      else if (msg.type === 'plan') { journal.finals = msg.finals || []; setPlan(msg.all); if (msg.info) ilog('Plan node-unrar-js: ' + msg.info); }
      else if (msg.type === 'items') disk = require('./native-unrar').makeDiskProgress(msg.items || []);
      else if (msg.type === 'progress') { lastDone = msg.done; lastTotal = msg.total; send({ phase: 'extract', done: msg.done, total: msg.total, name: '' }); }
      else if (msg.type === 'done') { ilog('node-unrar-js: gata, fișiere: ' + msg.files + (msg.mode ? ' (' + msg.mode + ')' : '')); end(() => resolve(msg)); }
      else if (msg.type === 'error') { ilog('node-unrar-js eroare: ' + msg.code + ' ' + (msg.detail || '')); end(() => { const e = new Error(msg.code); e.detail = msg.detail; reject(e); }); }
    });
    w.on('error', e => { ilog('Worker error: ' + (e && e.message)); end(() => reject(e)); });
    // mesajul final poate sosi la puțin timp după „exit”, așa că așteptăm înainte să declarăm eroare
    w.on('exit', code => setTimeout(() => end(() => {
      ilog('Worker a ieșit fără rezultat, cod ' + code);
      reject(new Error(installCancelled ? 'cancelled' : 'worker_exit_' + code));
    }), 400));
  });
}

// Testează dacă putem scrie în folder. Returnează { ok, code } — „code” e codul real al erorii (EPERM, EACCES, EROFS, ENOENT...).
// Important: ștergerea fișierului de test e „best effort” (antivirusul îl poate ține blocat o clipă);
// o ștergere eșuată NU înseamnă că folderul nu e scriibil.
function canWrite(dir) {
  const f = path.join(dir, '.rms-write-test-' + process.pid);
  try { fs.writeFileSync(f, ''); } catch (e) { return { ok: false, code: String((e && e.code) || 'UNKNOWN') }; }
  for (let i = 0; i < 6; i++) {
    try { fs.unlinkSync(f); break; } catch (e) {
      if (e && e.code === 'ENOENT') break;
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120); } catch {}
    }
  }
  return { ok: true, code: '' };
}

let installWorker = null;
let installCancelled = false;
let finalizing = false;

ipcMain.handle('install-start', async () => {
  await cfgReady;
  // dacă există un backup local valid (aceeași versiune, nimic nou de descărcat), restaurăm instant din el, fără arhivă —
  // verificat ÎNAINTE de „packLocked”, ca restaurarea unui singur mod șters să nu fie blocată de „pachetul e la zi”
  const bk = mainBackupUsable();
  if (bk) {
    if (!pwUnlocked) return { ok: false, error: 'pw' };
    pwUnlocked = false;
    if (downloadBusy) return { ok: false, error: 'busy' };
    const p = currentPaths();
    if (!p.gta || !p.fivem) return { ok: false, error: 'no_paths' };
    setBusy(true);
    try {
      const send = d => { if (win && !win.isDestroyed()) win.webContents.send('install-progress', d); presenceFromPhase('install', d); };
      send({ phase: 'extract', done: 0, total: bk.files.length, name: '' });
      let m = readManifest();
      const restoredFiles = [];
      let i = 0;
      for (const f of bk.files) {
        i++;
        try {
          fs.mkdirSync(path.dirname(f.orig), { recursive: true });
          try { fs.rmSync(f.orig, { force: true }); } catch {}
          // moveRetry are fallback copy+delete pentru EXDEV (backup pe alt disc decât GTA V / FiveM, ex. C: vs D:),
          // unde fs.renameSync simplu eșuează mereu cu „cross-device link not permitted”
          if (!moveRetry(f.backup, f.orig)) throw new Error('move_failed');
          restoredFiles.push(f.orig);
        } catch (e) { ilog('Restaurare din backup eșuată pentru: ' + f.orig + ' – ' + (e && e.message)); }
        send({ phase: 'extract', done: i, total: bk.files.length, name: path.basename(f.orig) });
      }
      m = {
        roots: [...new Set([...(m.roots || []), p.fivem, p.gta])],
        created: m.created || [],
        touched: [...new Set([...(m.touched || []), ...restoredFiles])],
        dirs: m.dirs || [],
        topDirs: m.topDirs || [],
        fivem: m.fivem || p.fivem
      };
      writeManifest(m);
      send({ phase: 'finalize' });
      await hideManifest({ topDirs: [], touched: restoredFiles, dirs: [], fivem: p.fivem });
      const failedRestore = bk.files.filter(f => !restoredFiles.includes(f.orig));
      if (failedRestore.length) writeMainBackupMeta({ version: bk.version, files: failedRestore, ts: bk.ts });
      else clearMainBackup();
      setPackState({ current: cfg.PACK_VERSION, currentName: packLabel(), currentUpdated: cfg.UPDATE_DATE, instVer: cfg.PACK_VERSION, instUpdated: cfg.UPDATE_DATE });
      ilog('=== Instalare din backup local reușită === restaurate: ' + restoredFiles.length + '/' + bk.files.length);
      // dacă lipsește ceva din GTA V chiar și după o restaurare „reușită”, înseamnă că backup-ul local e deja incomplet
      // (fișiere pierdute dintr-un ciclu anterior) — nu mai are rost să fie reîncercat la infinit cu aceleași lipsuri:
      // se curăță complet și se forțează o redescărcare + extragere reală din arhivă la următoarea instalare
      const missingEnb = verifyGtaEnb(p);
      if (missingEnb.length) {
        clearMainBackup();
        setNeedRedownload(true);
        setBackupIncomplete(true);   // „Dezinstalare” nu va mai recrea un backup local din manifestul ăsta, cât timp nu s-a extras curat din arhivă
        ilog('Backup local curățat (incomplet) — e nevoie de redescărcare pentru o instalare curată.');
      } else {
        setNeedRedownload(false);
      }
      setAutostart(true).catch(() => {});   // RMS e instalat: watchdog-ul pornește și cu launcherul închis
      setFolderOptionsBlock(true).catch(() => {});   // „Show hidden items” nu mai poate fi bifat din Explorer cât timp RMS e instalat
      captureRootBaseline(m).then(() => writeManifest(m)).catch(() => {});   // reper pentru atributele GTA V / FiveM
      purgeMainArchives(packArchivePath()).catch(() => {});   // nu bloca răspunsul: șterge și arhiva (ex. cea aleasă manual), ca și la instalarea normală
      return { ok: true, fromBackup: true, incomplete: missingEnb.length > 0 };
    } catch (e) {
      ilog('Instalare din backup eșuată: ' + ((e && e.message) || e));
      return { ok: false, error: String((e && e.message) || e) };
    } finally { setBusy(false); }
  }
  if (packLocked()) return { ok: false, error: 'up_to_date' };
  if (!pwUnlocked) return { ok: false, error: 'pw' };
  pwUnlocked = false;
  // după dezinstalare modul se descarcă singur în timpul instalării (ensurePack), cu progres pe aceeași bară — fără redirect la Descărcări
  if (downloadBusy) return { ok: false, error: 'busy' };
  if (!(await packReady())) return { ok: false, error: 'config' };
  const p = currentPaths();
  if (!p.gta || !p.fivem) return { ok: false, error: 'no_paths' };

  finalizing = false;
  setBusy(true);            // blochează și butonul de descărcare manuală cât timp rulează instalarea
  installCancelled = false;
  journal.finals = []; journal.all = []; journal.newDirs = []; journal.topDirs = []; journal.tmp = null; journal.roots = [p.fivem, p.gta];
  let prevManifest = readManifest();
  journal.stages = [path.join(p.fivem, '.rms-stage-fivem'), path.join(p.gta, '.rms-stage-gta'), path.join(p.gta, '.rms-stage-js')];
  let lastSend = 0;   // maxim ~4 mesaje / secundă către interfață (fără inundarea canalului IPC)
  const send = d => {
    if (!win || win.isDestroyed()) return;
    const now = Date.now();
    if (d && (d.phase === 'download' || d.phase === 'extract') && now - lastSend < 250) return;
    lastSend = now;
    win.webContents.send('install-progress', d);
    presenceFromPhase('install', d);
  };
  let archive = null;
  try {
    ilog('=== Instalare pornită === GTA: ' + p.gta + ' | FiveM: ' + p.fivem);
    for (const d of [p.gta, p.fivem]) {
      const w = canWrite(d);
      if (!w.ok) { ilog('Scriere refuzată în ' + d + ' [' + w.code + ']'); return { ok: false, error: 'write_denied', detail: d, code: w.code }; }
    }

    // fișierele ascunse la o instalare anterioară nu pot fi suprascrise: le facem vizibile temporar
    await showManifest(prevManifest);
    if (installCancelled) throw new Error('cancelled');
    archive = await ensurePack(send);
    if (installCancelled) throw new Error('cancelled');
    send({ phase: 'extract', done: 0, total: 0, name: '' });
    ilog('Arhivă: ' + archive + ' (' + (fs.existsSync(archive) ? fs.statSync(archive).size + ' B' : 'NU EXISTĂ') + ')');
    await extractPack(archive, p, send);   // arhiva rămâne ascunsă tot timpul
    if (installCancelled) throw new Error('cancelled');
    finalizing = true;   // de aici nu se mai poate anula (se salvează lista și se ascund fișierele)
    // succes: salvăm lista (pentru dezinstalare) și ascundem tot ce a instalat RMS
    const mf = {
      roots: [...new Set([...prevManifest.roots, p.fivem, p.gta])],
      created: [...new Set([...prevManifest.created, ...journal.finals])],
      touched: [...new Set([...prevManifest.touched, ...journal.all])],
      dirs: [...new Set([...prevManifest.dirs, ...journal.newDirs])],
      topDirs: [...new Set([...prevManifest.topDirs, ...journal.topDirs])],
      fivem: p.fivem
    };
    writeManifest(mf);
    send({ phase: 'finalize' });   // interfața afișează „Se finalizează… așteaptă”
    await hideManifest(mf);
    ilog('Fișiere ascunse: ' + mf.touched.length + ' | foldere ascunse: ' + (mf.dirs.length + mf.topDirs.length) + ' (' + mf.topDirs.map(d => path.basename(d)).join(', ') + ')');
    const arcDirs = [archive, manualPackPath(), lastDownloadPath].filter(Boolean).map(f => path.dirname(f));   // înainte ca purgeMainArchives să uite calea
    // curățările sunt independente: rulează simultan (înainte se așteptau pe rând, fiecare cu propria scanare a Coșului de reciclare)
    await Promise.all([
      purgeLeftoverFolders([p.fivem, p.gta]),   // niciun folder în plus (.rms-off etc.)
      purgeMainArchives(archive),               // ambele arhive (datele aplicației + cea aleasă manual) și copiile din Recycle Bin
      purgeWorkDir(packDir()),                  // folderul din care s-a dezarhivat, complet
      purgeExtracted(arcDirs)                   // orice „RMS_GRAPHICS” dezarhivat de mână / fișiere temporare
    ].map(pr => Promise.resolve(pr).catch(e => ilog('Curățare după instalare: ' + ((e && e.message) || e))))); 
    journal.finals = []; journal.all = []; journal.newDirs = []; journal.topDirs = []; journal.tmp = null;   // succes: nu mai ștergem nimic
    if (!(Number(cfg.PACK_VERSION) > 0)) { try { await refreshRemote(); } catch {} }   // manifestul online încă nu era citit: îl reîncercăm ca să nu salvăm versiunea 0
    setPackState({ current: cfg.PACK_VERSION, currentName: packLabel(), currentUpdated: cfg.UPDATE_DATE, instVer: cfg.PACK_VERSION, instUpdated: cfg.UPDATE_DATE });
    ilog('=== Instalare reușită ===');
    setNeedRedownload(false);
    setBackupIncomplete(false);   // extragere reală reușită din arhivă: manifestul e din nou complet, backup-ul local poate fi folosit normal
    verifyGtaEnb(p);   // avertisment vizibil în log dacă lipsește ceva din partea de ENB a GTA V (nu blochează instalarea)
    await Promise.all([
      (async () => { try { await forceRmsFileState(); } catch {} })(),   // instant: mods/plugins vizibile, fișierele RMS_ ascunse — nu se așteaptă watchdog-ul de 30s
      (async () => { try { await grantAdminFullControl(existing([path.join(p.gta, 'enblocal.ini'), path.join(p.gta, 'enbseries.ini')])); } catch {} })()
    ]);
    setAutostart(true).catch(() => {});   // RMS e instalat: watchdog-ul pornește și cu launcherul închis
    setFolderOptionsBlock(true).catch(() => {});   // „Show hidden items” nu mai poate fi bifat din Explorer cât timp RMS e instalat
    captureRootBaseline(mf).then(() => writeManifest(mf)).catch(() => {});   // reper pentru atributele GTA V / FiveM
    return { ok: true };
  } catch (e) {
    cleanupInstall();   // eșec sau anulare: ștergem ce era pe jumătate instalat
    try { await purgeLeftoverFolders([p.fivem, p.gta]); } catch {}   // și folderele/fișierele temporare .rms-*
    try { await hideManifest(prevManifest); } catch {}   // refacem „Hidden” pentru instalarea anterioară
    ilog('=== Instalare eșuată: ' + ((e && e.message) || e) + (e && e.detail ? ' [' + e.detail + ']' : ''));
    if (installCancelled || (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR'))) { await purgeWorkDir(packDir()); return { ok: false, canceled: true }; }
    const code = String((e && e.message) || e);
    await purgeWorkDir(packDir());   // nu rămâne nicio arhivă / .part în folderul de lucru (data viitoare se descarcă din nou)
    return { ok: false, error: code, detail: e && e.detail };
  } finally {
    setBusy(false);
    installWorker = null;
    packPassOverride = null;   // parola arhivei principale (de la Worker) nu mai zăbovește în memorie după instalare
    try { presence.clearProgress(); } catch {}
  }
});

/* ---------------- Fișiere ascunse + listă de instalare (pentru dezinstalare) ---------------- */
// Doar fișierele/folderele instalate de RMS primesc atributul „Hidden”. Orice alt mod pus de utilizator în
// mods / plugins / folderul GTA rămâne vizibil și nu este atins la dezinstalare: ștergerea se face strict după listă.
const manifestFile = () => path.join(app.getPath('userData'), 'install-manifest.json');
function readManifest() {
  let j = {};
  try { j = JSON.parse(fs.readFileSync(manifestFile(), 'utf8')); } catch {}
  const arr = v => Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];
  // rootAttrs: reperul atributelor GTA V / FiveM de la instalare (vezi captureRootBaseline); nu e un array, deci se păstrează separat
  const rootAttrs = (j.rootAttrs && typeof j.rootAttrs === 'object' && !Array.isArray(j.rootAttrs)) ? j.rootAttrs : undefined;
  return { roots: arr(j.roots), created: arr(j.created), touched: arr(j.touched), dirs: arr(j.dirs), topDirs: arr(j.topDirs), fivem: typeof j.fivem === 'string' ? j.fivem : '', rootAttrs };
}
function writeManifest(m) { try { fs.writeFileSync(manifestFile(), JSON.stringify(m)); } catch (e) { ilog('Nu am putut salva lista de instalare: ' + (e && e.message)); } }
const hasManifest = () => { const m = readManifest(); return m.touched.length + m.created.length + m.dirs.length + m.topDirs.length > 0 || !!readUiState().dest || !!readNbState().gta; };

// listă de instalare separată pentru fiecare pachet opțional cu arhivă proprie (ex. RMS Christmas): rămâne independentă
// de pachetul principal, ca dezinstalarea opțională să șteargă DOAR ce a adăugat ea, fără să afecteze pachetul principal.
const optManifestFile = id => path.join(app.getPath('userData'), 'optional-manifest-' + id + '.json');
function readOptManifest(id) {
  let j = {};
  try { j = JSON.parse(fs.readFileSync(optManifestFile(id), 'utf8')); } catch {}
  const arr = v => Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];
  return { roots: arr(j.roots), created: arr(j.created), touched: arr(j.touched), dirs: arr(j.dirs), topDirs: arr(j.topDirs), fivem: typeof j.fivem === 'string' ? j.fivem : '' };
}
function writeOptManifest(id, m) { try { fs.writeFileSync(optManifestFile(id), JSON.stringify(m)); } catch (e) { ilog('Nu am putut salva lista pachetului opțional (' + id + '): ' + (e && e.message)); } }

// attrib acceptă mai multe căi într-o singură rulare; le grupăm (mic, ca să nu depășim limitele) iar ce eșuează trece prin PowerShell
const winRun = (cmd, args, env) => new Promise(res => execFile(cmd, args, { windowsHide: true, maxBuffer: 1 << 24, env: env || process.env }, (err, out) => res({ err, out: String(out || '') })));

/* ---------------- Watchdog la pornirea Windows: verificarea „nu e dezascuns nimic” continuă și cu launcherul închis ---------------- */
// Cât timp RMS e instalat, se înregistrează o Scheduled Task care pornește acest .exe cu „--rms-watchdog” la login, fără fereastră,
// doar ca să continue verificarea din rehideTick() și alertele pe Discord. Nu se folosește Run (HKCU) pentru că launcherul cere
// „requireAdministrator”, iar un item din Run cu privilegii de admin fie cere UAC la fiecare login, fie e blocat silențios de Windows.
// O Scheduled Task cu „/RL HIGHEST” creată dintr-un proces deja elevat (launcherul rulează mereu ca admin) pornește elevat, fără
// niciun prompt. Se șterge la dezinstalarea completă a RMS.
const AUTOSTART_TASK = 'RMSGraphicsWatchdog';
// PID-ul watchdog-ului curent (dacă rulează), pe disc — ca să nu pornească de mai multe ori în paralel (din
// setAutostart() după instalare, din GUI la fiecare pornire ca plasă de siguranță, și din Scheduled Task la login).
const watchdogPidFile = () => path.join(app.getPath('userData'), 'watchdog.pid');
function watchdogAlreadyRunning() {
  try {
    const pid = Number(fs.readFileSync(watchdogPidFile(), 'utf8'));
    if (!pid) return false;
    process.kill(pid, 0);   // nu trimite niciun semnal, doar verifică dacă procesul mai există; aruncă dacă nu
    return true;
  } catch { return false; }
}
// pornește watchdog-ul ACUM, fără să aștepte următoarea logare Windows — Scheduled Task-ul (ONLOGON) de mai jos
// rămâne pentru după un restart/relogare, dar fără asta, între instalare și următoarea logare (sau dacă launcherul
// se închide imediat după instalare), nu exista NICIUN proces care să verifice/trimită alerte.
function launchWatchdogNow() {
  if (process.platform !== 'win32' || !app.isPackaged || WATCHDOG) return;
  if (watchdogAlreadyRunning()) return;
  try {
    require('child_process').spawn(process.execPath, ['--rms-watchdog'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {}
}
async function setAutostart(enable) {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  try {
    if (enable) {
      const cmd = '"' + process.execPath + '" --rms-watchdog';
      await winRun('schtasks', ['/Create', '/F', '/SC', 'ONLOGON', '/RL', 'HIGHEST', '/TN', AUTOSTART_TASK, '/TR', cmd]);
      launchWatchdogNow();
    } else {
      await winRun('schtasks', ['/Delete', '/F', '/TN', AUTOSTART_TASK]);
      try { const pid = Number(fs.readFileSync(watchdogPidFile(), 'utf8')); if (pid) process.kill(pid); } catch {}
      try { fs.unlinkSync(watchdogPidFile()); } catch {}
    }
  } catch {}
}
// „Hidden items” / „Hide protected operating system files” NU sunt setări per-folder — sunt globale, pe tot contul
// Windows al userului. Singura metodă reală de a-i opri accesul la ele e să dezactivezi complet fereastra „Folder
// Options” din Explorer (politica NoFolderOptions), cât timp RMS e instalat — se reactivează la dezinstalare completă.
// ATENȚIE: asta blochează TOATE opțiunile din Folder Options (nu doar hidden items) pe tot calculatorul userului,
// nu doar pentru folderele RMS — e intenționat (nu există variantă „doar pentru un folder”). Cineva cu drepturi de
// admin poate oricând anula asta din regedit, deci e o piedică în plus, nu o blocare garantată 100%.
async function setFolderOptionsBlock(enable) {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  try {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer';
    if (enable) await winRun('reg', ['add', key, '/v', 'NoFolderOptions', '/t', 'REG_DWORD', '/d', '1', '/f']);
    else await winRun('reg', ['delete', key, '/v', 'NoFolderOptions', '/f']);
    // forțează Explorer să recitească politicile acum, fără logoff/restart (poate tot cere relansarea Explorer ca să se vadă instant în ribbon)
    await winRun('RUNDLL32.EXE', ['user32.dll,UpdatePerUserSystemParameters']);
  } catch {}
}
// IMPORTANT: pe lângă „Hidden” se pune și atributul „System” (attrib +s). Motivul: „Show hidden items” din Explorer
// (exact ce s-a folosit în testul din captură) ignoră complet atributul Hidden al fișierului și le arată pe toate —
// SINGURA excepție sunt fișierele care au ȘI atributul System, ținute ascunse de o bifă SEPARATĂ („Hide protected
// operating system files”, din Folder Options), activă implicit pe Windows și pe care aproape nimeni n-o atinge.
// Deci cu +h +s, un „Show hidden items” simplu NU le mai scoate la iveală — trebuie debifată și bifa aia a doua, mult
// mai puțin cunoscută. Nu afectează cu nimic citirea fișierelor de către joc (System e tot doar un flag de afișare).
async function psSetHidden(list, hide) {
  if (!list.length) return;
  const f = path.join(os.tmpdir(), 'rms-attr-' + process.pid + '-' + Date.now() + '.txt');
  try {
    fs.writeFileSync(f, '\ufeff' + list.join('\r\n'), 'utf8');
    const script = '$h=[IO.FileAttributes]::Hidden -bor [IO.FileAttributes]::System; Get-Content -LiteralPath $env:RMS_LIST -Encoding UTF8 | ForEach-Object { if ($_) { try { $i=Get-Item -LiteralPath $_ -Force; if ($env:RMS_HIDE -eq "1") { $i.Attributes = $i.Attributes -bor $h } else { $i.Attributes = $i.Attributes -band (-bnot $h) } } catch {} } }';
    await winRun('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { ...process.env, RMS_LIST: f, RMS_HIDE: hide ? '1' : '0' });
  } finally { try { fs.unlinkSync(f); } catch {} }
}
async function attribMany(flag, list) {
  if (process.platform !== 'win32' || !list.length) return;
  try { await unlockPaths(list); } catch {}   // dacă fișierele sunt blocate (ACL), se deblochează înainte de schimbarea atributelor
  // IMPORTANT: comanda externă „attrib” NU suportă corect mai multe căi deodată într-un singur apel (procesează
  // fiabil doar o cale per rulare) — trimis cu zeci/sute de căi ca argumente separate, raporta succes (exit 0) fără
  // să le ascundă de fapt pe toate, așa că fișierele rămâneau vizibile deși logul zicea „ascuns”. Se trece direct
  // prin PowerShell (deja verificat ca merge corect, vezi psSetHidden), nu doar ca plasă de siguranță la eroare.
  await psSetHidden(list, flag === '+h');
}

/* ---------------- Blocarea „Hidden” (ACL): cât timp RMS e instalat, atributul nu mai poate fi schimbat din attrib / Explorer ---------------- */
// Doar fișierele RMS care nu se rescriu niciodată (.rpf din mods, dll-urile și shaderele ENB) primesc „Deny: Write attributes” pentru Everyone.
// Fișierele de configurare (.ini etc.) și folderul „plugins” rămân libere, ca ENB să-și poată salva setările. Citirea de către joc nu e afectată.
const ACL_PS = `param([string]$List,[string]$Mode)
$sid = New-Object Security.Principal.SecurityIdentifier 'S-1-1-0'
$rule = New-Object Security.AccessControl.FileSystemAccessRule($sid,[Security.AccessControl.FileSystemRights]::WriteAttributes,[Security.AccessControl.AccessControlType]::Deny)
$sec = [Security.AccessControl.AccessControlSections]::Access
if ($List -like '*.json') { $paths = Get-Content -LiteralPath $List -Raw -Encoding UTF8 | ConvertFrom-Json } else { $paths = Get-Content -LiteralPath $List -Encoding UTF8 }
foreach ($p in $paths) {
  if (-not $p) { continue }
  try {
    if (Test-Path -LiteralPath $p -PathType Container) { $a = [IO.Directory]::GetAccessControl($p, $sec) } elseif (Test-Path -LiteralPath $p) { $a = [IO.File]::GetAccessControl($p, $sec) } else { continue }
    if ($Mode -eq 'add') { $a.AddAccessRule($rule) } else { [void]$a.RemoveAccessRule($rule) }
    if (Test-Path -LiteralPath $p -PathType Container) { [IO.Directory]::SetAccessControl($p, $a) } else { [IO.File]::SetAccessControl($p, $a) }
  } catch {}
}
`;
const LOCK_EXT = new Set(['.rpf', '.dll', '.fx', '.fxh', '.dds', '.png', '.bmp', '.tga']);
const lockRegFile = () => path.join(app.getPath('userData'), 'locked-files.json');
let lockReg = null;
function loadLockReg() {
  if (lockReg) return lockReg;
  lockReg = new Set();
  try { const j = JSON.parse(fs.readFileSync(lockRegFile(), 'utf8')); if (Array.isArray(j)) for (const x of j) if (typeof x === 'string') lockReg.add(x); } catch {}
  return lockReg;
}
function saveLockReg() { try { fs.writeFileSync(lockRegFile(), JSON.stringify([...loadLockReg()])); } catch {} }
function isLockableFile(f) {
  const low = path.resolve(f).toLowerCase(), sep = path.sep;
  if (!LOCK_EXT.has(path.extname(low))) return false;
  // cele 2 dll-uri ale comutatorului „RMS ENB” (d3d11.dll / d3dcompiler_46e.dll) stau în „plugins”, dar trebuie
  // blocate ACL la fel ca restul — altfel rămân ascunse DOAR prin atribut, fără lacăt, și un simplu „attrib -h”
  // le descoperă instant (exact tentativele de deblocare raportate false-pozitiv până la următoarea re-ascundere).
  // Restul folderului „plugins” rămâne neatins (alte plugin-uri FiveM au nevoie să scrie liber acolo).
  const isEnbPlugin = low.includes(sep + 'plugins' + sep) && ['d3d11.dll', 'd3dcompiler_46e.dll'].includes(path.basename(low));
  if (low.includes(sep + 'plugins' + sep) && !isEnbPlugin) return false;
  return isEnbPlugin || ['d3d11.dll', 'd3dcompiler_46e.dll'].includes(path.basename(low)) || low.includes(sep + 'mods' + sep) || low.includes(sep + 'enbseries' + sep);
}
async function runAcl(list, mode) {
  if (!list.length) return;
  const base = path.join(os.tmpdir(), 'rms-acl-' + process.pid + '-' + Date.now());
  const ps1 = base + '.ps1', txt = base + '.txt';
  try {
    fs.writeFileSync(ps1, '﻿' + ACL_PS, 'utf8');
    fs.writeFileSync(txt, '﻿' + list.join('\r\n'), 'utf8');
    await winRun('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-List', txt, '-Mode', mode]);
  } catch (e) { ilog('ACL ' + mode + ' eroare: ' + String((e && e.message) || e).slice(0, 160)); }
  finally { try { fs.unlinkSync(ps1); } catch {} try { fs.unlinkSync(txt); } catch {} }
}
// După instalare: enblocal.ini și enbseries.ini primesc explicit „Allow: Full control” pentru grupul Administrators
// (SID S-1-5-32-544, independent de limba Windows), ca în Proprietăți -> Security să apară bifat implicit, nu doar
// moștenit. Nu se ating celelalte permisiuni/grupuri, doar se adaugă regula asta pentru Administrators.
const ACL_ADMIN_PS = `param([string]$List)
$sid = New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544'
$rule = New-Object Security.AccessControl.FileSystemAccessRule($sid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]::None,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
foreach ($p in (Get-Content -LiteralPath $List -Encoding UTF8)) {
  if (-not $p) { continue }
  try {
    if (Test-Path -LiteralPath $p -PathType Leaf) {
      $a = Get-Acl -LiteralPath $p
      $a.SetAccessRule($rule)
      Set-Acl -LiteralPath $p $a
    }
  } catch {}
}
`;
async function grantAdminFullControl(list) {
  if (process.platform !== 'win32' || !list.length) return;
  const base = path.join(os.tmpdir(), 'rms-acladmin-' + process.pid + '-' + Date.now());
  const ps1 = base + '.ps1', txt = base + '.txt';
  try {
    fs.writeFileSync(ps1, '﻿' + ACL_ADMIN_PS, 'utf8');
    fs.writeFileSync(txt, '﻿' + list.join('\r\n'), 'utf8');
    await winRun('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-List', txt]);
    ilog('Permisiuni Administratori (Full control) setate: ' + list.join(', '));
  } catch (e) { ilog('Permisiuni Administratori eroare: ' + String((e && e.message) || e).slice(0, 160)); }
  finally { try { fs.unlinkSync(ps1); } catch {} try { fs.unlinkSync(txt); } catch {} }
}
async function lockManifest(m) {
  if (process.platform !== 'win32') return;
  try {
    const reg = loadLockReg();
    const dirs = existing([...(m.topDirs || [])]).filter(p => !isFivePlugins(m, p));
    const files = existing(m.touched || []).filter(isLockableFile);
    const todo = [...new Set([...dirs, ...files])].filter(p => !reg.has(p));
    if (!todo.length) return;
    await runAcl(todo, 'add');
    for (const p of todo) reg.add(p);
    saveLockReg();
    ilog('Blocare atribute: ' + todo.length + ' căi (fișiere + foldere)');
  } catch (e) { ilog('Blocare atribute eșuată: ' + String((e && e.message) || e).slice(0, 160)); }
}
async function unlockPaths(list) {
  if (process.platform !== 'win32' || !list.length) return;
  const reg = loadLockReg();
  if (!reg.size) return;
  const norm = p => path.resolve(p).toLowerCase();
  const want = new Set(list.map(norm));
  const hit = [...reg].filter(p => want.has(norm(p)));
  if (!hit.length) return;
  await runAcl(hit, 'remove');
  for (const p of hit) reg.delete(p);
  saveLockReg();
}
// toate căile din registrul REAL de blocări ACL care sunt egale cu „root” sau în interiorul lui — spre deosebire de
// enbSubManifest (care caută în manifestul principal), asta întreabă direct ce e blocat cu adevărat pe disc, ca
// deblocarea să nu rateze nimic dacă manifestul nu reflectă exact tot ce ACL a blocat (ex. foldere ENB mai vechi)
function lockedUnder(root) {
  const fullLow = path.resolve(root).toLowerCase();
  return [...loadLockReg()].filter(p => { const low = path.resolve(p).toLowerCase(); return low === fullLow || low.startsWith(fullLow + path.sep); });
}
// interoghează în bloc (un singur proces PowerShell) care din căile date NU mai are atributul „Hidden” — astfel se verifică
// ORICE fișier urmărit (nu doar folderele/fișierele de prim nivel), ca o comandă dată pe un .rpf individual din mods să fie prinsă și ea
async function psQueryUnhidden(list) {
  if (process.platform !== 'win32' || !list.length) return [];
  const f = path.join(os.tmpdir(), 'rms-qh-' + process.pid + '-' + Date.now() + '.txt');
  try {
    fs.writeFileSync(f, '﻿' + list.join('\r\n'), 'utf8');
    const script = '$h=[IO.FileAttributes]::Hidden; Get-Content -LiteralPath $env:RMS_LIST -Encoding UTF8 | ForEach-Object { if ($_) { try { $i=Get-Item -LiteralPath $_ -Force; if (-not ($i.Attributes -band $h)) { Write-Output $_ } } catch {} } }';
    const r = await winRun('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { ...process.env, RMS_LIST: f });
    return r.out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } finally { try { fs.unlinkSync(f); } catch {} }
}
// interoghează în bloc atributele NUMERICE (IO.FileAttributes, ca bitmask) ale unor căi — folosit pentru folderele rădăcină
// (GTA V Legacy / FiveM.app), care NU se ascund niciodată; se compară doar cu valoarea de la instalare, ca să se vadă dacă
// cineva le-a schimbat atributele (ex. le-a scos Read-only / System, sau orice altă modificare suspectă).
async function psRootAttrs(list) {
  if (process.platform !== 'win32' || !list.length) return {};
  const f = path.join(os.tmpdir(), 'rms-ra-' + process.pid + '-' + Date.now() + '.txt');
  try {
    fs.writeFileSync(f, '﻿' + list.join('\r\n'), 'utf8');
    const script = 'Get-Content -LiteralPath $env:RMS_LIST -Encoding UTF8 | ForEach-Object { if ($_) { try { $i=Get-Item -LiteralPath $_ -Force; Write-Output ($_ + "|" + [int]$i.Attributes) } catch {} } }';
    const r = await winRun('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { ...process.env, RMS_LIST: f });
    const out = {};
    for (const line of r.out.split(/\r?\n/)) { const i = line.lastIndexOf('|'); if (i < 0) continue; out[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
    return out;
  } finally { try { fs.unlinkSync(f); } catch {} }
}
// la o instalare reușită se rețin atributele curente ale GTA V / FiveM (baseline), ca reper pentru rehideTick
async function captureRootBaseline(m) {
  try {
    const roots = existing(m.roots || []);
    if (!roots.length) return;
    m.rootAttrs = await psRootAttrs(roots);
  } catch {}
}
// necondiționat, indiferent de manifest: (1) folderele „mods” și „plugins” din FiveM rămân mereu VIZIBILE — sunt
// foldere PARTAJATE cu alte moduri ale utilizatorului, nu doar ale RMS; (2) ORICE fișier din „mods” al cărui nume
// începe cu „RMS_” (ex. RMS_Graphics.rpf, RMS_Vegetation.rpf…) rămâne cu Hidden — forțat direct pe disc după nume,
// nu doar pe baza listei din manifest (care putea rămâne incompletă/depășită). Apelată și imediat după o instalare
// reușită (nu doar la verificarea periodică), ca efectul să fie instant, nu după până la 30s.
async function forceRmsFileState() {
  if (process.platform !== 'win32') return;
  try {
    const cpNow = currentPaths();
    if (cpNow.fivem) {
      const sharedDirs = existing(['mods', 'plugins'].map(n => path.join(cpNow.fivem, n)));
      if (sharedDirs.length) await attribMany('-h', sharedDirs);
    }
  } catch {}
  try {
    const md = fivemModsDir();
    if (md) {
      let names; try { names = fs.readdirSync(md); } catch { names = []; }
      const rmsFiles = existing(names.filter(n => /^rms_/i.test(n)).map(n => path.join(md, n)));
      if (rmsFiles.length) {
        await attribMany('+h', rmsFiles);
        try {
          const reg = loadLockReg();
          const todo = rmsFiles.filter(p => !reg.has(p));
          if (todo.length) { await runAcl(todo, 'add'); for (const p of todo) reg.add(p); saveLockReg(); }
        } catch {}
      }
    }
  } catch {}
}
// protecție în plus: cât rulează launcherul, TOATE fișierele/folderele RMS urmărite care au devenit vizibile se ascund la loc;
// în plus, folderele rădăcină GTA V / FiveM (fără să fie ascunse) sunt verificate dacă le-a schimbat cineva atributele
let rehiding = false;
async function rehideTick() {
  // isBusyLocked() = lacătul pe disc, valabil și pentru celălalt proces (watchdog fără fereastră / GUI cu fereastră,
  // vezi comentariul de la setBusy mai sus) — fără el, o instalare/dezinstalare pornită în ALT proces trecea
  // neobservată aici și fișierele făcute temporar vizibile (normal, ca să poată fi mutate/șterse) erau tratate greșit
  // ca tamper: re-ascunse în timp ce erau mutate + alertă falsă pe Discord.
  if (rehiding || downloadBusy || isBusyLocked() || process.platform !== 'win32') return;
  rehiding = true;
  try {
    const main = readManifest();
    const manifests = [main, ...OPT_ARCHIVE_IDS.map(readOptManifest)];
    for (const m of manifests) {
      if (!m.touched.length && !m.topDirs.length) continue;
      const dirs = existing([...(m.topDirs || []), ...(m.dirs || [])]).filter(p => !isFivePlugins(m, p));
      const files = existing(m.touched || []).filter(p => !isFivePlugins(m, p));
      const all = [...new Set([...dirs, ...files])];
      if (!all.length) continue;
      let bad = await psQueryUnhidden(all);
      if (!bad.length) continue;
      // interogarea de mai sus (PowerShell, pe sute de fișiere) durează — dacă o instalare/dezinstalare a pornit
      // chiar în acest interval (în orice proces), lista „bad” e deja depășită: nu mai înseamnă tamper, ci efectul
      // normal al acelei operații. Se renunță complet, fără re-ascundere și fără alertă.
      if (downloadBusy || isBusyLocked()) continue;
      // verificare dublă, cu o mică pauză: elimină falsele pozitive tranzitorii (coincidențe de timing, cache de
      // sistem etc.) — un tampering real rămâne neascuns și la a doua citire, deci tot se re-ascunde/alertează corect
      await new Promise(r => setTimeout(r, 400));
      if (downloadBusy || isBusyLocked()) continue;
      bad = await psQueryUnhidden(bad);
      if (!bad.length) continue;
      await attribMany('+h', bad);
      // re-blocare ACL (Deny: WriteAttributes) pentru fișierele RMS redevenite vizibile: attribMany le deblochează
      // mereu înainte să schimbe atributul (ca să poată, chiar dacă erau blocate), deci fără asta ar rămâne
      // neblocate definitiv după prima re-ascundere, deschise la un nou „unhide” din afara aplicației
      try {
        const relock = bad.filter(p => isLockableFile(p) || dirs.includes(p));
        if (relock.length) await runAcl(relock, 'add');
        for (const p of relock) loadLockReg().add(p);
        saveLockReg();
      } catch {}
      // log local detaliat (nu doar numărul total) — ca să se poată diagnostică exact ce s-a prins, fără să mai fie
      // nevoie de screenshot din Discord: pe ce zonă, și câteva nume de exemplu din fiecare
      try {
        const cpNow = currentPaths();
        const sample = a => bad.filter(p => areaOf(p, cpNow) === a).slice(0, 5).map(p => path.basename(p));
        const gtaN = bad.filter(p => areaOf(p, cpNow) === 'GTA V').length;
        const fivemN = bad.filter(p => areaOf(p, cpNow) === 'FiveM').length;
        const detail = [gtaN ? 'GTA V: ' + gtaN + ' (ex: ' + sample('GTA V').join(', ') + ')' : '', fivemN ? 'FiveM: ' + fivemN + ' (ex: ' + sample('FiveM').join(', ') + ')' : ''].filter(Boolean).join(' | ');
        ilog('Re-ascundere automată: ' + bad.length + (detail ? ' — ' + detail : ''));
      } catch { ilog('Re-ascundere automată: ' + bad.length); }
      try { sendTamperLog(bad).catch(() => {}); } catch {}
    }
    if (downloadBusy || isBusyLocked()) return;
    await forceRmsFileState();
    // folderele rădăcină (GTA V Legacy + FiveM.app): doar verificare, fără ascundere
    const roots = existing(main.roots || []);
    if (roots.length) {
      if (!main.rootAttrs) { await captureRootBaseline(main); writeManifest(main); }
      else {
        const now = await psRootAttrs(roots);
        if (downloadBusy || isBusyLocked()) return;   // instalare pornită cât timp se interoga PowerShell-ul de mai sus
        const changed = roots.filter(r => main.rootAttrs[r] !== undefined && now[r] !== undefined && now[r] !== main.rootAttrs[r]);
        if (changed.length) {
          ilog('Atribute schimbate pe folderul principal: ' + changed.join(', '));
          try { sendTamperLog(changed, 'root').catch(() => {}); } catch {}
          for (const r of changed) main.rootAttrs[r] = now[r];   // nu mai repetă alerta pentru aceeași schimbare neschimbată la rândul ei
          writeManifest(main);
        }
      }
    }
  } catch {} finally { rehiding = false; }
}
// atributele reale ale unei căi (attrib fără parametri le afișează); true dacă are „H”
async function isHiddenWin(p) {
  const r = await winRun('attrib', [p]);
  return /H/.test(r.out.split(/[A-Za-z]:\\/)[0]);
}
const existing = list => list.filter(p => { try { fs.lstatSync(p); return true; } catch { return false; } });
const underRoots = (p, roots) => { const low = path.resolve(p).toLowerCase(); return roots.some(r => low.startsWith(path.resolve(r).toLowerCase() + path.sep)); };

// la începutul instalării: folderele care NU există încă (ex. un folder nou sub mods) sunt create de RMS
function setPlan(all) {
  journal.all = Array.isArray(all) ? all : [];
  const roots = journal.roots.map(r => path.resolve(r));
  const dirs = new Set();
  for (const f of journal.all) {
    let d = path.dirname(f);
    while (true) {
      const low = path.resolve(d).toLowerCase();
      if (roots.some(r => r.toLowerCase() === low) || !roots.some(r => low.startsWith(r.toLowerCase() + path.sep))) break;
      if (!fs.existsSync(d)) dirs.add(d);
      d = path.dirname(d);
    }
  }
  journal.newDirs = [...dirs];
  // folderele de prim nivel (ex. „mods”, „plugins”) care conțin fișiere RMS se ascund și ele, chiar dacă existau deja
  const tops = new Set();
  for (const f of journal.all) {
    const r = roots.find(x => path.resolve(f).toLowerCase().startsWith(x.toLowerCase() + path.sep));
    if (!r) continue;
    const seg = path.relative(r, f).split(path.sep);
    if (seg.length > 1) tops.add(path.join(r, seg[0]));
  }
  journal.topDirs = [...tops];
}

// întâi folderele de prim nivel (mods, plugins, enbseries…), apoi fișierele; la final se VERIFICĂ elementele vizibile de prim nivel
// folderele „mods” și „plugins” din FiveM Application Data rămân mereu VIZIBILE și neblocate ca folder (nu se ascund,
// nu se pun pe ACL) — sunt foldere PARTAJATE cu alte moduri ale utilizatorului, deci nu trebuie ascuns tot folderul,
// doar fișierele RMS individuale dinăuntru. Altfel, dacă utilizatorul șterge „mods” și pune un folder nou cu același
// nume, acela ar ajunge ascuns/blocat automat la următoarea instalare sau re-ascundere, deși nu e al RMS.
const FIVEM_SHARED_TOPDIRS = new Set(['mods', 'plugins']);
function isFivePlugins(m, p) {
  // necondiționat: orice folder numit „mods” sau „plugins” e exceptat de la ascundere/ACL, indiferent dacă
  // manifestul are sau nu câmpul „fivem” populat corect (nu depinde de el, ca să nu existe nicio breșă)
  return FIVEM_SHARED_TOPDIRS.has(path.basename(p).toLowerCase());
}
async function hideManifest(m) {
  const pluginsDirs = existing([...(m.topDirs || []), ...m.dirs]).filter(p => isFivePlugins(m, p));
  const tops = existing([...(m.topDirs || []), ...m.dirs]).filter(p => !isFivePlugins(m, p));
  await attribMany('+h', tops);
  await attribMany('+h', existing(m.touched).filter(p => !isFivePlugins(m, p)));
  if (pluginsDirs.length) await attribMany('-h', pluginsDirs);
  const roots = (m.roots || []).map(r => path.resolve(r).toLowerCase());
  const topFiles = existing(m.touched.filter(f => roots.includes(path.dirname(path.resolve(f)).toLowerCase())));
  const visible = [...existing(m.topDirs || []).filter(p => !isFivePlugins(m, p)), ...topFiles];
  const bad = [];
  (await Promise.all(visible.map(async p => [p, await isHiddenWin(p)]))).forEach(([p, ok]) => { if (!ok) bad.push(p); });
  if (bad.length) { await psSetHidden(bad, true); }
  let still = 0;
  (await Promise.all(bad.map(async p => [p, await isHiddenWin(p)]))).forEach(([p, ok]) => { if (!ok) { still++; ilog('NU am putut ascunde: ' + p); } });
  ilog('Verificare ascundere: ' + (visible.length - bad.length) + '/' + visible.length + ' ok din prima' + (bad.length ? ', ' + (bad.length - still) + ' reparate prin PowerShell' : '') + (still ? ', ' + still + ' EȘUATE' : ''));
  await lockManifest(m);
}
async function showManifest(m) {
  await attribMany('-h', existing([...(m.topDirs || []), ...m.dirs]));
  await attribMany('-h', existing(m.touched));
}

// arhiva descărcată (dacă există) – din ea se poate reface lista de fișiere când lista de instalare lipsește
function packArchivePath() {
  const f = path.join(packDir(), cfg.DOWNLOAD_FILENAME || 'RMS_GRAPHICS.rar');
  if (fs.existsSync(f)) return f;
  const man = manualPackPath();
  return man && fs.existsSync(man) ? man : null;
}
async function planFromArchive(p) {
  try {
    const archive = packArchivePath();
    const native = require('./native-unrar');
    const exe = native.findUnrarExe();
    if (!archive || !exe) return null;
    return await native.planFiles({ exe, archive, password: packPassword(), fivemDir: p.fivem, gtaDir: p.gta });
  } catch (e) { ilog('Nu am putut citi lista din arhivă: ' + ((e && e.message) || e)); return null; }
}
function topDirsOf(all, roots) {
  const rs = roots.map(r => path.resolve(r));
  const tops = new Set();
  for (const f of all) {
    const r = rs.find(x => path.resolve(f).toLowerCase().startsWith(x.toLowerCase() + path.sep));
    if (!r) continue;
    const seg = path.relative(r, f).split(path.sep);
    if (seg.length > 1) tops.add(path.join(r, seg[0]));
  }
  return [...tops];
}

// „instalat” = există lista de instalare ȘI cel puțin un fișier din ea mai există pe disc (altfel butonul de dezinstalare rămâne inactiv)
// Ce a pus RMS se citește și direct de pe disc (nu doar din lista de instalare), ca „instalat” să rămână corect
// după repornire, după o instalare făcută de mână sau cu o versiune mai veche a launcherului.
const RMS_RPF_NAMES = new Set(['rms_custom_vehshare','rms_dynamicfx','rms_gasstation','rms_graphics','rms_graphics_audiofx','rms_roads','rms_textures','rms_vegetation','rms_clean_sky']);
function scanRmsDisk(rpfOnly) {
  const out = [];
  const list = d => { try { return fs.readdirSync(d); } catch { return []; } };
  try {
    const p = currentPaths();
    if (p.gta && !rpfOnly) for (const n of list(p.gta)) if (['d3d11.dll', 'd3dcompiler_46e.dll'].includes(n.toLowerCase())) out.push(path.join(p.gta, n));
    const mods = fivemModsDir();
    if (mods) for (const n of list(mods)) if (/\.rpf$/i.test(n) && RMS_RPF_NAMES.has(n.slice(0, -4).toLowerCase())) out.push(path.join(mods, n));
  } catch {}
  return out.filter(f => { try { return fs.lstatSync(f).isFile(); } catch { return false; } });
}
// Verificare vizibilă în log: după o instalare reușită, chiar au ajuns în folderul GTA V ales fișierele/folderele ENB
// așteptate (enbseries, shaderinput, enblocal.ini, enbseries.ini, d3d11.dll, d3dcompiler_46e.dll)? Nu blochează
// instalarea (poate fi un pachet fără ENB), dar scrie clar în log dacă lipsește ceva, în loc să tacă din gură.
function verifyGtaEnb(p) {
  try {
    if (!p || !p.gta) return [];
    const expect = ['enbseries', 'shaderinput', 'enblocal.ini', 'enbseries.ini', 'd3d11.dll', 'd3dcompiler_46e.dll'];
    const missing = expect.filter(n => !fs.existsSync(path.join(p.gta, n)));
    if (missing.length) ilog('ATENȚIE: lipsesc din folderul GTA V după instalare: ' + missing.join(', '));
    else ilog('Verificare GTA V: toate elementele ENB așteptate sunt prezente.');
    return missing;
  } catch { return []; }
}
function isRmsInstalled() {
  const m = readManifest();
  const list = [...m.touched, ...m.created];
  if (list.some(f => { try { fs.lstatSync(f); return true; } catch { return false; } })) return true;
  return scanRmsDisk(true).length > 0;   // pe disc contează doar fișierele .rpf RMS (d3d11.dll etc. pot veni și de la alte moduri)
}
// Folderul „mods” din FiveM: în folderul ales la Auto Install („FiveM Application Data”), în FiveM.app de lângă el
// sau, dacă nu s-a ales încă nimic, în locația implicită %LOCALAPPDATA%\FiveM\FiveM.app. Se folosește doar pentru afișarea
// stării „instalat” din RMS System Info (dezinstalarea și blocările rămân după lista de instalare).
function fivemModsDir() {
  const cand = [];
  const p = currentPaths();
  if (p.fivem) {
    const f = path.resolve(p.fivem);
    cand.push(path.join(f, 'mods'), path.join(f, 'FiveM.app', 'mods'), path.join(path.dirname(f), 'FiveM.app', 'mods'));
  }
  const la = process.env.LOCALAPPDATA || '';
  if (la) cand.push(path.join(la, 'FiveM', 'FiveM.app', 'mods'), path.join(la, 'FiveM', 'FiveM Application Data', 'mods'));
  return cand.find(d => isDir(d)) || null;
}
ipcMain.handle('install-status', () => {
  const mods = fivemModsDir();
  return { installed: isRmsInstalled(), needDownload: needRedownload(), modsFound: !!mods, modsDir: mods || '' };
});

// Backup local pentru pachetul principal: la dezinstalare, fișierele .rpf RMS + cele 2 dll-uri (singurele șterse efectiv,
// vezi UNINSTALL_ONLY mai jos) NU se șterg, ci se mută într-un folder ascuns din datele aplicației. Dacă la o instalare
// ulterioară versiunea e aceeași (niciun update), se restaurează instant din backup, fără nicio redescărcare.
const mainBackupRoot = () => path.join(app.getPath('userData'), 'rms-backup');
const mainBackupMetaFile = () => path.join(app.getPath('userData'), 'rms-backup-map.json');
function readMainBackupMeta() {
  try { const j = JSON.parse(fs.readFileSync(mainBackupMetaFile(), 'utf8')); return (j && typeof j === 'object' && Array.isArray(j.files)) ? j : null; } catch { return null; }
}
function writeMainBackupMeta(j) { try { fs.writeFileSync(mainBackupMetaFile(), JSON.stringify(j)); } catch (e) { ilog('Nu am putut salva harta backup-ului: ' + (e && e.message)); } }
function clearMainBackup() {
  try { fs.rmSync(mainBackupRoot(), { recursive: true, force: true }); } catch {}
  try { fs.unlinkSync(mainBackupMetaFile()); } catch {}
}
// backup valid = există, nu s-a schimbat versiunea pachetului între timp (altfel preferăm o descărcare nouă) și fiecare
// fișier listat chiar mai există fizic în backup
function mainBackupUsable() {
  const meta = readMainBackupMeta();
  if (!meta || !meta.files.length) return null;
  if (Number(meta.version) !== Number(cfg.PACK_VERSION)) return null;
  return meta.files.every(f => { try { fs.lstatSync(f.backup); return true; } catch { return false; } }) ? meta : null;
}
function moveRetry(from, to) {
  for (let i = 0; i < 5; i++) {
    try { fs.renameSync(from, to); return true; }
    catch (e) {
      if (e && e.code === 'ENOENT') return false;
      // EXDEV (disc diferit) nu se rezolvă reîncercând rename-ul — se trece direct la copiere, altfel pierdem
      // ~1s de așteptare (sleepSync) degeaba, de câteva ori la rând, pentru fiecare fișier de pe alt disc
      if (e && e.code === 'EXDEV') break;
      sleepSync(250);
    }
  }
  try { fs.copyFileSync(from, to); fs.rmSync(from, { force: true }); return true; } catch { return false; }
}
const asleep = ms => new Promise(r => setTimeout(r, ms));
// variantă ASINCRONĂ a lui moveRetry, pentru mutări în buclă (ex. dezinstalare completă: zeci/sute de fișiere,
// posibil pe alt disc decât folderul de backup) — nu blochează thread-ul principal (deci nici fereastra aplicației,
// care altfel ajunge „Not Responding” în Windows cât timp se copiază date mari sincron)
async function moveRetryAsync(from, to) {
  for (let i = 0; i < 5; i++) {
    try { await fs.promises.rename(from, to); return true; }
    catch (e) {
      if (e && e.code === 'ENOENT') return false;
      if (e && e.code === 'EXDEV') break;
      await asleep(250);
    }
  }
  try { await fs.promises.copyFile(from, to); await fs.promises.rm(from, { force: true }); return true; } catch { return false; }
}

async function runUninstall() {
  if (downloadBusy) return { ok: false, error: 'busy' };
  setBusy(true);
  try {
    const prevVersion = Number(readPackState().current) || 0;   // versiunea instalată acum, salvată pentru harta de backup
    let m = readManifest();
    const hadNb = !!readNbState().gta;
    await restoreNightBright();   // resturi Night Bright de la versiuni vechi (pune la loc fișierele ENB din pachet, care apoi se șterg odată cu pachetul)
    // dacă RMS ENB era „dezactivat” (cele 2 dll-uri mutate în backup-ul local ascuns din plugins), le aducem înapoi
    // la locul lor normal înainte de dezinstalare, ca să fie șterse ca tot restul și să nu rămână un backup orfan
    let enbBkDir = null;
    try {
      const cpNow = currentPaths();
      if (cpNow.fivem) {
        enbBkDir = enbBackupDir(cpNow);
        for (const n of ENB_FIVEM_PLUGIN_NAMES) {
          const b = path.join(enbBkDir, n), live = path.join(cpNow.fivem, 'plugins', n);
          if (pathKindExisting(b) && !pathKindExisting(live)) { try { await unlockPaths(lockedUnder(b)); } catch {} await enbMoveFile(b, live); }
        }
      }
    } catch {}
    // se șterge ABSOLUT TOT ce a pus RMS (instalare de la 0 la o reinstalare): fișierele noi, cele care au înlocuit
    // fișiere vechi cu același nume, și tot ce a mai rămas fizic pe disc (vezi diskFiles mai jos)
    let files = [...new Set([...m.created, ...m.touched])];
    let roots = m.roots;
    const diskFiles = scanRmsDisk();   // și ce există pe disc, chiar dacă lista de instalare lipsește
    if (diskFiles.length) {
      const cp = currentPaths(), md = fivemModsDir();
      roots = [...new Set([...roots, cp.fivem, cp.gta, md].filter(Boolean))];
      files = [...new Set([...files, ...diskFiles])];
    }
    if (!files.length && (readUiState().dest || hadNb)) {   // s-au instalat doar pachete opționale fără arhivă (frontend.xml / Night Bright)
      restoreUiFile();
      try { fs.unlinkSync(optStateFile()); } catch {}
      ilog('=== Dezinstalare reușită === frontend.xml restaurat');
      return { ok: true, removed: 1 };
    }
    if (!files.length) {
      // lista de instalare lipsește (instalare mai veche): o refacem din arhiva păstrată în datele aplicației
      const p = currentPaths();
      if (!p.gta || !p.fivem) return { ok: false, error: 'nothing' };
      files = (await planFromArchive(p)) || [];
      if (!files.length) return { ok: false, error: 'nothing' };
      roots = [p.fivem, p.gta];
      m = { roots, created: [], touched: files, dirs: [], topDirs: topDirsOf(files, roots), fivem: p.fivem };
      ilog('Dezinstalare: lista refăcută din arhivă (' + files.length + ' fișiere)');
    }
    ilog('=== Dezinstalare pornită === fișiere: ' + files.length + ' | foldere create: ' + m.dirs.length);
    const safe = l => l.filter(p => underRoots(p, roots));
    // la dezinstalare completă se șterge ABSOLUT tot ce a instalat RMS (mods, plugins, enbseries, shaderinput,
    // enblocal.ini, enbseries.ini, cele 2 dll-uri etc.) — nu doar cele 2 dll-uri ca înainte
    const target = safe(files);

    // 1) scoatem „Hidden” doar de pe fișierele care se șterg
    await showManifest({ touched: target, dirs: [], topDirs: [] });

    // 2) NU se șterg: se mută într-un backup local (ca o reinstalare ulterioară, la aceeași versiune, să nu mai necesite
    // redescărcare) — întâi o singură încercare rapidă, apoi reîncercări pentru cele blocate / read-only.
    // EXCEPȚIE: dacă manifestul curent e deja cunoscut ca incomplet (o restaurare anterioară a ieșit cu fișiere
    // lipsă), NU se mai creează alt backup local din el — s-ar recrea mereu, incomplet, și ar bloca pentru totdeauna
    // o extragere reală din arhivă (vezi isBackupIncomplete). Fișierele se șterg direct de data asta.
    const skipBackup = isBackupIncomplete();
    const backupMap = [];
    // ASINCRON: la o dezinstalare completă se mută potențial sute de fișiere (texturi, enbseries etc.), adesea pe alt
    // disc decât folderul de backup (ex. GTA V pe D:, backup-ul în datele aplicației de pe C:) — folosit sincron,
    // asta bloca thread-ul principal (deci și fereastra aplicației, „Not Responding”) pentru tot timpul copierii.
    // Cu fs.promises + await, Node poate procesa în continuare mesajele ferestrei între fișiere / în timpul copierii.
    const moveToBackup = async f => {
      if (skipBackup) { await fs.promises.rm(f, { force: true }); return; }
      const dest = path.join(mainBackupRoot(), String(backupMap.length + 1).padStart(5, '0') + '-' + path.basename(f));
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      try {
        await fs.promises.rename(f, dest);
      } catch (e) {
        if (e && e.code === 'EXDEV') { await fs.promises.copyFile(f, dest); await fs.promises.rm(f, { force: true }); }
        else throw e;
      }
      backupMap.push({ orig: f, backup: dest });
    };
    let removed = 0; const retry = [];
    for (const f of target) {
      try { if (!fs.existsSync(f)) continue; await moveToBackup(f); removed++; }
      catch (e) { if (!e || e.code !== 'ENOENT') retry.push(f); }
    }
    const failed = [];
    if (retry.length) {
      await attribMany('-r', existing(retry));
      for (const f of retry) {
        if (!fs.existsSync(f)) { removed++; continue; }
        if (skipBackup) { try { await fs.promises.rm(f, { force: true }); removed++; } catch { failed.push(f); } continue; }
        const dest = path.join(mainBackupRoot(), String(backupMap.length + 1).padStart(5, '0') + '-' + path.basename(f));
        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
        if (await moveRetryAsync(f, dest)) { backupMap.push({ orig: f, backup: dest }); removed++; } else failed.push(f);
      }
    }
    if (!skipBackup && backupMap.length) {
      // păstrăm și intrările mai vechi din backup (aceeași versiune) care nu mai sunt live acum, dar încă există fizic
      // în backup — altfel, dacă o restaurare anterioară a eșuat pentru un fișier, el „dispare” din evidență pentru
      // totdeauna la următorul ciclu dezinstalare/instalare, deși fișierul lui de backup chiar există pe disc
      const oldMeta = readMainBackupMeta();
      if (oldMeta && Number(oldMeta.version) === (prevVersion || Number(cfg.PACK_VERSION) || 0)) {
        const have = new Set(backupMap.map(e => path.resolve(e.orig).toLowerCase()));
        for (const e of oldMeta.files) {
          const lowOrig = path.resolve(e.orig).toLowerCase();
          if (have.has(lowOrig)) continue;
          try { fs.lstatSync(e.backup); backupMap.push(e); have.add(lowOrig); } catch {}
        }
      }
      writeMainBackupMeta({ version: prevVersion || Number(cfg.PACK_VERSION) || 0, files: backupMap, ts: Date.now() });
      try { await hideOnWin(mainBackupRoot()); } catch {}   // folderul de backup rămâne ascuns, nu se vede în Explorer
    }

    // 3) foldere rămase goale după ștergere (mods / plugins existente dinainte NU se șterg)
    const rs = roots.map(r => path.resolve(r).toLowerCase());
    const fivemRoot = m.fivem || (currentPaths().fivem) || roots.find(r => /fivem/i.test(r)) || '';
    const fvLow = fivemRoot ? path.resolve(fivemRoot).toLowerCase() : null;
    // doar folderele de prim nivel din FiveM (mods, plugins) rămân; cele din GTA V se șterg dacă au rămas goale
    const keepLow = new Set(safe(m.topDirs).map(d => path.resolve(d).toLowerCase()).filter(d => fvLow && d.startsWith(fvLow + path.sep)));
    const cand = new Set();
    for (const f of target) {
      let d = path.dirname(f);
      while (true) {
        const low = path.resolve(d).toLowerCase();
        if (rs.includes(low) || !rs.some(r => low.startsWith(r + path.sep))) break;
        cand.add(d); d = path.dirname(d);
      }
    }
    // se șterg toate folderele rămase goale, inclusiv „mods” și „plugins” din FiveM (dacă mai conțin altceva, rămân)
    for (const d of [...cand].sort((a, b) => b.length - a.length)) {
      try { fs.rmdirSync(d); } catch {}
    }
    // în folderele RMS din GTA V (enbseries, shaderinput etc.) scoatem și subfolderele goale rămase — recursiv, dar
    // doar dacă sunt chiar goale (nu atingem nimic care mai conține ceva, ex. un folder cu fișiere puse manual de user)
    const pruneEmpty = d => {
      let kids; try { kids = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const k of kids) if (k.isDirectory()) pruneEmpty(path.join(d, k.name));
      try { fs.rmdirSync(d); } catch {}
    };
    // instalare „de la 0”: foldere-rădăcină RMS din GTA V (NU mods/plugins din FiveM, acelea rămân mereu dacă există
    // dinainte) se curăță complet dacă au rămas fără conținut, ca să nu rămână cochilii goale (enbseries, shaderinput…)
    for (const d of safe(m.topDirs)) {
      const low = path.resolve(d).toLowerCase();
      if (fvLow && (low === fvLow || low.startsWith(fvLow + path.sep))) continue;   // folderele din FiveM nu se ating aici
      pruneEmpty(d);
    }

    if (failed.length) {
      writeManifest({ roots, created: failed, touched: failed, dirs: [], topDirs: [], fivem: m.fivem || '' });
      await hideManifest({ roots, touched: failed, dirs: [], topDirs: [] });   // ce nu s-a putut șterge rămâne în listă pentru o nouă încercare
      ilog('Dezinstalare incompletă, rămase: ' + failed.length + ' | șterse: ' + removed);
      return { ok: false, error: 'partial', left: failed.length, removed };
    }
    restoreUiFile();
    try { fs.unlinkSync(manifestFile()); } catch {}
    try { fs.unlinkSync(optStateFile()); } catch {}
    if (enbBkDir) { try { fs.rmdirSync(enbBkDir); } catch {} }   // backup-ul ascuns RMS ENB, dacă a rămas gol, nu trebuie să rămână orfan
    clearMainBackup();   // dezinstalare completă = de la 0: se șterge ORICE backup local (chiar și unul creat în acest ciclu), fără excepție
    setBackupIncomplete(false);   // nimic instalat, nimic de backup: steagul „incomplet” nu mai are rost — următoarea Instalare oricum extrage din arhivă
    setPackState({ current: 0, currentName: '', archive: 0, instVer: 0, instUpdated: '' });   // nimic instalat: versiunea instalată dispare și din Descărcări, și din Auto Install
    setNeedRedownload(true);   // Auto Install rămâne blocat până la o nouă descărcare din tab-ul Descărcări
    try { await unlockPaths([...loadLockReg()]); } catch {}   // nimic RMS nu mai e instalat: se scoate blocarea și de pe folderele rămase (ex. „mods” cu alte moduri)
    // „mods” și „plugins” sunt foldere PARTAJATE (pot rămâne cu alte moduri ale utilizatorului) și nu trebuie să rămână
    // Hidden după o dezinstalare completă — inclusiv dacă au rămas Hidden dintr-un ciclu mai vechi (înainte de acest fix),
    // caz în care nimic altceva nu le-ar mai dezascunde automat decât la o viitoare (re)instalare
    try { await forceRmsFileState(); } catch {}
    ilog('=== Dezinstalare reușită === șterse: ' + removed);
    setAutostart(false).catch(() => {}); resetTamperCount();   // nimic RMS instalat: watchdog-ul se oprește și contorul de tentative se resetează
    setFolderOptionsBlock(false).catch(() => {});   // nimic RMS instalat: „Folder Options” redevine disponibil normal în Explorer
    return { ok: true, removed };
  } catch (e) {
    ilog('Dezinstalare eșuată: ' + ((e && e.message) || e));
    return { ok: false, error: String((e && e.message) || e) };
  } finally { setBusy(false); }
}
ipcMain.handle('install-uninstall', () => runUninstall());

/* ---------------- Moduri .rpf din folderul „mods” (lista + dezinstalare individuală) ---------------- */
const RMS_RPF_SKIP = new Set(['rms_custom_vehshare','rms_dynamicfx','rms_gasstation','rms_graphics','rms_graphics_audiofx','rms_roads','rms_textures','rms_vegetation','rms_clean_sky']);   // modurile RMS nu apar în listă
function isUserRpf(name) {   // doar .rpf care NU sunt RMS: modurile RMS sunt protejate și nu se șterg individual
  return typeof name === 'string' && name === path.basename(name) && /\.rpf$/i.test(name) && !RMS_RPF_SKIP.has(name.slice(0, -4).toLowerCase());
}
let modsWatch = null, modsWatchDir = '', modsTimer = null;
function watchMods(dir) {
  if (dir === modsWatchDir && modsWatch) return;
  try { if (modsWatch) modsWatch.close(); } catch {}
  modsWatch = null; modsWatchDir = dir || '';
  if (!dir) return;
  try {
    modsWatch = fs.watch(dir, () => {
      clearTimeout(modsTimer);
      modsTimer = setTimeout(() => {
        for (const w of BrowserWindow.getAllWindows()) { try { w.webContents.send('mods-changed'); } catch {} }
      }, 200);
    });
    modsWatch.on('error', () => { try { modsWatch.close(); } catch {} modsWatch = null; modsWatchDir = ''; });
  } catch { modsWatch = null; modsWatchDir = ''; }
}
ipcMain.handle('mods-list', () => {
  try {
    const dir = fivemModsDir();
    watchMods(dir);
    if (!dir) return { ok: true, dir: '', items: [] };
    // fișierele puse de un pachet RMS Optional cu arhivă proprie (Halloween, Christmas...) apar separat, cu id-ul pachetului
    const optOwners = {};
    for (const id of OPT_ARCHIVE_IDS) {
      const m = readOptManifest(id);
      for (const f of [...m.created, ...m.touched]) optOwners[path.resolve(f).toLowerCase()] = id;
    }
    const items = [];
    const seen = new Set();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile() || !/\.rpf$/i.test(e.name)) continue;
      const full = path.join(dir, e.name);
      let size = 0; try { size = fs.statSync(full).size; } catch {}
      const opt = optOwners[path.resolve(full).toLowerCase()] || '';
      items.push({ name: e.name, size, rms: RMS_RPF_SKIP.has(e.name.slice(0, -4).toLowerCase()), opt, backed: false });
      seen.add(path.resolve(full).toLowerCase());
    }
    // moduri RMS dezinstalate individual (mutate în backup-ul local): rămân vizibile în listă, ca „Instalare”,
    // ca să poată fi puse la loc fără redescărcare; apar DOAR dacă au fost instalate cândva (deci au backup)
    // ȘI doar dacă pachetul RMS, per ansamblu, e tot instalat (aceeași verificare ca la „Instalat” / „Neinstalat”
    // din Auto Install) — dacă RMS nu mai e instalat deloc, dispar complet din tab (se reface din Auto Install)
    const meta = isRmsInstalled() ? readMainBackupMeta() : null;
    if (meta && Array.isArray(meta.files)) {
      const dirLow = path.resolve(dir).toLowerCase();
      for (const f of meta.files) {
        const origLow = path.resolve(f.orig || '').toLowerCase();
        if (path.dirname(origLow) !== dirLow || seen.has(origLow)) continue;
        const base = path.basename(f.orig);
        if (!/\.rpf$/i.test(base) || !RMS_RPF_SKIP.has(base.slice(0, -4).toLowerCase())) continue;
        let size = 0; try { size = fs.statSync(f.backup).size; } catch { continue; }   // backup lipsă → nu arătăm un mod fantomă
        items.push({ name: base, size, rms: true, opt: '', backed: true });
        seen.add(origLow);
      }
    }
    const grp = x => x.rms ? 2 : (x.opt ? 1 : 0);
    items.sort((a, b) => (grp(a) - grp(b)) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    return { ok: true, dir, items };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
ipcMain.handle('mods-delete', async (_e, name) => {
  try {
    if (!isUserRpf(name)) return { ok: false, error: 'invalid' };
    const dir = fivemModsDir();
    if (!dir) return { ok: false, error: 'nomods' };
    const file = path.join(dir, name);
    if (path.dirname(path.resolve(file)) !== path.resolve(dir)) return { ok: false, error: 'invalid' };
    if (!fs.existsSync(file)) return { ok: false, error: 'missing' };
    try { await attribMany('-r', [file]); await attribMany('-h', [file]); } catch {}
    let err = null;
    for (let i = 0; i < 5; i++) {
      try { fs.unlinkSync(file); err = null; break; } catch (e) { err = e; await new Promise(r => setTimeout(r, 250)); }
    }
    if (err && fs.existsSync(file)) { ilog('Ștergere mod eșuată: ' + name + ' – ' + err.message); return { ok: false, error: 'locked' }; }
    ilog('Mod șters: ' + name);
    return { ok: true };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
// un singur mod RMS (ex. rms_graphics.rpf), NU tot pachetul: se scoate din ACL + Hidden, apoi se mută în backup-ul local
// (ca și la dezinstalarea completă), ca „Reinstalează” din Auto Install să-l poată aduce înapoi fără redescărcare.
// FIX: extrasă din ipcMain.handle('mods-delete-rms', ...) ca funcție reutilizabilă.
async function disableRmsModFile(name) {
  const base = typeof name === 'string' && /\.rpf$/i.test(name) ? name.slice(0, -4).toLowerCase() : '';
  if (!base || !RMS_RPF_SKIP.has(base)) return { ok: false, error: 'invalid' };
  const dir = fivemModsDir();
  if (!dir) return { ok: false, error: 'nomods' };
  const file = path.join(dir, name);
  if (path.dirname(path.resolve(file)) !== path.resolve(dir)) return { ok: false, error: 'invalid' };
  if (!fs.existsSync(file)) return { ok: false, error: 'missing' };
  const low = path.resolve(file).toLowerCase();
  try { await unlockPaths([file]); await attribMany('-h', [file]); } catch {}
  const dest = path.join(mainBackupRoot(), Date.now() + '-' + path.basename(file));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let moved = false;
  try { fs.renameSync(file, dest); moved = true; } catch { moved = moveRetry(file, dest); }
  if (!moved || fs.existsSync(file)) { ilog('Ștergere mod RMS eșuată: ' + name); return { ok: false, error: 'locked' }; }
  const prevMeta = readMainBackupMeta();
  const files = [...((prevMeta && prevMeta.files) || []).filter(f => String(f.orig || '').toLowerCase() !== low), { orig: file, backup: dest }];
  writeMainBackupMeta({ version: Number(readPackState().current) || Number(cfg.PACK_VERSION) || 0, files, ts: Date.now() });
  try { await hideOnWin(mainBackupRoot()); } catch {}
  writeManifest(removeFromManifest(readManifest(), low));
  ilog('Mod RMS mutat în backup (nu tot pachetul): ' + name);
  return { ok: true };
}
ipcMain.handle('mods-delete-rms', async (_e, name) => {
  // setBusy: cât timp fișierul e temporar Unhidden/deblocat pentru mutare, watchdog-ul (rehideTick, la 10s) nu
  // trebuie să-l vadă așa și să trimită o alertă falsă de tamper — exact ce se întâmpla înainte de acest fix.
  setBusy(true);
  try { return await disableRmsModFile(name); }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  finally { setBusy(false); }
});
// reface un singur mod RMS din backup-ul local, direct în folderul mods (fără redescărcare, fără parolă),
// și îl ascunde + blochează din nou, exact ca pe celelalte fișiere RMS instalate
// FIX: extrasă ca funcție reutilizabilă (vezi disableRmsModFile mai sus).
async function restoreRmsModFile(name) {
  const base = typeof name === 'string' && /\.rpf$/i.test(name) ? name.slice(0, -4).toLowerCase() : '';
  if (!base || !RMS_RPF_SKIP.has(base)) return { ok: false, error: 'invalid' };
  const dir = fivemModsDir();
  if (!dir) return { ok: false, error: 'nomods' };
  const file = path.join(dir, name);
  if (path.dirname(path.resolve(file)) !== path.resolve(dir)) return { ok: false, error: 'invalid' };
  const low = path.resolve(file).toLowerCase();
  const meta = readMainBackupMeta();
  const entry = meta && Array.isArray(meta.files) && meta.files.find(f => String(f.orig || '').toLowerCase() === low);
  if (!entry) return { ok: false, error: 'missing' };
  try { fs.lstatSync(entry.backup); } catch { return { ok: false, error: 'missing' }; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.rmSync(file, { force: true }); } catch {}
  let moved = false;
  try { fs.renameSync(entry.backup, file); moved = true; } catch { moved = moveRetry(entry.backup, file); }
  if (!moved || !fs.existsSync(file)) { ilog('Instalare mod RMS eșuată: ' + name); return { ok: false, error: 'locked' }; }
  const leftover = meta.files.filter(f => String(f.orig || '').toLowerCase() !== low);
  if (leftover.length) writeMainBackupMeta({ version: meta.version, files: leftover, ts: meta.ts });
  else clearMainBackup();
  const p = currentPaths();
  let m = readManifest();
  m = {
    roots: [...new Set([...(m.roots || []), p.fivem, p.gta].filter(Boolean))],
    created: m.created || [],
    touched: [...new Set([...(m.touched || []), file])],
    dirs: m.dirs || [],
    topDirs: m.topDirs || [],
    fivem: m.fivem || p.fivem
  };
  writeManifest(m);
  await hideManifest({ topDirs: [], touched: [file], dirs: [], fivem: p.fivem || m.fivem });
  try { await forceRmsFileState(); } catch {}
  ilog('Mod RMS restaurat din backup (fără redescărcare): ' + name);
  return { ok: true };
}
ipcMain.handle('mods-install-rms', async (_e, name) => {
  // setBusy: la fel ca la mods-delete-rms — cât timp fișierul e temporar deblocat/mutat din backup, watchdog-ul
  // (rehideTick, la 10s) nu trebuie să-l vadă așa și să trimită o alertă falsă de tamper pe Discord.
  setBusy(true);
  try {
    const r = await restoreRmsModFile(name);
    // reactivezi RMS Clean Sky din Dezinstalare Moduri -> RMS Milky Way (de la Optional) se dezinstalează automat,
    // dacă era instalat (exclusivitate — vezi funcțiile de mai sus).
    if (r.ok && typeof name === 'string' && name.toLowerCase() === CLEAN_SKY_FILE.toLowerCase()) { try { await uninstallMilkyWayForCleanSky(); } catch {} }
    return r;
  }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  finally { setBusy(false); }
});

/* ---------------- „RMS ENB” (în tab-ul Dezinstalare Moduri) — comutator Instalare/Dezinstalare prin backup local ---------------- */
// Se ating DOAR cele 2 fișiere d3d11.dll + d3dcompiler_46e.dll din folderul „plugins” al FiveM (locul ales la Auto
// Install) — restul folderului „plugins” nu se atinge. NIMIC din folderul GTA V nu se mișcă vreodată prin acest
// comutator: enbseries, shaderinput, enblocal.ini, enbseries.ini și cele 2 dll-uri din GTA V rămân exact cum le-a
// pus Auto Install (ascunse + blocate), neatinse. „Dezinstalare” mută cele 2 fișiere într-un backup ASCUNS chiar
// în folderul „plugins” al FiveM (NU în datele aplicației) — ca mutarea să fie mereu pe ACELAȘI disc ca FiveM,
// fără eroarea „cross-device” (EXDEV) care apărea când backup-ul stătea pe alt disc. „Instalare” le pune înapoi
// din acel backup local, ascunse + blocate (ACL), la fel ca restul pachetului.
const ENB_FIVEM_PLUGIN_NAMES = ['d3d11.dll', 'd3dcompiler_46e.dll'];
const ENB_BACKUP_DIRNAME = '.rms-enb-backup';
function enbBackupDir(p) { return path.join(p.fivem, 'plugins', ENB_BACKUP_DIRNAME); }
function enbItems() {
  const p = currentPaths();
  if (!p.fivem) return null;
  const bk = enbBackupDir(p);
  return ENB_FIVEM_PLUGIN_NAMES.map(n => ({ key: 'plugins/' + n, live: path.join(p.fivem, 'plugins', n), backup: path.join(bk, n) }));
}
function pathKindExisting(p) { try { return fs.lstatSync(p).isDirectory() ? 'dir' : 'file'; } catch { return null; } }
function removeFromManifest(m, fullLow) {
  const keep = p => path.resolve(p).toLowerCase() !== fullLow;
  return { roots: m.roots, created: (m.created || []).filter(keep), touched: (m.touched || []).filter(keep), dirs: m.dirs || [], topDirs: m.topDirs || [], fivem: m.fivem };
}
// mută un singur fișier cu reîncercări: un fișier blocat temporar (antivirus, FiveM pornit etc.) nu mai oprește
// restul operației — se reîncearcă de câteva ori, apoi copiere + ștergere ca rezervă (disc/volum diferit)
async function enbMoveFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try { fs.rmSync(to, { force: true }); } catch {}
  for (let i = 0; i < 5; i++) {
    try { fs.renameSync(from, to); return true; } catch (e) { if (e && e.code === 'ENOENT') return false; await new Promise(r => setTimeout(r, 250)); }
  }
  try { fs.copyFileSync(from, to); fs.rmSync(from, { force: true }); return true; } catch { return false; }
}
function enbSend(phase, done, total) { try { if (win && !win.isDestroyed()) win.webContents.send('enb-progress', { phase, done, total }); } catch {} }
ipcMain.handle('enb-status', () => {
  try {
    if (!isRmsInstalled()) return { ok: true, state: 'none' };
    const items = enbItems();
    if (!items) return { ok: true, state: 'nopaths' };
    const live = items.filter(it => pathKindExisting(it.live)).length;
    const backed = items.filter(it => pathKindExisting(it.backup)).length;
    return { ok: true, state: live ? 'installed' : backed ? 'uninstalled' : 'none' };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
ipcMain.handle('enb-uninstall', async () => {
  if (downloadBusy) return { ok: false, error: 'busy' };
  const items = enbItems();
  if (!items) return { ok: false, error: 'nopaths' };
  setBusy(true);
  enbSend('start', 0, items.length);
  try {
    let m = readManifest();
    let moved = 0; const failed = [];
    let i = 0;
    for (const it of items) {
      i++;
      if (!pathKindExisting(it.live)) { enbSend('move', i, items.length); continue; }
      try {
        const low = path.resolve(it.live).toLowerCase();
        // deblocarea se face după registrul REAL de ACL-uri (lockedUnder), nu doar după ce „crede” manifestul — altfel
        // fișierul poate rămâne blocat (Access Denied) și mutarea eșuează
        try { await unlockPaths([...lockedUnder(it.live), it.live]); await attribMany('-h', [it.live]); } catch {}
        const ok = await enbMoveFile(it.live, it.backup);
        enbSend('move', i, items.length);
        if (!ok) { failed.push(it.key); continue; }   // fișierul ăsta a eșuat: trecem mai departe, NU oprim restul
        m = removeFromManifest(m, low);
        moved++;
      } catch (e) { failed.push(it.key); ilog('RMS ENB: eroare la ' + it.key + ': ' + ((e && e.message) || e)); }
    }
    writeManifest(m);
    // folderul de backup rămâne ascuns, ca să nu se vadă în folderul „plugins” al FiveM
    if (moved) { const p = currentPaths(); if (p.fivem) { try { await attribMany('+h', [enbBackupDir(p)]); } catch {} } }
    enbSend('done', items.length, items.length);
    ilog('RMS ENB: dezactivat (' + moved + '/' + items.length + ' fișiere mutate în backup' + (failed.length ? ', eșuate: ' + failed.join(', ') : '') + ')');
    return { ok: true, moved, failed };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  finally { setBusy(false); }
});
ipcMain.handle('enb-install', async () => {
  if (downloadBusy) return { ok: false, error: 'busy' };
  const items = enbItems();
  if (!items) return { ok: false, error: 'nopaths' };
  setBusy(true);
  enbSend('start', 0, items.length);
  try {
    const p = currentPaths();
    let m = readManifest();
    const restoredFiles = [];
    let moved = 0; const failed = [];
    let i = 0;
    for (const it of items) {
      i++;
      if (!pathKindExisting(it.backup)) { enbSend('move', i, items.length); continue; }   // nimic de restaurat pentru el
      try {
        // backup-ul poate fi rămas blocat ACL (dacă a fost mutat acolo înainte de a fi deblocat corect): se deblochează
        // și înainte de mutarea înapoi, ca „Access Denied” să nu mai apară nici în această direcție
        try { await unlockPaths(lockedUnder(it.backup)); } catch {}
        const ok = await enbMoveFile(it.backup, it.live);
        enbSend('move', i, items.length);
        if (!ok) { failed.push(it.key); continue; }
        moved++;
        restoredFiles.push(it.live);
      } catch (e) { failed.push(it.key); ilog('RMS ENB: eroare la ' + it.key + ': ' + ((e && e.message) || e)); }
    }
    if (restoredFiles.length) await hideManifest({ topDirs: [], touched: restoredFiles, dirs: [], fivem: p.fivem });
    m = {
      roots: [...new Set([...(m.roots || []), p.fivem, p.gta].filter(Boolean))],
      created: m.created || [],
      touched: [...new Set([...(m.touched || []), ...restoredFiles])],
      dirs: m.dirs || [],
      topDirs: m.topDirs || [],
      fivem: m.fivem || p.fivem
    };
    writeManifest(m);
    enbSend('done', items.length, items.length);
    ilog('RMS ENB: activat (' + moved + '/' + items.length + ' fișiere restaurate din backup' + (failed.length ? ', eșuate: ' + failed.join(', ') : '') + ')');
    return { ok: true, moved, failed };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  finally { setBusy(false); }
});

/* ---------------- Ștergerea arhivei după instalare (inclusiv din Coșul de reciclare) ---------------- */
// fs.unlinkSync șterge definitiv (nu trece prin Recycle Bin). Separat, curățăm și copiile mai vechi ale arhivei
// care au fost șterse manual și stau în Coșul de reciclare: citim fișierele $I (calea originală) și ștergem perechea $I + $R.
async function purgeFromRecycleBin(names) {
  if (process.platform !== 'win32') return 0;
  const fsp = fs.promises;
  const wanted = new Set(names.map(n => String(n).toLowerCase()));
  if (!wanted.size) return 0;
  let purged = 0;
  const pool = async (arr, limit, fn) => {   // rulează fn pe elemente cu maxim „limit” operații simultane
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(limit, arr.length) }, async () => { while (i < arr.length) { const x = arr[i++]; try { await fn(x); } catch {} } }));
  };
  const drives = [];
  for (let c = 67; c <= 90; c++) drives.push(String.fromCharCode(c) + ':\\$Recycle.Bin');
  await Promise.all(drives.map(async bin => {                // C: … Z: în paralel
    let sids; try { sids = await fsp.readdir(bin, { withFileTypes: true }); } catch { return; }
    for (const sid of sids) {
      if (!sid.isDirectory()) continue;
      const dir = path.join(bin, sid.name);
      let items; try { items = await fsp.readdir(dir); } catch { continue; }
      await pool(items.filter(it => /^\$I/i.test(it)), 24, async it => {
        const buf = await fsp.readFile(path.join(dir, it));
        let orig;
        if (buf.length >= 28 && buf.readBigInt64LE(0) === 2n) {
          const len = buf.readInt32LE(24);
          orig = buf.toString('utf16le', 28, 28 + len * 2);
        } else orig = buf.toString('utf16le', 24);
        orig = orig.replace(/\0.*$/s, '');
        if (!wanted.has(path.win32.basename(orig).toLowerCase())) return;
        const rName = '$R' + it.slice(2);
        for (const f of [path.join(dir, rName), path.join(dir, it)]) {
          try { await fsp.rm(f, { recursive: true, force: true }); } catch {}
        }
        purged++;
      });
    }
  }));
  return purged;
}

// După instalare: nu rămâne niciun folder în plus (.rms-off, .rms-stage-*, .rms-write-test-*) în FiveM Application Data / folderul GTA V.
// Se șterg definitiv, apoi se scot și copiile lor din Recycle Bin.
const LEFTOVER_RE = /^\.rms-(off|stage-.+|write-test-.+|probe-.+)$/i;
async function purgeLeftoverFolders(dirs) {
  try {
    const names = new Set(['.rms-off', '.rms-stage-fivem', '.rms-stage-gta', '.rms-stage-js']);
    let removed = 0;
    for (const d of dirs.filter(Boolean)) {
      let entries; try { entries = fs.readdirSync(d); } catch { continue; }
      for (const n of entries) {
        if (!LEFTOVER_RE.test(n)) continue;
        names.add(n);
        const full = path.join(d, n);
        let isD = false; try { isD = fs.statSync(full).isDirectory(); } catch {}
        rmRetry(full, isD);
        if (!fs.existsSync(full)) removed++;
      }
    }
    const bin = removed ? await purgeFromRecycleBin([...names]) : 0;
    ilog('Curățare foldere în plus: șterse ' + removed + ' | scoase din Recycle Bin: ' + bin);
  } catch (e) { ilog('Curățarea folderelor în plus a eșuat: ' + ((e && e.message) || e)); }
}

// Ștergere definitivă (fără Recycle Bin): scoate Hidden / Read-only, reîncearcă ~10 s (arhiva poate fi încă ținută
// deschisă câteva clipe după extragere) și merge și dacă „RMS_GRAPHICS.rar” e un folder.
async function wipeFile(f) {
  if (!f || !fs.existsSync(f)) return true;
  try { await attribMany('-h', [f]); await attribMany('-r', [f]); } catch {}
  for (let i = 0; i < 20 && fs.existsSync(f); i++) {
    try { await fs.promises.rm(f, { recursive: true, force: true }); } catch {}
    if (fs.existsSync(f)) await new Promise(r => setTimeout(r, 500));
  }
  return !fs.existsSync(f);
}
const pendingDelFile = () => path.join(app.getPath('userData'), 'pending-delete.json');
function queuePendingDelete(list) {
  let cur = []; try { cur = JSON.parse(fs.readFileSync(pendingDelFile(), 'utf8')) || []; } catch {}
  try { fs.writeFileSync(pendingDelFile(), JSON.stringify([...new Set([...cur, ...list])])); } catch {}
}
function unqueuePendingDelete(list) {
  let cur = []; try { cur = JSON.parse(fs.readFileSync(pendingDelFile(), 'utf8')) || []; } catch { return; }
  const rest = cur.filter(f => !list.includes(f));
  try { if (rest.length) fs.writeFileSync(pendingDelFile(), JSON.stringify(rest)); else fs.unlinkSync(pendingDelFile()); } catch {}
}
// arhivele mari pot fi ținute ocupate minute întregi de scanarea antivirus chiar după ce s-a terminat instalarea
// (Windows Defender etc.): în loc să renunțăm după prima încercare eșuată (10s) și să așteptăm un restart al
// launcherului, mai reîncercăm din fundal, din ce în ce mai rar, timp de ~9 minute, fără să blocăm nimic din UI.
function scheduleArchiveRetry(files, attempt) {
  attempt = attempt || 0;
  if (!files || !files.length || attempt >= 8) return;
  setTimeout(async () => {
    const left = [];
    for (const f of files) if (!(await wipeFile(f))) left.push(f);
    const done = files.filter(f => !left.includes(f));
    if (done.length) { unqueuePendingDelete(done); try { await purgeFromRecycleBin(done.map(f => path.basename(f))); } catch {} }
    if (left.length) { queuePendingDelete(left); scheduleArchiveRetry(left, attempt + 1); }
    else if (done.length) ilog('Arhivă ștearsă după reîncercări ulterioare instalării: ' + done.join(' ; '));
  }, 15000 * (attempt + 1));
}
async function processPendingDeletes() {
  let list = []; try { list = JSON.parse(fs.readFileSync(pendingDelFile(), 'utf8')) || []; } catch { return; }
  const left = [];
  for (const f of list) if (!(await wipeFile(f))) left.push(f);
  try { if (left.length) fs.writeFileSync(pendingDelFile(), JSON.stringify(left)); else fs.unlinkSync(pendingDelFile()); } catch {}
  const bin = await purgeFromRecycleBin([...new Set([...list.map(f => path.basename(f)), cfg.DOWNLOAD_FILENAME || 'RMS_GRAPHICS.rar'])]);
  ilog('Arhive rămase de la instalarea anterioară: șterse ' + (list.length - left.length) + '/' + list.length + ' | scoase din Recycle Bin: ' + bin);
}
// dacă pachetul e deja instalat pe disc dar arhiva aleasă manual la descărcare (din „Descărcări”) a mai rămas undeva
// (ex. Downloads), fiindcă era ocupată exact când s-a încercat ștergerea ei la finalul instalării, o ștergem acum
async function purgeStaleManualArchive() {
  try {
    if (!isRmsInstalled()) return;
    const m = manualPackPath();
    if (!m) return;
    if (fs.existsSync(m)) {
      const ok = await wipeFile(m);
      if (!ok) { queuePendingDelete([m]); return; }
      try { await purgeFromRecycleBin([path.basename(m)]); } catch {}
    }
    try { fs.unlinkSync(manualPackFile()); } catch {}
  } catch {}
}

// Folderul ascuns din datele aplicației în care Auto Install descarcă și din care dezarhivează (…\pack, …\pack-opt):
// se șterge complet, cu tot cu arhivă, resturi .part și folderul însuși, plus copiile din Recycle Bin.
async function purgeWorkDir(dir) {
  try {
    if (!fs.existsSync(dir)) return true;
    let names = []; try { names = fs.readdirSync(dir); } catch {}
    for (const n of names) await wipeFile(path.join(dir, n));
    const gone = await wipeFile(dir);
    if (!gone) queuePendingDelete([dir]);
    const bin = await purgeFromRecycleBin([...new Set([...names, path.basename(dir)])]);
    ilog('Folder de lucru șters: ' + dir + ' -> ' + (gone ? 'da' : 'NU (se reîncearcă la pornire)') + ' | fișiere: ' + names.length + ' | din Recycle Bin: ' + bin);
    return gone;
  } catch (e) { ilog('Ștergerea folderului de lucru a eșuat: ' + ((e && e.message) || e)); return false; }
}

// Tot ce a rămas dezarhivat în afara GTA V / FiveM: folderul „RMS_GRAPHICS” (ex. „Extract here” din WinRAR) lângă arhivă
// și în Descărcări / Desktop / Documente / Temp, plus fișierele temporare rms-* ale launcherului din %TEMP%.
async function purgeExtracted(extraDirs) {
  try {
    const base = path.basename(cfg.DOWNLOAD_FILENAME || 'RMS_GRAPHICS.rar').replace(/\.rar$/i, '');
    const nameRe = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '( \\(\\d+\\))?$', 'i');   // RMS_GRAPHICS, RMS_GRAPHICS (1)…
    const dirs = new Set((extraDirs || []).filter(Boolean).map(d => path.resolve(d)));
    for (const k of ['downloads', 'desktop', 'documents', 'temp']) { try { dirs.add(app.getPath(k)); } catch {} }
    const gone = [], names = new Set();
    for (const d of dirs) {
      let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        if (!e.isDirectory() || !nameRe.test(e.name)) continue;
        const f = path.join(d, e.name);
        if (await wipeFile(f)) gone.push(f); else queuePendingDelete([f]);
        names.add(e.name);
      }
    }
    const tmp = os.tmpdir();
    try {
      for (const n of fs.readdirSync(tmp)) {
        if (!/^rms-(?!launcher-cache$)/i.test(n)) continue;   // cache-ul browserului launcherului rămâne
        const f = path.join(tmp, n); if (await wipeFile(f)) gone.push(f);
      }
    } catch {}
    const bin = names.size ? await purgeFromRecycleBin([...names]) : 0;
    ilog('Resturi dezarhivate șterse: ' + gone.length + (gone.length ? ' (' + gone.join(' ; ') + ')' : '') + ' | din Recycle Bin: ' + bin);
  } catch (e) { ilog('Ștergerea resturilor dezarhivate a eșuat: ' + ((e && e.message) || e)); }
}

async function purgeArchive(file) {
  try {
    const names = [path.basename(file), cfg.DOWNLOAD_FILENAME || 'RMS_GRAPHICS.rar'];
    const gone = await wipeFile(file);
    if (!gone) { queuePendingDelete([file]); scheduleArchiveRetry([file]); }
    const bin = await purgeFromRecycleBin(names);
    try { if (manualPackPath() && !fs.existsSync(manualPackPath())) fs.unlinkSync(manualPackFile()); } catch {}
    ilog('Arhiva ștearsă după instalare: ' + (gone ? 'da' : 'NU (' + file + ')') + ' | copii scoase din Recycle Bin: ' + bin);
  } catch (e) { ilog('Ștergerea arhivei a eșuat: ' + ((e && e.message) || e)); }
}


// După Auto Install: se șterg AMBELE arhive ale pachetului principal (cea din datele aplicației și cea aleasă manual în tab-ul Descărcări,
// oriunde ar fi) și toate copiile lor din Coșul de reciclare. Arhivele opționale nu sunt atinse aici.
async function purgeMainArchives(used) {
  try {
    const names = new Set([cfg.DOWNLOAD_FILENAME || 'RMS_GRAPHICS.rar']);
    const files = new Map();
    const add = f => { if (f) { files.set(path.resolve(f).toLowerCase(), f); names.add(path.basename(f)); } };
    add(used);
    add(manualPackPath());
    try { for (const f of fs.readdirSync(packDir())) add(path.join(packDir(), f)); } catch {}
    // aceeași arhivă (și resturile .part) în folderul ales la descărcare și în locurile obișnuite: Descărcări, Desktop, Documente, Temp
    try {
      const nm = cfg.DOWNLOAD_FILENAME || 'RMS_GRAPHICS.rar';
      const dirs = new Set();
      for (const f of [...files.values(), lastDownloadPath]) if (f) dirs.add(path.dirname(path.resolve(f)));
      for (const k of ['downloads', 'desktop', 'documents', 'temp']) { try { dirs.add(app.getPath(k)); } catch {} }
      for (const d of dirs) for (const n of [nm, nm + '.part']) { const f = path.join(d, n); if (fs.existsSync(f)) add(f); }
    } catch {}
    for (const f of files.values()) await wipeFile(f);
    const left = [...files.values()].filter(f => fs.existsSync(f));
    if (left.length) { queuePendingDelete(left); scheduleArchiveRetry(left); }   // reîncercare din fundal + la următoarea pornire
    const bin = await purgeFromRecycleBin([...names]);
    try { if (!manualPackPath() || !fs.existsSync(manualPackPath())) fs.unlinkSync(manualPackFile()); } catch {}
    ilog('Arhive șterse după instalare: ' + (files.size - left.length) + '/' + files.size + (left.length ? ' | rămase: ' + left.join(' ; ') : '') + ' | copii scoase din Recycle Bin: ' + bin);
  } catch (e) { ilog('Ștergerea arhivelor a eșuat: ' + ((e && e.message) || e)); }
}

/* ---------------- RMS Optional: pachete separate (Mini Map 3440x1440 etc.) ---------------- */
// Același motor ca Auto Install (descărcare -> extragere în GTA V / FiveM -> ascundere -> ștergerea arhivei),
// dar cu arhivă, parolă și versiune proprii. Progresul se trimite pe canalul „opt-progress”.
const optStateFile = () => path.join(app.getPath('userData'), 'optional-state.json');
function readOptState() { try { const j = JSON.parse(fs.readFileSync(optStateFile(), 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; } }
function writeOptState(s) { try { fs.writeFileSync(optStateFile(), JSON.stringify(s)); } catch {} }
const optDir = () => path.join(app.getPath('userData'), 'pack-opt');
const optOf = id => (OPT_IDS.includes(id) ? cfg.OPTIONAL[id] : null);
const optConfigured = o => !!o && URL_RE.test(String(o.packUrl || ''));
// Dimensiunea reală a arhivei (octeți), citită automat de pe link (fără descărcare, doar un HEAD), ca Halloween și Christmas
// să nu mai arate aceeași mărime „aproximativă” din config, ci dimensiunea reală a fiecăreia. Rezultatul e păstrat în cache
// (24h) pe disc, ca să nu trimitem o cerere HEAD de fiecare dată când se deschide tab-ul Optional.
const optSizeCacheFile = () => path.join(app.getPath('userData'), 'optional-sizes.json');
function readOptSizeCache() { try { const j = JSON.parse(fs.readFileSync(optSizeCacheFile(), 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; } }
function writeOptSizeCache(c) { try { fs.writeFileSync(optSizeCacheFile(), JSON.stringify(c)); } catch {} }
let optRemoteSize = readOptSizeCache();   // { [id]: { bytes, ts, url } } — ținut și în memorie, ca opt-meta să răspundă instant
async function probeRemoteSizeOnce(url) {
  try {
    let r = await net.fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(12000) });
    if (!r.ok || !Number(r.headers.get('content-length') || 0)) {
      // unele linkuri Google Drive nu răspund la HEAD cu Content-Length: GET + oprire imediată a conexiunii
      r = await net.fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(12000) });
    }
    const ct = String(r.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('text/html')) { try { r.body && r.body.cancel && r.body.cancel(); } catch {} return 0; }   // pagină de avertisment Google Drive, nu arhiva
    const len = Number(r.headers.get('content-length') || 0);
    try { r.body && r.body.cancel && r.body.cancel(); } catch {}
    return len > 1048576 ? len : 0;   // ignorăm răspunsuri prea mici (probabil o pagină de eroare, nu arhiva)
  } catch { return 0; }
}
// gofile.io: pagina gofile.io/d/{id} e un SPA (JS), nu arhiva — nu are rost să dăm HEAD pe ea. Trebuie trecut prin
// API-ul lor (același flux ca la descărcarea efectivă, din download-worker.js) ca să aflăm mărimea reală a fișierului.
const GOFILE_RE = /^https:\/\/gofile\.io\/d\/([\w-]+)/i;
const GOFILE_WT = '4fd6sg89d7s6';   // vezi comentariul din download-worker.js despre „website token”-ul gofile
let gofileAccountToken = null;
async function gofileAccount() {
  if (gofileAccountToken) return gofileAccountToken;
  const r = await net.fetch('https://api.gofile.io/accounts', { method: 'POST', signal: AbortSignal.timeout(12000) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.status !== 'ok' || !j.data || !j.data.token) return '';
  gofileAccountToken = j.data.token;
  return gofileAccountToken;
}
async function probeGofileSize(url) {
  try {
    const id = (GOFILE_RE.exec(url) || [])[1];
    if (!id) return 0;
    const token = await gofileAccount();
    if (!token) return 0;
    const r = await net.fetch('https://api.gofile.io/contents/' + id + '?wt=' + GOFILE_WT + '&cache=true', {
      headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(12000)
    });
    const j = await r.json().catch(() => null);
    if (!j || j.status !== 'ok' || !j.data) return 0;
    const kids = j.data.children ? Object.values(j.data.children) : (j.data.type === 'file' ? [j.data] : []);
    const file = kids.find(c => c && c.type === 'file');
    return file ? Number(file.size || 0) : 0;
  } catch { return 0; }
}
// MEGA: la fel ca gofile, un HEAD/GET simplu nu merge — fișierul e criptat și trebuie citit prin librăria megajs
// (aceeași cu care se face și descărcarea efectivă, din download-worker.js).
const MEGA_RE = /^https:\/\/mega\.nz\//i;
async function probeMegaSize(url) {
  try {
    const { File } = require('megajs');
    const file = File.fromURL(url);
    await file.loadAttributes();
    return Number(file.size || 0);
  } catch { return 0; }
}
async function probeRemoteSize(url) {
  if (MEGA_RE.test(url)) return await probeMegaSize(url);
  if (GOFILE_RE.test(url)) return await probeGofileSize(url);
  let bytes = await probeRemoteSizeOnce(url);
  if (!bytes) {
    // fișierele mari de pe Google Drive arată o pagină „nu poate fi scanat pentru viruși” în loc de arhivă (fără Content-Length);
    // reîncercăm cu parametrul care ocolește acel avertisment, ca fiecare pachet să-și arate dimensiunea reală, nu una din config
    const sep = url.includes('?') ? '&' : '?';
    const u2 = url.includes('confirm=') ? url : url + sep + 'confirm=t';
    if (u2 !== url) bytes = await probeRemoteSizeOnce(u2);
  }
  return bytes;
}
async function ensureOptSizeProbed(id) {
  const o = optOf(id);
  if (!o || !optConfigured(o)) return;
  const cached = optRemoteSize[id];
  if (cached && cached.url === o.packUrl && cached.bytes > 0 && (Date.now() - (cached.ts || 0)) < 24 * 3600 * 1000) return;
  const bytes = await probeRemoteSize(o.packUrl);
  if (bytes > 0) {
    optRemoteSize[id] = { bytes, ts: Date.now(), url: o.packUrl };
    writeOptSizeCache(optRemoteSize);
  }
}
function optSizeGb(id, o) {
  const cached = optRemoteSize[id];
  if (cached && cached.url === o.packUrl && cached.bytes > 0) return cached.bytes / 1073741824;
  return Number(o.sizeGb) || 0;
}
// pachetele din aceeași listă nu pot fi instalate simultan (ex. decorațiuni de oraș incompatibile între ele)
const OPT_EXCLUSIVE_GROUPS = [];   // RMS Halloween a fost scos; Christmas a rămas fără partener de exclusivitate
const exclusivePartners = id => { const g = OPT_EXCLUSIVE_GROUPS.find(g => g.includes(id)); return g ? g.filter(x => x !== id) : []; };
// „instalat” pentru un pachet cu arhivă proprie = cel puțin un fișier din lista lui de instalare chiar există pe disc
// (altfel, dacă fișierele au fost șterse manual din „Dezinstalare Moduri”, starea rămâne corectă automat)
function optArchiveInstalled(id) {
  const m = readOptManifest(id);
  const files = [...new Set([...m.created, ...m.touched])];
  return files.some(f => { try { fs.lstatSync(f); return true; } catch { return false; } });
}
function isOptInstalled(id, st) {
  const s = (st || readOptState())[id];
  if (!s || !s.installed) return false;
  return OPT_ARCHIVE_IDS.includes(id) ? optArchiveInstalled(id) : true;
}

// --- RMS Milky Way (pachet opțional, de la RMS Optional) <-> RMS Clean Sky (mod RMS „default”, comutat individual
// din Dezinstalare Moduri): sunt exclusive — mereu doar unul dintre ele activ pe disc, niciodată amândouă deodată.
const CLEAN_SKY_FILE = 'RMS_Clean_Sky.rpf';
const MILKYWAY_OPT_ID = 'milkyway';
// instalezi Milky Way (de la Optional) -> Clean Sky se dezactivează automat (mutat în backup-ul local al
// modurilor RMS, exact ca un „Dezinstalare” individuală din Dezinstalare Moduri; dacă era deja dezactivat, nu
// face nimic — disableRmsModFile răspunde „missing” și ignorăm).
async function disableCleanSkyForMilkyWay() {
  try { const r = await disableRmsModFile(CLEAN_SKY_FILE); if (r.ok) ilog('RMS Clean Sky dezactivat automat (exclusivitate cu RMS Milky Way).'); }
  catch (e) { ilog('Dezactivare automată RMS Clean Sky eșuată: ' + ((e && e.message) || e)); }
}
// dezinstalezi Milky Way (de la Optional) -> Clean Sky se reactivează automat din backup-ul local, fără nicio redescărcare
async function restoreCleanSkyAfterMilkyWay() {
  try { const r = await restoreRmsModFile(CLEAN_SKY_FILE); if (r.ok) ilog('RMS Clean Sky reactivat automat (RMS Milky Way a fost dezinstalat).'); }
  catch (e) { ilog('Reactivare automată RMS Clean Sky eșuată: ' + ((e && e.message) || e)); }
}
// reactivezi (instalezi) Clean Sky din Dezinstalare Moduri -> Milky Way se dezinstalează automat, dacă era instalat
async function uninstallMilkyWayForCleanSky() {
  try {
    if (!isOptInstalled(MILKYWAY_OPT_ID)) return;
    const r = await uninstallOptArchive(MILKYWAY_OPT_ID);
    if (r.ok) { const st = readOptState(); delete st[MILKYWAY_OPT_ID]; writeOptState(st); ilog('RMS Milky Way dezinstalat automat (exclusivitate cu RMS Clean Sky).'); }
  } catch (e) { ilog('Dezinstalare automată RMS Milky Way eșuată: ' + ((e && e.message) || e)); }
}

ipcMain.handle('opt-meta', async () => {
  await cfgReady;
  // asigurăm o verificare Discord reală (din cache sau live) înainte de a calcula accesul Beta — fără asta,
  // la pornire currentHasBeta() putea citi o stare neinițializată și bloca din greșeală pachetele Beta
  try { await getStatus(); } catch {}
  const st = readOptState(), p = currentPaths(), packs = {};
  const installedMap = {};
  let dirty = false;
  for (const id of OPT_IDS) {
    const inst = isOptInstalled(id, st);
    if (!inst && st[id] && st[id].installed) { delete st[id]; try { fs.unlinkSync(optManifestFile(id)); } catch {} dirty = true; }   // ștears manual din afara aplicației: starea se autocorectează
    installedMap[id] = inst;
  }
  if (dirty) writeOptState(st);
  const hasBeta = currentHasBeta();
  for (const id of OPT_ARCHIVE_IDS) ensureOptSizeProbed(id).catch(() => {});   // nu blocăm răspunsul; la primul apel arată mărimea din config, apoi se corectează
  for (const id of OPT_IDS) {
    const o = cfg.OPTIONAL[id], s = st[id] || {}, ver = Number(o.version) || 0, installed = installedMap[id];
    const blockedBy = exclusivePartners(id).find(x => installedMap[x]) || '';
    const bg = installed ? { locked: false, phase: '', from: 0, until: 0 } : optBetaGateInfo(id);
    const gw = optGateWindow(id);   // fereastra brută (afișată mereu, indiferent de rol/instalare), pentru a arăta cui/cand se aplică regula
    packs[id] = {
      configured: optConfigured(o) || OPT_UI_IDS.includes(id), uiOnly: OPT_UI_IDS.includes(id) && !optConfigured(o), sizeGb: optSizeGb(id, o), version: ver, updated: String(o.updateDate || ''),
      installed, installedVersion: Number(s.version) || 0,
      updateAvailable: installed && ver > (Number(s.version) || 0),
      blockedBy,
      beta: !!OPT_BETA_GATE[id],
      betaLocked: bg.locked,
      betaPhase: bg.phase,
      betaFrom: bg.from ? new Date(bg.from).toISOString() : '',
      betaUntil: bg.until ? new Date(bg.until).toISOString() : '',
      gateFrom: gw.from ? new Date(gw.from).toISOString() : '',
      gateUntil: gw.until ? new Date(gw.until).toISOString() : '',
      color: id === GAS_STATION_ID && installed ? String(s.color || '') : '',
      colors: id === GAS_STATION_ID ? GAS_COLORS : undefined,
      changelog: Array.isArray(o.changelog) ? o.changelog : null   // istoric propriu de versiuni (ex. RMS Graphics BETA); null = fără changelog separat
    };
  }
  return { packs, hasPaths: !!(p.gta && p.fivem), hasBeta };
});

async function ensureOptional(o, send, id) {
  const dir = optDir();
  fs.mkdirSync(dir, { recursive: true });
  await hideOnWin(dir);
  if (installCancelled) throw new Error('cancelled');
  for (const f of fs.readdirSync(dir)) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }   // resturi de la o descărcare întreruptă
  const file = path.join(dir, o.filename);
  ilog('Descarc pachetul opțional în: ' + file);
  await downloadArchive(file, d => send({ phase: 'download', ...d }), { url: o.packUrl, estimated: Math.round((id ? optSizeGb(id, o) : (Number(o.sizeGb) || 0)) * 1073741824) });
  await hideOnWin(file);
  return file;
}

/* ---------------- Fișier UI FiveM (frontend.xml) instalat odată cu pachetul opțional ---------------- */
// Destinație: <FiveM>\FiveM.app\citizen\common\data\ui\frontend.xml. Folderul FiveM e cel ales în Auto Install
// („FiveM Application Data” e în același folder cu „FiveM.app”). Conținutul fișierului e încorporat în aplicație (ui-file.js).
// Originalul se salvează și se pune la loc la dezinstalare.
const UI_FILE = 'frontend.xml';
const uiStateFile = () => path.join(app.getPath('userData'), 'ui-file-state.json');
const uiBackupFile = () => path.join(app.getPath('userData'), 'ui-backup', UI_FILE);
const validUi = b => b && b.length > 1024 && b.length < 2 * 1024 * 1024 && /<frontend[\s>]/i.test(b.toString('utf8'));
function readUiState() { try { const j = JSON.parse(fs.readFileSync(uiStateFile(), 'utf8')); return j && typeof j.dest === 'string' ? j : {}; } catch { return {}; } }

function fiveMUiDir(p) {
  if (!p || !p.fivem) return null;
  const bases = [path.dirname(path.resolve(p.fivem)), path.resolve(p.fivem)];
  for (const b of bases) {
    const appDir = path.join(b, 'FiveM.app');
    if (isDir(appDir)) return path.join(appDir, 'citizen', 'common', 'data', 'ui');
  }
  return null;
}

function loadUiContent() {
  let buf;
  try { buf = Buffer.from(require('./ui-file.js'), 'base64'); } catch { throw new Error('ui_file_missing'); }
  if (!validUi(buf)) throw new Error('ui_file_bad');
  return buf;
}

function restoreUiFile() {
  const st = readUiState();
  if (!st.dest) return;
  try {
    if (st.hadOriginal && fs.existsSync(uiBackupFile())) fs.copyFileSync(uiBackupFile(), st.dest);
    else fs.unlinkSync(st.dest);
  } catch (e) { if (!e || e.code !== 'ENOENT') { ilog('frontend.xml: nu am putut restaura (' + ((e && e.message) || e) + ')'); return; } }
  try { fs.unlinkSync(uiStateFile()); } catch {}
  try { fs.rmSync(path.dirname(uiBackupFile()), { recursive: true, force: true }); } catch {}
  ilog('frontend.xml: restaurat / șters din ' + st.dest);
}

async function installUiFile(p, o) {
  const dir = fiveMUiDir(p);
  if (!dir) throw new Error('no_fivemapp');
  const content = loadUiContent();
  const dest = path.join(dir, UI_FILE);
  let st = readUiState();
  if (st.dest && st.dest.toLowerCase() !== dest.toLowerCase()) { restoreUiFile(); st = {}; }   // locația FiveM s-a schimbat
  if (!st.dest) {                                                  // originalul se salvează o singură dată
    let had = false;
    try { if (fs.existsSync(dest)) { fs.mkdirSync(path.dirname(uiBackupFile()), { recursive: true }); fs.copyFileSync(dest, uiBackupFile()); had = true; } } catch {}
    st = { dest, hadOriginal: had };
  }
  fs.mkdirSync(dir, { recursive: true });
  try { fs.writeFileSync(dest, content); }
  catch (e) {
    if (e && (e.code === 'EPERM' || e.code === 'EACCES')) { await attribMany('-r', [dest]); fs.writeFileSync(dest, content); }
    else throw e;
  }
  try { fs.writeFileSync(uiStateFile(), JSON.stringify(st)); } catch {}
  ilog('frontend.xml instalat în ' + dest);
}

/* ---------------- Curățare Night Bright (pachet scos din launcher) ---------------- */
// Dacă Night Bright / Night Bright Normal a fost instalat cu o versiune veche a launcherului, se pun la loc fișierele ENB originale
// (sau se șterg cele puse de launcher), ca să nu rămână ascunse în folderul GTA V.
const nbStateFile = () => path.join(app.getPath('userData'), 'nightbright-state.json');
const nbBackupDir = () => path.join(app.getPath('userData'), 'nb-backup');
function readNbState() {
  try { const j = JSON.parse(fs.readFileSync(nbStateFile(), 'utf8')); return j && typeof j.gta === 'string' && Array.isArray(j.files) ? j : {}; } catch { return {}; }
}
async function restoreNightBright() {
  const st = readNbState();
  if (!st.gta) return;
  let failed = false;
  for (const f of st.files) {
    const dest = path.join(st.gta, f.name), bak = path.join(nbBackupDir(), f.name);
    try {
      if (fs.existsSync(dest)) { await attribMany('-h', [dest]); await attribMany('-r', [dest]); }
      if (f.had && fs.existsSync(bak)) {
        fs.copyFileSync(bak, dest);
        if (f.hidden) await attribMany('+h', [dest]);
      } else { try { fs.unlinkSync(dest); } catch (e) { if (!e || e.code !== 'ENOENT') throw e; } }
    } catch (e) { failed = true; ilog('Night Bright: nu am putut restaura ' + f.name + ' (' + ((e && e.message) || e) + ')'); }
  }
  if (failed) return;
  try { fs.unlinkSync(nbStateFile()); } catch {}
  try { fs.rmSync(nbBackupDir(), { recursive: true, force: true }); } catch {}
  try { const o = readOptState(); delete o.nightbright; delete o.normalbright; writeOptState(o); } catch {}
  ilog('Night Bright: curățat din ' + st.gta);
}

// dezinstalează un pachet opțional CU arhivă proprie (ex. RMS Christmas): șterge DOAR fișierele din lista
// lui (optional-manifest-<id>.json), scoate „Hidden” + blocarea ACL de pe ele, apoi curăță folderele rămase goale.
async function uninstallOptArchive(id) {
  const m = readOptManifest(id);
  const files = [...new Set([...m.created, ...m.touched])];
  if (!files.length) return { ok: true, removed: 0 };
  const roots = m.roots || [];
  await showManifest(m);   // scoate „Hidden” de pe tot ce a pus acest pachet
  let removed = 0; const retry = [];
  for (const f of files) {
    try { fs.unlinkSync(f); removed++; }
    catch (e) { if (!e || e.code !== 'ENOENT') retry.push(f); else removed++; }
  }
  const failed = [];
  if (retry.length) {
    await attribMany('-r', existing(retry));
    for (const f of retry) { rmRetry(f, false); if (fs.existsSync(f)) failed.push(f); else removed++; }
  }
  // foldere rămase goale (nu se șterg rădăcinile alese, ex. folderul FiveM însuși)
  const rs = roots.map(r => path.resolve(r).toLowerCase());
  const cand = new Set();
  for (const f of files) {
    let d = path.dirname(f);
    while (true) {
      const low = path.resolve(d).toLowerCase();
      if (rs.includes(low) || !rs.some(r => low.startsWith(r + path.sep))) break;
      cand.add(d); d = path.dirname(d);
    }
  }
  for (const d of [...cand].sort((a, b) => b.length - a.length)) { try { fs.rmdirSync(d); } catch {} }
  if (failed.length) {
    writeOptManifest(id, { roots: m.roots, created: failed, touched: failed, dirs: [], topDirs: [], fivem: m.fivem || '' });
    ilog('Dezinstalare opțională (' + id + ') incompletă, rămase: ' + failed.length + ' | șterse: ' + removed);
    return { ok: false, error: 'partial', left: failed.length, removed };
  }
  try { await unlockPaths(files); } catch {}
  try { fs.unlinkSync(optManifestFile(id)); } catch {}
  ilog('Dezinstalare opțională (' + id + '): șterse ' + removed + ' fișiere');
  return { ok: true, removed };
}

ipcMain.handle('opt-uninstall', async (_e, id) => {
  if (!optOf(id)) return { ok: false, error: 'unknown' };
  if (downloadBusy) return { ok: false, error: 'busy' };
  setBusy(true);
  try {
    let removed = 0;
    if (OPT_UI_IDS.includes(id)) {
      const had = !!readUiState().dest;
      restoreUiFile();                                   // pune la loc frontend.xml original sau îl șterge
      if (readUiState().dest) return { ok: false, error: 'restore_failed' };
      if (had) removed++;
    }
    if (OPT_ARCHIVE_IDS.includes(id)) {
      const r = await uninstallOptArchive(id);
      if (!r.ok) return r;
      removed += r.removed;
    }
    const st = readOptState(); delete st[id]; writeOptState(st);
    ilog('Dezinstalare opțională (' + id + '): ' + (removed ? removed + ' elemente scoase' : 'nu era instalat nimic'));
    if (id === MILKYWAY_OPT_ID) { try { await restoreCleanSkyAfterMilkyWay(); } catch {} }
    return { ok: true, removed };
  } finally { setBusy(false); }
});

ipcMain.handle('opt-install', async (_e, id, opts) => {
  await cfgReady;
  const o = optOf(id);
  if (!o) return { ok: false, error: 'unknown' };
  let gasColor = '';
  if (id === GAS_STATION_ID) {
    gasColor = GAS_COLORS.find(c => c.toLowerCase() === String((opts && opts.color) || '').toLowerCase()) || '';
    if (!gasColor) return { ok: false, error: 'no_color' };
  }
  if (downloadBusy) return { ok: false, error: 'busy' };
  const partner = exclusivePartners(id).find(x => isOptInstalled(x));
  if (partner) return { ok: false, error: 'exclusive', other: partner };
  const bgChk = optBetaGateInfo(id);
  if (bgChk.locked) return { ok: false, error: 'beta_locked', phase: bgChk.phase, from: bgChk.from ? new Date(bgChk.from).toISOString() : '', until: bgChk.until ? new Date(bgChk.until).toISOString() : '' };
  const hasArchive = optConfigured(o);   // fără link configurat se instalează doar fișierul UI (frontend.xml)
  const needsUi = OPT_UI_IDS.includes(id);
  // pachet arhivă-only fără link încă pus în manifest (ex. RMS Graphics BETA, înainte să existe link-ul real):
  // eroare clară în loc de un „succes” gol care n-ar instala nimic
  if (!hasArchive && !needsUi) return { ok: false, error: 'not_configured' };
  // RMS Graphics BETA scrie în EXACT aceleași foldere/fișiere ca pachetul principal (ENB, d3d11.dll etc.) — ca
  // să nu se amestece cele două, dacă pachetul principal e instalat, îl dezinstalăm complet ÎNAINTE de a pune Beta
  if (id === BETA_PACK_OPT_ID && isRmsInstalled()) {
    ilog('RMS Graphics BETA: se dezinstalează pachetul principal înainte de instalarea Beta...');
    const un = await runUninstall();
    if (!un.ok) return { ok: false, error: 'uninstall_failed', detail: un.error };
  }
  const fivemOnly = OPT_FIVEM_ONLY.has(id);   // arhiva se instalează DOAR în FiveM (ex. folderul „mods”), niciodată în GTA V
  const p = currentPaths();
  if (!p.gta || !p.fivem) return { ok: false, error: 'no_paths' };
  if (needsUi && !fiveMUiDir(p)) return { ok: false, error: 'no_fivemapp' };
  const px = fivemOnly ? { ...p, gta: p.fivem } : p;   // „gta” devine folderul FiveM, ca totul (inclusiv „mods”) să ajungă acolo

  finalizing = false;
  setBusy(true);
  installCancelled = false;
  journal.finals = []; journal.all = []; journal.newDirs = []; journal.topDirs = []; journal.tmp = null; journal.roots = [px.fivem, px.gta];
  const usesOwnManifest = hasArchive && !needsUi;   // pachete arhivă-only (ex. Halloween): listă proprie, separată de pachetul principal
  const prevManifest = usesOwnManifest ? readOptManifest(id) : readManifest();
  journal.stages = [path.join(px.fivem, '.rms-stage-fivem'), path.join(px.gta, '.rms-stage-gta'), path.join(px.gta, '.rms-stage-js')];
  packPassOverride = String(o.password || '');
  let lastSend = 0;
  const send = d => {
    if (!win || win.isDestroyed()) return;
    const now = Date.now();
    if (d && (d.phase === 'download' || d.phase === 'extract') && now - lastSend < 250) return;
    lastSend = now;
    win.webContents.send('opt-progress', { id, ...d });
    presenceFromPhase('opt_install', d);
  };
  let archive = null;
  optPick = gasColor ? { folder: gasColor, file: GAS_FILE } : null;
  optInstalling = true;
  try {
    ilog('=== Instalare opțională (' + id + ') pornită === GTA: ' + p.gta + ' | FiveM: ' + p.fivem + (fivemOnly ? ' (doar FiveM)' : ''));
    // FIX: pentru pachetele „doar FiveM" (ex. Christmas, Milky Way) se verifică scrierea DOAR în folderul unde chiar
    // se instalează (px.gta/px.fivem, ambele = folderul FiveM aici) — înainte se testa și p.gta (GTA V) degeaba,
    // ceea ce putea bloca instalarea cu „Nu pot scrie în folderul ales” chiar dacă FiveM era perfect scriibil.
    for (const d of [...new Set([px.gta, px.fivem])]) {
      const w = canWrite(d);
      if (!w.ok) { ilog('Scriere refuzată în ' + d + ' [' + w.code + ']'); return { ok: false, error: 'write_denied', detail: d, code: w.code }; }
    }
    await showManifest(prevManifest);
    if (gasColor) {
      // RMS_GasStation.rpf există deja în pachetul principal (ascuns + blocat prin ACL): îl deblocăm ca să poată fi înlocuit automat,
      // fără întrebări; la final protecțiile (ascundere + blocare) se pun din nou pe fișierul nou.
      const modsDir = path.join(px.fivem, 'mods'), target = path.join(modsDir, GAS_FILE);
      if (fs.existsSync(target) || fs.existsSync(modsDir)) {
        try { await unlockPaths([target, modsDir]); } catch (e) { ilog('Deblocare ' + GAS_FILE + ' eșuată: ' + ((e && e.message) || e)); }
        try { await attribMany('-h', existing([target, modsDir])); } catch {}
        try { fs.chmodSync(target, 0o666); } catch {}
        ilog('Înlocuire automată: ' + target + (fs.existsSync(target) ? ' (există deja, se suprascrie)' : ' (fișier nou)'));
      }
    }
    if (installCancelled) throw new Error('cancelled');
    if (hasArchive) {
      archive = await ensureOptional(o, send, id);   // descărcat în folderul de lucru al pachetelor opționale, ales automat
      if (installCancelled) throw new Error('cancelled');
      send({ phase: 'extract', done: 0, total: 0, name: '' });
      await extractPack(archive, px, send);
      if (installCancelled) throw new Error('cancelled');
    } else ilog('Pachet opțional fără arhivă configurată: se instalează doar frontend.xml');
    finalizing = true;
    send({ phase: 'finalize' });
    if (needsUi) await installUiFile(p, o);   // FiveM\FiveM.app\citizen\common\data\ui\frontend.xml
    if (hasArchive) {
      const mf = {
        roots: [...new Set([...prevManifest.roots, px.fivem, px.gta])],
        created: [...new Set([...prevManifest.created, ...journal.finals])],
        touched: [...new Set([...prevManifest.touched, ...journal.all])],
        dirs: [...new Set([...prevManifest.dirs, ...journal.newDirs])],
        topDirs: [...new Set([...prevManifest.topDirs, ...journal.topDirs])],
        fivem: px.fivem
      };
      if (usesOwnManifest) writeOptManifest(id, mf); else writeManifest(mf);
      await hideManifest(mf);   // ascunde + blochează (ACL) exact ce a instalat acest pachet
      await purgeLeftoverFolders([px.fivem, px.gta]);
      await purgeArchive(archive);   // arhiva opțională (și copiile din Recycle Bin) se șterg de peste tot după instalare
      await purgeWorkDir(optDir());
    }
    journal.finals = []; journal.all = []; journal.newDirs = []; journal.topDirs = []; journal.tmp = null;
    const st = readOptState();
    st[id] = { installed: true, version: Number(o.version) || 0, date: Date.now(), ...(gasColor ? { color: gasColor } : {}) }; writeOptState(st);
    ilog('=== Instalare opțională (' + id + ') reușită ===');
    if (id === MILKYWAY_OPT_ID) { try { await disableCleanSkyForMilkyWay(); } catch {} }
    return { ok: true };
  } catch (e) {
    cleanupInstall();
    try { await purgeLeftoverFolders([px.fivem, px.gta]); } catch {}
    try { await hideManifest(prevManifest); } catch {}
    if (gasColor || hasArchive) { try { await lockManifest(readManifest()); } catch {} }   // refacem protecțiile pachetului principal, deblocate mai sus (fișiere existente înlocuite)
    ilog('=== Instalare opțională (' + id + ') eșuată: ' + ((e && e.message) || e) + (e && e.detail ? ' [' + e.detail + ']' : ''));
    await purgeWorkDir(optDir());   // arhiva opțională și resturile .part nu rămân în folderul de lucru
    if (installCancelled || (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR'))) return { ok: false, canceled: true };
    return { ok: false, error: String((e && e.message) || e), detail: e && e.detail };
  } finally {
    setBusy(false);
    optPick = null;
    optInstalling = false;
    installWorker = null;
    packPassOverride = null;
    try { presence.clearProgress(); } catch {}
  }
});

ipcMain.on('install-cancel', () => {
  if (finalizing) return;
  installCancelled = true;
  if (activeDownload) activeDownload.abort();
  if (installWorker) installWorker.terminate();
});