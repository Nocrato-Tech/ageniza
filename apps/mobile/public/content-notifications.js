self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (windows) => {
    const target = windows.find((client) => { const url = new URL(client.url); return url.origin === self.location.origin && url.pathname === '/app-mobile/'; });
    if (target) return target.focus();
    return self.clients.openWindow('/app-mobile/');
  }));
});
