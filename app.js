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

        let storedSolution = solution;
        let evaluations = [];
        let bestScore = null;

        if (solution && typeof solution === 'object') {
            storedSolution = solution.solution ?? '';
            evaluations = Array.isArray(solution.evaluations) ? solution.evaluations : [];
            bestScore = typeof solution.bestScore === 'number' ? solution.bestScore : null;
        }

        const data = {
            problem,
            solution: storedSolution,
            recognizedText,
            evaluations,
            bestScore,
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

// ==================== РЕШЕНИЕ ЗАДАЧИ ====================
let currentProblem = '';
let currentSolution = '';
let currentRecognizedText = '';
let currentSolutionDetails = null;
let currentEvaluationResults = null;

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

        // Генерация нескольких решений с помощью LLM
        document.getElementById('processing-title').textContent = 'Решение задачи...';
        document.getElementById('processing-text').textContent = 'ИИ анализирует задачу';

        const candidates = await runSelfConsistency(problemText);

        // Проверка и оценка решений
        document.getElementById('processing-text').textContent = 'Проверка полученных ответов';
        const scoredCandidates = await scoreSolutions(candidates);

        if (!scoredCandidates.length) {
            throw new Error('Не удалось получить решение от ИИ. Попробуйте ещё раз.');
        }

        const sortedCandidates = scoredCandidates.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
        const bestCandidate = sortedCandidates[0];

        currentSolution = bestCandidate.solution;
        currentEvaluationResults = {
            bestScore: bestCandidate.score ?? 0,
            results: sortedCandidates.map(candidate => ({
                ...candidate,
                isBest: candidate === bestCandidate
            }))
        };
        currentSolutionDetails = {
            solution: bestCandidate.solution,
            evaluations: currentEvaluationResults.results,
            bestScore: currentEvaluationResults.bestScore
        };

        // Отображение решения
        processingSection.classList.add('hidden');
        showSolution(problemText, bestCandidate.solution, currentRecognizedText, currentEvaluationResults);
        solutionSection.classList.remove('hidden');

    } catch (error) {
        console.error('Ошибка решения:', error);
        showStatus(`Ошибка: ${error.message}`, 'error');
        processingSection.classList.add('hidden');
        inputSection.classList.remove('hidden');
    }
}

async function generateGeminiSolution(problemText, { temperature = 0.7, seed = Date.now() } = {}) {
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
            temperature,
            max_tokens: 2000,
            seed
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

async function generateSolution(problemText, options = {}) {
    return generateGeminiSolution(problemText, options);
}

async function runSelfConsistency(problemText) {
    const attempts = [
        { temperature: 0.5, seed: Date.now() },
        { temperature: 0.8, seed: Date.now() + 1 },
        { temperature: 1.1, seed: Date.now() + 2 }
    ];

    const candidates = [];

    for (let index = 0; index < attempts.length; index++) {
        const attempt = attempts[index];
        try {
            const solution = await generateGeminiSolution(problemText, attempt);
            candidates.push({
                id: `attempt-${index + 1}`,
                solution,
                temperature: attempt.temperature,
                seed: attempt.seed
            });
        } catch (error) {
            console.error('Ошибка при генерации варианта решения:', error);
            candidates.push({
                id: `attempt-${index + 1}`,
                solution: 'Не удалось получить ответ для этой попытки.',
                temperature: attempt.temperature,
                seed: attempt.seed
            });
        }
    }

    return candidates;
}

async function scoreSolutions(candidates) {
    if (!llmEngine) {
        throw new Error('Модель ИИ не загружена. Попробуйте перезагрузить страницу.');
    }

    const scored = [];

    for (const candidate of candidates) {
        const prompt = `Ты строгий проверяющий. Тебе дана задача и решение кандидата. Проверь корректность решения и оцени его по шкале от 0 до 100. В выводе укажи итоговый балл в формате "Оценка: <число>/100" и кратко прокомментируй ошибки или верные шаги.

Задача:
${currentProblem}

Решение кандидата:
${candidate.solution}

Ответ:`;

        const request = {
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.2,
            max_tokens: 700,
        };

        if (llmSupportsModelParameter) {
            request.model = MODEL_ID;
        }

        try {
            const response = await llmEngine.chat.completions.create(request);
            const review = response.choices[0].message.content.trim();
            const scoreMatch = review.match(/(100|[1-9]?\d)\s*(?:\/\s*100|из\s*100|балл(?:ов)?)/i);
            let score = scoreMatch ? parseInt(scoreMatch[1], 10) : 0;
            if (Number.isNaN(score)) {
                score = 0;
            }
            score = Math.min(Math.max(score, 0), 100);

            scored.push({
                ...candidate,
                score,
                review
            });
        } catch (error) {
            console.error('Ошибка проверки решения:', error);
            scored.push({
                ...candidate,
                score: 0,
                review: 'Не удалось получить оценку. Попробуйте ещё раз.'
            });
        }
    }

    return scored;
}

function showSolution(problem, solution, recognizedText, evaluationData = null) {
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

    renderEvaluationResults(evaluationData);
}

function formatSolution(text) {
    // Простое форматирование текста
    const safeText = (text ?? '').toString();
    if (!safeText.trim()) {
        return '<p>Ответ отсутствует</p>';
    }

    let formatted = safeText
        .replace(/\n\n/g, '</p><p>')
        .replace(/\n/g, '<br>')
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>');

    return `<p>${formatted}</p>`;
}

function renderEvaluationResults(evaluationData) {
    const evaluationContainer = document.getElementById('evaluation-results');
    const scoreElement = document.getElementById('evaluation-score');
    const noteElement = document.getElementById('evaluation-note');
    const alternativesList = document.getElementById('alternatives-list');

    if (!evaluationContainer || !scoreElement || !alternativesList) {
        return;
    }

    if (!evaluationData || !Array.isArray(evaluationData.results) || evaluationData.results.length === 0) {
        evaluationContainer.classList.add('hidden');
        alternativesList.innerHTML = '';
        if (noteElement) {
            noteElement.classList.add('hidden');
            noteElement.textContent = '';
        }
        return;
    }

    evaluationContainer.classList.remove('hidden');
    const bestScore = evaluationData.bestScore ?? 0;
    scoreElement.textContent = `${bestScore}/100`;

    if (noteElement) {
        const allBelowHundred = evaluationData.results.every(result => (result.score ?? 0) < 100);
        if (allBelowHundred) {
            noteElement.textContent = 'Внимание: ни одна из попыток не получила 100/100. Проверьте решение вручную.';
            noteElement.classList.remove('hidden');
        } else {
            noteElement.classList.add('hidden');
            noteElement.textContent = '';
        }
    }

    alternativesList.innerHTML = evaluationData.results.map((result, index) => {
        const parts = [`Попытка ${index + 1}`];
        if (typeof result.temperature !== 'undefined') {
            parts.push(`температура ${result.temperature}`);
        }
        if (typeof result.score === 'number') {
            parts.push(`${result.score}/100`);
        }
        if (result.isBest) {
            parts.push('выбранное решение');
        }

        const summary = parts.join(' • ');

        return `
            <li class="alternative-item ${result.isBest ? 'selected' : ''}">
                <details ${result.isBest ? 'open' : ''}>
                    <summary>${escapeHtml(summary)}</summary>
                    <div class="alternative-body">
                        <div class="alternative-solution-text">${formatSolution(result.solution)}</div>
                        <div class="alternative-review">
                            <h4>Отзыв проверки</h4>
                            <p>${escapeHtml(result.review || 'Без отзыва')}</p>
                        </div>
                    </div>
                </details>
            </li>
        `;
    }).join('');
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
    currentSolutionDetails = null;
    currentEvaluationResults = null;
}

async function saveCurrentSolution() {
    if (!currentProblem || !currentSolution) {
        showStatus('Нет данных для сохранения', 'error');
        return;
    }

    try {
        const solutionPayload = currentSolutionDetails ?? {
            solution: currentSolution,
            evaluations: currentEvaluationResults ? currentEvaluationResults.results : [],
            bestScore: currentEvaluationResults ? currentEvaluationResults.bestScore : null
        };

        await saveSolution(currentProblem, solutionPayload, currentRecognizedText);
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
    if (Array.isArray(solution.evaluations) && solution.evaluations.length > 0) {
        const computedBestScore = typeof solution.bestScore === 'number'
            ? solution.bestScore
            : solution.evaluations.reduce((max, item) => Math.max(max, item.score ?? 0), 0);

        const normalizedResults = solution.evaluations.map((item, index, array) => ({
            ...item,
            isBest: (item.score ?? 0) === computedBestScore &&
                array.findIndex(candidate => (candidate.score ?? 0) === computedBestScore) === index
        }));

        currentEvaluationResults = {
            bestScore: computedBestScore,
            results: normalizedResults
        };

        currentSolutionDetails = {
            solution: solution.solution,
            evaluations: normalizedResults,
            bestScore: computedBestScore
        };
    } else {
        currentEvaluationResults = null;
        currentSolutionDetails = null;
    }

    document.getElementById('history-section').classList.add('hidden');
    showSolution(solution.problem, solution.solution, solution.recognizedText, currentEvaluationResults);
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

// Инициализация статуса при загрузке
updateOfflineStatus();
