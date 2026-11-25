import { createServer } from 'node:http';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { MoodleLoginRequired, MoodleSession } from './moodle.mjs';

const { AGENDA_ORIGIN, AGENDA_ACCESS_KEY, MOODLE_USERNAME, MOODLE_PASSWORD } = process.env;
if (!AGENDA_ORIGIN || !AGENDA_ACCESS_KEY || AGENDA_ACCESS_KEY.length < 24 || !MOODLE_USERNAME || !MOODLE_PASSWORD) {
  throw new Error('Faltan los ajustes privados del servidor.');
}

const hash = value => createHash('sha256').update(value).digest();
const digest = hash('Bearer ' + AGENDA_ACCESS_KEY);
const owner = calendarSession(new MoodleSession(MOODLE_USERNAME, MOODLE_PASSWORD));
const accounts = new Map();
const loginAttempts = new Map();
const sessionLifetime = 12 * 60 * 60 * 1000;
const loginWindow = 15 * 60 * 1000;
let activeLogins = 0;

function calendarSession(moodle) {
  return { moodle, cache: { months: [], assignments: {} }, lastCheck: 0, running: undefined };
}

function payload(session) {
  return { ...session.cache, refresh: session.lastCheck ? { status: 'ok', checkedAt: session.lastCheck } : null };
}

function sync(session, automatic) {
  if (session.running) return session.running;
  const freshness = automatic ? 10 * 60 * 1000 : 15000;
  if (session.lastCheck && Date.now() - session.lastCheck < freshness) return Promise.resolve(payload(session));
  session.running = session.moodle.snapshot(session.cache.assignments).then(next => {
    const previous = new Map(session.cache.months.map(month => [month.month, month]));
    const checkedAt = Date.now();
    const months = next.months.map(month => {
      const existing = previous.get(month.month);
      return JSON.stringify(existing?.events) === JSON.stringify(month.events)
        ? existing : { ...month, updatedAt: checkedAt };
    });
    session.cache = { months, assignments: next.assignments };
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

async function credentials(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') return null;
  if (Number(request.headers['content-length']) > 4096) return null;
  let body = '';
  request.setEncoding('utf8');
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 4096) return null;
  }
  try {
    const { username, password } = JSON.parse(body);
    if (typeof username !== 'string' || typeof password !== 'string' ||
        !username.trim() || username.length > 254 || !password || password.length > 512) return null;
    return { username: username.trim(), password };
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
  const accountId = createHmac('sha256', AGENDA_ACCESS_KEY).update(entry.username.toLowerCase()).digest('hex');
  if (activeLogins >= 3 || accounts.size >= 30 || !countAttempt('account:' + accountId, 5, now)) {
    return send(response, 429, { error: 'Hay demasiados accesos en este momento. Vuelve a intentarlo más tarde.' });
  }
  const session = calendarSession(new MoodleSession(entry.username, entry.password));
  activeLogins++;
  try {
    const calendar = await sync(session, false);
    const token = randomBytes(32).toString('base64url');
    session.expires = Date.now() + sessionLifetime;
    accounts.set(hash('Bearer ' + token).toString('hex'), session);
    return send(response, 200, { accountId, token, expires: session.expires, calendar });
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
  if (method === 'GET' && url === '/health') {
    return send(response, 200, { ok: true, revision: process.env.RENDER_GIT_COMMIT || null });
  }
  if (!['/api/calendar', '/api/sync', '/api/auto-sync', '/api/login', '/api/logout'].includes(url)) {
    return send(response, 404, { error: 'Ruta desconocida.' });
  }
  if (headers.origin !== AGENDA_ORIGIN) return send(response, 403, { error: 'Origen no autorizado.' });
  response.setHeader('Access-Control-Allow-Origin', AGENDA_ORIGIN);
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
  const isOwner = timingSafeEqual(supplied, digest);
  prune(Date.now());
  const session = isOwner ? owner : accounts.get(accountKey);
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
}).listen(Number(process.env.PORT || 10000), '0.0.0.0');
