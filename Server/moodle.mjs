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
  #courseNames = new Map();

  constructor(username, password, fetchPage = fetch) {
    this.username = username;
    this.password = password;
    this.fetchPage = fetchPage;
  }

  forgetCredentials() {
    this.username = undefined;
    this.password = undefined;
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
    if (!this.username || !this.password) throw new MoodleLoginRequired();
    if (Date.now() < this.#retryLoginAfter) throw new Error('Inicio de sesión pendiente de comprobar.');
    this.#retryLoginAfter = Date.now() + 15 * 60 * 1000;
    const { url, $ } = await this.page(moodle + loginPath + '?authCAS=CAS');
    if (url.origin === moodle && $('a[href*="/login/logout.php"]').length) return { url, $ };
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
    return result;
  }

  async authenticate() {
    const landing = await this.signIn();
    if (landing.$('a[href*="/login/logout.php"]').length) return;
    const page = await this.page(moodle + calendarPath + '?view=month');
    if (page.url.pathname !== calendarPath || !page.$('a[href*="/login/logout.php"]').length) {
      throw new Error('No se pudo verificar la sesión activa de Moodle.');
    }
  }

  async snapshot(previousAssignments = {}, previousDetails = {}) {
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
    const taskDetails = Object.fromEntries(ids.filter(id => previousDetails[id]).map(id => [id, previousDetails[id]]));
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
          const details = readTaskDetails(page.$);
          if (!details.course && details.courseId) await this.#lookupCourse(details);
          if (details.course || details.opens || details.due || details.closes) {
            delete details.courseId;
            taskDetails[id] = details;
          }
        } catch {}
      }));
    }
    this.#cursor = (start + limit) % (ids.length || 1);
    return { months, assignments, taskDetails };
  }

  async #lookupCourse(details) {
    const { courseId } = details;
    if (!this.#courseNames.has(courseId)) {
      this.#courseNames.set(courseId, this.page(moodle + base + '/course/view.php?id=' + courseId).then(page => {
        if (page.url.pathname !== base + '/course/view.php') return '';
        return page.$('#page-header h1, main h1').first().text().trim().slice(0, 250);
      }).catch(() => ''));
    }
    const course = await this.#courseNames.get(courseId);
    if (course) details.course = course;
    else this.#courseNames.delete(courseId);
  }
}

export class MoodleLoginRequired extends Error {}

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
      if (!eventType || eventType === 'due' || eventType === 'extension') {
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
    /^(estado de (la )?entrega|submission status):?$/.test(normalize($(element).children().first().text()))).first();
  const value = normalize((row.length ? row.children().last() : table.find('.submissionstatus').first()).text());
  if (/^(entregad[oa]( para (calificar|evaluar))?|enviad[oa] para (calificar|evaluar)|submitted for grading)$/.test(value)) return 'submitted';
  if (/^(borrador|draft)(\s|$)/.test(value)) return 'draft';
  if (/^todav[ií]a no se han realizado env[ií]os$/.test(value)) return 'pending';
  if (/^(sin (entregar|entrega|env[ií]o)|no entregad[oa]|no enviad[oa]|a[uú]n no (hay|ha habido) (entrega|env[ií]o)s?|no (hay|ha habido) (ning[uú]n[ao] )?(entrega|env[ií]o)s?|no se ha (enviado|entregado|realizado) (nada|ninguna entrega|ning[uú]n env[ií]o|esta tarea)( (para|en) esta tarea)?|nothing (has been )?submitted for this assignment|no submission(?: yet)?)$/.test(value)) return 'pending';
  return null;
}

function readTaskDetails($) {
  const details = {};
  const text = value => value.replace(/\s+/g, ' ').trim().slice(0, 250);
  const normalize = value => text(value).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/:$/, '');
  const courseLink = $('.breadcrumb a[href*="/course/view.php"], [aria-label="Breadcrumb"] a[href*="/course/view.php"]').last();
  const course = text(courseLink.text());
  if (course && !/^(curso|course)$/i.test(course)) details.course = course;
  const courseHref = courseLink.attr('href') || $('#page-header a[href*="/course/view.php"], .secondary-navigation a[href*="/course/view.php"]').first().attr('href');
  const courseId = /(?:^|\s)course-(\d{1,12})(?:\s|$)/.exec($('body').attr('class') || '')?.[1] ||
    /[?&]id=(\d{1,12})(?:&|$)/.exec(courseHref || '')?.[1];
  if (courseId && courseId !== '1') details.courseId = courseId;

  let extendedDue;
  function addDate(label, value) {
    const name = normalize(label);
    const date = text(value);
    if (!date || date === '-') return;
    if (/^(abrio|abrira|abre|abiert[oa]|se (abrio|abre|abrira)|apertura|fecha de apertura|permitir entregas desde|entregas abiertas|opens?|opened|submissions open(?:ed)?|allow submissions from)( el)?$/.test(name)) details.opens = date;
    if (/^(cierre|fecha de (cierre|corte)|cierra|cerro|cerrado|se cierra|se cerro|closes?|closed|cut.?off date)$/.test(name)) details.closes = date;
    if (/^(fecha limite(?: de entrega)?|fecha de (entrega|vencimiento)|vencimiento|vence|plazo de entrega|due(?: date)?|submission due)$/.test(name)) details.due = date;
    if (/^(fecha de (extension|prorroga)|extension due date|extended due date)$/.test(name)) extendedDue = date;
  }

  $('[data-region="activity-dates"] .date-item, .activity-dates .date-item').each((_, node) => {
    const item = $(node).clone();
    const label = item.find('.date-item-label').first();
    const name = label.text();
    label.remove();
    addDate(name, item.text());
  });
  $('.submissionstatustable tr').each((_, node) => {
    const cells = $(node).children();
    if (cells.length === 2) addDate(cells.first().text(), cells.last().text());
  });
  if (extendedDue) details.due = extendedDue;
  return details;
}
