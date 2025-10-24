// ==================== ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ ====================
let llmEngine = null;
let llmLoading = false;
let llmLoaded = false;
let tesseractWorker = null;
let currentImage = null;
let deferredPrompt = null;
let db = null;

const DB_NAME = 'MathChemSolver';
const DB_VERSION = 1;
const STORE_NAME = 'solutions';

// ==================== ИНИЦИАЛИЗАЦИЯ ====================
document.addEventListener('DOMContentLoaded', async () => {
    console.log('Приложение запущено');
    console.log('Протокол:', window.location.protocol);
    console.log('Хост:', window.location.host);

    // Проверка HTTPS (нужно для камеры на iOS)
    if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost') {
        showStatus('⚠️ Для работы камеры требуется HTTPS. Некоторые функции могут быть недоступны.', 'warning');
    }

    // Регистрация Service Worker
    if ('serviceWorker' in navigator) {
        try {
            const basePath = window.BASE_PATH || '';
            const swPath = `${basePath}/sw.js`;
            const registration = await navigator.serviceWorker.register(swPath, {
                scope: `${basePath}/`
            });
            console.log('Service Worker зарегистрирован:', registration.scope);
            updateOfflineStatus();
        } catch (error) {
            console.error('Ошибка регистрации Service Worker:', error);
            showStatus('Service Worker не загружен. Офлайн режим недоступен.', 'warning');
        }
    }

    // Инициализация базы данных
    await initDB();

    // Инициализация темы
    initTheme();

    // Обработка установки PWA
    initPWAInstall();

    // Инициализация событий
    initEventListeners();

    // Показываем интерфейс сразу (без ожидания модели)
    document.getElementById('model-loading').classList.add('hidden');
    document.getElementById('input-section').classList.remove('hidden');

    // Показываем статус
    showStatus('Приложение готово! Модель ИИ загрузится при первом использовании.', 'success');

    console.log('Инициализация завершена');
});

// ==================== БАЗА ДАННЫХ ====================
async function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => {
            console.error('Ошибка открытия БД:', request.error);
            reject(request.error);
        };

        request.onsuccess = () => {
            db = request.result;
            console.log('БД инициализирована');
            resolve();
        };

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const objectStore = db.createObjectStore(STORE_NAME, {
                    keyPath: 'id',
                    autoIncrement: true
                });
                objectStore.createIndex('timestamp', 'timestamp', { unique: false });
                console.log('Object store создан');
            }
        };
    });
}

async function saveSolution(problem, solution, recognizedText = null) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);

        const data = {
            problem,
            solution,
            recognizedText,
            timestamp: new Date().toISOString()
        };

        const request = store.add(data);

        request.onsuccess = () => {
            console.log('Решение сохранено в БД');
            showStatus('Решение сохранено в историю', 'success');
            resolve(request.result);
        };

        request.onerror = () => {
            console.error('Ошибка сохранения:', request.error);
            reject(request.error);
        };
    });
}

async function getAllSolutions() {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const index = store.index('timestamp');
        const request = index.openCursor(null, 'prev'); // Сортировка по убыванию

        const solutions = [];

        request.onsuccess = (event) => {
            const cursor = event.target.result;
            if (cursor) {
                solutions.push({ id: cursor.primaryKey, ...cursor.value });
                cursor.continue();
            } else {
                resolve(solutions);
            }
        };

        request.onerror = () => {
            reject(request.error);
        };
    });
}

async function clearAllSolutions() {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.clear();

        request.onsuccess = () => {
            console.log('История очищена');
            showStatus('История очищена', 'success');
            resolve();
        };

        request.onerror = () => {
            reject(request.error);
        };
    });
}

// ==================== ТЕМА ====================
function initTheme() {
    const savedTheme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);
    updateThemeIcon(savedTheme);
}

function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';

    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
    updateThemeIcon(newTheme);
}

function updateThemeIcon(theme) {
    const icon = document.querySelector('.theme-icon');
    if (theme === 'dark') {
        icon.innerHTML = '<path d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"></path>';
    } else {
        icon.innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>';
    }
}

// ==================== PWA УСТАНОВКА ====================
function initPWAInstall() {
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e;

        // Показываем кастомный промпт установки
        const installPrompt = document.getElementById('install-prompt');
        installPrompt.classList.remove('hidden');
    });

    document.getElementById('install-btn').addEventListener('click', async () => {
        if (deferredPrompt) {
            deferredPrompt.prompt();
            const { outcome } = await deferredPrompt.userChoice;
            console.log('Результат установки:', outcome);
            deferredPrompt = null;
        }
        document.getElementById('install-prompt').classList.add('hidden');
    });

    document.getElementById('install-cancel').addEventListener('click', () => {
        document.getElementById('install-prompt').classList.add('hidden');
    });
}

// ==================== ИНИЦИАЛИЗАЦИЯ LLM ====================
async function ensureLLMLoaded(showProgress = false) {
    // Если уже загружена - возвращаем сразу
    if (llmLoaded && llmEngine) {
        console.log('✅ Модель уже загружена');
        return llmEngine;
    }

    // Если уже идет загрузка - ждём
    if (llmLoading) {
        console.log('⏳ Модель уже загружается, ожидание...');
        // Ждём пока загрузится
        while (llmLoading) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        if (llmLoaded && llmEngine) {
            return llmEngine;
        }
        throw new Error('Не удалось загрузить модель');
    }

    // Начинаем загрузку
    llmLoading = true;

    try {
        console.log('📥 Начинается загрузка модели LLM...');

        // Проверка наличия WebLLM библиотеки
        if (typeof window.webllm === 'undefined') {
            console.error('❌ WebLLM библиотека не загружена!');
            throw new Error('WebLLM библиотека не загружена. Проверьте подключение к интернету.');
        }

        console.log('✅ WebLLM библиотека найдена:', window.webllm);

        if (showProgress) {
            document.getElementById('processing-title').textContent = 'Загрузка модели ИИ...';
            document.getElementById('processing-text').textContent = 'Первый запуск: загрузка ~600MB. Может занять 3-5 минут.';
        }

        // Проверка поддержки WebGPU
        if ('gpu' in navigator) {
            console.log('✅ WebGPU поддерживается');
        } else {
            console.warn('⚠️ WebGPU не поддерживается, будет использован CPU (медленнее)');
        }

        // Инициализация WebLLM
        if (!llmEngine) {
            console.log('Создание MLCEngine...');
            llmEngine = new window.webllm.MLCEngine();

            // Обновление прогресса
            llmEngine.setInitProgressCallback((progress) => {
                const percent = Math.round(progress.progress * 100);
                console.log(`📊 Загрузка модели: ${percent}% - ${progress.text}`);

                if (showProgress) {
                    document.getElementById('processing-text').textContent =
                        `Загрузка: ${percent}% - ${progress.text || 'Загрузка модели...'}`;
                }
            });

            console.log('✅ MLCEngine создан');
        }

        // Загрузка модели DeepSeek-R1-Distill-Qwen-1.5B
        console.log('🚀 Начинаем загрузку модели DeepSeek-R1-Distill-Qwen-1.5B...');

        await llmEngine.reload('DeepSeek-R1-Distill-Qwen-1.5B-q4f16_1-MLC', {
            temperature: 0.7,
            top_p: 0.9,
        });

        llmLoaded = true;
        llmLoading = false;

        console.log('✅ Модель LLM успешно загружена!');
        showStatus('✅ Модель ИИ готова! Теперь можно решать задачи офлайн.', 'success');

        return llmEngine;

    } catch (error) {
        llmLoading = false;
        llmLoaded = false;
        console.error('❌ ОШИБКА загрузки модели:', error);
        console.error('Детали ошибки:', error.message, error.stack);
        throw error;
    }
}

// ==================== ОБРАБОТЧИКИ СОБЫТИЙ ====================
function initEventListeners() {
    // Переключение темы
    document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

    // История
    document.getElementById('history-btn').addEventListener('click', showHistory);
    document.getElementById('close-history-btn').addEventListener('click', closeHistory);
    document.getElementById('clear-history-btn').addEventListener('click', async () => {
        if (confirm('Удалить всю историю?')) {
            await clearAllSolutions();
            await showHistory();
        }
    });

    // Камера и загрузка
    document.getElementById('camera-btn').addEventListener('click', () => {
        document.getElementById('file-input').click();
    });

    document.getElementById('upload-btn').addEventListener('click', () => {
        document.getElementById('upload-input').click();
    });

    document.getElementById('file-input').addEventListener('change', handleImageUpload);
    document.getElementById('upload-input').addEventListener('change', handleImageUpload);

    // Удаление изображения
    document.getElementById('remove-image').addEventListener('click', removeImage);

    // Ввод текста
    document.getElementById('text-input').addEventListener('input', updateSolveButton);

    // Решение задачи
    document.getElementById('solve-btn').addEventListener('click', solveProblem);

    // Новая задача
    document.getElementById('new-task-btn').addEventListener('click', resetToInput);

    // Сохранение решения
    document.getElementById('save-solution-btn').addEventListener('click', saveCurrentSolution);

    // Обновление статуса офлайн
    window.addEventListener('online', updateOfflineStatus);
    window.addEventListener('offline', updateOfflineStatus);

    // Кнопка очистки кеша
    document.getElementById('clear-cache-btn').addEventListener('click', clearCacheAndReload);
}

// ==================== РАБОТА С ИЗОБРАЖЕНИЯМИ ====================
function handleImageUpload(event) {
    const file = event.target.files[0];
    if (!file) {
        console.log('Файл не выбран');
        return;
    }

    console.log('Загружен файл:', file.name, 'Тип:', file.type, 'Размер:', file.size);

    if (!file.type.startsWith('image/')) {
        showStatus('Пожалуйста, выберите изображение (JPG, PNG, и т.д.)', 'error');
        return;
    }

    // Проверка размера файла (макс 10MB)
    if (file.size > 10 * 1024 * 1024) {
        showStatus('Файл слишком большой. Максимум 10MB', 'error');
        return;
    }

    const reader = new FileReader();

    reader.onerror = (error) => {
        console.error('Ошибка чтения файла:', error);
        showStatus('Не удалось загрузить изображение', 'error');
    };

    reader.onload = (e) => {
        currentImage = e.target.result;
        console.log('Изображение загружено, размер данных:', currentImage.length);
        showImagePreview(currentImage);
        updateSolveButton();
        showStatus('Фото загружено! Теперь нажмите "Решить задачу"', 'success');
    };

    reader.readAsDataURL(file);
}

function showImagePreview(imageSrc) {
    const preview = document.getElementById('preview-container');
    const image = document.getElementById('preview-image');

    image.src = imageSrc;
    preview.classList.remove('hidden');
}

function removeImage() {
    currentImage = null;
    document.getElementById('preview-container').classList.add('hidden');
    document.getElementById('file-input').value = '';
    document.getElementById('upload-input').value = '';
    updateSolveButton();
}

function updateSolveButton() {
    const textInput = document.getElementById('text-input').value.trim();
    const solveBtn = document.getElementById('solve-btn');

    solveBtn.disabled = !currentImage && !textInput;
}

// ==================== OCR ====================
async function performOCR(imageData) {
    try {
        if (!tesseractWorker) {
            tesseractWorker = await Tesseract.createWorker('rus+eng', 1, {
                logger: (m) => {
                    console.log('Tesseract:', m);
                    if (m.status === 'recognizing text') {
                        const percent = Math.round(m.progress * 100);
                        document.getElementById('processing-text').textContent =
                            `Распознавание текста: ${percent}%`;
                    }
                }
            });
        }

        const { data: { text } } = await tesseractWorker.recognize(imageData);
        return text.trim();
    } catch (error) {
        console.error('Ошибка OCR:', error);
        throw new Error('Не удалось распознать текст с изображения');
    }
}

// ==================== РЕШЕНИЕ ЗАДАЧИ ====================
let currentProblem = '';
let currentSolution = '';
let currentRecognizedText = '';

async function solveProblem() {
    const inputSection = document.getElementById('input-section');
    const processingSection = document.getElementById('processing-section');
    const solutionSection = document.getElementById('solution-section');

    inputSection.classList.add('hidden');
    processingSection.classList.remove('hidden');

    try {
        let problemText = '';

        // Если есть изображение - делаем OCR
        if (currentImage) {
            document.getElementById('processing-title').textContent = 'Обработка изображения...';
            document.getElementById('processing-text').textContent = 'Распознавание текста с фото';

            problemText = await performOCR(currentImage);
            currentRecognizedText = problemText;

            if (!problemText) {
                throw new Error('Не удалось распознать текст. Попробуйте ввести задачу вручную.');
            }

            console.log('Распознанный текст:', problemText);
        } else {
            // Используем текст из поля ввода
            problemText = document.getElementById('text-input').value.trim();
            currentRecognizedText = null;
        }

        currentProblem = problemText;

        // Генерация решения с помощью LLM
        document.getElementById('processing-title').textContent = 'Решение задачи...';
        document.getElementById('processing-text').textContent = 'ИИ анализирует задачу';

        const solution = await generateSolution(problemText);
        currentSolution = solution;

        // Отображение решения
        processingSection.classList.add('hidden');
        showSolution(problemText, solution, currentRecognizedText);
        solutionSection.classList.remove('hidden');

    } catch (error) {
        console.error('Ошибка решения:', error);
        showStatus(`Ошибка: ${error.message}`, 'error');
        processingSection.classList.add('hidden');
        inputSection.classList.remove('hidden');
    }
}

async function generateSolution(problemText) {
    // Загружаем модель если ещё не загружена
    try {
        console.log('🔄 Проверка загрузки модели...');
        await ensureLLMLoaded(true);
        console.log('✅ Модель готова к генерации');
    } catch (error) {
        console.error('❌ Не удалось загрузить модель:', error);

        // Показываем пользователю распознанный текст хотя бы
        let errorMsg = 'Не удалось загрузить модель ИИ.\n\n';

        if (error.message.includes('WebLLM библиотека')) {
            errorMsg += '🌐 Проблема: CDN библиотека не загрузилась.\n';
            errorMsg += '💡 Решение: Проверьте интернет и обновите страницу (F5).\n\n';
        } else {
            errorMsg += `Ошибка: ${error.message}\n\n`;
        }

        errorMsg += '📝 Распознанный текст вы можете скопировать выше и решить вручную.';

        throw new Error(errorMsg);
    }

    const prompt = `Ты эксперт по математике и химии для 11 класса. Реши следующую задачу пошагово на русском языке.

Задача: ${problemText}

Формат ответа:
1. Краткий ответ
2. Подробное решение (с пояснениями каждого шага)
3. Проверка (если применимо)

Решение:`;

    try {
        document.getElementById('processing-title').textContent = 'ИИ решает задачу...';
        document.getElementById('processing-text').textContent = 'Анализирую условие...';

        console.log('🤖 Отправка запроса к модели...');

        const response = await llmEngine.chat.completions.create({
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.7,
            max_tokens: 2000,
        });

        console.log('✅ Получен ответ от модели');

        const solution = response.choices[0].message.content;
        return solution;
    } catch (error) {
        console.error('❌ Ошибка генерации решения:', error);
        throw new Error('Не удалось получить решение от ИИ: ' + error.message);
    }
}

function showSolution(problem, solution, recognizedText) {
    // Показываем распознанный текст если есть
    if (recognizedText) {
        const recognizedSection = document.getElementById('recognized-text');
        const recognizedContent = document.getElementById('recognized-content');
        recognizedContent.textContent = recognizedText;
        recognizedSection.classList.remove('hidden');
    } else {
        document.getElementById('recognized-text').classList.add('hidden');
    }

    // Форматирование решения
    const solutionContent = document.getElementById('solution-content');
    solutionContent.innerHTML = formatSolution(solution);
}

function formatSolution(text) {
    // Простое форматирование текста
    let formatted = text
        .replace(/\n\n/g, '</p><p>')
        .replace(/\n/g, '<br>')
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>');

    return `<p>${formatted}</p>`;
}

function resetToInput() {
    document.getElementById('solution-section').classList.add('hidden');
    document.getElementById('input-section').classList.remove('hidden');

    // Очистка
    removeImage();
    document.getElementById('text-input').value = '';
    currentProblem = '';
    currentSolution = '';
    currentRecognizedText = '';
}

async function saveCurrentSolution() {
    if (!currentProblem || !currentSolution) {
        showStatus('Нет данных для сохранения', 'error');
        return;
    }

    try {
        await saveSolution(currentProblem, currentSolution, currentRecognizedText);
    } catch (error) {
        console.error('Ошибка сохранения:', error);
        showStatus('Ошибка сохранения в историю', 'error');
    }
}

// ==================== ИСТОРИЯ ====================
async function showHistory() {
    const inputSection = document.getElementById('input-section');
    const solutionSection = document.getElementById('solution-section');
    const historySection = document.getElementById('history-section');
    const historyList = document.getElementById('history-list');

    inputSection.classList.add('hidden');
    solutionSection.classList.add('hidden');
    historySection.classList.remove('hidden');

    try {
        const solutions = await getAllSolutions();

        if (solutions.length === 0) {
            historyList.innerHTML = '<p class="empty-history">История пуста</p>';
            return;
        }

        historyList.innerHTML = solutions.map(solution => {
            const date = new Date(solution.timestamp).toLocaleString('ru-RU');
            const problemPreview = solution.problem.slice(0, 100) +
                (solution.problem.length > 100 ? '...' : '');
            const solutionPreview = solution.solution.slice(0, 150) +
                (solution.solution.length > 150 ? '...' : '');

            return `
                <div class="history-item" data-id="${solution.id}">
                    <div class="history-date">${date}</div>
                    <div class="history-problem">${escapeHtml(problemPreview)}</div>
                    <div class="history-solution">${escapeHtml(solutionPreview)}</div>
                </div>
            `;
        }).join('');

        // Обработчики клика на элементы истории
        document.querySelectorAll('.history-item').forEach(item => {
            item.addEventListener('click', () => {
                const id = parseInt(item.dataset.id);
                const solution = solutions.find(s => s.id === id);
                if (solution) {
                    showHistorySolution(solution);
                }
            });
        });

    } catch (error) {
        console.error('Ошибка загрузки истории:', error);
        showStatus('Ошибка загрузки истории', 'error');
    }
}

function showHistorySolution(solution) {
    currentProblem = solution.problem;
    currentSolution = solution.solution;
    currentRecognizedText = solution.recognizedText;

    document.getElementById('history-section').classList.add('hidden');
    showSolution(solution.problem, solution.solution, solution.recognizedText);
    document.getElementById('solution-section').classList.remove('hidden');
}

function closeHistory() {
    document.getElementById('history-section').classList.add('hidden');
    document.getElementById('input-section').classList.remove('hidden');
}

// ==================== УТИЛИТЫ ====================
function showStatus(message, type = 'info') {
    const statusBar = document.getElementById('status-bar');
    const statusText = statusBar.querySelector('.status-text');

    statusBar.className = `status-bar ${type}`;
    statusText.textContent = message;
    statusBar.classList.remove('hidden');

    setTimeout(() => {
        statusBar.classList.add('hidden');
    }, 5000);
}

function updateOfflineStatus() {
    const statusElement = document.getElementById('offline-status');
    if (navigator.onLine) {
        statusElement.textContent = 'Онлайн';
        statusElement.classList.remove('offline');
    } else {
        statusElement.textContent = 'Офлайн';
        statusElement.classList.add('offline');
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Очистка кеша и перезагрузка
async function clearCacheAndReload() {
    if (!confirm('Это удалит весь кеш (включая загруженную модель ~600MB) и перезагрузит страницу. Продолжить?')) {
        return;
    }

    try {
        console.log('🗑️ Очистка кеша...');

        // Очистка всех кешей
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames.map(name => caches.delete(name)));
        console.log('✅ Все кеши удалены');

        // Удаление Service Worker
        if ('serviceWorker' in navigator) {
            const registrations = await navigator.serviceWorker.getRegistrations();
            await Promise.all(registrations.map(reg => reg.unregister()));
            console.log('✅ Service Worker удален');
        }

        // Очистка IndexedDB
        if (db) {
            db.close();
        }
        indexedDB.deleteDatabase(DB_NAME);
        console.log('✅ IndexedDB очищена');

        // Перезагрузка страницы
        alert('Кеш очищен! Страница перезагрузится.');
        window.location.reload(true);

    } catch (error) {
        console.error('❌ Ошибка очистки кеша:', error);
        alert('Ошибка очистки кеша: ' + error.message);
    }
}

// Инициализация статуса при загрузке
updateOfflineStatus();
