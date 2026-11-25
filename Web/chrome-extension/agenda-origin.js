const localAgenda = 'http://127.0.0.1:8765/';
const hostedAgendaKey = 'agenda-pages-url';

function githubPagesRoot(address) {
  try {
    const url = new URL(address);
    if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.github\.io$/.test(url.hostname) ||
        url.port || url.username || url.password || url.search || url.hash ||
        !/^\/(?:[a-zA-Z0-9._-]+\/?)?$/.test(url.pathname)) return null;
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url;
  } catch {
    return null;
  }
}

function isAgendaPage(address, hosted) {
  return [localAgenda, hosted].filter(Boolean)
    .some(root => address === root || address === root + 'index.html');
}
