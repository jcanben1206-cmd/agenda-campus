const form = document.getElementById('credentials');
const status = document.getElementById('status');
const remove = document.getElementById('remove');
const username = document.getElementById('username');
const password = document.getElementById('password');

chrome.storage.local.get('moodle-credentials').then(values => {
  if (values['moodle-credentials']) {
    remove.hidden = false;
    status.textContent = 'Hay credenciales guardadas en este perfil de Chrome.';
  }
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!username.value.trim()) { username.focus(); return; }
  const button = event.submitter;
  button.disabled = true;
  remove.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'save-credentials', username: username.value.trim(), password: password.value
    });
    if (!result) throw new Error('Error al guardar');
    form.reset();
    remove.hidden = false;
    status.textContent = 'Credenciales guardadas. Consulta el resultado de la sincronización en Agenda Campus.';
  } catch {
    status.textContent = 'No se pudieron guardar las credenciales.';
  } finally {
    button.disabled = false;
    remove.disabled = false;
  }
});

remove.addEventListener('click', async () => {
  try {
    if (!await chrome.runtime.sendMessage({ type: 'delete-credentials' })) throw new Error('Error al borrar');
    form.reset();
    remove.hidden = true;
    status.textContent = 'Credenciales borradas.';
  } catch {
    status.textContent = 'No se pudieron borrar las credenciales.';
  }
});
