#!/usr/bin/env node
'use strict';
/*
 * Împachetare cu cod obfuscat (RMS GRAPHICS Launcher)
 * ----------------------------------------------------
 * Ce face:
 *   1. Face o copie de siguranță a fișierelor sursă (proces principal + scriptul din index.html).
 *   2. Suprascrie temporar aceleași fișiere cu versiuni obfuscate (identificatori, control flow,
 *      string-uri criptate RC4, cod „capcană" anti-tamper).
 *   3. Rulează electron-builder (build/dir/portable/release, după argumentul primit).
 *   4. ÎNTOTDEAUNA, chiar dacă build-ul eșuează, restaurează fișierele sursă originale, ca
 *      proiectul cu care lucrezi (și cu care lucrează Claude) să rămână neschimbat.
 *
 * De ce nu e atins ui-file.js:
 *   Conține deja doar un singur șir base64 (frontend.xml încorporat) — nu e cod, iar
 *   obfuscarea l-ar umfla fără niciun beneficiu.
 *
 * De ce index.html primește un tratament mai blând (fără criptare de string-uri):
 *   Scriptul din pagină include imaginile RMS Christmas în base64. Criptarea RC4 a unor
 *   șiruri de sute de KB ar umfla fișierul mult și inutil (acele date nu sunt „logică" de
 *   ascuns). Se obfuscă totuși structura codului (identificatori, control flow).
 *
 * Rulare:
 *   node scripts/obfuscate-release.js dir        → npm run build:dir (folder, fără instalator)
 *   node scripts/obfuscate-release.js nsis        → npm run build    (.exe instalator, fără publicare)
 *   node scripts/obfuscate-release.js portable    → npm run build:portable
 *   node scripts/obfuscate-release.js release     → build .exe + publică pe GitHub Releases
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BACKUP_DIR = path.join(ROOT, '.obfuscate-backup');

// Fișiere din procesul principal (Node/Electron): obfuscare completă, inclusiv string-uri.
const MAIN_PROCESS_FILES = [
  'main.js',
  'preload.js',
  'config.js',
  'unrar-worker.js',
  'download-worker.js',
  'native-unrar.js',
  'discord-presence.js',
  'launcher-update.js',
  'post-update-webhook.js',
].filter(f => fs.existsSync(path.join(ROOT, f)));

// Fișiere opționale, din versiuni mai vechi/alte variante ale proiectului — obfuscate dacă există.
const OPTIONAL_MAIN_FILES = ['nightbright-files.js', 'normalbright-files.js', 'pure-mode.js']
  .filter(f => fs.existsSync(path.join(ROOT, f)));

const ALL_MAIN_FILES = [...MAIN_PROCESS_FILES, ...OPTIONAL_MAIN_FILES];

let JavaScriptObfuscator;
try {
  JavaScriptObfuscator = require('javascript-obfuscator');
} catch (e) {
  console.error('\n[obfuscate] Lipsește pachetul "javascript-obfuscator".');
  console.error('Rulează mai întâi: npm install --save-dev javascript-obfuscator@4.1.1\n');
  process.exit(1);
}

const MAIN_OPTS = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.5,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.2,
  stringArray: true,
  stringArrayEncoding: ['rc4'],
  stringArrayThreshold: 0.8,
  stringArrayWrappersCount: 2,
  stringArrayWrappersChainedCalls: true,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,       // păstrează module.exports/require intacte
  selfDefending: true,        // codul „se apără": o reformatare/„beautify" îl strică intenționat
  target: 'node',
  log: false,
};

// Pentru scriptul din index.html (context de browser, nu Node): fără criptare de string-uri,
// ca să nu umfle inutil imaginile base64 încorporate în pagină.
const RENDERER_OPTS = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.3,
  deadCodeInjection: false,
  stringArray: false,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  selfDefending: false,       // selfDefending + inline <script> mare poate fi fragil; nu merită riscul aici
  target: 'browser',
  log: false,
};

function obfuscateSource(code, opts) {
  return JavaScriptObfuscator.obfuscate(code, opts).getObfuscatedCode();
}

function backupFile(rel) {
  const src = path.join(ROOT, rel);
  const dst = path.join(BACKUP_DIR, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function restoreAll() {
  if (!fs.existsSync(BACKUP_DIR)) return;
  const walk = dir => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) { walk(full); continue; }
      const rel = path.relative(BACKUP_DIR, full);
      fs.copyFileSync(full, path.join(ROOT, rel));
    }
  };
  walk(BACKUP_DIR);
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
  console.log('[obfuscate] Fișierele sursă originale au fost restaurate.');
}

function obfuscateIndexHtml() {
  const file = path.join(ROOT, 'index.html');
  if (!fs.existsSync(file)) return;
  backupFile('index.html');
  let html = fs.readFileSync(file, 'utf8');
  // doar <script> fără src= (cod propriu, nu librării externe de pe CDN)
  html = html.replace(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g, (m, attrs, code) => {
    if (!code.trim()) return m;
    const obf = obfuscateSource(code, RENDERER_OPTS);
    return `<script${attrs}>${obf}</script>`;
  });
  fs.writeFileSync(file, html, 'utf8');
}

function obfuscateMainFiles() {
  for (const rel of ALL_MAIN_FILES) {
    const file = path.join(ROOT, rel);
    backupFile(rel);
    const src = fs.readFileSync(file, 'utf8');
    const obf = obfuscateSource(src, MAIN_OPTS);
    // verificare de siguranță: codul obfuscat trebuie să fie JS valid înainte să-l scriem peste original
    new (require('vm').Script)(obf, { filename: rel });
    fs.writeFileSync(file, obf, 'utf8');
    console.log(`[obfuscate] ${rel}: ${src.length} -> ${obf.length} octeți`);
  }
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, shell: process.platform === 'win32' });
  return r.status;
}

function main() {
  const mode = (process.argv[2] || 'dir').toLowerCase();
  const builderArgs = {
    dir: ['--win', 'dir'],
    nsis: ['--win', 'nsis'],
    portable: ['--win', 'portable'],
    release: ['--win', 'nsis', '--publish', 'always'],
  }[mode];
  if (!builderArgs) {
    console.error('Mod necunoscut: ' + mode + ' (folosește: dir | nsis | portable | release)');
    process.exit(1);
  }

  if (fs.existsSync(BACKUP_DIR)) {
    console.error('[obfuscate] Există deja un folder .obfuscate-backup — pare că un build anterior a fost întrerupt.');
    console.error('Verifică fișierele din proiect (ar putea fi încă obfuscate) și, dacă e cazul, restaurează manual din .obfuscate-backup, apoi șterge folderul.');
    process.exit(1);
  }

  let exitCode = 1;
  try {
    console.log('[obfuscate] Pornesc obfuscarea (' + ALL_MAIN_FILES.length + ' fișiere proces principal + index.html)…');
    obfuscateMainFiles();
    obfuscateIndexHtml();
    console.log('[obfuscate] Gata. Pornesc electron-builder ' + builderArgs.join(' ') + ' …');
    exitCode = run(path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder'), builderArgs);
  } finally {
    restoreAll();
  }
  process.exit(exitCode || 0);
}

main();
