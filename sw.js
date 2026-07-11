// Принудительная немедленная установка
self.addEventListener('install', (event) => {
    self.skipWaiting();
});

// Активация и захват контроля над страницей
self.addEventListener('activate', (event) => {
    event.waitUntil(clients.claim());
});

// Обязательный перехватчик сети (оставляем пустым, чтобы пропускать запросы)
self.addEventListener('fetch', (event) => {
    // Chrome требует наличия этого события для признания PWA
});
