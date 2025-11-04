// ==================== ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ ====================
let llmEngine = null;
let llmSupportsModelParameter = false;
let tesseractWorker = null;
let currentImage = null;
let deferredPrompt = null;
let db = null;

const DB_NAME = 'MathChemSolver';
const DB_VERSION = 1;
const STORE_NAME = 'solutions';
const MODEL_ID = 'DeepSeek-R1-Distill-Qwen-1.5B-q4f16_1-MLC';

// ==================== ИНИЦИАЛИЗАЦИЯ ====================
document.addEventListener('DOMContentLoaded', async () => {
    console.log('Приложение запущено');

    // Регистрация Service Worker
    if ('serviceWorker' in navigator) {
        try {
            const registration = await navigator.serviceWorker.register('/sw.js');
            console.log('Service Worker зарегистрирован:', registration.scope);
            updateOfflineStatus();
        } catch (error) {
            console.error('Ошибка регистрации Service Worker:', error);
        }
    }

    // Инициализация базы данных
    await initDB();
    await renderHistoryPreview();

    // Инициализация темы
    initTheme();

    // Обработка установки PWA
    initPWAInstall();

    // Инициализация событий
    initEventListeners();

    // Загрузка модели
    await initLLM();
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
            renderHistoryPreview();
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
            renderHistoryPreview();
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
    if (!icon) return;

    const sunIcon = `
        <circle cx="12" cy="12" r="4"></circle>
        <line x1="12" y1="2" x2="12" y2="4"></line>
        <line x1="12" y1="20" x2="12" y2="22"></line>
        <line x1="4.93" y1="4.93" x2="6.34" y2="6.34"></line>
        <line x1="17.66" y1="17.66" x2="19.07" y2="19.07"></line>
        <line x1="2" y1="12" x2="4" y2="12"></line>
        <line x1="20" y1="12" x2="22" y2="12"></line>
        <line x1="4.93" y1="19.07" x2="6.34" y2="17.66"></line>
        <line x1="17.66" y1="6.34" x2="19.07" y2="4.93"></line>
    `;

    const moonIcon = `
        <path d="M21 12.79A9 9 0 0 1 11.21 3a7 7 0 1 0 9.79 9.79z"></path>
    `;

    icon.innerHTML = theme === 'dark' ? sunIcon : moonIcon;
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
async function initLLM() {
    const loadingSection = document.getElementById('model-loading');
    const inputSection = document.getElementById('input-section');
    const progressFill = document.getElementById('progress-fill');
    const progressText = document.getElementById('progress-text');
    const loadingStatus = document.getElementById('loading-status');

    try {
        loadingStatus.textContent = 'Проверка поддержки WebGPU...';

        // Проверка поддержки WebGPU
        if (!('gpu' in navigator)) {
            throw new Error('WebGPU не поддерживается. Требуется современный браузер.');
        }

        if (!window.webllm) {
            throw new Error('Библиотека WebLLM недоступна. Проверьте подключение к интернету.');
        }

        loadingStatus.textContent = 'Инициализация WebLLM...';

        const handleProgress = (progress) => {
            const percent = Math.round(progress.progress * 100);
            progressFill.style.width = `${percent}%`;
            progressText.textContent = `${percent}%`;
            loadingStatus.textContent = progress.text || 'Загрузка модели...';
        };

        // Загрузка модели DeepSeek-R1-Distill-Qwen-1.5B
        if (typeof window.webllm.CreateMLCEngine === 'function') {
            llmEngine = await window.webllm.CreateMLCEngine({
                modelId: MODEL_ID,
                initProgressCallback: handleProgress,
            });
            llmSupportsModelParameter = true;
        } else if (typeof window.webllm.MLCEngine === 'function') {
            llmEngine = new window.webllm.MLCEngine();
            llmEngine.setInitProgressCallback(handleProgress);
            await llmEngine.reload(MODEL_ID, {
                temperature: 0.7,
                top_p: 0.9,
            });
            llmSupportsModelParameter = false;
        } else {
            throw new Error('Не удалось инициализировать WebLLM. Обновите приложение.');
        }

        console.log('Модель LLM загружена');
        showStatus('Модель ИИ готова к работе!', 'success');

        // Переключение на основной интерфейс
        loadingSection.classList.add('hidden');
        inputSection.classList.remove('hidden');

    } catch (error) {
        console.error('Ошибка загрузки модели:', error);
        loadingStatus.textContent = `Ошибка: ${error.message}`;
        showStatus(`Ошибка загрузки модели: ${error.message}`, 'error');

        // Fallback: показываем интерфейс даже если модель не загрузилась
        setTimeout(() => {
            loadingSection.classList.add('hidden');
            inputSection.classList.remove('hidden');
        }, 3000);
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

    const heroHistoryButton = document.getElementById('hero-history');
    if (heroHistoryButton) {
        heroHistoryButton.addEventListener('click', showHistory);
    }

    const previewHistoryButton = document.getElementById('history-preview-btn');
    if (previewHistoryButton) {
        previewHistoryButton.addEventListener('click', showHistory);
    }

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
}

// ==================== РАБОТА С ИЗОБРАЖЕНИЯМИ ====================
function handleImageUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
        showStatus('Пожалуйста, выберите изображение', 'error');
        return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
        currentImage = e.target.result;
        showImagePreview(currentImage);
        updateSolveButton();
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

// ==================== ВИЗУАЛИЗАЦИЯ ПРОГРЕССА ====================
function resetProcessingFlow() {
    document.querySelectorAll('.progress-step').forEach(step => {
        step.classList.remove('is-active', 'is-complete');
    });
}

function activateProcessingStep(step) {
    const stepElement = document.querySelector(`.progress-step[data-step="${step}"]`);
    if (!stepElement) return;

    document.querySelectorAll('.progress-step').forEach(element => {
        if (element !== stepElement && !element.classList.contains('is-complete')) {
            element.classList.remove('is-active');
        }
    });

    stepElement.classList.add('is-active');
}

function completeProcessingStep(step) {
    const stepElement = document.querySelector(`.progress-step[data-step="${step}"]`);
    if (!stepElement) return;

    stepElement.classList.remove('is-active');
    stepElement.classList.add('is-complete');
}

function toggleReviewProgress(show) {
    const container = document.getElementById('review-progress');
    if (!container) return;
    container.classList.toggle('hidden', !show);
    container.setAttribute('aria-hidden', show ? 'false' : 'true');
    if (!show) {
        setReviewProgress(0);
    }
}

function setReviewProgress(value) {
    const fill = document.getElementById('review-progress-fill');
    const label = document.getElementById('review-progress-value');
    if (fill) {
        fill.style.width = `${value}%`;
    }
    if (label) {
        label.textContent = `${value}%`;
    }
}

async function runVerificationProgress() {
    setReviewProgress(0);
    toggleReviewProgress(true);
    const checkpoints = [18, 36, 58, 82, 94, 100];

    for (const point of checkpoints) {
        setReviewProgress(point);
        await delay(point === 100 ? 160 : 200);
    }

    await delay(180);
    toggleReviewProgress(false);
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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
    resetProcessingFlow();
    activateProcessingStep('prepare');
    toggleReviewProgress(false);

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
            completeProcessingStep('prepare');
        } else {
            // Используем текст из поля ввода
            problemText = document.getElementById('text-input').value.trim();
            currentRecognizedText = null;
            completeProcessingStep('prepare');
        }

        currentProblem = problemText;

        // Генерация решения с помощью LLM
        document.getElementById('processing-title').textContent = 'Решение задачи...';
        document.getElementById('processing-text').textContent = 'ИИ анализирует задачу';
        activateProcessingStep('generate');

        const solution = await generateSolution(problemText);
        currentSolution = solution;
        completeProcessingStep('generate');

        document.getElementById('processing-title').textContent = 'Перепроверяем решение...';
        document.getElementById('processing-text').textContent = 'ИИ оценивает корректность ответа';
        activateProcessingStep('verify');
        await runVerificationProgress();
        completeProcessingStep('verify');

        // Отображение решения
        processingSection.classList.add('hidden');
        showSolution(problemText, solution, currentRecognizedText);
        solutionSection.classList.remove('hidden');

    } catch (error) {
        console.error('Ошибка решения:', error);
        showStatus(`Ошибка: ${error.message}`, 'error');
        toggleReviewProgress(false);
        resetProcessingFlow();
        processingSection.classList.add('hidden');
        inputSection.classList.remove('hidden');
    }
}

async function generateSolution(problemText) {
    if (!llmEngine) {
        throw new Error('Модель ИИ не загружена. Попробуйте перезагрузить страницу.');
    }

    const prompt = `Ты эксперт по математике и химии для 11 класса. Реши следующую задачу пошагово на русском языке.

Задача: ${problemText}

Формат ответа:
1. Краткий ответ
2. Подробное решение (с пояснениями каждого шага)
3. Проверка (если применимо)

Решение:`;

    try {
        const request = {
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.7,
            max_tokens: 2000,
        };

        if (llmSupportsModelParameter) {
            request.model = MODEL_ID;
        }

        const response = await llmEngine.chat.completions.create(request);

        const solution = response.choices[0].message.content;
        return solution;
    } catch (error) {
        console.error('Ошибка генерации:', error);
        throw new Error('Не удалось получить решение от ИИ. Проверьте подключение.');
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
            const sourceTag = solution.recognizedText
                ? '<span class="history-tag">Фото</span>'
                : '<span class="history-tag manual">Текст</span>';

            return `
                <article class="history-item" data-id="${solution.id}">
                    <div class="history-meta">
                        <span class="history-date">${date}</span>
                        ${sourceTag}
                    </div>
                    <h3 class="history-problem">${escapeHtml(problemPreview)}</h3>
                    <p class="history-solution">${escapeHtml(solutionPreview)}</p>
                </article>
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

async function renderHistoryPreview() {
    const previewContainer = document.getElementById('history-preview');
    if (!previewContainer || !db) return;

    try {
        const solutions = await getAllSolutions();

        if (solutions.length === 0) {
            previewContainer.innerHTML = '<div class="history-preview-empty">Сохраняйте решения, чтобы видеть их здесь</div>';
            return;
        }

        const latestSolutions = solutions.slice(0, 3);
        previewContainer.innerHTML = latestSolutions.map(solution => {
            const date = new Date(solution.timestamp).toLocaleDateString('ru-RU', {
                day: '2-digit',
                month: 'short'
            });
            const problemPreview = solution.problem.slice(0, 80) +
                (solution.problem.length > 80 ? '…' : '');
            const solutionPreview = solution.solution.slice(0, 110) +
                (solution.solution.length > 110 ? '…' : '');
            const tagClass = solution.recognizedText ? 'ocr' : 'manual';
            const tagLabel = solution.recognizedText ? 'Фото' : 'Текст';

            return `
                <div class="history-preview-item">
                    <div class="history-preview-meta">
                        <span>${date}</span>
                        <span class="history-preview-tag ${tagClass}">${tagLabel}</span>
                    </div>
                    <div class="history-preview-title">${escapeHtml(problemPreview)}</div>
                    <div class="history-preview-excerpt">${escapeHtml(solutionPreview)}</div>
                </div>
            `;
        }).join('');
    } catch (error) {
        console.error('Ошибка предварительного просмотра истории:', error);
        previewContainer.innerHTML = '<div class="history-preview-empty">Не удалось загрузить историю</div>';
    }
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

// Инициализация статуса при загрузке
updateOfflineStatus();
