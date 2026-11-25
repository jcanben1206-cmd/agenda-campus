self.addEventListener('push', event => {
  let body = 'Hay novedades en Moodle.';
  try { body = event.data?.json().body || body; } catch {}
  event.waitUntil(self.registration.showNotification('Agenda Campus', { body, tag: 'agenda-campus-moodle' }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const url = self.registration.scope;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const agenda = windows.find(client => client.url === url || client.url.startsWith(url + '?'));
    if (agenda) await agenda.focus();
    else await self.clients.openWindow(url);
  })());
});
