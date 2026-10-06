// Service worker: prima obaveštenja (web push) i otvara aplikaciju na dodir.
// Ne kešira stranice — aplikacija uvek radi sa najnovijom verzijom sa servera.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data && event.data.text() }; }
  const base = self.registration.scope;
  event.waitUntil(self.registration.showNotification(data.title || "Raspored App", {
    body: data.body || "",
    tag: data.tag,
    renotify: !!data.tag,
    icon: base + "icons/icon-192.png",
    badge: base + "icons/badge-96.png",
    data: { url: base + (data.path || "index.html") },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || self.registration.scope;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if (c.url.startsWith(self.registration.scope)) {
        await c.focus();
        c.navigate(url).catch(() => {});
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
