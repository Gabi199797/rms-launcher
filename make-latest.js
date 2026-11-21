// Generează dist/latest.yml dacă electron-builder nu l-a creat. Rulare: node make-latest.js
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const dist = path.join(__dirname, 'dist');
const ver = require('./package.json').version;
const exe = fs.readdirSync(dist).find(f => f.toLowerCase().endsWith('.exe') && f.includes(ver) && !f.includes('uninstaller'));
if (!exe) { console.error('Nu găsesc installerul pentru versiunea ' + ver + ' în dist. Rulează întâi npm run build.'); process.exit(1); }
const buf = fs.readFileSync(path.join(dist, exe));
const sha512 = crypto.createHash('sha512').update(buf).digest('base64');
const name = exe.replace(/\s+/g, '.');           // GitHub înlocuiește spațiile cu puncte
if (name !== exe) fs.copyFileSync(path.join(dist, exe), path.join(dist, name));
const yml = `version: ${ver}
files:
  - url: ${name}
    sha512: ${sha512}
    size: ${buf.length}
path: ${name}
sha512: ${sha512}
releaseDate: '${new Date().toISOString()}'
`;
fs.writeFileSync(path.join(dist, 'latest.yml'), yml);
console.log('Creat dist/latest.yml pentru ' + name + ' (v' + ver + ')');
