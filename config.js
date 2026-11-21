// ============================================================
//  CONFIGURARE DISCORD  –  completează cele 2 valori de mai jos
// ============================================================
module.exports = {
  // 1) https://discord.com/developers/applications -> New Application
  //    -> OAuth2 -> copiază "Client ID"
  //    -> la "Redirects" adaugă exact: http://localhost:53134/callback
  CLIENT_ID: '1437718484468633684',

  // 2) În Discord: Setări utilizator -> Avansat -> activează "Developer Mode".
  //    Apoi: Server Settings -> Roles -> click dreapta pe rolul
  //    "RMS Graphics" -> Copy Role ID
  ROLE_ID: '1570490336239947778',

  // Opțional: ID-ul rolului „RMS Beta” (Copy Role ID). Dacă e gol, rândul „RMS Beta” nu apare în profil.
  BETA_ROLE_ID: '1560609671054893147',

  // Opțional: ID-ul serverului. Dacă îl lași gol, se află automat din invitație.
  GUILD_ID: '1570490304619085904',

  // 3) Jurnal (opțional): în Discord -> click pe canalul de log -> Edit Channel
  //    -> Integrations -> Webhooks -> New Webhook -> Copy Webhook URL.
  //    Lasă gol ('') ca să dezactivezi jurnalul.
  LOG_WEBHOOK_URL: 'https://discord.com/api/webhooks/1570508393100222555/YxvMMBqczrI0nvUUbvFJK7SdO8JpggNI-9Rx6xxaWU4sHCpO5UvTiJc1cIbTx7nf9uYq',

  // Canal separat doar pentru alertele de securitate (tentative de „unhide” pe fișiere/foldere protejate RMS sau
  // schimbări de atribute pe folderul GTA V / FiveM). Nu se amestecă cu jurnalul de descărcări de mai sus.
  SECURITY_WEBHOOK_URL: 'https://discord.com/api/webhooks/1562114632574046299/q-PM-BCQtXjCGd27eQBoSTNYUVM-L3f6BkMLVtM93bG-uydmf5S3qyoEHyK57dG996ni',

  // Manifest online (GitHub): de aici se citește linkul arhivei, data, versiunea etc. la fiecare pornire.
  // Valorile de mai jos (PACK_URL, UPDATE_DATE, ...) rămân ca rezervă, dacă nu există internet.
  // Pune linkul „Raw” al fișierului rms-pack.json din repo-ul tău.
  MANIFEST_URL: 'https://gist.githubusercontent.com/Gabi199797/aac1e39b5da47bee5e2832497ddf671a/raw/rms-pack.json',

  // Acces prin Cloudflare Worker — dezactivat (gol). Dacă vrei să revii la el, pune aici adresa
  // Worker-ului (vezi worker/README.md) și lasă câmpurile de mai jos goale.
  PACK_ACCESS_URL: '',

  // 4) Arhiva de descărcat (Cloudflare R2 — fără limită de trafic, fără cotă — sau orice link direct https).
  //    Linkul nu mai apare în clar aici: stă criptat (AES-256-GCM, ca parola) și e decriptat doar în memorie, în
  //    main.js. Dacă trebuie schimbat linkul, spune-mi noul link și îți dau alt PACK_URL_BLOB.
  PACK_URL_BLOB: 'yMiE8SPCzl7HSA/B8xjoIYvWgvKhD4ONoaEu/h7obSW51RRvdTMTd1E/l7Jl56bqfwiYHQz93CB9wGgVDJWYma/Do4XLVUbPNbYiPelE0NdlFr37qRPCxLlvoBiiOWEC',

  // Parola arhivei .rar (se afișează în tab-ul Auto Install și se cere la pornirea instalării).
  // Nu mai apare în clar aici: stă criptată (AES-256-GCM, ca linkul) în main.js (PW_BLOB). Rândul de mai jos
  // rămâne doar ca rezervă, dacă vreodată PW_BLOB e gol. Dacă trebuie schimbată parola, spune-mi noua parolă.
  PACK_PASSWORD: '',
  DOWNLOAD_FILENAME: 'RMS_GRAPHICS.rar',

  // Data ultimului update al pachetului (se afișează animat în tab-urile Descărcări și Auto Install)
  UPDATE_DATE: '13.10.2026',
  DOWNLOAD_SIZE_GB: 2.6,   // în GB, folosit doar dacă linkul nu trimite dimensiunea reală (pune o valoare ușor mai mare decât arhiva)

  // Pachete opționale (tab-ul „RMS Optional”). Link gol = apare „În curând”.
  // Se pot suprascrie și din gist: "optional": { "minimap": { "packUrl": "...", "sizeGb": 0.1, "version": 1, "updateDate": "..." } }
  OPTIONAL_PACKS: {
    minimap: { packUrl: '', filename: 'RMS_MINIMAP_3440x1440.rar', password: '', sizeGb: 0.1, version: 1, updateDate: '' },
    milkyway: { filename: 'RMS_MILKYWAY.rar', password: '', sizeGb: 0.1, version: 1, updateDate: '' }   // packUrl: nu mai stă în clar aici — e criptat în main.js (OPT_URL_BLOB.milkyway)
  },

  // Adresa JSON-ului produs de stats-bot.js (ex.: http://IP-ul-tau:3100/stats.json) cu {role_members, role_online}.
  STATS_URL: '',

  // Când utilizatorul pierde rolul „RMS Graphics”: se dezinstalează automat tot ce a pus RMS în FiveM / GTA V (+ arhivele, inclusiv din Coș).
  AUTO_UNINSTALL_ON_ROLE_LOSS: true,
  // La fel, dar și launcherul însuși se dezinstalează (doar varianta instalată, nu portable / npm start).
  AUTO_REMOVE_LAUNCHER: true,

  // Rolul „C.E.O” (insignă aurie în profil + rang în Discord Rich Presence). Prioritate maximă.
  CEO_ROLE_ID: '1570496390969303191',
  // Rolul „Admin” (insignă roșie în profil + rang în Rich Presence). Sub C.E.O.
  ADMIN_ROLE_ID: '1570495038809440329',
  // Rolul „Developer” (insignă cyan + rang în Rich Presence). Pune aici ID-ul numeric al rolului (Copy Role ID). Gol = dezactivat.
  DEV_ROLE_ID: '',

  // Discord Rich Presence (statusul „Joacă RMS Graphics Launcher” în profil). false = oprit.
  RICH_PRESENCE: true,
  // Numele imaginii încărcate în Developer Portal → Rich Presence → Art Assets.
  RICH_PRESENCE_IMAGE: 'logo',
  // Imagini mici (opțional) după rang: numele din Art Assets. Gol = nu se afișează.
  RICH_PRESENCE_SMALL: { ceo: '', admin: '', dev: '', beta: '', member: '' },
  // Butoane sub status (maxim 2, doar linkuri https). Se văd pentru ceilalți utilizatori, nu pentru tine.
  RICH_PRESENCE_BUTTONS: [
    { label: 'Discord Server', url: 'https://discord.gg/QgKRmfrydf' },
    { label: '', url: '' }   // al doilea buton: pune eticheta + linkul (ex. site, canal, tutorial). Gol = nu apare
  ],

  // Autorul launcherului (apare în Rich Presence, la hover pe logo).
  CREATOR: 'fNKje',

  INVITE_CODE: 'QgKRmfrydf',
  INVITE_URL: 'https://discord.gg/QgKRmfrydf',
  REDIRECT_URI: 'http://localhost:53134/callback'
};