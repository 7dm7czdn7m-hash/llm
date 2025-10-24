const CACHE_NAME = 'math-chem-solver-v1';
const urlsToCache = [
    './',
    './index.html',
    './styles.css',
    './app.js',
    './manifest.json',
    'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.46/lib/index.min.js',
    'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js'
];

// Установка Service Worker
self.addEventListener('install', (event) => {
    console.log('Service Worker: Установка');

    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('Service Worker: Кеширование файлов');
                return cache.addAll(urlsToCache.map(url => {
                    return new Request(url, { cache: 'reload' });
                })).catch((error) => {
                    console.error('Ошибка кеширования:', error);
                });
            })
    );

    // Принудительная активация нового Service Worker
    self.skipWaiting();
});

// Активация Service Worker
self.addEventListener('activate', (event) => {
    console.log('Service Worker: Активация');

    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('Service Worker: Удаление старого кеша', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );

    // Контроль всех клиентов
    self.clients.claim();
});

// Перехват запросов
self.addEventListener('fetch', (event) => {
    const { request } = event;

    // Игнорируем запросы к chrome-extension
    if (request.url.startsWith('chrome-extension://')) {
        return;
    }

    // Игнорируем запросы браузера
    if (request.url.includes('browser-sync')) {
        return;
    }

    // Стратегия: Cache First для статических ресурсов
    if (
        request.url.includes('.css') ||
        request.url.includes('.js') ||
        request.url.includes('.html') ||
        request.url.includes('manifest.json') ||
        request.url.includes('/icons/')
    ) {
        event.respondWith(
            caches.match(request).then((cachedResponse) => {
                if (cachedResponse) {
                    return cachedResponse;
                }

                return fetch(request).then((response) => {
                    // Не кешируем ошибочные ответы
                    if (!response || response.status !== 200 || response.type === 'error') {
                        return response;
                    }

                    const responseToCache = response.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(request, responseToCache);
                    });

                    return response;
                });
            }).catch(() => {
                // Возвращаем базовый HTML если офлайн
                if (request.destination === 'document') {
                    return caches.match('/index.html');
                }
            })
        );
        return;
    }

    // Для запросов к WebLLM и Tesseract - используем Network First
    if (
        request.url.includes('cdn.jsdelivr.net') ||
        request.url.includes('huggingface.co') ||
        request.url.includes('tessdata')
    ) {
        event.respondWith(
            fetch(request).then((response) => {
                // Кешируем успешные ответы
                if (response && response.status === 200) {
                    const responseToCache = response.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(request, responseToCache);
                    });
                }
                return response;
            }).catch(() => {
                // Если сеть недоступна, берём из кеша
                return caches.match(request);
            })
        );
        return;
    }

    // Для остальных запросов - Network First
    event.respondWith(
        fetch(request).catch(() => {
            return caches.match(request);
        })
    );
});

// Обработка сообщений от клиента
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

// Синхронизация в фоне (опционально)
self.addEventListener('sync', (event) => {
    console.log('Service Worker: Фоновая синхронизация', event.tag);
});

// Обработка уведомлений (опционально)
self.addEventListener('notificationclick', (event) => {
    console.log('Service Worker: Клик по уведомлению', event);
    event.notification.close();

    event.waitUntil(
        clients.openWindow('/')
    );
});
