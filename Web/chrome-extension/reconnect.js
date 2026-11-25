(() => {
  const moodle = 'https://educacionadistancia.juntadeandalucia.es';
  const base = '/centros/sevilla';
  const login = base + '/login/index.php';
  const cas = 'https://edea.juntadeandalucia.es';

  async function reconnect() {
    if (location.origin === moodle && location.pathname === login) {
      const access = [...document.querySelectorAll('a[href]')].find(link => {
        const url = new URL(link.href);
        return url.origin === moodle && url.pathname === login && url.searchParams.get('authCAS') === 'CAS';
      });
      if (access && await chrome.runtime.sendMessage({ type: 'moodle-login' })) {
        location.replace(moodle + login + '?authCAS=CAS');
      }
      return;
    }
    if (location.origin === moodle) {
      if (await chrome.runtime.sendMessage({ type: 'return-calendar' })) {
        location.replace(moodle + base + '/calendar/view.php?view=month#agenda-campus-background');
      }
      return;
    }
    if (location.origin !== cas || location.pathname !== '/cas/login') return;
    const params = new URLSearchParams(location.search);
    if (!params.get('service') || params.get('gateway') === 'true') return;
    const service = new URL(params.get('service'));
    if (service.origin !== moodle || service.pathname !== login || service.searchParams.get('authCAS') !== 'CAS') return;

    const password = document.querySelector('input[type="password"][name="password"]');
    const form = password?.form;
    const username = form?.querySelector('input[name="username"]');
    if (!form || !username || form.method.toLowerCase() !== 'post') return;
    const target = new URL(form.action, location.href);
    if (target.origin !== cas || target.pathname !== '/cas/login') return;
    const authorization = await chrome.runtime.sendMessage({ type: 'cas-watch' });
    if (!authorization) return;

    if (authorization.saved) {
      const approval = await chrome.runtime.sendMessage({ type: 'cas-submit' });
      if (!approval?.credentials) return;
      username.value = approval.credentials.username;
      password.value = approval.credentials.password;
      form.requestSubmit();
      return;
    }

    let waiting = false;
    async function submitWhenFilled() {
      if (waiting || !username.value.length || !password.value.length) return;
      waiting = true;
      if (await chrome.runtime.sendMessage({ type: 'cas-submit' })) form.requestSubmit();
    }
    const timer = setInterval(() => submitWhenFilled().catch(() => clearInterval(timer)), 500);
    setTimeout(() => clearInterval(timer), 25000);
    await submitWhenFilled();
  }

  reconnect().catch(() => {});
})();
