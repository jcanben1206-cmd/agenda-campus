import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { MoodleLoginRequired, MoodleSession } from './moodle.mjs';
import { isScheduledRequest, moodleBackground } from './background.mjs';

const local = process.argv.includes('--local');
const localOrigin = 'http://127.0.0.1:8772';
const { AGENDA_ACCESS_KEY, MOODLE_USERNAME, MOODLE_PASSWORD } = process.env;
const agendaOrigin = local ? localOrigin : process.env.AGENDA_ORIGIN;
if (!local && (!agendaOrigin || !AGENDA_ACCESS_KEY || AGENDA_ACCESS_KEY.length < 24 || !MOODLE_USERNAME || !MOODLE_PASSWORD)) {
  throw new Error('Faltan los ajustes privados del servidor.');
}

const hash = value => createHash('sha256').update(value).digest();
const digest = local ? null : hash('Bearer ' + AGENDA_ACCESS_KEY);
const owner = local ? null : calendarSession(new MoodleSession(MOODLE_USERNAME, MOODLE_PASSWORD, fetch, true));
const background = local ? null : moodleBackground(AGENDA_ACCESS_KEY, MOODLE_USERNAME.trim().toLowerCase());
const accounts = new Map();
const loginAttempts = new Map();
const sessionLifetime = 12 * 60 * 60 * 1000;
const loginWindow = 15 * 60 * 1000;
let activeLogins = 0;

function calendarSession(moodle) {
  return { moodle, cache: { months: [], assignments: {}, taskDetails: {} }, lastCheck: 0, running: undefined };
}

function payload(session) {
  return { ...session.cache, refresh: session.lastCheck ? { status: 'ok', checkedAt: session.lastCheck } : null };
}

function sync(session, automatic) {
  if (session.running) return session.running;
  const freshness = automatic ? 10 * 60 * 1000 : 15000;
  if (session.lastCheck && Date.now() - session.lastCheck < freshness) return Promise.resolve(payload(session));
  session.running = session.moodle.snapshot(session.cache.assignments, session.cache.taskDetails).then(next => {
    const previous = new Map(session.cache.months.map(month => [month.month, month]));
    const checkedAt = Date.now();
    const months = next.months.map(month => {
      const existing = previous.get(month.month);
      return JSON.stringify(existing?.events) === JSON.stringify(month.events)
        ? existing : { ...month, updatedAt: checkedAt };
    });
    const olderIds = new Set(months.filter(month => !next.months.some(fresh => fresh.month === month.month))
      .flatMap(month => month.events.map(event => event.assignmentId).filter(Boolean)));
    const retain = (saved, latest) => ({ ...Object.fromEntries(Object.entries(saved).filter(([id]) => olderIds.has(id))), ...latest });
    session.cache = { months, assignments: retain(session.cache.assignments, next.assignments),
      taskDetails: retain(session.cache.taskDetails, next.taskDetails) };
    session.lastCheck = checkedAt;
    return payload(session);
  }).finally(() => { session.running = undefined; });
  return session.running;
}

function prune(now) {
  for (const [key, session] of accounts) if (session.expires <= now) accounts.delete(key);
  for (const [key, attempt] of loginAttempts) if (attempt.expires <= now) loginAttempts.delete(key);
}

function countAttempt(key, limit, now) {
  const attempt = loginAttempts.get(key) || { count: 0, expires: now + loginWindow };
  loginAttempts.set(key, attempt);
  return ++attempt.count <= limit;
}

async function readJson(request, limit) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') return null;
  if (Number(request.headers['content-length']) > limit) return null;
  let body = '';
  request.setEncoding('utf8');
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > limit) return null;
  }
  try { return JSON.parse(body); } catch { return null; }
}

async function credentials(request) {
  try {
    const { username, password, remember } = await readJson(request, 4096);
    if (typeof username !== 'string' || typeof password !== 'string' ||
        !username.trim() || username.length > 254 || !password || password.length > 512) return null;
    return { username: username.trim(), password, remember: remember === true };
  } catch {
    return null;
  }
}

async function login(request, response) {
  const now = Date.now();
  prune(now);
  const client = request.headers['x-forwarded-for']?.split(',').at(-1)?.trim() || request.socket.remoteAddress;
  if (activeLogins >= 3 || accounts.size >= 30 || loginAttempts.size >= 1000 ||
      !countAttempt('client:' + client, 16, now)) {
    return send(response, 429, { error: 'Hay demasiados accesos en este momento. Vuelve a intentarlo más tarde.' });
  }
  const entry = await credentials(request);
  if (!entry) return send(response, 400, { error: 'Introduce tu usuario y contraseña de Moodle.' });
  const accountId = local ? hash('agenda-local:' + entry.username.toLowerCase()).toString('hex')
    : createHmac('sha256', AGENDA_ACCESS_KEY).update(entry.username.toLowerCase()).digest('hex');
  if (activeLogins >= 3 || accounts.size >= 30 || !countAttempt('account:' + accountId, 5, now)) {
    return send(response, 429, { error: 'Hay demasiados accesos en este momento. Vuelve a intentarlo más tarde.' });
  }
  const session = calendarSession(new MoodleSession(entry.username, entry.password, fetch, true));
  activeLogins++;
  try {
    await session.moodle.authenticate();
    const token = randomBytes(32).toString('base64url');
    session.backgroundOwner = !local && entry.username.toLowerCase() === MOODLE_USERNAME.trim().toLowerCase();
    session.expires = Date.now() + (entry.remember ? 30 * 86400000 : sessionLifetime);
    accounts.set(hash('Bearer ' + token).toString('hex'), session);
    return send(response, 200, { accountId, token, expires: session.expires, backgroundOwner: session.backgroundOwner,
      calendar: session.backgroundOwner && owner.lastCheck ? payload(owner) : undefined });
  } catch {
    return send(response, 401, { error: 'Moodle no confirmó el acceso. Revisa tus datos o prueba más tarde.' });
  } finally {
    session.moodle.forgetCredentials();
    activeLogins--;
  }
}

function send(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(body));
}

createServer(async (request, response) => {
  const { method, url, headers } = request;
  if (local) {
    if (headers.host !== '127.0.0.1:8772') return send(response, 403, { error: 'Dirección local incorrecta.' });
    if (url.startsWith('/api/background/')) return send(response, 404, { error: 'Función no disponible en local.' });
    const files = new Map([['/', ['index.html', 'text/html; charset=utf-8']],
      ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']]]);
    if (method === 'GET' && files.has(url)) {
      const [name, type] = files.get(url);
      try {
        const content = await readFile(new URL('../Web/dist/' + name, import.meta.url));
        response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Security-Policy': "form-action 'self'; frame-ancestors 'none'" });
        return response.end(content);
      } catch { return send(response, 500, { error: 'No se pudo abrir Agenda Campus.' }); }
    }
  }
  if (method === 'GET' && url === '/health') {
    return send(response, 200, { ok: true, revision: process.env.RENDER_GIT_COMMIT || null, calendarApi: true });
  }
  if (method === 'POST' && url === '/api/background/sync') {
    if (!await isScheduledRequest(headers.authorization)) return send(response, 401, { error: 'Comprobación no autorizada.' });
    try {
      const input = await readJson(request, 4 * 1024 * 1024);
      if (!input || !(input.state === null || typeof input.state === 'string')) {
        return send(response, 400, { error: 'Estado de comprobación inválido.' });
      }
      const saved = background.restore(input.state);
      if (saved?.refresh?.checkedAt > owner.lastCheck && !owner.running) {
        owner.cache = { months: saved.months, assignments: saved.assignments, taskDetails: saved.taskDetails };
        owner.lastCheck = saved.refresh.checkedAt;
      }
      return send(response, 200, await background.check(await sync(owner, false)));
    } catch {
      return send(response, 502, { error: 'No se pudo comprobar Moodle.' });
    }
  }
  if (!['/api/calendar', '/api/sync', '/api/auto-sync', '/api/login', '/api/logout',
    '/api/background/key', '/api/background/subscribe'].includes(url)) {
    return send(response, 404, { error: 'Ruta desconocida.' });
  }
  if (headers.origin !== agendaOrigin && !(local && method === 'GET' && !headers.origin)) return send(response, 403, { error: 'Origen no autorizado.' });
  response.setHeader('Access-Control-Allow-Origin', agendaOrigin);
  response.setHeader('Vary', 'Origin');
  if (method === 'OPTIONS') {
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    return response.writeHead(204).end();
  }
  if (url === '/api/login') {
    if (method !== 'POST') return send(response, 405, { error: 'Método no permitido.' });
    try { return await login(request, response); }
    catch { if (!response.destroyed) return send(response, 400, { error: 'No se pudo leer la solicitud.' }); }
    return;
  }
  const supplied = hash(headers.authorization || '');
  const accountKey = supplied.toString('hex');
  const isOwner = !local && timingSafeEqual(supplied, digest);
  prune(Date.now());
  const account = accounts.get(accountKey);
  if (url === '/api/background/key' || url === '/api/background/subscribe') {
    if (!isOwner && !account?.backgroundOwner) return send(response, 401, { error: 'Usa la conexión del propietario para activar los avisos.' });
    if (url.endsWith('/key') && method === 'GET') return send(response, 200, { key: background.publicKey });
    if (url.endsWith('/subscribe') && method === 'POST') {
      try {
        if (background.subscribe(await readJson(request, 4096))) return send(response, 200, { ok: true });
      } catch {}
      return send(response, 400, { error: 'Suscripción push no admitida.' });
    }
    return send(response, 405, { error: 'Método no permitido.' });
  }
  const session = isOwner || account?.backgroundOwner ? owner : account;
  if (!session) return send(response, 401, { error: 'La sesión ha caducado o la clave no es correcta.' });
  if (url === '/api/logout') {
    if (method !== 'POST' || isOwner) return send(response, 405, { error: 'Método no permitido.' });
    accounts.delete(accountKey);
    return send(response, 200, { ok: true });
  }
  if (method === 'GET' && url === '/api/calendar') return send(response, 200, payload(session));
  if (method !== 'POST' || url === '/api/calendar') return send(response, 405, { error: 'Método no permitido.' });
  try {
    return send(response, 200, await sync(session, url === '/api/auto-sync'));
  } catch (error) {
    if (!isOwner && error instanceof MoodleLoginRequired) {
      accounts.delete(accountKey);
      return send(response, 401, { error: 'La sesión de Moodle ha caducado.' });
    }
    return send(response, 502, { error: 'El servidor no pudo consultar Moodle. Se conservan los datos de la última lectura.' });
  }
}).listen(local ? 8772 : Number(process.env.PORT || 10000), local ? '127.0.0.1' : '0.0.0.0');
