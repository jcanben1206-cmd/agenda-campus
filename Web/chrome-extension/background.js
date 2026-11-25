importScripts('vault.js', 'agenda-origin.js');

const calendarUrl = 'https://educacionadistancia.juntadeandalucia.es/centros/sevilla/calendar/view.php?view=month#agenda-campus-background';
const syncAlarm = 'moodle-sync';
const cleanupAlarm = 'moodle-sync-cleanup';
const jobKey = 'moodle-background-tab';
let opening = false;

async function finish(tabId, timedOut = false) {
  const job = (await chrome.storage.session.get(jobKey))[jobKey];
  if (job?.tabId !== tabId) return;
  await chrome.storage.session.remove(jobKey);
  await chrome.alarms.clear(cleanupAlarm);
  if (timedOut) {
    await chrome.storage.local.set({ 'moodle-refresh': { status: 'unavailable', checkedAt: Date.now() } });
  }
  try { await chrome.tabs.remove(tabId); } catch {}
}

async function startSync() {
  if (opening) return;
  opening = true;
  try {
    const job = (await chrome.storage.session.get(jobKey))[jobKey];
    if (job) return;

    const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    try {
      await chrome.storage.session.set({ [jobKey]: { tabId: tab.id } });
      await chrome.alarms.create(cleanupAlarm, { delayInMinutes: 2.5 });
      await chrome.tabs.update(tab.id, { url: calendarUrl });
    } catch (error) {
      await finish(tab.id, true);
      try { await chrome.tabs.remove(tab.id); } catch {}
      throw error;
    }
  } finally {
    opening = false;
  }
}

function report(error) {
  console.warn('Agenda Campus: no se pudo programar la actualización.', error);
}

chrome.runtime.onInstalled.addListener(() => { chrome.alarms.clear(syncAlarm).catch(report); });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === cleanupAlarm) {
    chrome.storage.session.get(jobKey).then(values => {
      const job = values[jobKey];
      if (job) return finish(job.tabId, true);
    }).catch(report);
  }
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.url === chrome.runtime.getURL('credentials.html')) {
    if (message?.type === 'save-credentials' &&
        typeof message.username === 'string' && message.username.length > 0 && message.username.length <= 254 &&
        typeof message.password === 'string' && message.password.length > 0 && message.password.length <= 512) {
      saveCredentials(message.username, message.password).then(() => {
        respond(true);
        startSync().catch(report);
      }, () => respond(false));
      return true;
    }
    if (message?.type === 'delete-credentials') {
      chrome.storage.local.remove(vaultRecord).then(async () => {
        const job = (await chrome.storage.session.get(jobKey))[jobKey];
        if (job) await finish(job.tabId);
      }).then(() => respond(true), () => respond(false));
      return true;
    }
  }
  if (['open-credentials', 'sync-now'].includes(message?.type) && sender.frameId === 0) {
    chrome.storage.local.get(hostedAgendaKey).then(async values => {
      if (!isAgendaPage(sender.url, values[hostedAgendaKey])) return false;
      if (message.type === 'sync-now') await startSync();
      else await chrome.runtime.openOptionsPage();
      return true;
    }).then(respond, () => respond(false));
    return true;
  }
  if (message?.type === 'agenda-campus:background-finished' &&
      sender.url === calendarUrl && Number.isInteger(sender.tab?.id)) {
    finish(sender.tab.id).catch(report);
  }
  const routes = {
    'moodle-login': /^https:\/\/educacionadistancia\.juntadeandalucia\.es\/centros\/sevilla\/login\/index\.php(?:[?#]|$)/,
    'cas-watch': /^https:\/\/edea\.juntadeandalucia\.es\/cas\/login(?:[?#]|$)/,
    'cas-submit': /^https:\/\/edea\.juntadeandalucia\.es\/cas\/login(?:[?#]|$)/,
    'return-calendar': /^https:\/\/educacionadistancia\.juntadeandalucia\.es\/centros\/sevilla\/(?:my\/(?:index\.php)?|index\.php)?(?:[?#]|$)/,
    'renew': /^https:\/\/educacionadistancia\.juntadeandalucia\.es\/centros\/sevilla\/calendar\/view\.php(?:[?#]|$)/
  };
  if (!Object.hasOwn(routes, message?.type) || !routes[message.type].test(sender.url || '') ||
      !Number.isInteger(sender.tab?.id) || sender.frameId !== 0) return;
  if (message.type === 'cas-watch' || message.type === 'cas-submit') {
    try {
      const casUrl = new URL(sender.url);
      if (casUrl.searchParams.get('gateway') === 'true') return;
      const service = new URL(casUrl.searchParams.get('service'));
      if (service.origin !== 'https://educacionadistancia.juntadeandalucia.es' ||
          service.pathname !== '/centros/sevilla/login/index.php' || service.searchParams.get('authCAS') !== 'CAS') return;
    } catch {
      return;
    }
  }
  chrome.storage.session.get(jobKey).then(async values => {
    const job = values[jobKey];
    if (job?.tabId !== sender.tab.id || job[message.type]) return false;
    if (message.type === 'cas-submit') {
      const key = 'moodle-autologin-tried';
      if (!job['cas-watch'] || (await chrome.storage.local.get(key))[key]) return false;
      const credentials = await loadCredentials();
      await chrome.storage.local.set({ [key]: true });
      await chrome.storage.session.set({ [jobKey]: { ...job, 'cas-submit': true } });
      return { credentials };
    }
    await chrome.storage.session.set({ [jobKey]: { ...job, [message.type]: true } });
    if (message.type === 'cas-watch') {
      return { saved: Boolean((await chrome.storage.local.get(vaultRecord))[vaultRecord]) };
    }
    return true;
  }).then(respond, () => respond(false));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => {
  finish(tabId).catch(report);
});
chrome.alarms.clear(syncAlarm).catch(report);
