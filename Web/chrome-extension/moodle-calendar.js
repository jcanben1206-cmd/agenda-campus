(() => {
  if (location.pathname !== '/centros/sevilla/calendar/view.php') return;
  const background = location.hash === '#agenda-campus-background';

  let timer;
  let lastSaved;
  let writing = false;
  const assignmentPath = '/centros/sevilla/mod/assign/view.php';
  const reconnectKey = 'agenda-campus-moodle-reconnect';

  function assignmentId(link) {
    try {
      const eventType = link.closest('li')?.dataset.eventEventtype;
      if (eventType && eventType !== 'due') return null;
      const url = new URL(link.getAttribute('href'), location.href);
      const id = url.searchParams.get('id');
      return url.origin === location.origin && url.pathname === assignmentPath && /^\d{1,18}$/.test(id) ? id : null;
    } catch {
      return null;
    }
  }

  function readCalendar(page) {
    const table = page.querySelector('#region-main table[id^="month-detailed-"]');
    const wrapper = table?.closest('.calendarwrapper[data-year][data-month]');
    if (!wrapper || Number(wrapper.dataset.categoryid) > 0 ||
        Number(wrapper.dataset.courseid) > 1 || wrapper.querySelector('[aria-busy="true"]')) return;

    const year = Number(wrapper.dataset.year);
    const month = Number(wrapper.dataset.month);
    if (!Number.isInteger(year) || year < 1900 || year > 9999 ||
        !Number.isInteger(month) || month < 1 || month > 12) return;
    const prefix = year + '-' + String(month).padStart(2, '0');
    const days = table.querySelectorAll('td[data-region="day"][data-day]');
    const daysInMonth = new Date(year, month, 0).getDate();
    if (days.length !== daysInMonth) return;

    const events = new Map();
    for (const cell of days) {
      const day = Number(cell.dataset.day);
      if (!Number.isInteger(day) || day < 1 || day > daysInMonth) return;
      for (const link of cell.querySelectorAll('li[data-region="event-item"] a[data-action="view-event"][data-event-id]')) {
        const id = link.dataset.eventId;
        const title = (link.querySelector('.eventname')?.textContent || link.getAttribute('title') || '').trim();
        if (!/^\d{1,18}$/.test(id) || !title) continue;
        events.set(id, {
          title: title.slice(0, 500), day: prefix + '-' + String(day).padStart(2, '0'), assignmentId: assignmentId(link)
        });
      }
    }

    return { month: prefix, events: [...events.values()] };
  }

  async function syncCalendar() {
    if (writing) return;
    const query = new URLSearchParams(location.search);
    const course = query.get('course');
    if ((course && course !== '1') || Number(query.get('category')) > 0) return;
    const snapshot = readCalendar(document);
    if (!snapshot) return;
    const serialized = JSON.stringify(snapshot);
    if (serialized === lastSaved) return;
    writing = true;
    try {
      await saveChanged({ ['moodle-month:' + snapshot.month]: { ...snapshot, updatedAt: Date.now() } });
      lastSaved = serialized;
    } catch (error) {
      console.warn('Agenda Campus: no se pudo guardar el calendario.', error);
    } finally {
      writing = false;
      if (lastSaved === serialized) schedule();
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(syncCalendar, 500);
  }

  let refreshing = false;

  async function saveChanged(values) {
    const previous = await chrome.storage.local.get(Object.keys(values));
    const changed = Object.fromEntries(Object.entries(values).filter(([key, next]) => {
      const before = previous[key];
      if (key.startsWith('moodle-month:')) return JSON.stringify(before?.events) !== JSON.stringify(next.events);
      return before !== next;
    }));
    if (Object.keys(changed).length) await chrome.storage.local.set(changed);
  }

  function readSubmission(page) {
    const table = page.querySelector('.submissionstatustable');
    if (!table) return 'unknown';
    if (table.querySelector('.submissionstatussubmitted')) return 'submitted';
    if (table.querySelector('.submissionstatusdraft')) return 'draft';
    if (table.querySelector('.submissionstatusreopened, .submissionstatusnew')) return 'pending';
    const normalize = value => value.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!]$/, '');
    const label = [...table.querySelectorAll('tr')].find(row => {
      const heading = row.firstElementChild;
      return heading && /^(estado de (la )?entrega|submission status)$/.test(normalize(heading.textContent));
    });
    const content = label?.lastElementChild || table.querySelector('.submissionstatus');
    const state = normalize(content?.textContent || '');
    if (/^(entregad[oa]( para (calificar|evaluar))?|enviad[oa] para (calificar|evaluar)|submitted for grading)$/.test(state)) return 'submitted';
    if (/^(borrador|draft)(\s|$)/.test(state)) return 'draft';
    if (/^(sin entregar|no entregad[oa]|no se ha enviado (nada|ninguna entrega)( para esta tarea)?|nothing (has been )?submitted for this assignment|no submission)$/.test(state)) return 'pending';
    return 'unknown';
  }

  async function readPage(url) {
    const response = await fetch(url, {
      credentials: 'same-origin', mode: 'same-origin', redirect: 'manual',
      cache: 'no-store', signal: AbortSignal.timeout(15000)
    });
    if (response.type === 'opaqueredirect' || response.status === 401 || response.status === 403) return null;
    if (!response.ok) throw new Error('Moodle HTTP ' + response.status);
    const template = document.createElement('template');
    template.innerHTML = await response.text();
    const page = template.content;
    if (page.querySelector('#page-login-index, form#login') ||
        (page.querySelector('a[href*="/login/index.php"]') && !page.querySelector('a[href*="/login/logout.php"]'))) return null;
    return page;
  }

  async function refreshSubmissions(ids) {
    if (!ids.length) return;
    const cursorKey = 'moodle-assignment-cursor';
    const cursor = (await chrome.storage.local.get(cursorKey))[cursorKey] || 0;
    const limit = Math.min(ids.length, 18);
    const start = cursor % ids.length;
    for (let index = 0; index < limit; index += 3) {
      const batch = Array.from({ length: Math.min(3, limit - index) }, (_, offset) => ids[(start + index + offset) % ids.length]);
      const results = await Promise.all(batch.map(async id => {
        const url = new URL(assignmentPath, location.origin);
        url.searchParams.set('id', id);
        try {
          const page = await readPage(url);
          return [id, page ? readSubmission(page) : 'unknown'];
        } catch {
          return [id, 'unknown'];
        }
      }));
      await saveChanged(Object.fromEntries(results
        .filter(([, state]) => state !== 'unknown')
        .map(([id, state]) => ['moodle-assignment:' + id, state])));
    }
    await saveChanged({ [cursorKey]: (start + limit) % ids.length });
  }

  async function refreshMonths() {
    if (refreshing) return;
    refreshing = true;
    let status = 'ok';
    try {
      const now = new Date();
      const results = {};
      for (const offset of [0, 1]) {
        const month = new Date(now.getFullYear(), now.getMonth() + offset, 15);
        const expected = month.getFullYear() + '-' + String(month.getMonth() + 1).padStart(2, '0');
        const url = new URL(location.pathname, location.origin);
        url.searchParams.set('view', 'month');
        url.searchParams.set('time', String(Math.floor(+month / 1000)));
        const page = await readPage(url);
        if (!page) {
          status = 'session';
          break;
        }
        const snapshot = readCalendar(page);
        if (snapshot?.month !== expected) throw new Error('Formato del calendario inesperado');
        results['moodle-month:' + snapshot.month] = { ...snapshot, updatedAt: Date.now() };
      }
      if (status === 'ok') {
        if (!background) sessionStorage.removeItem(reconnectKey);
        await saveChanged(results);
        const events = Object.values(results).flatMap(snapshot => snapshot.events);
        await refreshSubmissions([...new Set(events.map(item => item.assignmentId).filter(Boolean))]);
      }
    } catch (error) {
      status = 'error';
      console.warn('Agenda Campus: no se pudo actualizar el calendario.', error);
    } finally {
      refreshing = false;
      try {
        const update = { 'moodle-refresh': { status, checkedAt: Date.now() } };
        if (status === 'ok') {
          update['moodle-autologin-tried'] = false;
        }
        await chrome.storage.local.set(update);
        if (background) {
          if (status === 'session' && await chrome.runtime.sendMessage({ type: 'renew' })) {
            location.replace('/centros/sevilla/login/index.php');
            return;
          }
          await chrome.runtime.sendMessage({ type: 'agenda-campus:background-finished' });
        } else if (status === 'session' && !sessionStorage.getItem(reconnectKey)) {
          sessionStorage.setItem(reconnectKey, '1');
          location.assign(location.pathname + '?view=month');
        }
      } catch (error) {
        console.warn('Agenda Campus: no se pudo guardar el estado de sincronización.', error);
      }
    }
  }

  if (background) {
    refreshMonths();
    return;
  }
  const main = document.querySelector('#region-main');
  if (!main) return;
  new MutationObserver(schedule).observe(main, { childList: true, subtree: true, characterData: true });
  window.addEventListener('pageshow', schedule);
  schedule();
  if (readCalendar(document)) {
    refreshMonths();
  }
})();
