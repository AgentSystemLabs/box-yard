// Box Yard's service worker, installed only once browser notifications are turned on (web/src/lib/browserNotifications.ts).
// It shows them (phones only allow that from a service worker) and opens Box Yard when one is clicked. It has no
// fetch handler, so it never caches or intercepts a request.
self.addEventListener("install", () => self.skipWaiting())

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const data = event.notification.data || {}
  const href = typeof data.href === "string" ? data.href : "/"
  const taskId = typeof data.taskId === "string" ? data.taskId : null
  event.waitUntil(
    (async () => {
      // Most recently focused first.
      const [tab] = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
      if (!tab) return self.clients.openWindow(href)
      // The tab moves in-app (lib/browserNotifications.ts listenForNotificationClicks), keeping its state.
      tab.postMessage({ type: "notification-click", href, taskId })
      return tab.focus()
    })(),
  )
})
