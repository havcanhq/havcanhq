/* HAVCAN service worker — Web Push + notification clicks only.
   No fetch handler and no caching: the app loads from the network exactly as before.
   Push payloads are JSON: { title, body, url, tag, icon, badge, data? }  (plain text bodies are tolerated too).
   The official HAVCAN logo is the default icon (colour) and badge (white-on-transparent mask). All paths resolve
   against the worker's own scope, so they work at the Cloudflare root or under a sub-path. */
var SCOPE = self.registration.scope;
var ICON = new URL('icons/havcan-logo-192.png', SCOPE).href;
var BADGE = new URL('icons/havcan-badge-96.png', SCOPE).href;

// The backend currently sends the colour icon path as the badge too. A badge must be a transparent monochrome mask
// (Android status bars use only its alpha channel), so that default is swapped for the real badge file.
// Any other badge URL a payload supplies is still honoured.
function pickBadge(raw) {
  if (!raw) return BADGE;
  try { return new URL(raw, SCOPE).href === ICON ? BADGE : raw; } catch (e) { return BADGE; }
}

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

function readPayload(event) {
  if (!event.data) return {};
  try { return event.data.json() || {}; }
  catch (e) { try { return { body: event.data.text() }; } catch (e2) { return {}; } }
}

// Only same-origin, in-scope URLs are ever opened from a notification.
function safeUrl(raw) {
  try {
    var u = new URL(raw || SCOPE, SCOPE);
    return u.origin === new URL(SCOPE).origin ? u.href : SCOPE;
  } catch (e) { return SCOPE; }
}

function showFor(payload) {
  var data = payload.data && typeof payload.data === 'object' ? payload.data : {};
  var url = payload.url || data.url || '';
  return self.registration.showNotification(payload.title || 'HAVCAN', {
    body: payload.body || '',
    icon: payload.icon || ICON,
    badge: pickBadge(payload.badge),
    tag: payload.tag || data.tag || undefined,
    renotify: !!(payload.tag || data.tag),
    data: { url: url, route: data.route || '', id: data.id || data.orderId || data.projectId || '' }
  });
}

self.addEventListener('push', function (event) {
  var payload = readPayload(event);
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    // The app is open and in view: hand the message to the page (it shows a toast) instead of a second system alert.
    var visible = list.filter(function (c) { return c.visibilityState === 'visible' && c.focused !== false; });
    if (visible.length) {
      visible.forEach(function (c) { c.postMessage({ type: 'havcan-push', payload: payload }); });
      return;
    }
    return showFor(payload);
  }));
});

// Exposed as a named function so the click behaviour is the same however it is triggered.
function handleNotificationClick(notification) {
  var info = notification.data || {};
  notification.close();
  var target = safeUrl(info.url || SCOPE);
  var msg = { type: 'havcan-notification-click', url: info.url || '', route: info.route || '', id: info.id || '' };
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (new URL(c.url).origin === new URL(SCOPE).origin && 'focus' in c) {
        c.postMessage(msg);
        // focus() can be refused (e.g. no user gesture on some platforms); the message above already routes the app.
        try { return Promise.resolve(c.focus()).catch(function () {}); } catch (e) { return Promise.resolve(); }
      }
    }
    // Cold start: the app reads ?hv_open= once it has loaded and its sessions are known, then routes there.
    var open = new URL(SCOPE);
    if (info.url || info.route) {
      open.searchParams.set('hv_open', info.url ? target.replace(new URL(SCOPE).origin, '') : '');
      if (info.route) open.searchParams.set('hv_route', info.route);
      if (info.id) open.searchParams.set('hv_id', info.id);
    }
    return self.clients.openWindow(open.href);
  });
}
self.addEventListener('notificationclick', function (event) {
  event.waitUntil(handleNotificationClick(event.notification));
});

self.addEventListener('notificationclose', function () { /* nothing to clean up: no per-notification state is kept */ });

// The browser rotated or expired the subscription: tell any open page so it can register the new one.
self.addEventListener('pushsubscriptionchange', function (event) {
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    list.forEach(function (c) { c.postMessage({ type: 'havcan-push-subscription-changed' }); });
  }));
});
