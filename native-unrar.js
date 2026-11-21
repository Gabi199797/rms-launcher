// Extragere rapidă cu UnRAR.exe (program nativ Windows). Dacă UnRAR.exe lipsește sau ceva nu merge,
// main.js revine automat la extragerea cu node-unrar-js (unrar-worker.js).
//
// Structura arhivei:  <ceva> / Part 1 / FiveM_App_data / mods, plugins  -> direct în folderul FiveM (mods, plugins)
//                     <ceva> / Part 2 / GTA 5 Folder / (tot)            -> direct în folderul GTA V
//
// Extragere DIRECTĂ, fără folder temporar în FiveM/GTA: se creează un mic folder în %TEMP% în care
// „Part 1/FiveM_App_data” și „Part 2/GTA 5 Folder” sunt legături (junction) către folderele alese,
// așa că UnRAR scrie fișierele exact la locul lor. Dacă legăturile nu pot fi create, se folosește
// vechea metodă cu folder temporar.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PART_RE = /^part(?:ea)?[\s._-]*([12])$/i;
const PART1_KEEP = new Set(['mods', 'plugins']);
const WRAP1_RE = /^fivem.*data$/i;
const WRAP2_RE = /^gta.*folder$/i;
const MT = '-mt' + Math.max(2, Math.min(8, os.cpus().length));   // mai multe fire pentru extragere / verificare CRC

// întoarce { dest, rel, prefix }: prefix = partea din cale care se „sare” (ex.: „RMS.../Part 1/FiveM_App_data”)
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

// foldere temporare de lucru (.rms-stage-*): se ascund imediat ce sunt create, ca să nu se vadă în FiveM / GTA V cât durează copierea
function hideDirSync(p) {
  if (process.platform !== 'win32') return;
  try { require('child_process').execFileSync('attrib', ['+h', p], { windowsHide: true }); } catch {}
}

function findUnrarExe() {
  if (process.platform !== 'win32') return null;
  const cands = [];
  if (process.resourcesPath) cands.push(path.join(process.resourcesPath, 'bin', 'UnRAR.exe'));
  cands.push(path.join(__dirname, 'bin', 'UnRAR.exe'));
  for (const c of cands) { try { if (fs.statSync(c).size > 10000) return c; } catch {} }
  return null;
}

function run(exe, args, cwd, onData, children, onErr) {
  return new Promise((resolve, reject) => {
    const c = spawn(exe, args, { cwd, windowsHide: true });
    children.add(c);
    try { if (c.pid) os.setPriority(c.pid, os.constants.priority.PRIORITY_ABOVE_NORMAL); } catch {}   // extragere mai rapidă
    c.stdout.on('data', onData);
    c.stderr.on('data', onErr || (() => {}));
    c.on('error', reject);
    c.on('close', code => { children.delete(c); resolve(code); });
  });
}

// Lista tehnică (lt): nume + tip + dimensiune pentru fiecare intrare
async function listEntries(exe, archive, children, pw) {
  let out = '', err = '';
  const code = await run(exe, ['lt', '-y', pw, archive], undefined, d => { out += d.toString('latin1'); }, children, d => { err += d.toString('latin1'); });
  if (code === 11) throw new Error('bad_password');
  if (code !== 0 && code !== 1) {
    const e = new Error('native_list');
    e.detail = 'cod ' + code + ' | ' + (out + ' ' + err).replace(/\s+/g, ' ').trim().slice(0, 240);
    throw e;
  }
  const entries = [];
  let cur = null;
  for (const line of out.split(/\r?\n/)) {
    let m;
    if ((m = /^\s*Name:\s?(.*)$/.exec(line))) { cur = { name: m[1], type: '', size: 0 }; entries.push(cur); }
    else if (cur && (m = /^\s*Type:\s*(\S+)/.exec(line))) cur.type = m[1];
    else if (cur && (m = /^\s*Size:\s*(\d+)/.exec(line))) cur.size = Number(m[1]);
  }
  const res = entries.filter(e => e.type.toLowerCase() === 'file');
  // arhivă „solidă” = fișierele depind unele de altele și nu se pot extrage în paralel; dacă nu putem afla, o tratăm ca solidă (varianta sigură)
  const det = /^\s*Details:\s*(.*)$/im.exec(out);
  res.solid = det ? /\bsolid\b/i.test(det[1]) : true;
  return res;
}

/* ---------- extragere directă prin legături (junction) ---------- */
function buildJunctionRoot(jobs, dirs) {
  const prefixes = new Map();                       // prefix -> dest
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
      // verificare: un fișier scris prin legătură trebuie să apară în folderul final
      const probe = '.rms-probe-' + process.pid;
      fs.writeFileSync(path.join(link, probe), '');
      const ok = fs.existsSync(path.join(dirs[dest], probe));
      try { fs.unlinkSync(path.join(link, probe)); } catch {}
      if (!ok) throw new Error('junction_failed');
    }
  } catch (e) { dropJunctionRoot(root, links); throw e; }
  return { root, links };
}

// scoate legăturile (fără să atingă conținutul folderelor finale) și apoi folderul temporar
function dropJunctionRoot(root, links) {
  let safe = true;
  for (const l of links) {
    try { fs.rmdirSync(l); } catch { try { fs.unlinkSync(l); } catch {} }
    if (fs.existsSync(l)) safe = false;
  }
  if (safe) { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} }
}

const keyOf = n => String(n).replace(/\//g, '\\').toLowerCase();

// Progres calculat din ce s-a scris efectiv pe disc (nu depinde de ce afișează UnRAR în consolă).
// items = [{ path, size }] în ordinea din arhivă; fișierele sunt scrise secvențial, deci avansăm un indicator peste cele complete
// și adăugăm dimensiunea parțială a următoarelor fișiere începute.
function makeDiskProgress(items) {
  let i = 0, base = 0;
  return {
    read() {
      const n = items.length;
      while (i < n) {
        let st; try { st = fs.statSync(items[i].path); } catch { break; }
        if (st.size >= items[i].size) { base += items[i].size; i++; } else break;
      }
      let part = 0;
      for (let j = i; j < Math.min(n, i + 64); j++) {
        try { part += Math.min(fs.statSync(items[j].path).size, items[j].size); } catch {}
      }
      return base + part;
    }
  };
}

// Progres în timpul unui fișier mare: UnRAR scrie „Extracting <nume>” când începe fișierul și „OK” abia la final,
// deci urmărim dimensiunea fișierului care se scrie chiar acum pe disc.
function makeWatcher(partial, id, pathFor, tick) {
  let cur = null;
  const timer = setInterval(() => {
    if (!cur) return;
    try { partial.set(id, fs.statSync(cur).size); } catch {}
    tick(false);
  }, 300);
  return {
    seen(buf) {
      const m = /^\s*Extracting\s+(.+?)\s*$/.exec(buf);
      cur = m && !/\s+OK$/.test(buf) ? pathFor(m[1]) : null;
      if (!cur) partial.set(id, 0);
    },
    stop() { clearInterval(timer); partial.delete(id); }
  };
}

async function nativeExtract({ exe, archive, password, fivemDir, gtaDir, onProgress, registerAbort, onPlan, pick }) {
  PICK = pick || null;
  if (PICK) { fivemDir = path.join(fivemDir, 'mods'); fs.mkdirSync(fivemDir, { recursive: true }); }
  const pw = password ? '-p' + password : '-p-';
  const children = new Set();
  let cancelled = false;
  registerAbort(() => {
    cancelled = true;
    for (const c of children) {
      try { c.kill(); } catch {}
      // pe Windows ne asigurăm că procesul UnRAR.exe chiar s-a oprit (inclusiv eventuale procese copil)
      if (process.platform === 'win32' && c.pid) { try { require('child_process').execFile('taskkill', ['/PID', String(c.pid), '/T', '/F'], { windowsHide: true }, () => {}); } catch {} }
    }
  });

  const stages = [];
  let layout = null;
  try {
    const entries = await listEntries(exe, archive, children, pw);
    if (cancelled) throw new Error('cancelled');

    const jobs = { fivem: [], gta: [] };
    let total = 0;
    const lay = layoutOf(entries.map(e => e.name));
    const skipped = [];
    for (const e of entries) {
      const c = classify(e.name, lay);
      if (!c) { skipped.push(e.name); continue; }
      jobs[c.dest].push({ name: e.name, rel: c.rel, prefix: c.prefix, dest: c.dest, size: e.size });
      total += e.size;
    }
    const all = [...jobs.fivem, ...jobs.gta];
    if (!all.length) { const e = new Error('native_nofiles'); e.detail = 'intrări: ' + entries.length + ' | ex.: ' + entries.slice(0, 4).map(x => x.name).join(' ; '); throw e; }
    const dirs = { fivem: fivemDir, gta: gtaDir };
    // anunțăm ce fișiere NU existau înainte, ca să poată fi șterse dacă instalarea nu se termină cu succes
    if (onPlan) { const allPaths = all.map(f => path.join(dirs[f.dest], ...f.rel.split('/'))); await onPlan(allPaths.filter(p => !fs.existsSync(p)), allPaths, 'Structură: ' + (lay.flat ? 'plată' : 'Part 1/2') + ' wrap=' + lay.wrap + ' | solid=' + entries.solid + ' | intrări: ' + entries.length + ' | de copiat: ' + allPaths.length + ' | omise: ' + skipped.length + (skipped.length ? ' [' + skipped.slice(0, 15).join(' ; ') + ']' : '') + ' | enb*: ' + (allPaths.filter(x => /enb/i.test(path.basename(x))).slice(0, 12).join(' ; ') || 'niciunul')); }

    let done = 0, last = 0, lastName = '';
    const partial = new Map();
    const sumPartial = () => { let s = 0; for (const v of partial.values()) s += v; return s; };
    const disk = new Map();
    const sumDisk = () => { let s = 0; for (const v of disk.values()) s += v; return s; };
    const tick = force => {
      const now = Date.now();
      if (force || now - last > 300) { last = now; onProgress({ done: Math.min(total, Math.max(done + sumPartial(), sumDisk())), total, name: lastName }); }
    };

    try { layout = buildJunctionRoot(all, dirs); } catch { layout = null; }

    if (layout) {
      /* ---- metoda directă: fișierele ajung direct în locul final ----
         Arhivă NESOLIDĂ: lista se împarte în mai multe procese UnRAR care rulează în paralel (mult mai rapid).
         Arhivă solidă: un singur proces (o parte din fișiere depind de celelalte). */
      const sizes = new Map(all.map(f => [keyOf(f.name), f.size]));
      const byKey = new Map(all.map(f => [keyOf(f.name), f]));
      const pathOf = f => path.join(dirs[f.dest], ...f.rel.split('/'));
      let unexpected = null;

      const workers = entries.solid ? 1 : Math.max(1, Math.min(4, os.cpus().length));
      const groups = Array.from({ length: workers }, () => ({ files: [], size: 0 }));
      for (const f of [...all].sort((a, b) => b.size - a.size)) {     // cele mai mari întâi, mereu în grupul cel mai gol
        const g = groups.reduce((m, x) => x.size < m.size ? x : m, groups[0]);
        g.files.push(f); g.size += f.size;
      }
      const runGroup = async (g, idx) => {
        if (!g.files.length) return 0;
        const id = 'direct' + idx;
        const listFile = path.join(os.tmpdir(), 'rms-list-' + process.pid + '-' + idx + '.txt');
        fs.writeFileSync(listFile, g.files.map(f => f.name).join('\r\n'), 'latin1');
        let buf = '';
        const watch = makeWatcher(partial, id, n => { const j = byKey.get(keyOf(n)); return j ? pathOf(j) : null; }, tick);
        const onData = d => {
          buf += d.toString('latin1');
          const lines = buf.split(/\r?\n/);
          buf = lines.pop();
          for (const ln of lines) {
            const m = /^\s*Extracting\s+(.*?)\s+OK\s*$/.exec(ln);
            if (!m) continue;
            const k = keyOf(m[1]);
            if (!sizes.has(k)) {                      // UnRAR a început să scoată ceva ce nu e în listă: oprim imediat
              if (!unexpected) { unexpected = m[1]; for (const c of children) { try { c.kill(); } catch {} } }
              continue;
            }
            done += sizes.get(k) || 0;
            lastName = m[1].split(/[\\/]/).pop();
            tick(false);
          }
          watch.seen(buf);
        };
        try {
          return await run(exe, ['x', '-y', '-o+', pw, '-idp', MT, archive, '@' + listFile, layout.root + path.sep], layout.root, onData, children);
        } finally { watch.stop(); try { fs.unlinkSync(listFile); } catch {} }
      };
      const codes = await Promise.all(groups.map(runGroup));
      if (cancelled) throw new Error('cancelled');
      if (unexpected) {
        try { fs.unlinkSync(path.join(layout.root, ...unexpected.split(/[\\/]/))); } catch {}
        throw new Error('native_unexpected');
      }
      if (codes.includes(11)) throw new Error('bad_password');
      const bad = codes.find(c => c !== 0 && c !== 1);
      if (bad !== undefined) throw new Error('native_exit_' + bad);
      // verificare: fiecare fișier există la locul final și are exact dimensiunea din arhivă
      for (const f of all) {
        let st; try { st = fs.statSync(pathOf(f)); } catch { throw Object.assign(new Error('native_missing'), { detail: pathOf(f) }); }
        if (st.size !== f.size) throw Object.assign(new Error('native_size'), { detail: pathOf(f) + ' (' + st.size + ' != ' + f.size + ')' });
      }
      done = total; lastName = ''; tick(true);
      return { type: 'done', files: all.length, mode: 'direct x' + workers + (entries.solid ? ' solid' : '') };
    }

    /* ---- rezervă: folder temporar în folderul țintă, apoi mutare ---- */
    const runDest = async (dest, destDir) => {
      const list = jobs[dest];
      if (!list.length) return;
      const stage = path.join(destDir, '.rms-stage-' + dest);
      fs.rmSync(stage, { recursive: true, force: true });
      fs.mkdirSync(stage, { recursive: true });
      hideDirSync(stage);
      stages.push(stage);

      const listFile = path.join(os.tmpdir(), 'rms-list-' + process.pid + '-' + dest + '.txt');
      fs.writeFileSync(listFile, list.map(f => f.name).join('\r\n'), 'latin1');

      const sizes = new Map(list.map(f => [keyOf(f.name), f.size]));
      let buf = '';
      const dp = makeDiskProgress(list.map(f => ({ path: path.join(stage, ...f.name.split(/[\\/]/)), size: f.size })));
      const dt = setInterval(() => { disk.set('st-' + dest, dp.read()); tick(false); }, 400);
      const watch = { seen() {}, stop() { clearInterval(dt); disk.set('st-' + dest, list.reduce((s, f) => s + f.size, 0)); } };
      const onData = d => {
        buf += d.toString('latin1');
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        for (const ln of lines) {
          const m = /^\s*Extracting\s+(.*?)\s+OK\s*$/.exec(ln);
          if (!m) continue;
          done += sizes.get(keyOf(m[1])) || 0;
          lastName = m[1].split(/[\\/]/).pop();
          tick(false);
        }
        watch.seen(buf);
      };

      let code;
      try {
        code = await run(exe, ['x', '-y', '-o+', pw, '-idp', MT, archive, '@' + listFile, stage + path.sep], stage, onData, children);
      } finally { watch.stop(); try { fs.unlinkSync(listFile); } catch {} }
      if (cancelled) throw new Error('cancelled');
      if (code === 11) throw new Error('bad_password');
      if (code !== 0 && code !== 1) throw new Error('native_exit_' + code);

      for (const f of list) {
        const src = path.join(stage, ...f.name.split(/[\\/]/));
        const dst = path.join(destDir, ...f.rel.split('/'));
        if (!fs.existsSync(src)) throw new Error('native_missing');
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        try { fs.renameSync(src, dst); }
        catch { try { fs.unlinkSync(dst); } catch {} fs.renameSync(src, dst); }
      }
    };

    await Promise.all([runDest('fivem', fivemDir), runDest('gta', gtaDir)]);
    if (cancelled) throw new Error('cancelled');
    done = total; lastName = ''; tick(true);
    return { type: 'done', files: all.length, mode: 'staged' };
  } finally {
    PICK = null;
    if (layout) dropJunctionRoot(layout.root, layout.links);
    for (const s of stages) { try { fs.rmSync(s, { recursive: true, force: true }); } catch {} }
  }
}

// Căile finale (în FiveM / GTA) ale tuturor fișierelor din arhivă; folosit la dezinstalare când lista de instalare lipsește
async function planFiles({ exe, archive, password, fivemDir, gtaDir }) {
  const pw = password ? '-p' + password : '-p-';
  const entries = await listEntries(exe, archive, new Set(), pw);
  const lay = layoutOf(entries.map(e => e.name));
  const dirs = { fivem: fivemDir, gta: gtaDir };
  const out = [];
  for (const e of entries) {
    const c = classify(e.name, lay);
    if (c) out.push(path.join(dirs[c.dest], ...c.rel.split('/')));
  }
  return out;
}

// Pentru bare de progres separate (Graphics = FiveM / ENB = GTA V): dimensiunile fișierelor pe destinații
async function planSizes({ exe, archive, password }) {
  const pw = password ? '-p' + password : '-p-';
  const entries = await listEntries(exe, archive, new Set(), pw);
  const lay = layoutOf(entries.map(e => e.name));
  const out = [];
  for (const e of entries) {
    const c = classify(e.name, lay);
    if (c && e.size > 0) out.push({ dest: c.dest, rel: c.rel, name: e.name, size: e.size });
  }
  return out;
}

module.exports = { findUnrarExe, nativeExtract, makeDiskProgress, planFiles, planSizes };