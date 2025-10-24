// Определяем базовый путь автоматически
const BASE_PATH = self.location.pathname.replace(/\/sw\.js$/, '');
const CACHE_NAME = 'math-chem-solver-v2';
const RUNTIME_CACHE = 'runtime-cache-v2';

// Основные файлы для кеширования
const CORE_ASSETS = [
    `${BASE_PATH}/`,
    `${BASE_PATH}/index.html`,
    `${BASE_PATH}/styles.css`,
    `${BASE_PATH}/app.js`,
    `${BASE_PATH}/manifest.json`,
    `${BASE_PATH}/icons/icon-192.png`,
    `${BASE_PATH}/icons/icon-512.png`
];

// CDN ресурсы
const CDN_RESOURCES = [
    'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.46/lib/index.min.js',
    'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js'
];

// ==================== УСТАНОВКА ====================
self.addEventListener('install', (event) => {
    console.log('[SW] Установка Service Worker, BASE_PATH:', BASE_PATH);

    event.waitUntil(
        (async () => {
            try {
                // Кешируем основные файлы
                const cache = await caches.open(CACHE_NAME);
                console.log('[SW] Кеширование основных файлов...');

                // Кешируем по одному для лучшей отладки
                for (const url of CORE_ASSETS) {
                    try {
                        await cache.add(new Request(url, { cache: 'reload' }));
                        console.log('[SW] Закеширован:', url);
                    } catch (error) {
                        console.warn('[SW] Не удалось закешировать:', url, error);
                    }
                }

                // Кешируем CDN ресурсы
                for (const url of CDN_RESOURCES) {
                    try {
                        const response = await fetch(url);
                        if (response.ok) {
                            await cache.put(url, response);
                            console.log('[SW] Закеширован CDN:', url);
                        }
                    } catch (error) {
                        console.warn('[SW] CDN недоступен:', url);
                    }
                }

                console.log('[SW] Установка завершена');
            } catch (error) {
                console.error('[SW] Ошибка при установке:', error);
            }
        })()
    );

    // Принудительная активация
    self.skipWaiting();
});

// ==================== АКТИВАЦИЯ ====================
self.addEventListener('activate', (event) => {
    console.log('[SW] Активация Service Worker');

    event.waitUntil(
        (async () => {
            // Удаляем старые кеши
            const cacheNames = await caches.keys();
            await Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME && cacheName !== RUNTIME_CACHE) {
                        console.log('[SW] Удаление старого кеша:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );

            // Контролируем все клиенты
            await self.clients.claim();
            console.log('[SW] Активация завершена');
        })()
    );
});

// ==================== ПЕРЕХВАТ ЗАПРОСОВ ====================
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    // Игнорируем некоторые запросы
    if (
        url.protocol === 'chrome-extension:' ||
        url.hostname.includes('browser-sync') ||
        request.method !== 'GET'
    ) {
        return;
    }

    // Стратегия для разных типов ресурсов
    event.respondWith(handleFetch(request));
});

async function handleFetch(request) {
    const url = new URL(request.url);

    try {
        // 1. Статические файлы приложения - Cache First
        if (isAppResource(url)) {
            return await cacheFirst(request, CACHE_NAME);
        }

        // 2. CDN библиотеки - Cache First с долгим хранением
        if (isCDNResource(url)) {
            return await cacheFirst(request, CACHE_NAME);
        }

        // 3. HuggingFace модели и Tessdata - Cache First (большие файлы)
        if (isLargeModelResource(url)) {
            return await cacheFirst(request, RUNTIME_CACHE);
        }

        // 4. Остальное - Network First
        return await networkFirst(request, RUNTIME_CACHE);

    } catch (error) {
        console.error('[SW] Ошибка обработки запроса:', request.url, error);

        // Fallback для HTML
        if (request.destination === 'document') {
            const cachedIndex = await caches.match(`${BASE_PATH}/index.html`);
            if (cachedIndex) return cachedIndex;
        }

        // Возвращаем ошибку
        return new Response('Офлайн режим. Ресурс недоступен.', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: { 'Content-Type': 'text/plain' }
        });
    }
}

// ==================== СТРАТЕГИИ КЕШИРОВАНИЯ ====================

// Cache First - сначала кеш, потом сеть
async function cacheFirst(request, cacheName) {
    const cached = await caches.match(request);

    if (cached) {
        console.log('[SW] Из кеша:', request.url);
        return cached;
    }

    console.log('[SW] Загрузка из сети:', request.url);
    const response = await fetch(request);

    if (response.ok) {
        const cache = await caches.open(cacheName);
        cache.put(request, response.clone());
    }

    return response;
}

// Network First - сначала сеть, потом кеш
async function networkFirst(request, cacheName) {
    try {
        const response = await fetch(request);

        if (response.ok) {
            const cache = await caches.open(cacheName);
            cache.put(request, response.clone());
        }

        return response;
    } catch (error) {
        const cached = await caches.match(request);
        if (cached) {
            console.log('[SW] Fallback к кешу:', request.url);
            return cached;
        }
        throw error;
    }
}

// ==================== ОПРЕДЕЛЕНИЕ ТИПОВ РЕСУРСОВ ====================

function isAppResource(url) {
    return (
        url.origin === self.location.origin &&
        (
            url.pathname.endsWith('.html') ||
            url.pathname.endsWith('.css') ||
            url.pathname.endsWith('.js') ||
            url.pathname.endsWith('.json') ||
            url.pathname.endsWith('.png') ||
            url.pathname.includes('/icons/')
        )
    );
}

function isCDNResource(url) {
    return (
        url.hostname.includes('cdn.jsdelivr.net') ||
        url.hostname.includes('unpkg.com')
    );
}

function isLargeModelResource(url) {
    return (
        url.hostname.includes('huggingface.co') ||
        url.pathname.includes('tessdata') ||
        url.pathname.includes('.wasm') ||
        url.pathname.includes('mlc-chat-config') ||
        url.pathname.includes('ndarray-cache')
    );
}

// ==================== ОБРАБОТКА СООБЩЕНИЙ ====================
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }

    if (event.data && event.data.type === 'CLEAR_CACHE') {
        event.waitUntil(
            caches.keys().then((cacheNames) => {
                return Promise.all(
                    cacheNames.map((cacheName) => caches.delete(cacheName))
                );
            })
        );
    }
});

console.log('[SW] Service Worker загружен, BASE_PATH:', BASE_PATH);
