import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { MoodleSession } from './moodle.mjs';

const { AGENDA_ORIGIN, AGENDA_ACCESS_KEY, MOODLE_USERNAME, MOODLE_PASSWORD } = process.env;
if (!AGENDA_ORIGIN || !AGENDA_ACCESS_KEY || AGENDA_ACCESS_KEY.length < 24 || !MOODLE_USERNAME || !MOODLE_PASSWORD) {
  throw new Error('Faltan los ajustes privados del servidor.');
}

const hash = value => createHash('sha256').update(value).digest();
const digest = hash('Bearer ' + AGENDA_ACCESS_KEY);
const moodle = new MoodleSession(MOODLE_USERNAME, MOODLE_PASSWORD);
let cache = { months: [], assignments: {} };
let lastCheck = 0;
let synced = false;
let running;

function payload() {
  return { ...cache, refresh: synced ? { status: 'ok', checkedAt: lastCheck } : null };
}

function sync(automatic) {
  if (running) return running;
  const freshness = automatic ? 10 * 60 * 1000 : 15000;
  if (synced && Date.now() - lastCheck < freshness) return Promise.resolve(payload());
  running = moodle.snapshot(cache.assignments).then(next => {
    const previous = new Map(cache.months.map(month => [month.month, month]));
    const checkedAt = Date.now();
    const months = next.months.map(month => {
      const existing = previous.get(month.month);
      return JSON.stringify(existing?.events) === JSON.stringify(month.events)
        ? existing : { ...month, updatedAt: checkedAt };
    });
    cache = { months, assignments: next.assignments };
    lastCheck = checkedAt;
    synced = true;
    return payload();
  }).finally(() => { running = undefined; });
  return running;
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
  if (!['/api/calendar', '/api/sync', '/api/auto-sync'].includes(url)) {
    return send(response, 404, { error: 'Ruta desconocida.' });
  }
  if (headers.origin !== AGENDA_ORIGIN) return send(response, 403, { error: 'Origen no autorizado.' });
  response.setHeader('Access-Control-Allow-Origin', AGENDA_ORIGIN);
  response.setHeader('Vary', 'Origin');
  if (method === 'OPTIONS') {
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Authorization');
    return response.writeHead(204).end();
  }
  if (!timingSafeEqual(hash(headers.authorization || ''), digest)) {
    return send(response, 401, { error: 'La clave del servidor no es correcta.' });
  }
  if (method === 'GET' && url === '/api/calendar') return send(response, 200, payload());
  if (method !== 'POST' || url === '/api/calendar') return send(response, 405, { error: 'Método no permitido.' });
  try {
    return send(response, 200, await sync(url === '/api/auto-sync'));
  } catch {
    return send(response, 502, { error: 'El servidor no pudo consultar Moodle. Se conservan los datos de la última lectura.' });
  }
}).listen(Number(process.env.PORT || 10000), '0.0.0.0');
