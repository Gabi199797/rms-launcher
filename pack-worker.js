/*
 * RMS Pack Worker (Cloudflare Workers)
 * ------------------------------------
 * Singurul scop: ascunde linkul real de descărcare și parola arhivei principale (RMS GRAPHICS),
 * și verifica EL ÎNSUȘI, direct la Discord, că cel care cere are rolul necesar — nu se bazează
 * pe ce spune launcherul.
 *
 * Cum funcționează (2 pași, ca launcherul să nu trebuiască schimbat în restul codului):
 *   1. GET /pack-info   cu  Authorization: Bearer <discord_access_token>
 *        -> verifică rolul direct la Discord
 *        -> răspunde { ok:true, password:"...", downloadUrl:"https://.../pack?t=<jeton semnat>" }
 *   2. GET <downloadUrl>  (fără alt header — jetonul e deja în link, valabil 10 minute)
 *        -> conținutul arhivei, direct din R2 (stream)
 * Pasul 2 e un link obișnuit (poate fi folosit ca atare de download-worker.js / probeRemoteSize,
 * exact ca un link direct de pe un alt host — nu trebuie adăugat niciun header nicăieri în restul
 * aplicației). Jetonul din link NU e tokenul tău de Discord: e un jeton scurt, semnat de acest
 * Worker (HMAC-SHA256), bun doar pentru acest fișier și doar 10 minute.
 *
 * De ce arhiva nu trebuie să fie publică în R2:
 *   Worker-ul citește arhiva din bucket prin „binding" (env.PACK_BUCKET), fără alte chei — deci
 *   bucket-ul poate (și trebuie) să fie complet PRIVAT. Nimeni nu mai poate ajunge la fișier
 *   decât prin acest Worker.
 *
 * Configurare (vezi wrangler.toml și README.md din acest folder):
 *   - env.GUILD_ID, env.ROLE_ID, env.OBJECT_KEY, env.FILENAME  -> variabile simple (necritice)
 *   - env.PACK_PASSWORD, env.SIGNING_KEY                       -> secrete (wrangler secret put)
 *   - env.PACK_BUCKET                                          -> binding R2 (wrangler.toml)
 */

const DISCORD_API = 'https://discord.com/api/v10';
const TOKEN_TTL_MS = 10 * 60 * 1000;   // 10 minute — suficient pentru un download, prea puțin ca să merite redistribuit

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// base64url, fără Buffer (Node) — doar API-uri web standard, ca să meargă în Workers fără
// "nodejs_compat". bufferul de intrare/ieșire e mereu un Uint8Array/ArrayBuffer.
function b64urlEncode(bufferLike) {
  const bytes = bufferLike instanceof ArrayBuffer ? new Uint8Array(bufferLike) : bufferLike;
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecodeToBytes(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hmacKey(env) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(env.SIGNING_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

// Jeton scurt, semnat de acest Worker (NU e tokenul de Discord): doar { exp } + semnătură HMAC.
async function mintDownloadToken(env) {
  const payload = JSON.stringify({ exp: Date.now() + TOKEN_TTL_MS });
  const payloadB64 = b64urlEncode(new TextEncoder().encode(payload));
  const key = await hmacKey(env);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
  return payloadB64 + '.' + b64urlEncode(sig);
}

async function verifyDownloadToken(token, env) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const [payloadB64, sigB64] = token.split('.');
  try {
    const key = await hmacKey(env);
    const ok = await crypto.subtle.verify('HMAC', key, b64urlDecodeToBytes(sigB64), new TextEncoder().encode(payloadB64));
    if (!ok) return false;
    const { exp } = JSON.parse(new TextDecoder().decode(b64urlDecodeToBytes(payloadB64)));
    return typeof exp === 'number' && Date.now() < exp;
  } catch {
    return false;
  }
}

function bearerToken(request) {
  const h = request.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  if (m) return m[1];
  // rezervă: la unii clienți (observat din launcher), header-ul Authorization nu ajunge la Worker — jetonul
  // poate veni și ca parametru în query ("auth"). Nu e un secret pe termen lung: jetonul de Discord (implicit
  // grant) expune doar profilul/rolul utilizatorului, nu parola arhivei sau accesul la contul Cloudflare.
  try {
    const q = new URL(request.url).searchParams.get('auth');
    if (q) return q;
  } catch {}
  return null;
}

// O cerere cu reîncercare scurtă la 429 (plafonată la 2.5s, ca să nu depășească timpul de execuție
// al unui Worker). Folosită atât pentru apelul cu jetonul utilizatorului, cât și pentru cel cu botul.
async function fetchWithRetry429(url, headers) {
  let r;
  for (let i = 0; i < 2; i++) {
    r = await fetch(url, { headers });
    if (r.status !== 429) break;
    if (i === 0) {
      let wait = 1000;
      try { const j = await r.clone().json(); wait = Math.min(2500, Math.max(300, (Number(j.retry_after) || 1) * 1000)); } catch {}
      await new Promise(res => setTimeout(res, wait));
    }
  }
  return r;
}

// Pasul 1: cine e utilizatorul? Apel SIMPLU (doar profil, scope "identify"), cu jetonul lui de Discord —
// doar ca să-i aflăm ID-ul, nu ca să-i verificăm rolul (vezi mai jos de ce).
async function getDiscordUserId(token) {
  const r = await fetchWithRetry429(`${DISCORD_API}/users/@me`, { authorization: 'Bearer ' + token });
  if (r.status === 429) { const e = new Error('rate_limited'); e.code = 'rate_limited'; throw e; }
  if (r.status === 401) return null;
  if (!r.ok) throw new Error('discord_http_' + r.status);
  const u = await r.json();
  return (u && u.id) ? String(u.id) : null;
}

// Pasul 2: are rolul? Verificat cu jetonul BOTULUI (env.DISCORD_BOT_TOKEN), nu cu cel al utilizatorului —
// Discord pare să trateze diferit (mai strict / nesigur) apelurile cu jeton de utilizator venite de pe
// IP-uri de tip „server/cloud” (cum sunt cele ale Cloudflare Workers) față de cele venite direct din
// launcher, de pe calculatorul utilizatorului. Apelul cu jeton de bot nu are limitarea asta.
async function hasRequiredRole(userId, env) {
  if (!env.DISCORD_BOT_TOKEN) throw new Error('bot_token_missing');
  const r = await fetchWithRetry429(`${DISCORD_API}/guilds/${env.GUILD_ID}/members/${userId}`, { authorization: 'Bot ' + env.DISCORD_BOT_TOKEN });
  if (r.status === 429) { const e = new Error('rate_limited'); e.code = 'rate_limited'; throw e; }
  if (r.status === 401 || r.status === 403 || r.status === 404) return false;
  if (!r.ok) throw new Error('discord_http_' + r.status);
  const member = await r.json();
  const roles = Array.isArray(member && member.roles) ? member.roles : [];
  return roles.includes(String(env.ROLE_ID));
}

async function handlePackInfo(request, env) {
  const token = bearerToken(request);
  if (!token) return json({ ok: false, error: 'no_token' }, 401);
  let userId, ok;
  try {
    userId = await getDiscordUserId(token);
  } catch (e) {
    if (e && e.code === 'rate_limited') return json({ ok: false, error: 'rate_limited' }, 429);
    return json({ ok: false, error: 'discord_unreachable' }, 503);
  }
  if (!userId) return json({ ok: false, error: 'no_token' }, 401);
  try {
    ok = await hasRequiredRole(userId, env);
  } catch (e) {
    if (e && e.code === 'rate_limited') return json({ ok: false, error: 'rate_limited' }, 429);
    // Discord indisponibil/eroare temporară: NU dăm acces implicit — mai bine un refuz temporar
    // decât o gaură de securitate dacă apelul la Discord cade silențios.
    return json({ ok: false, error: 'discord_unreachable' }, 503);
  }
  if (!ok) return json({ ok: false, error: 'no_role' }, 403);

  const url = new URL(request.url);
  const dl = await mintDownloadToken(env);
  const downloadUrl = `${url.origin}/pack?t=${encodeURIComponent(dl)}`;
  return json({ ok: true, password: env.PACK_PASSWORD || '', downloadUrl });
}

async function handlePack(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get('t');
  const ok = await verifyDownloadToken(token, env);
  if (!ok) return json({ ok: false, error: 'bad_or_expired_token' }, 403);

  const obj = await env.PACK_BUCKET.get(env.OBJECT_KEY);
  if (!obj) return json({ ok: false, error: 'not_found' }, 404);

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('content-length', String(obj.size));
  headers.set('content-disposition', `attachment; filename="${(env.FILENAME || 'RMS_GRAPHICS.rar').replace(/"/g, '')}"`);
  headers.set('cache-control', 'no-store');
  // HEAD (folosit de probeRemoteSize ca să afle mărimea arhivei, fără să o descarce) primește
  // aceleași headere, dar fără corp — exact ca un server obișnuit de fișiere.
  return new Response(request.method === 'HEAD' ? null : obj.body, { headers });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/pack-info') {
        if (request.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405);
        return await handlePackInfo(request, env);
      }
      if (url.pathname === '/pack') {
        if (request.method !== 'GET' && request.method !== 'HEAD') return json({ ok: false, error: 'method_not_allowed' }, 405);
        return await handlePack(request, env);
      }
      return json({ ok: false, error: 'not_found' }, 404);
    } catch (e) {
      return json({ ok: false, error: 'internal_error', detail: String((e && e.message) || e) }, 500);
    }
  },
};