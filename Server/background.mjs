import { createCipheriv, createDecipheriv, createECDH, createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import webpush from 'web-push';

const issuer = 'https://token.actions.githubusercontent.com';
const audience = 'agenda-campus-moodle-background';
const repository = 'jcanben1206-cmd/agenda-campus';
const approvedPushHosts = new Set(['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com']);
let githubKeys;
let githubKeysUntil = 0;

export async function isScheduledRequest(authorization) {
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false;
  try {
    const [header, payload, signature, extra] = authorization.slice(7).split('.');
    if (extra || !signature) return false;
    const decode = part => JSON.parse(Buffer.from(part, 'base64url'));
    const { alg, kid } = decode(header);
    const { iss, aud, exp, nbf, repository: repo, workflow_ref: workflow, event_name: event } = decode(payload);
    const now = Math.floor(Date.now() / 1000);
    if (alg !== 'RS256' || typeof kid !== 'string' || iss !== issuer || aud !== audience ||
        !Number.isFinite(exp) || exp <= now || !Number.isFinite(nbf) || nbf > now + 15 ||
        repo !== repository || workflow !== repository + '/.github/workflows/moodle-check.yml@refs/heads/main' ||
        !['schedule', 'workflow_dispatch', 'push'].includes(event)) return false;
    if (Date.now() >= githubKeysUntil || !githubKeys?.has(kid)) {
      const response = await fetch(issuer + '/.well-known/jwks', { signal: AbortSignal.timeout(8000), redirect: 'error' });
      if (!response.ok) return false;
      githubKeys = new Map((await response.json()).keys.map(key => [key.kid, key]));
      githubKeysUntil = Date.now() + 60 * 60 * 1000;
    }
    const jwk = githubKeys.get(kid);
    return Boolean(jwk && verify('RSA-SHA256', Buffer.from(header + '.' + payload),
      createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(signature, 'base64url')));
  } catch {
    return false;
  }
}

function normalizeSubscription(value) {
  try {
    const { endpoint, keys } = value;
    const url = new URL(endpoint);
    if (typeof endpoint !== 'string' || endpoint.length > 1500 || url.protocol !== 'https:' ||
        url.port || url.username || url.password || url.hash ||
        !(approvedPushHosts.has(url.hostname) || url.hostname.endsWith('.push.apple.com')) ||
        !/^[A-Za-z0-9_-]{87}$/.test(keys?.p256dh) || !/^[A-Za-z0-9_-]{22}$/.test(keys?.auth)) return null;
    return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
  } catch {
    return null;
  }
}

export function moodleBackground(secret, username) {
  const derive = label => createHash('sha256').update(label + '\0' + secret).digest();
  const stateKey = derive('agenda-campus-background-state');
  const curve = createECDH('prime256v1');
  let key = derive('agenda-campus-web-push');
  for (;;) {
    try { curve.setPrivateKey(key); break; }
    catch { key = createHash('sha256').update(key).digest(); }
  }
  const publicKey = curve.getPublicKey().toString('base64url');
  const subscriptions = new Map();
  let previous;

  function subscribe(value) {
    const subscription = normalizeSubscription(value);
    if (!subscription || (subscriptions.size >= 12 && !subscriptions.has(subscription.endpoint))) return false;
    subscriptions.set(subscription.endpoint, subscription);
    return true;
  }

  function restore(sealed) {
    if (typeof sealed !== 'string' || sealed.length > 4 * 1024 * 1024) return;
    try {
      const [iv, tag, bytes] = sealed.split('.').map(part => Buffer.from(part, 'base64url'));
      const decipher = createDecipheriv('aes-256-gcm', stateKey, iv);
      decipher.setAuthTag(tag);
      const stored = JSON.parse(Buffer.concat([decipher.update(bytes), decipher.final()]));
      if (stored.username && stored.username !== username) return;
      if (!previous) previous = stored.previous;
      for (const subscription of stored.subscriptions) {
        if (!subscriptions.has(subscription.endpoint)) subscribe(subscription);
      }
      return stored.username === username ? stored.calendar : undefined;
    } catch {}
  }

  function seal(calendar) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', stateKey, iv);
    const bytes = Buffer.concat([cipher.update(JSON.stringify({
      username, previous, calendar, subscriptions: [...subscriptions.values()]
    })), cipher.final()]);
    return [iv, cipher.getAuthTag(), bytes].map(part => part.toString('base64url')).join('.');
  }

  async function check(calendar) {
    const next = {};
    for (const month of calendar.months) {
      for (const event of month.events) {
        if (event.assignmentId) {
          const id = event.assignmentId;
          next[id] = [event.day, calendar.assignments[id] || previous?.[id]?.[1]];
        }
      }
    }
    const changed = previous ? Object.entries(next).filter(([id, [day, state]]) => {
      const before = previous[id];
      return !before || before[0] !== day || (before[1] && state && before[1] !== state);
    }).length : 0;
    previous = next;
    if (changed) {
      const payload = JSON.stringify({ body: changed === 1 ? 'Hay un cambio en tus tareas de Moodle.' : 'Hay ' + changed + ' cambios en tus tareas de Moodle.' });
      await Promise.all([...subscriptions.values()].map(async subscription => {
        try {
          await webpush.sendNotification(subscription, payload, {
            TTL: 900, timeout: 8000,
            vapidDetails: { subject: 'https://jcanben1206-cmd.github.io/agenda-campus/', publicKey, privateKey: key.toString('base64url') }
          });
        } catch (error) {
          if ([404, 410].includes(error.statusCode)) subscriptions.delete(subscription.endpoint);
        }
      }));
    }
    return { changed, state: seal(calendar) };
  }

  return { publicKey, subscribe, restore, check };
}
