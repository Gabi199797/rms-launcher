// Descărcarea arhivei rulează aici, într-un worker thread, ca scrierea pe disc
// să nu blocheze procesul principal al aplicației (altfel fereastra nu mai răspunde la comenzi).
// Sursa este MEGA (mega.nz/file/...), Google Drive (drive.usercontent.google.com/download?id=...), MediaFire,
// gofile.io sau orice link direct https.
// MEGA: prin librăria „megajs” (decriptare AES făcută de ea), stream Node direct, nu prin fetch ca celelalte.
// Google Drive: pentru fișiere mari, Google întoarce o pagină de confirmare (scanare antivirus); o trecem automat.
// MediaFire: linkul direct se extrage din pagină, apoi arhiva se descarcă prin HTTP.
// gofile.io: nu oferă link direct — se trece prin API-ul lor (token de „guest” + interogarea conținutului).
// Trimite către main.js mesaje: progress / done / error.
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const { Transform, Readable } = require('stream');
const { pipeline } = require('stream/promises');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const post = m => parentPort.postMessage(m);
const ctrl = new AbortController();
parentPort.on('message', m => { if (m === 'abort') ctrl.abort(); });

const unesc = s => String(s || '').replace(/&amp;/g, '&').replace(/\\\//g, '/');
const attr = (tag, name) => { const m = new RegExp('\\b' + name + '\\s*=\\s*["\']([^"\']*)["\']', 'i').exec(tag); return m ? unesc(m[1]) : ''; };


// ---- MEGA ----
// Spre deosebire de celelalte surse, MEGA nu merge prin fetch http simplu — fișierele sunt criptate AES, iar
// librăria „megajs” face autentificarea anonimă, citirea atributelor (nume/mărime) și decriptarea pe loc, oferind
// un stream Node.js normal (nu un Response ca la fetch), tratat separat mai jos în blocul principal.
const isMega = u => /^https:\/\/mega\.nz\//i.test(u);
async function megaOpen(url, signal) {
  let File;
  try { ({ File } = require('megajs')); } catch { throw new Error('Librăria megajs lipsește din build. [mega_lib]'); }
  let file;
  try { file = File.fromURL(url); } catch { throw new Error('HTTP 404'); }
  try { await file.loadAttributes(); } catch (e) {
    const msg = String((e && e.message) || e);
    if (/over\s*quota|bandwidth|limit|rate|too\s+many/i.test(msg)) throw new Error('Limita de transfer MEGA a fost depășită (quota). Încearcă mai târziu. [mega_quota]');
    if (/not\s*found|invalid|expired|EKEY|ENOENT|ETOOMANY|EBLOCKED/i.test(msg)) throw new Error('HTTP 404');
    throw new Error('Nu s-a putut deschide linkul MEGA. [mega_err]');
  }
  // maxConnections: megajs descarcă fișierul în bucăți (chunk-uri), în paralel, pe mai multe conexiuni HTTP către
  // MEGA. Implicit erau doar 4 — MEGA limitează viteza FIECĂREI conexiuni individuale (mai dur pe linkuri anonime),
  // așa că mai multe conexiuni simultane compensează limita per-conexiune și cresc viteza totală de descărcare
  // (exact ce fac și aplicațiile oficiale MEGA). 24 împinge puțin mai sus pragul la care apar erori de tip
  // ETOOMANY, dar important: dacă MEGA plafonează banda PER-IP (nu per-conexiune) pentru linkuri anonime,
  // niciun număr de conexiuni nu mai ajută peste acel plafon — asta se vede doar testând.
  const stream = file.download({ maxConnections: 24, forceHttps: true });
  if (signal) {
    if (signal.aborted) { try { stream.destroy(); } catch {} }
    signal.addEventListener('abort', () => { try { stream.destroy(); } catch {} });
  }
  return { stream, size: Number(file.size || 0) };
}

// ---- cookie jar partajat (Google Drive ȘI MediaFire au nevoie de el, nu doar Drive) ----
const jar = new Map();
const cookieHdr = () => [...jar].map(([k, v]) => k + '=' + v).join('; ');
function eat(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of list) { const m = /^([^=;]+)=([^;]*)/.exec(c); if (m) jar.set(m[1], m[2]); }
}
const isDrive = u => /^https:\/\/(?:drive\.usercontent\.google\.com|drive\.google\.com|docs\.google\.com)\//i.test(u);
function driveForm(html, base) {                                  // pagina „Google Drive nu poate scana fișierul” are un formular cu câmpuri ascunse
  const f = /<form\b[^>]*id=["']download-form["'][^>]*>/i.exec(html) || /<form\b[^>]*action=["'][^"']*download[^"']*["'][^>]*>/i.exec(html);
  if (!f) return null;
  const action = attr(f[0], 'action');
  if (!action) return null;
  let u; try { u = new URL(action, base); } catch { return null; }
  const re = /<input\b[^>]*>/gi; let m;
  while ((m = re.exec(html.slice(f.index)))) {
    const n = attr(m[0], 'name'); if (n) u.searchParams.set(n, attr(m[0], 'value'));
  }
  return u.href;
}
async function driveOpen(url, signal) {
  let id = (/[?&]id=([\w-]+)/.exec(url) || /\/d\/([\w-]+)/.exec(url) || [])[1];
  if (!id) throw new Error('HTTP 404');
  let cur = 'https://drive.usercontent.google.com/download?id=' + id + '&export=download&confirm=t';
  for (let hop = 0; hop < 3; hop++) {
    const r = await fetch(cur, { redirect: 'follow', signal, headers: { 'user-agent': UA, accept: '*/*', ...(jar.size ? { cookie: cookieHdr() } : {}) } });
    eat(r);
    if (r.status === 404 || r.status === 410) throw new Error('HTTP 404');
    const ct = String(r.headers.get('content-type') || '');
    if (r.ok && !/text\/html/i.test(ct)) return r;
    const html = await r.text().catch(() => '');
    if (/quota|too\s+many\s+users|download\s+limit|has\s+been\s+(?:viewed|downloaded)\s+too\s+many/i.test(html) || r.status === 429) throw new Error('Limita de descărcări Google Drive a fost depășită (quota). Încearcă mai târziu.');
    if (/file\s+not\s+found|does\s+not\s+exist|requested\s+URL\s+was\s+not\s+found|you\s+need\s+access|request\s+access/i.test(html)) throw new Error('HTTP 404');
    const next = driveForm(html, r.url || cur);
    if (!next || next === cur) break;
    cur = next;
  }
  throw new Error('Nu s-a putut obține descărcarea de pe Google Drive. Verifică dacă fișierul e partajat „Oricine are linkul”. [drive_nolink]');
}

// ---- gofile.io ----
// Nu oferă link direct ca MediaFire: trebuie trecut prin API-ul lor (token de „guest” + interogarea conținutului).
// „wt” (website token) e un cod pe care gofile îl schimbă periodic special ca să îngreuneze descărcarea automată — dacă
// descărcarea de pe gofile începe brusc să eșueze cu [gofile_nf]/[gofile_token], foarte probabil ei l-au schimbat și
// trebuie actualizat aici cu valoarea curentă (se poate găsi din nou căutând în JS-ul lor de pe gofile.io).
const isGofile = u => /^https:\/\/gofile\.io\/d\//i.test(u);
const GOFILE_WT = '4fd6sg89d7s6';
let gofileAccountToken = null;
async function gofileAccount(signal) {
  if (gofileAccountToken) return gofileAccountToken;
  const r = await fetch('https://api.gofile.io/accounts', { method: 'POST', signal, headers: { 'user-agent': UA } });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.status !== 'ok' || !j.data || !j.data.token) throw new Error('Nu s-a putut obține acces la gofile.io. [gofile_token]');
  gofileAccountToken = j.data.token;
  return gofileAccountToken;
}
async function gofileOpen(url, signal) {
  const id = (/\/d\/([\w-]+)/.exec(url) || [])[1];
  if (!id) throw new Error('HTTP 404');
  const token = await gofileAccount(signal);
  const r = await fetch('https://api.gofile.io/contents/' + id + '?wt=' + GOFILE_WT + '&cache=true', {
    signal, headers: { 'user-agent': UA, authorization: 'Bearer ' + token }
  });
  if (r.status === 404) throw new Error('HTTP 404');
  if (r.status === 429) throw new Error('Limita de descărcări gofile.io a fost depășită (quota). Încearcă mai târziu. [gofile_quota]');
  const j = await r.json().catch(() => null);
  if (!j || j.status !== 'ok' || !j.data) throw new Error('HTTP 404');
  const kids = j.data.children ? Object.values(j.data.children) : (j.data.type === 'file' ? [j.data] : []);
  const file = kids.find(c => c && c.type === 'file');
  if (!file || !file.link) throw new Error('HTTP 404');
  const res = await fetch(file.link, { redirect: 'follow', signal, headers: { 'user-agent': UA, accept: '*/*', cookie: 'accountToken=' + token } });
  if (res.status === 404 || res.status === 410) throw new Error('HTTP 404');
  if (res.status === 429 || res.status === 509) throw new Error('Limita de descărcări gofile.io a fost depășită (quota). Încearcă mai târziu. [gofile_quota]');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res;
}

// Extrage linkul direct din pagina MediaFire.
function mediafireDirect(html) {
  const tag = (/<a\b[^>]*id=["']downloadButton["'][^>]*>/i.exec(html) || [])[0] || '';
  let href = attr(tag, 'href');
  if (/^https?:\/\//i.test(href)) return href;
  const scr = attr(tag, 'data-scrambled-url');                  // varianta în care linkul e codat base64
  if (scr) { try { const d = Buffer.from(scr, 'base64').toString('utf8'); if (/^https?:\/\//i.test(d)) return d; } catch {} }
  const m = /https?:\/\/download\d*\.mediafire\.com\/[^"'\s<>\\]+/i.exec(html);
  return m ? unesc(m[0]) : null;
}

async function resolveUrl(url, signal) {
  if (!/^https?:\/\/(?:www\.)?mediafire\.com\/(?:file|view|download)\//i.test(url)) return { url, ref: '' };
  // „?action=check” (și orice alt query string) pare să ceară un mod special al paginii MediaFire — care dă 403 fără
  // sesiune autentificată (probabil un buton din dashboard-ul lor, nu linkul public de share); pagina publică normală
  // de fișier nu are nevoie de el, deci îl scoatem înainte de cerere
  url = url.split(/[?#]/)[0];
  const r = await fetch(url, { redirect: 'follow', signal, headers: { 'user-agent': UA, accept: 'text/html,*/*' } });
  eat(r);   // MediaFire poate lega linkul direct de sesiunea (cookie) stabilită la vizita paginii — fără cookie-ul ăsta
            // trimis mai departe la cererea efectivă, CDN-ul lor poate răspunde 403 chiar dacă linkul extras e corect
  if (r.status === 404 || r.status === 410) throw new Error('HTTP 404');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const ct = String(r.headers.get('content-type') || '');
  if (!/text\/html/i.test(ct)) return { url: r.url || url, ref: '' };   // MediaFire a întors direct fișierul
  const html = await r.text();
  const direct = mediafireDirect(html);
  if (!direct) {
    if (/file\s+(?:has\s+been\s+)?(?:deleted|removed)|invalid\s+or\s+deleted|dangerous\s+file|file\s+not\s+found/i.test(html)) throw new Error('HTTP 404');
    throw new Error('Nu s-a găsit linkul de descărcare pe pagina MediaFire. [mediafire_nolink]');
  }
  return { url: direct, ref: url };
}

(async () => {
  const { url, tmp, knownSize, estimated } = workerData;
  try {
    let bodyStream, tot = 0;
    if (isMega(url)) {
      const m = await megaOpen(url, ctrl.signal);
      bodyStream = m.stream;
      tot = m.size || 0;
    } else {
      let res;
      if (isDrive(url)) res = await driveOpen(url, ctrl.signal);
      else if (isGofile(url)) res = await gofileOpen(url, ctrl.signal);
      else {
        const src = await resolveUrl(url, ctrl.signal);
        res = await fetch(src.url, { redirect: 'follow', signal: ctrl.signal, headers: { 'user-agent': UA, accept: '*/*', ...(src.ref ? { referer: src.ref } : {}), ...(jar.size ? { cookie: cookieHdr() } : {}) } });
        if (res.status === 404 || res.status === 410) throw new Error('HTTP 404');
        if (res.status === 403 && src.ref) throw new Error('Linkul MediaFire a fost respins (403). Poate fi un link expirat sau protecție anti-leech — încearcă din nou sau regenerează linkul din contul MediaFire. [mediafire_403]');
        if (!res.ok) throw new Error('HTTP ' + res.status);
      }
      const ct = String(res.headers.get('content-type') || '');
      if (/text\/html/i.test(ct) || !res.body) throw new Error('Linkul nu returnează arhiva, ci o pagină web. [not_direct]');
      tot = Number(res.headers.get('content-length')) || 0;
      bodyStream = Readable.fromWeb(res.body);
    }

    const total = tot || knownSize || estimated || 0;
    let received = 0, lastT = Date.now(), lastB = 0, speed = 0;

    const counter = new Transform({
      highWaterMark: 16 * 1024 * 1024,
      transform(chunk, _enc, cb) {
        received += chunk.length;
        const now = Date.now();
        if (now - lastT >= 300) {                               // maxim ~3 actualizări pe secundă către interfață
          const inst = (received - lastB) / ((now - lastT) / 1000);
          speed = speed ? speed * 0.7 + inst * 0.3 : inst;      // viteză netezită
          lastT = now; lastB = received;
          post({ type: 'progress', received, total, speed });
        }
        cb(null, chunk);
      }
    });

    await pipeline(bodyStream, counter, fs.createWriteStream(tmp, { highWaterMark: 16 * 1024 * 1024 }), { signal: ctrl.signal });

    if (received < 1024) throw new Error('empty');          // orice sub 1 KB e, practic sigur, un răspuns gol/eroare, indiferent de sursă
    if (tot && received !== tot) throw new Error('incomplete');   // Content-Length cunoscut: verificare exactă, nu una pe prag arbitrar
    else if (!tot && received < 1024 * 1024) throw new Error('empty');   // Content-Length lipsă (nu putem verifica exact): pragul vechi de 1 MB rămâne, ca plasă de siguranță doar pentru sursele fără dimensiune cunoscută — pachetele mici cu Content-Length corect (ex. RMS Motion Blur, ~60 KB) nu mai sunt respinse din greșeală
    post({ type: 'done', received, size: received });
  } catch (e) {
    post({ type: 'error', name: e && e.name, code: e && e.code, message: String((e && e.message) || e).slice(0, 300) });
  }
})();