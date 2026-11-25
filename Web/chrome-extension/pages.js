const pagesForm = document.getElementById('pages');
const pagesInput = document.getElementById('pages-url');
const pagesStatus = document.getElementById('pages-status');
const removePages = document.getElementById('remove-pages');
const pagesBridge = 'agenda-campus-pages';

async function displayPages() {
  const values = await chrome.storage.local.get(hostedAgendaKey);
  pagesInput.value = values[hostedAgendaKey] || '';
  removePages.hidden = !pagesInput.value;
}
displayPages().catch(() => {});

async function replaceBridge(url) {
  const previous = await chrome.storage.local.get(hostedAgendaKey);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [pagesBridge] });
  const settings = url ? {
    id: pagesBridge,
    matches: [url.href + '*'],
    js: ['agenda-origin.js', 'agenda-bridge.js'],
    runAt: 'document_idle'
  } : null;
  if (settings) {
    if (existing.length) await chrome.scripting.updateContentScripts([settings]);
    else await chrome.scripting.registerContentScripts([settings]);
    await chrome.storage.local.set({ [hostedAgendaKey]: url.href });
  } else {
    await chrome.storage.local.remove(hostedAgendaKey);
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [pagesBridge] });
  }
  const oldOrigin = githubPagesRoot(previous[hostedAgendaKey])?.origin;
  if (oldOrigin && oldOrigin !== url?.origin) {
    await chrome.permissions.remove({ origins: [oldOrigin + '/*'] });
  }
}

pagesForm.addEventListener('submit', async event => {
  event.preventDefault();
  const url = githubPagesRoot(pagesInput.value.trim());
  if (!url) {
    pagesStatus.textContent = 'Introduce la dirección HTTPS de tu web en github.io.';
    return;
  }
  try {
    event.submitter.disabled = true;
    if (!(await chrome.permissions.request({ origins: [url.origin + '/*'] }))) {
      throw new Error('Chrome no concedió acceso a esta web.');
    }
    await replaceBridge(url);
    await displayPages();
    pagesStatus.textContent = 'Web vinculada. Ábrela o recárgala en este perfil de Chrome.';
  } catch (error) {
    pagesStatus.textContent = error.message || 'No se pudo vincular la web.';
  } finally {
    event.submitter.disabled = false;
  }
});

removePages.addEventListener('click', async () => {
  try {
    await replaceBridge(null);
    await displayPages();
    pagesStatus.textContent = 'Web desvinculada.';
  } catch {
    pagesStatus.textContent = 'No se pudo desvincular la web.';
  }
});
