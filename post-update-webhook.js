#!/usr/bin/env node
'use strict';

/**
 * Trimite un embed Discord frumos formatat pe webhook-ul RMS GRAPHICS
 * de câte ori se publică un update nou (citește ultima intrare din manifest.json).
 *
 * Folosire:
 *   node post-update-webhook.js                 -> citește ./manifest.json și trimite
 *   node post-update-webhook.js /cale/manifest.json
 *   node post-update-webhook.js --dry            -> doar afișează payload-ul, nu trimite nimic
 */

const fs = require('fs');
const path = require('path');

// ===== Configurație (ale tale) =====
const WEBHOOK_URL = 'https://discord.com/api/webhooks/1570508266348351549/Vi_xC531KTE8bvBavPyxQY724U5jrUMIRBfn0Z-W4b6zdnc7rvpKsffl1_np2VPAJesQ';
const AUTHOR_DISCORD_ID = '370178392001085441';   // cine a publicat update-ul (tu)
const PING_ROLE_ID = '1570490336239947778';        // rolul care primește tag la fiecare update

const BRAND_COLOR = 0xF97316; // portocaliul din launcher (RMS "GRAPHICS")
const TAG_META = {
  new: { label: '✨ Noutăți',       dot: '🟢' },
  imp: { label: '⚡ Îmbunătățiri',  dot: '🔵' },
  fix: { label: '🔧 Reparații',     dot: '🟠' },
};

// ===== Argumente =====
const args = process.argv.slice(2);
const dry = args.includes('--dry');
const manifestPath = args.find(a => !a.startsWith('--')) || path.join(__dirname, 'manifest.json');

// ===== Citește manifestul =====
if (!fs.existsSync(manifestPath)) {
  console.error('Nu găsesc manifestul la: ' + manifestPath);
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const entry = (manifest.changelog || [])[0];
if (!entry) {
  console.error('manifest.json nu are nicio intrare în "changelog".');
  process.exit(1);
}

// ===== Grupează item-urile pe tip, păstrând ordinea new -> imp -> fix =====
function groupItems(items) {
  const groups = { new: [], imp: [], fix: [] };
  for (const it of items) {
    if (groups[it.k]) groups[it.k].push(it);
  }
  return groups;
}

// Discord limitează fiecare "field.value" la 1024 caractere -> spargem în bucăți dacă e nevoie
function chunkLines(lines, max = 1024) {
  const chunks = [];
  let cur = '';
  for (const line of lines) {
    const next = cur ? cur + '\n' + line : line;
    if (next.length > max) {
      if (cur) chunks.push(cur);
      cur = line;
    } else {
      cur = next;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.length ? chunks : [''];
}

function buildFields(groups) {
  const fields = [];
  for (const k of ['new', 'imp', 'fix']) {
    const list = groups[k];
    if (!list.length) continue;
    const meta = TAG_META[k];
    const lines = list.map(it => `${meta.dot} ${it.ro}`);
    const chunks = chunkLines(lines);
    chunks.forEach((chunk, i) => {
      fields.push({
        name: chunks.length > 1 ? `${meta.label} (${i + 1}/${chunks.length})` : meta.label,
        value: chunk,
        inline: false,
      });
    });
  }
  return fields;
}

// Se postează TOT update-ul zilei: prima intrare + toate celelalte cu aceeași dată (ex. „Launcher 6.4.4” + „2.5.5.4”),
// ca să apară același conținut ca în tab-ul „RMS Actualizări” din launcher.
const sameDay = (manifest.changelog || []).filter((e, i) => i === 0 || (e && e.date === entry.date));
const multi = sameDay.length > 1;
let fields = [];
const counts = { new: 0, imp: 0, fix: 0 };
for (const e of sameDay) {
  const g = groupItems(e.items || []);
  counts.new += g.new.length; counts.imp += g.imp.length; counts.fix += g.fix.length;
  const part = buildFields(g);
  if (multi) {
    const vname = /^launcher\b/i.test(String(e.v)) ? String(e.v) : 'v' + String(e.v).replace(/^v/i, '');
    for (const f of part) f.name = `${f.name} · ${vname}`;
  }
  fields = fields.concat(part);
}
fields = fields.slice(0, 19);   // limita Discord: 25 câmpuri / embed (3 sunt deja folosite mai sus)

// intrare de launcher („Launcher 6.4.0”): anunțul nu pomenește arhiva (versiune pachet / mărime), fiindcă arhiva nu s-a schimbat
const isLauncher = /^launcher\b/i.test(String(entry.v));
const launcherVer = String(entry.v).replace(/^launcher\s*/i, '').replace(/^v/i, '');
const counts_line = `**${counts.new} noi** · **${counts.imp} îmbunătățiri** · **${counts.fix} reparații**`;

const embed = {
  title: isLauncher ? `🚀 RMS GRAPHICS Launcher — Update v${launcherVer}` : `🚀 RMS GRAPHICS — Update v${entry.v}`,
  description: isLauncher
    ? counts_line
    : counts_line + `\n` + `Versiune pachet: \`${manifest.version}\`  •  Mărime: \`${manifest.sizeGb} GB\``,
  color: BRAND_COLOR,
  fields: [
    { name: '📅 Data update-ului', value: entry.date, inline: true },
    { name: '🧑 Publicat de', value: `<@${AUTHOR_DISCORD_ID}>`, inline: true },
    { name: '​', value: '​', inline: true },
    ...fields,
  ],
  footer: { text: 'RMS GRAPHICS Launcher' },
  timestamp: new Date().toISOString(), // Discord îl arată automat în ora locală a fiecăruia
};

const payload = {
  content: `<@&${PING_ROLE_ID}> s-a lansat un update nou pentru **RMS GRAPHICS${isLauncher ? ' Launcher' : ''}**!`,
  embeds: [embed],
  allowed_mentions: { parse: [], roles: [PING_ROLE_ID], users: [] },
};

if (dry) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

(async () => {
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.error(`Discord a răspuns ${res.status}: ${txt}`);
      process.exit(1);
    }
    console.log(`Trimis cu succes: update v${entry.v} (${entry.date}).`);
  } catch (err) {
    console.error('Eroare la trimiterea către webhook:', err.message || err);
    process.exit(1);
  }
})();
