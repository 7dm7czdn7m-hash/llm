import {
    generateGeminiSolution,
    reviewGeminiSolution,
    hasGeminiApiKey,
    getGeminiApiKey,
    setGeminiApiKey,
    clearGeminiApiKey,
} from './geminiClient.js';

let tesseractWorker = null;
let currentImage = null;
let db = null;

const DB_NAME = 'MathChemSolver';
const DB_VERSION = 1;
const STORE_NAME = 'solutions';

let currentProblem = '';
let currentSolution = '';
let currentRecognizedText = '';
let currentSolutionDetails = null;
let currentEvaluationResults = null;

// ==================== ИНИЦИАЛИЗАЦИЯ ====================
document.addEventListener('DOMContentLoaded', async () => {
    console.log('Gemini Study Copilot готов к работе');

    if ('serviceWorker' in navigator) {
        try {
            const registration = await navigator.serviceWorker.register('/sw.js');
            console.log('Service Worker зарегистрирован:', registration.scope);
        } catch (error) {
            console.error('Ошибка регистрации Service Worker:', error);
        }
    }

    await initDB();
    initTheme();
    initEventListeners();
    updateOfflineStatus();
    hydrateApiKeyInput();

    if (!hasGeminiApiKey()) {
        showStatus('Добавьте свой Gemini API ключ, чтобы решать задачи.', 'warning');
    }
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
            const database = event.target.result;
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                const objectStore = database.createObjectStore(STORE_NAME, {
                    keyPath: 'id',
                    autoIncrement: true,
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
            timestamp: new Date().toISOString(),
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
        const request = index.openCursor(null, 'prev');

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
    if (!icon) return;
    if (theme === 'dark') {
        icon.innerHTML = '<path d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"></path>';
    } else {
        icon.innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>';
    }
}

// ==================== ОБРАБОТЧИКИ СОБЫТИЙ ====================
function initEventListeners() {
    document.getElementById('theme-toggle')?.addEventListener('click', toggleTheme);
    document.getElementById('history-btn')?.addEventListener('click', showHistory);
    document.getElementById('close-history-btn')?.addEventListener('click', closeHistory);
    document.getElementById('clear-history-btn')?.addEventListener('click', async () => {
        if (confirm('Удалить всю историю?')) {
            await clearAllSolutions();
            await showHistory();
        }
    });

    document.getElementById('camera-btn')?.addEventListener('click', () => {
        document.getElementById('file-input').click();
    });

    document.getElementById('upload-btn')?.addEventListener('click', () => {
        document.getElementById('upload-input').click();
    });

    document.getElementById('paste-btn')?.addEventListener('click', handleClipboardPaste);

    document.getElementById('file-input')?.addEventListener('change', handleImageUpload);
    document.getElementById('upload-input')?.addEventListener('change', handleImageUpload);

    document.getElementById('remove-image')?.addEventListener('click', removeImage);

    document.getElementById('text-input')?.addEventListener('input', updateSolveButton);

    document.getElementById('solve-btn')?.addEventListener('click', solveProblem);
    document.getElementById('new-task-btn')?.addEventListener('click', resetToInput);
    document.getElementById('save-solution-btn')?.addEventListener('click', saveCurrentSolution);

    window.addEventListener('online', updateOfflineStatus);
    window.addEventListener('offline', updateOfflineStatus);

    document.getElementById('api-key-btn')?.addEventListener('click', openApiKeyModal);
    document.getElementById('hero-api-btn')?.addEventListener('click', openApiKeyModal);
    document.getElementById('api-key-close')?.addEventListener('click', closeApiKeyModal);
    document.getElementById('api-key-backdrop')?.addEventListener('click', closeApiKeyModal);
    document.getElementById('api-key-save')?.addEventListener('click', saveApiKeyFromModal);
    document.getElementById('api-key-clear')?.addEventListener('click', () => {
        clearGeminiApiKey();
        hydrateApiKeyInput();
        showStatus('Gemini API ключ удалён.', 'warning');
    });

    document.getElementById('hero-start-btn')?.addEventListener('click', () => {
        const workspace = document.getElementById('workspace');
        workspace?.scrollIntoView({ behavior: 'smooth' });
    });
}

// ==================== API KEY МОДАЛКА ====================
function openApiKeyModal() {
    hydrateApiKeyInput();
    document.getElementById('api-key-dialog')?.classList.remove('hidden');
    setTimeout(() => {
        document.getElementById('api-key-input')?.focus();
    }, 50);
}

function closeApiKeyModal() {
    document.getElementById('api-key-dialog')?.classList.add('hidden');
}

function hydrateApiKeyInput() {
    const input = document.getElementById('api-key-input');
    if (input) {
        input.value = getGeminiApiKey();
    }
}

function saveApiKeyFromModal() {
    const input = document.getElementById('api-key-input');
    if (!input) return;
    const key = input.value.trim();
    if (!key) {
        showStatus('Введите корректный API ключ.', 'error');
        return;
    }
    setGeminiApiKey(key);
    showStatus('Gemini API ключ сохранён.', 'success');
    closeApiKeyModal();
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

async function handleClipboardPaste() {
    if (!navigator.clipboard) {
        showStatus('Браузер не поддерживает доступ к буферу обмена', 'error');
        return;
    }

    try {
        if (navigator.clipboard.read) {
            const items = await navigator.clipboard.read();
            for (const item of items) {
                for (const type of item.types) {
                    if (type.startsWith('image/')) {
                        const blob = await item.getType(type);
                        const dataUrl = await blobToDataURL(blob);
                        currentImage = dataUrl;
                        showImagePreview(currentImage);
                        updateSolveButton();
                        showStatus('Изображение вставлено из буфера обмена', 'success');
                        return;
                    }
                }
            }
        }

        const text = await navigator.clipboard.readText();
        if (text) {
            const textInput = document.getElementById('text-input');
            textInput.value = text;
            updateSolveButton();
            showStatus('Текст задачи вставлен из буфера обмена', 'success');
            return;
        }

        showStatus('Буфер обмена пуст или не содержит поддерживаемых данных', 'warning');
    } catch (error) {
        console.error('Ошибка вставки из буфера обмена:', error);
        showStatus('Не удалось получить данные из буфера обмена', 'error');
    }
}

function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

function showImagePreview(imageSrc) {
    const preview = document.getElementById('preview-container');
    const image = document.getElementById('preview-image');

    image.src = imageSrc;
    preview.classList.remove('hidden');
}

function removeImage() {
    currentImage = null;
    const preview = document.getElementById('preview-container');
    if (preview) {
        preview.classList.add('hidden');
    }
    const fileInput = document.getElementById('file-input');
    const uploadInput = document.getElementById('upload-input');
    if (fileInput) fileInput.value = '';
    if (uploadInput) uploadInput.value = '';
    updateSolveButton();
}

function updateSolveButton() {
    const textValue = document.getElementById('text-input')?.value.trim() ?? '';
    const solveBtn = document.getElementById('solve-btn');
    if (!solveBtn) return;
    solveBtn.disabled = !currentImage && !textValue;
}

// ==================== OCR ====================
async function performOCR(imageData) {
    try {
        if (!tesseractWorker) {
            tesseractWorker = await Tesseract.createWorker('rus+eng', 1, {
                logger: (m) => {
                    if (m.status === 'recognizing text') {
                        const percent = Math.round(m.progress * 100);
                        const processingText = document.getElementById('processing-text');
                        if (processingText) {
                            processingText.textContent = `Распознавание текста: ${percent}%`;
                        }
                    }
                },
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
async function solveProblem() {
    if (!hasGeminiApiKey()) {
        showStatus('Сначала добавьте Gemini API ключ.', 'error');
        openApiKeyModal();
        return;
    }

    const inputSection = document.getElementById('input-section');
    const processingSection = document.getElementById('processing-section');
    const solutionSection = document.getElementById('solution-section');

    inputSection?.classList.add('hidden');
    processingSection?.classList.remove('hidden');

    try {
        let problemText = '';

        if (currentImage) {
            document.getElementById('processing-title').textContent = 'Обработка изображения...';
            document.getElementById('processing-text').textContent = 'Распознавание текста с фото';

            problemText = await performOCR(currentImage);
            currentRecognizedText = problemText;

            if (!problemText) {
                throw new Error('Не удалось распознать текст. Попробуйте ввести задачу вручную.');
            }
        } else {
            problemText = document.getElementById('text-input').value.trim();
            currentRecognizedText = null;
        }

        currentProblem = problemText;

        document.getElementById('processing-title').textContent = 'Решение задачи...';
        document.getElementById('processing-text').textContent = 'Gemini анализирует варианты';

        const candidates = await runSelfConsistency(problemText);

        document.getElementById('processing-text').textContent = 'Перепроверяем ответы';
        const scoredCandidates = await scoreSolutions(candidates);

        if (!scoredCandidates.length) {
            throw new Error('Не удалось получить решение от Gemini. Попробуйте ещё раз.');
        }

        const sorted = scoredCandidates.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
        const bestCandidate = sorted[0];

        currentSolution = bestCandidate.solution;
        currentEvaluationResults = {
            bestScore: bestCandidate.score ?? 0,
            results: sorted.map((candidate) => ({
                ...candidate,
                isBest: candidate === bestCandidate,
            })),
        };

        currentSolutionDetails = {
            solution: bestCandidate.solution,
            evaluations: currentEvaluationResults.results,
            bestScore: currentEvaluationResults.bestScore,
        };

        processingSection?.classList.add('hidden');
        showSolution(problemText, bestCandidate.solution, currentRecognizedText, currentEvaluationResults);
        solutionSection?.classList.remove('hidden');
    } catch (error) {
        console.error('Ошибка решения:', error);
        showStatus(`Ошибка: ${error.message}`, 'error');
        processingSection?.classList.add('hidden');
        inputSection?.classList.remove('hidden');
    }
}

async function runSelfConsistency(problemText) {
    const attempts = [
        { temperature: 0.4, seed: Date.now() },
        { temperature: 0.75, seed: Date.now() + 1 },
        { temperature: 1.05, seed: Date.now() + 2 },
    ];

    const candidates = [];

    for (let index = 0; index < attempts.length; index++) {
        const attempt = attempts[index];
        try {
            const solution = await generateGeminiSolution(problemText, {
                temperature: attempt.temperature,
                seed: attempt.seed,
            });
            candidates.push({
                id: `attempt-${index + 1}`,
                solution,
                temperature: attempt.temperature,
                seed: attempt.seed,
            });
        } catch (error) {
            console.error('Ошибка при генерации варианта решения:', error);
            candidates.push({
                id: `attempt-${index + 1}`,
                solution: 'Не удалось получить ответ для этой попытки.',
                temperature: attempt.temperature,
                seed: attempt.seed,
            });
        }
    }

    return candidates;
}

async function scoreSolutions(candidates) {
    const scored = [];

    for (const candidate of candidates) {
        try {
            const review = await reviewGeminiSolution(currentProblem, candidate.solution, {
                seed: candidate.seed,
            });
            const scoreMatch = review.match(/(100|[1-9]?\d)\s*(?:\/\s*100|из\s*100|\bбалл(?:ов)?)/i);
            let score = scoreMatch ? parseInt(scoreMatch[1], 10) : 0;
            if (Number.isNaN(score)) {
                score = 0;
            }
            score = Math.min(Math.max(score, 0), 100);

            scored.push({
                ...candidate,
                score,
                review,
            });
        } catch (error) {
            console.error('Ошибка проверки решения:', error);
            scored.push({
                ...candidate,
                score: 0,
                review: 'Не удалось получить оценку. Попробуйте ещё раз.',
            });
        }
    }

    return scored;
}

function showSolution(problem, solution, recognizedText, evaluationData = null) {
    if (recognizedText) {
        const recognizedSection = document.getElementById('recognized-text');
        const recognizedContent = document.getElementById('recognized-content');
        recognizedContent.textContent = recognizedText;
        recognizedSection.classList.remove('hidden');
    } else {
        document.getElementById('recognized-text').classList.add('hidden');
    }

    const solutionContent = document.getElementById('solution-content');
    solutionContent.innerHTML = formatSolution(solution);

    renderEvaluationResults(evaluationData);
}

function formatSolution(text) {
    const safeText = (text ?? '').toString();
    if (!safeText.trim()) {
        return '<p>Ответ отсутствует</p>';
    }

    const formatted = safeText
        .replace(/\r/g, '')
        .replace(/\n\n+/g, '</p><p>')
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
        const allBelowHundred = evaluationData.results.every((result) => (result.score ?? 0) < 100);
        if (allBelowHundred) {
            noteElement.textContent = 'Внимание: ни одна из попыток не получила 100/100. Проверьте решение вручную.';
            noteElement.classList.remove('hidden');
        } else {
            noteElement.classList.add('hidden');
            noteElement.textContent = '';
        }
    }

    alternativesList.innerHTML = evaluationData.results
        .map((result, index) => {
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
        })
        .join('');
}

function resetToInput() {
    document.getElementById('solution-section')?.classList.add('hidden');
    document.getElementById('processing-section')?.classList.add('hidden');
    document.getElementById('input-section')?.classList.remove('hidden');

    removeImage();
    const textInput = document.getElementById('text-input');
    if (textInput) {
        textInput.value = '';
    }

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
        const payload = currentSolutionDetails ?? {
            solution: currentSolution,
            evaluations: currentEvaluationResults ? currentEvaluationResults.results : [],
            bestScore: currentEvaluationResults ? currentEvaluationResults.bestScore : null,
        };

        await saveSolution(currentProblem, payload, currentRecognizedText);
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

    inputSection?.classList.add('hidden');
    solutionSection?.classList.add('hidden');
    historySection?.classList.remove('hidden');

    try {
        const solutions = await getAllSolutions();

        if (solutions.length === 0) {
            historyList.innerHTML = '<p class="empty-history">История пуста</p>';
            return;
        }

        historyList.innerHTML = solutions
            .map((solution) => {
                const date = new Date(solution.timestamp).toLocaleString('ru-RU');
                const problemPreview = solution.problem.slice(0, 120) + (solution.problem.length > 120 ? '...' : '');
                const solutionPreview = solution.solution.slice(0, 160) + (solution.solution.length > 160 ? '...' : '');

                return `
                    <div class="history-item" data-id="${solution.id}">
                        <div class="history-date">${escapeHtml(date)}</div>
                        <div class="history-problem">${escapeHtml(problemPreview)}</div>
                        <div class="history-solution">${escapeHtml(solutionPreview)}</div>
                    </div>
                `;
            })
            .join('');

        document.querySelectorAll('.history-item').forEach((item) => {
            item.addEventListener('click', () => {
                const id = parseInt(item.dataset.id, 10);
                const solution = solutions.find((s) => s.id === id);
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
            isBest:
                (item.score ?? 0) === computedBestScore &&
                array.findIndex((candidate) => (candidate.score ?? 0) === computedBestScore) === index,
        }));

        currentEvaluationResults = {
            bestScore: computedBestScore,
            results: normalizedResults,
        };

        currentSolutionDetails = {
            solution: solution.solution,
            evaluations: normalizedResults,
            bestScore: computedBestScore,
        };
    } else {
        currentEvaluationResults = null;
        currentSolutionDetails = null;
    }

    document.getElementById('history-section')?.classList.add('hidden');
    showSolution(solution.problem, solution.solution, solution.recognizedText, currentEvaluationResults);
    document.getElementById('solution-section')?.classList.remove('hidden');
}

function closeHistory() {
    document.getElementById('history-section')?.classList.add('hidden');
    document.getElementById('input-section')?.classList.remove('hidden');
}

// ==================== УТИЛИТЫ ====================
function showStatus(message, type = 'info') {
    const statusBar = document.getElementById('status-bar');
    if (!statusBar) return;
    const statusText = statusBar.querySelector('.status-text');

    statusBar.className = `status-bar ${type}`;
    statusText.textContent = message;
    statusBar.classList.remove('hidden');

    clearTimeout(showStatus.timeoutId);
    showStatus.timeoutId = setTimeout(() => {
        statusBar.classList.add('hidden');
    }, 6000);
}

function updateOfflineStatus() {
    const statusElement = document.getElementById('offline-status');
    if (!statusElement) return;
    if (navigator.onLine) {
        statusElement.textContent = 'Онлайн (Gemini доступен)';
        statusElement.classList.remove('offline');
    } else {
        statusElement.textContent = 'Офлайн (запросы к Gemini недоступны)';
        statusElement.classList.add('offline');
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

updateOfflineStatus();
