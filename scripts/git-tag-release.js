#!/usr/bin/env node
'use strict';

// Rulează automat ÎNAINTE de "npm run release" (convenția npm: scriptul "pre<nume>").
// Scop: creează + trimite pe GitHub tag-ul de versiune curentă, pentru că electron-builder
// are nevoie ca tag-ul să existe deja pe remote înainte să poată publica un release direct
// (altfel GitHub răspunde cu eroarea 422 "Published releases must have a valid tag").
//
// Diferența față de versiunea veche: dacă "git" nu e disponibil (nu e instalat sau nu e în
// PATH-ul terminalului curent), afișează un mesaj clar în română și se oprește curat — în loc
// să crape cu un stack trace Node urât.

const { spawnSync } = require('child_process');
const path = require('path');

const pkg = require(path.join(__dirname, '..', 'package.json'));
const tag = 'v' + pkg.version;

function run(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8' });
}

function fail(lines) {
  console.error('');
  lines.forEach((l) => console.error(l));
  console.error('');
  process.exit(1);
}

// 1) verifică dacă "git" poate fi rulat deloc din acest terminal
const check = run('git', ['--version']);
if (check.error || check.status !== 0) {
  fail([
    '✗ Nu am putut rula comanda "git" — release-ul s-a oprit aici, înainte de build.',
    '',
    '  Cel mai probabil Git nu e instalat, sau nu e în PATH-ul terminalului curent',
    '  (PowerShell / CMD / terminalul din VS Code).',
    '',
    '  Cum repari:',
    '  1. Într-un terminal nou, scrie:  git --version',
    '     Dacă dă eroare și acolo, Git nu e instalat sau PATH-ul nu e actualizat.',
    '  2. Instalează Git de aici (dacă nu-l ai):  https://git-scm.com/download/win',
    '  3. Dacă l-ai instalat recent, închide COMPLET terminalul/VS Code și',
    '     redeschide-l, ca Windows să reîncarce variabila PATH.',
    '',
    '  Poți continua manual chiar acum, dintr-un terminal unde "git --version" merge:',
    '       git tag ' + tag + ' -f',
    '       git push origin ' + tag + ' -f',
    '       npx electron-builder --win nsis --publish always'
  ]);
}

// 2) verifică dacă suntem într-un folder care e repository git
const insideRepo = run('git', ['rev-parse', '--is-inside-work-tree']);
if (insideRepo.error || insideRepo.status !== 0) {
  fail([
    '✗ Folderul curent nu pare să fie un repository Git (nu găsesc un .git aici).',
    '  Rulează "npm run release" din folderul proiectului, nu din altă locație.'
  ]);
}

console.log('→ Marchez tag-ul ' + tag + ' și îl trimit pe GitHub...');

// 3) creează tag-ul local (-f = suprascrie dacă a mai existat un tag cu numele ăsta)
const tagRes = run('git', ['tag', tag, '-f']);
if (tagRes.error || tagRes.status !== 0) {
  fail([
    '✗ Nu am putut crea tag-ul ' + tag + '.',
    tagRes.stderr ? '  ' + tagRes.stderr.trim() : ''
  ].filter(Boolean));
}

// 4) trimite tag-ul pe GitHub
const pushRes = run('git', ['push', 'origin', tag, '-f']);
if (pushRes.error || pushRes.status !== 0) {
  fail([
    '✗ Tag-ul ' + tag + ' a fost creat local, dar nu a putut fi trimis pe GitHub (git push).',
    '  Verifică conexiunea la internet și că ai acces de scriere la repository.',
    pushRes.stderr ? '  ' + pushRes.stderr.trim() : ''
  ].filter(Boolean));
}

console.log('✓ Tag-ul ' + tag + ' a fost creat și trimis cu succes pe GitHub.');
console.log('  Continuă build-ul...');
