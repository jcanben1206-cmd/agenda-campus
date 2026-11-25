import { load } from 'cheerio';
import { CookieJar } from 'tough-cookie';

const moodle = 'https://educacionadistancia.juntadeandalucia.es';
const identity = 'https://edea.juntadeandalucia.es';
const base = '/centros/sevilla';
const loginPath = base + '/login/index.php';
const calendarPath = base + '/calendar/view.php';
const assignmentPath = base + '/mod/assign/view.php';
const allowed = url => !url.username && !url.password && (
  (url.origin === moodle && (url.pathname === base + '/' || url.pathname.startsWith(base + '/'))) ||
  (url.origin === identity && url.pathname === '/cas/login')
);

export class MoodleSession {
  #jar = new CookieJar();
  #retryLoginAfter = 0;
  #cursor = 0;

  constructor(username, password, fetchPage = fetch) {
    this.username = username;
    this.password = password;
    this.fetchPage = fetchPage;
  }

  async page(address, form = null) {
    let url = new URL(address);
    for (let hops = 0; hops < 12; hops++) {
      if (!allowed(url)) throw new Error('Destino de Moodle no reconocido.');
      const headers = { Accept: 'text/html' };
      const cookie = await this.#jar.getCookieString(url.href);
      if (cookie) headers.Cookie = cookie;
      const response = await this.fetchPage(url, {
        headers, redirect: 'manual', signal: AbortSignal.timeout(12000),
        method: form ? 'POST' : 'GET', body: form
      });
      for (const entry of response.headers.getSetCookie()) await this.#jar.setCookie(entry, url.href, { ignoreError: true });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (form && [307, 308].includes(response.status)) throw new Error('Redirección inesperada del formulario de EducaAnd.');
        const redirect = response.headers.get('location');
        if (!redirect) throw new Error('Redirección sin destino.');
        url = new URL(redirect, url);
        form = null;
        continue;
      }
      if (!response.ok) throw new Error('El portal no respondió correctamente.');
      return { url, $: load(await response.text()) };
    }
    throw new Error('El portal superó el límite de redirecciones.');
  }

  async signIn() {
    if (Date.now() < this.#retryLoginAfter) throw new Error('Inicio de sesión pendiente de comprobar.');
    this.#retryLoginAfter = Date.now() + 15 * 60 * 1000;
    const { url, $ } = await this.page(moodle + loginPath + '?authCAS=CAS');
    if (url.origin === moodle && $('a[href*="/login/logout.php"]').length) return;
    if (url.origin !== identity || url.searchParams.get('gateway') === 'true') throw new Error('EducaAnd no mostró el formulario previsto.');
    const service = new URL(url.searchParams.get('service') || '');
    if (service.origin !== moodle || service.pathname !== loginPath || service.searchParams.get('authCAS') !== 'CAS') {
      throw new Error('Servicio de identidad inesperado.');
    }
    const form = $('input[type="password"][name="password"]').closest('form').first();
    if (form.attr('method')?.toLowerCase() !== 'post' || !form.find('input[name="username"]').length) {
      throw new Error('Formulario de EducaAnd inesperado.');
    }
    const target = new URL(form.attr('action') || url.href, url);
    if (target.origin !== identity || target.pathname !== '/cas/login') throw new Error('Destino del formulario inesperado.');
    const body = new URLSearchParams();
    form.find('input[type="hidden"][name]').each((_, element) => {
      body.append($(element).attr('name'), $(element).val() || '');
    });
    body.set('username', this.username);
    body.set('password', this.password);
    const result = await this.page(target, body);
    if (result.url.origin !== moodle || result.url.pathname === loginPath) throw new Error('EducaAnd no confirmó el inicio de sesión.');
  }

  async snapshot(previousAssignments = {}) {
    const now = new Date();
    const months = [];
    for (const offset of [0, 1]) {
      const month = new Date(now.getFullYear(), now.getMonth() + offset, 15);
      const date = month.getFullYear() + '-' + String(month.getMonth() + 1).padStart(2, '0');
      const url = moodle + calendarPath + '?view=month&time=' + Math.floor(+month / 1000);
      let page = await this.page(url);
      if (page.url.pathname !== calendarPath || !page.$('a[href*="/login/logout.php"]').length) {
        await this.signIn();
        page = await this.page(url);
      }
      if (page.url.pathname !== calendarPath || !page.$('a[href*="/login/logout.php"]').length) {
        throw new Error('No se pudo verificar la sesión activa de Moodle.');
      }
      const events = readCalendar(page.$, date, page.url);
      this.#retryLoginAfter = 0;
      months.push({ month: date, events });
    }

    const ids = [...new Set(months.flatMap(month => month.events.map(event => event.assignmentId).filter(Boolean)))];
    const assignments = Object.fromEntries(ids.filter(id => previousAssignments[id]).map(id => [id, previousAssignments[id]]));
    const start = this.#cursor % (ids.length || 1);
    const limit = Math.min(18, ids.length);
    for (let index = 0; index < limit; index += 3) {
      const batch = Array.from({ length: Math.min(3, limit - index) }, (_, offset) => ids[(start + index + offset) % ids.length]);
      await Promise.all(batch.map(async id => {
        try {
          const page = await this.page(moodle + assignmentPath + '?id=' + id);
          if (page.url.pathname !== assignmentPath) return;
          const state = readSubmission(page.$);
          if (state) assignments[id] = state;
        } catch {}
      }));
    }
    this.#cursor = (start + limit) % (ids.length || 1);
    return { months, assignments };
  }
}

function readCalendar($, month, pageUrl) {
  const table = $('#region-main table[id^="month-detailed-"]').first();
  const wrapper = table.closest('.calendarwrapper[data-year][data-month]');
  const shown = wrapper.attr('data-year') + '-' + String(wrapper.attr('data-month')).padStart(2, '0');
  const cells = table.find('td[data-region="day"][data-day]');
  const [year, index] = month.split('-').map(Number);
  if (shown !== month || cells.length !== new Date(year, index, 0).getDate()) {
    throw new Error('Formato inesperado del calendario de Moodle.');
  }
  const events = new Map();
  cells.each((_, cell) => {
    const day = month + '-' + String($(cell).attr('data-day')).padStart(2, '0');
    $(cell).find('li[data-region="event-item"] a[data-action="view-event"][data-event-id]').each((_, item) => {
      const link = $(item);
      const title = (link.find('.eventname').text() || link.attr('title') || '').trim();
      const eventId = link.attr('data-event-id');
      if (!title || !/^\d{1,18}$/.test(eventId)) return;
      const eventType = link.closest('li').attr('data-event-eventtype');
      let assignmentId = null;
      if (!eventType || eventType === 'due') {
        try {
          const url = new URL(link.attr('href'), pageUrl);
          const id = url.searchParams.get('id');
          if (url.origin === moodle && url.pathname === assignmentPath && /^\d{1,18}$/.test(id)) assignmentId = id;
        } catch {}
      }
      events.set(eventId, { title: title.slice(0, 500), day, assignmentId });
    });
  });
  return [...events.values()];
}

function readSubmission($) {
  const table = $('.submissionstatustable').first();
  if (table.find('.submissionstatussubmitted').length) return 'submitted';
  if (table.find('.submissionstatusdraft').length) return 'draft';
  if (table.find('.submissionstatusreopened, .submissionstatusnew').length) return 'pending';
  const normalize = value => value.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!]$/, '');
  const row = table.find('tr').filter((_, element) =>
    /^(estado de (la )?entrega|submission status)$/.test(normalize($(element).children().first().text()))).first();
  const value = normalize((row.length ? row.children().last() : table.find('.submissionstatus').first()).text());
  if (/^(entregad[oa]( para (calificar|evaluar))?|enviad[oa] para (calificar|evaluar)|submitted for grading)$/.test(value)) return 'submitted';
  if (/^(borrador|draft)(\s|$)/.test(value)) return 'draft';
  if (/^(sin entregar|no entregad[oa]|no se ha enviado (nada|ninguna entrega)( para esta tarea)?|nothing (has been )?submitted for this assignment|no submission)$/.test(value)) return 'pending';
  return null;
}
