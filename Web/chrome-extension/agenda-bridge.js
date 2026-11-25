(async () => {
  const values = await chrome.storage.local.get(hostedAgendaKey);
  if (!isAgendaPage(location.href, values[hostedAgendaKey])) return;
  let enabled = true;

  let revision = 0;
  async function publish() {
    const requested = ++revision;
    try {
      const values = await chrome.storage.local.get(null);
      if (!enabled || requested !== revision) return;
      const months = Object.entries(values)
        .filter(([key]) => /^moodle-month:\d{4}-\d{2}$/.test(key))
        .map(([, snapshot]) => snapshot);
      const assignments = Object.fromEntries(Object.entries(values)
        .filter(([key]) => /^moodle-assignment:\d{1,18}$/.test(key))
        .map(([key, state]) => [key.slice('moodle-assignment:'.length), state]));
      window.postMessage({ type: 'agenda-campus:moodle-snapshots', months, assignments, refresh: values['moodle-refresh'] }, location.origin);
    } catch (error) {
      console.warn('Agenda Campus: no se pudo leer el calendario de la extensión.', error);
    }
  }
  window.addEventListener('message', event => {
    if (!enabled || event.source !== window || event.origin !== location.origin) return;
    if (event.data?.type === 'agenda-campus:request-moodle-snapshots') publish();
    if (event.data?.type === 'agenda-campus:open-credentials') {
      chrome.runtime.sendMessage({ type: 'open-credentials' }).catch(() => {});
    }
    if (event.data?.type === 'agenda-campus:sync-now') {
      chrome.runtime.sendMessage({ type: 'sync-now' }).then(started => {
        if (!started) window.postMessage({ type: 'agenda-campus:sync-error' }, location.origin);
      }).catch(() => window.postMessage({ type: 'agenda-campus:sync-error' }, location.origin));
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[hostedAgendaKey]) {
      enabled = isAgendaPage(location.href, changes[hostedAgendaKey].newValue);
      if (!enabled) return;
    }
    if (area === 'local' && Object.keys(changes).some(key => /^(moodle-refresh$|moodle-month:|moodle-assignment:)/.test(key))) publish();
  });
  publish();
})().catch(() => {});
