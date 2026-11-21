// Extragere cu node-unrar-js (varianta de rezervă, dacă UnRAR.exe lipsește sau nu merge).
// Rulează într-un worker thread și trimite către main.js mesaje: progress / done / error.
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Part 1 -> doar mods + plugins -> "FiveM Application Data"; Part 2 -> tot conținutul -> folderul GTA V
const PART_RE = /^part(?:ea)?[\s._-]*([12])$/i;
const PART1_KEEP = new Set(['mods', 'plugins']);
// foldere "ambalaj" din arhivă, care se sar: Part 1 > FiveM_App_data, Part 2 > GTA 5 Folder
const WRAP1_RE = /^fivem.*data$/i;
const WRAP2_RE = /^gta.*folder$/i;

// Aflăm structura arhivei: cu foldere „Part 1 / Part 2” (varianta veche) sau „plată”: mods + plugins -> FiveM, restul -> GTA V
// (opțional într-un singur folder-ambalaj care se sare).
const FLAT_SKIP = new Set(['desktop.ini', 'thumbs.db']);
const splitName = n => String(n).replace(/\\/g, '/').split('/').filter(Boolean);
function layoutOf(names) {
  let hasPart = false;
  const paths = names.map(splitName);
  for (const p of paths) { if (p.some(x => PART_RE.test(x))) hasPart = true; }
  if (hasPart) return { flat: false, wrap: 0 };
  // câte niveluri de folder „ambalaj” de la început sunt IDENTICE la TOATE intrările — unele arhive au un
  // singur nivel („RMS_GRAPHICS/…”), altele au folderul dublat din greșeală la arhivare („RMS_GRAPHICS/RMS_GRAPHICS/…”),
  // deci nu ne oprim neapărat după un singur nivel: continuăm cât timp toate intrările sunt încă de acord pe
  // segmentul curent, și ne oprim exact înainte de „mods”/„plugins” (acolo începe conținutul real de copiat) —
  // altfel conținutul ajunge într-un subfolder în plus (ex. ENB nu mai e găsit de joc, modurile nu mai ajung în
  // folderul „mods” al FiveM, ci rătăcite în GTA V, exact bug-ul raportat).
  let wrap = 0;
  while (paths.every(p => p.length > wrap + 1)) {
    const seg = paths[0][wrap].toLowerCase();
    if (seg === 'mods' || seg === 'plugins') break;
    if (!paths.every(p => p[wrap].toLowerCase() === seg)) break;
    wrap++;
  }
  return { flat: true, wrap };
}
function classifyFlat(name, wrap) {
  const parts = splitName(name);
  let rel = parts.slice(wrap);
  if (!rel.length || FLAT_SKIP.has(rel[rel.length - 1].toLowerCase())) return null;
  // folder-ambalaj recognoscibil (ex. „GTA 5 Folder”, „FiveM_App_data”) chiar dacă arhiva nu mai are „Part 1/Part 2”
  // ca nume literal: se sare, altfel conținutul ajunge într-un subfolder în plus în loc de direct în FiveM / GTA V
  // (ex. ENB-ul nu mai e găsit de joc dacă stă în „<GTA V>\GTA 5 Folder\enbseries” în loc de „<GTA V>\enbseries”)
  if (rel.length > 1 && WRAP2_RE.test(rel[0])) {
    const rel2 = rel.slice(1);
    return { dest: 'gta', rel: rel2.join('/'), prefix: [...parts.slice(0, wrap), rel[0]].join('/') };
  }
  if (rel.length > 1 && WRAP1_RE.test(rel[0])) {
    const rel2 = rel.slice(1);
    const top2 = (rel2[0] || '').toLowerCase();
    if (rel2.length > 1 && (top2 === 'mods' || top2 === 'plugins')) {
      return { dest: 'fivem', rel: rel2.join('/'), prefix: [...parts.slice(0, wrap), rel[0]].join('/') };
    }
    return null;   // altceva sub ambalajul FiveM, neprevăzut: se ignoră, ca înainte
  }
  const top = rel[0].toLowerCase();
  const dest = rel.length > 1 && (top === 'mods' || top === 'plugins') ? 'fivem' : 'gta';
  return { dest, rel: rel.join('/'), prefix: parts.slice(0, wrap).join('/') };
}


// Pachete cu „alegere” (ex. Gas Station LED): din arhivă se scoate DOAR <folderCuloare>/<fișier> și ajunge direct în <FiveM>\mods
let PICK = null;
function classifyPick(name) {
  const parts = splitName(name);
  const n = parts.length;
  if (n < 2) return null;
  const nz = x => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (nz(parts[n - 1]) !== nz(PICK.file)) return null;
  // folderul culorii poate fi oriunde deasupra fișierului (arhiva poate avea foldere-ambalaj); ignorăm majuscule, spații, „_” și „-”
  const want = nz(PICK.folder);
  let hit = -1;
  for (let i = n - 2; i >= 0; i--) { if (nz(parts[i]) === want) { hit = i; break; } }
  if (hit < 0) return null;
  return { dest: 'fivem', rel: parts[n - 1], prefix: parts.slice(0, n - 1).join('/') };
}
function classify(name, lay) {
  if (PICK) return classifyPick(name);
  if (lay && lay.flat) return classifyFlat(name, lay.wrap);
  const parts = String(name).replace(/\\/g, '/').split('/').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const m = PART_RE.exec(parts[i]);
    if (!m) continue;
    let rel = parts.slice(i + 1);
    if (rel.length && (m[1] === '1' ? WRAP1_RE : WRAP2_RE).test(rel[0])) rel = rel.slice(1);
    if (!rel.length) return null;
    const prefix = parts.slice(0, parts.length - rel.length).join('/');
    if (m[1] === '1') return PART1_KEEP.has(rel[0].toLowerCase()) ? { dest: 'fivem', rel: rel.join('/'), prefix } : null;
    return { dest: 'gta', rel: rel.join('/'), prefix };
  }
  return null;
}

// mută un fișier; dacă destinația e pe alt disc (rename eșuează), îl copiază și șterge originalul
function moveFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try { fs.renameSync(src, dst); return; } catch {}
  try { fs.unlinkSync(dst); } catch {}
  try { fs.renameSync(src, dst); return; } catch {}
  fs.copyFileSync(src, dst);
  fs.unlinkSync(src);
}


// Extragere DIRECTĂ: un mic folder în %TEMP% în care „Part 1/FiveM_App_data” și „Part 2/GTA 5 Folder”
// sunt legături (junction) către folderele alese, deci fișierele ajung direct la locul lor, fără folder temporar în FiveM/GTA.
function buildJunctionRoot(jobs, dirs) {
  const prefixes = new Map();
  for (const j of jobs) {
    const prev = prefixes.get(j.prefix);
    if (prev && prev !== j.dest) throw new Error('layout_conflict');
    prefixes.set(j.prefix, j.dest);
  }
  const low = [...prefixes.keys()].map(p => p.toLowerCase());
  if (low.some(a => low.some(b => a !== b && b.startsWith(a + '/')))) throw new Error('layout_conflict');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rms-x-'));
  const links = [];
  try {
    for (const [prefix, dest] of prefixes) {
      const link = path.join(root, ...prefix.split('/'));
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.mkdirSync(dirs[dest], { recursive: true });
      fs.symlinkSync(dirs[dest], link, 'junction');
      links.push(link);
      const probe = '.rms-probe-' + process.pid;
      fs.writeFileSync(path.join(link, probe), '');
      const ok = fs.existsSync(path.join(dirs[dest], probe));
      try { fs.unlinkSync(path.join(link, probe)); } catch {}
      if (!ok) throw new Error('junction_failed');
    }
  } catch (e) { dropJunctionRoot(root, links); throw e; }
  return { root, links };
}
function dropJunctionRoot(root, links) {
  let safe = true;
  for (const l of links) {
    try { fs.rmdirSync(l); } catch { try { fs.unlinkSync(l); } catch {} }
    if (fs.existsSync(l)) safe = false;
  }
  if (safe) { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} }
}

// foldere temporare de lucru (.rms-stage-*): se ascund imediat ce sunt create, ca să nu se vadă în FiveM / GTA V cât durează copierea
function hideDirSync(p) {
  if (process.platform !== 'win32') return;
  try { require('child_process').execFileSync('attrib', ['+h', p], { windowsHide: true }); } catch {}
}

const post = m => parentPort.postMessage(m);

async function loadLib() {
  try { return require('node-unrar-js'); } catch (e1) {
    try { return await import('node-unrar-js'); } catch (e2) { throw Object.assign(new Error('lib_missing'), { detail: String((e2 && e2.message) || e2) }); }
  }
}

async function main() {
  const { archive, password, gtaDir } = workerData;
  let fivemDir = workerData.fivemDir;
  PICK = workerData.pick || null;
  if (PICK) { fivemDir = path.join(fivemDir, 'mods'); fs.mkdirSync(fivemDir, { recursive: true }); }
  const lib = await loadLib();
  const createExtractorFromFile = lib.createExtractorFromFile || (lib.default && lib.default.createExtractorFromFile);
  if (!createExtractorFromFile) throw Object.assign(new Error('lib_missing'), { detail: 'createExtractorFromFile lipsește' });

  // 1) listăm conținutul (fără să scriem nimic pe disc)
  const lister = await createExtractorFromFile({ filepath: archive, password: password || undefined });
  const headers = [...lister.getFileList().fileHeaders].filter(h => !(h.flags && h.flags.directory));
  const jobs = [];
  let total = 0;
  const lay = layoutOf(headers.map(h => h.name));
  const skipped = [];
  for (const h of headers) {
    const c = classify(h.name, lay);
    if (!c) { skipped.push(h.name); continue; }
    jobs.push({ name: h.name, dest: c.dest, rel: c.rel, prefix: c.prefix, size: h.unpSize || 0 });
    total += h.unpSize || 0;
  }
  if (!jobs.length) { const e = new Error('native_nofiles'); e.detail = 'fișiere: ' + headers.length + ' | ex.: ' + headers.slice(0, 4).map(x => x.name).join(' ; '); throw e; }
  const dirs = { fivem: fivemDir, gta: gtaDir };
  const allPaths = jobs.map(j => path.join(dirs[j.dest], ...j.rel.split('/')));
  post({ type: 'plan', finals: allPaths.filter(p => !fs.existsSync(p)), all: allPaths, info: 'Structură: ' + (lay.flat ? 'plată' : 'Part 1/2') + ' wrap=' + lay.wrap + ' | intrări: ' + headers.length + ' | de copiat: ' + allPaths.length + ' | omise: ' + skipped.length + (skipped.length ? ' [' + skipped.slice(0, 15).join(' ; ') + ']' : '') + ' | enb*: ' + (allPaths.filter(x => /enb/i.test(path.basename(x))).slice(0, 12).join(' ; ') || 'niciunul') });

  // 2) țintă: metoda directă (junction) sau, dacă nu merge, folder temporar în folderul GTA
  let layout = null;
  try { layout = buildJunctionRoot(jobs, dirs); } catch { layout = null; }
  const stage = layout ? null : path.join(gtaDir, '.rms-stage-js');
  if (stage) { fs.rmSync(stage, { recursive: true, force: true }); fs.mkdirSync(stage, { recursive: true }); hideDirSync(stage); }

  try {
    const extractor = await createExtractorFromFile({ filepath: archive, targetPath: layout ? layout.root : stage, password: password || undefined });

    let done = 0, last = 0;
    const tick = (force, name) => {
      const now = Date.now();
      if (force || now - last > 300) { last = now; post({ type: 'progress', done, total, name: name || '' }); }
    };
    tick(true, '');

    post({ type: 'items', items: jobs.map(j => ({ path: path.join(layout ? layout.root : stage, ...j.name.split(/[\\/]/)), size: j.size })) });
    const extracted = extractor.extract({ files: jobs.map(j => j.name) });
    const sizeByName = new Map(jobs.map(j => [j.name, j.size]));
    // scrierea pe disc are loc pe parcursul iterării; anunțăm fișierul curent ca main.js să-i urmărească dimensiunea
    const it = extracted.files[Symbol.iterator]();
    const outRoot = layout ? layout.root : stage;
    for (let idx = 0; ; idx++) {
      const j = jobs[idx];
      post({ type: 'current', path: j ? path.join(outRoot, ...j.name.split(/[\\/]/)) : null });
      const r = it.next();
      if (r.done) break;
      const n = r.value.fileHeader.name;
      done += sizeByName.get(n) || 0;
      tick(true, '');
    }
    post({ type: 'current', path: null });

    for (const j of jobs) {
      const finalPath = path.join(dirs[j.dest], ...j.rel.split('/'));
      if (layout) {
        if (!fs.existsSync(finalPath)) throw new Error('native_missing');
      } else {
        const src = path.join(stage, ...j.name.split(/[\\/]/));
        if (!fs.existsSync(src)) throw new Error('native_missing');
        moveFile(src, finalPath);
      }
    }
    done = total; tick(true, '');
    post({ type: 'done', files: jobs.length, mode: layout ? 'direct' : 'staged' });
  } finally {
    if (layout) dropJunctionRoot(layout.root, layout.links);
    if (stage) { try { fs.rmSync(stage, { recursive: true, force: true }); } catch {} }
  }
}

main().catch(e => {
  const reason = String((e && e.reason) || '');
  const code = /PASSWORD/i.test(reason) ? 'bad_password' : reason ? 'rar_error' : String((e && e.message) || e);
  post({ type: 'error', code, detail: String((e && (e.detail || e.reason || e.stack)) || e).slice(0, 300) });
});