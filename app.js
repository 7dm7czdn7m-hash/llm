import {
    runEnsemble,
    ARBITER_MODEL,
    hasOpenRouterApiKey,
    getOpenRouterApiKey,
    setOpenRouterApiKey,
    clearOpenRouterApiKey,
} from './orchestrator.js';

let tesseractWorker = null;
let currentImage = null;
let db = null;

const DB_NAME = 'MathChemSolver';
const DB_VERSION = 1;
const STORE_NAME = 'solutions';

let currentProblem = '';
let currentRecognizedText = '';
let currentConsensus = null;

// ==================== ИНИЦИАЛИЗАЦИЯ ====================
document.addEventListener('DOMContentLoaded', async () => {
    console.log('Heavy Study Ensemble загружен');

    await initDB();
    initTheme();
    initEventListeners();
    updateOfflineStatus();
    hydrateApiKeyInput();

    if (!hasOpenRouterApiKey()) {
        showStatus('Добавьте OpenRouter ключ, чтобы запустить ансамбль моделей.', 'warning');
        openApiKeyModal();
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

async function saveSolution(problem, consensus, recognizedText = null) {
    return new Promise((resolve, reject) => {
        if (!db) {
            reject(new Error('База данных не инициализирована.'));
            return;
        }

        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);

        const data = {
            problem,
            recognizedText,
            finalAnswer: consensus?.finalAnswer ?? '',
            arbiter: consensus?.arbiter ?? null,
            groups: consensus?.groups ?? [],
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
        if (!db) {
            reject(new Error('База данных не инициализирована.'));
            return;
        }

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
        if (!db) {
            reject(new Error('База данных не инициализирована.'));
            return;
        }

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
        clearOpenRouterApiKey();
        hydrateApiKeyInput();
        showStatus('OpenRouter ключ удалён.', 'warning');
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
    document.getElementById('api-key-backdrop')?.classList.remove('hidden');
    setTimeout(() => {
        document.getElementById('api-key-input')?.focus();
    }, 50);
}

function closeApiKeyModal() {
    document.getElementById('api-key-dialog')?.classList.add('hidden');
    document.getElementById('api-key-backdrop')?.classList.add('hidden');
}

function hydrateApiKeyInput() {
    const input = document.getElementById('api-key-input');
    if (input) {
        input.value = getOpenRouterApiKey();
    }
}

function saveApiKeyFromModal() {
    const input = document.getElementById('api-key-input');
    if (!input) return;
    const key = input.value.trim();
    if (!key) {
        showStatus('Введите корректный OpenRouter ключ.', 'error');
        return;
    }
    setOpenRouterApiKey(key);
    showStatus('OpenRouter ключ сохранён.', 'success');
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

        const {
            data: { text },
        } = await tesseractWorker.recognize(imageData);
        return text.trim();
    } catch (error) {
        console.error('Ошибка OCR:', error);
        throw new Error('Не удалось распознать текст с изображения');
    }
}

// ==================== РЕШЕНИЕ ЗАДАЧИ ====================
async function solveProblem() {
    if (!hasOpenRouterApiKey()) {
        showStatus('Сначала добавьте OpenRouter API ключ.', 'error');
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

        document.getElementById('processing-title').textContent = 'Ансамбль решает задачу...';
        document.getElementById('processing-text').textContent = 'Запускаем Flash, Qwen, DeepSeek и Grok';

        const ensembleResult = await runEnsemble(problemText);

        currentConsensus = ensembleResult;

        processingSection?.classList.add('hidden');
        renderSolution(problemText, ensembleResult, currentRecognizedText);
        solutionSection?.classList.remove('hidden');
    } catch (error) {
        console.error('Ошибка решения:', error);
        showStatus(`Ошибка: ${error.message}`, 'error');
        processingSection?.classList.add('hidden');
        inputSection?.classList.remove('hidden');
    }
}

function renderSolution(problem, consensus, recognizedText) {
    if (recognizedText) {
        const recognizedSection = document.getElementById('recognized-text');
        const recognizedContent = document.getElementById('recognized-content');
        recognizedContent.textContent = recognizedText;
        recognizedSection.classList.remove('hidden');
    } else {
        document.getElementById('recognized-text').classList.add('hidden');
    }

    const solutionContent = document.getElementById('solution-content');
    solutionContent.innerHTML = formatSolution(consensus.finalAnswer || 'Ответ отсутствует');

    renderArbiter(consensus.arbiter);
    renderGroups(consensus.groups, consensus.arbiter);
}

function renderArbiter(arbiter) {
    const chosenElement = document.getElementById('arbiter-chosen');
    const confidenceElement = document.getElementById('arbiter-confidence');
    const reasonElement = document.getElementById('arbiter-reason');
    const thinkingBlock = document.getElementById('arbiter-thinking-block');
    const thinkingElement = document.getElementById('arbiter-thinking');
    const arbiterCard = document.getElementById('arbiter-report');
    const badgeElement = document.getElementById('arbiter-model-badge');

    if (!arbiterCard || !chosenElement || !confidenceElement || !reasonElement) {
        return;
    }

    if (!arbiter) {
        arbiterCard.classList.add('hidden');
        chosenElement.textContent = '—';
        confidenceElement.textContent = '—';
        reasonElement.textContent = '';
        return;
    }

    arbiterCard.classList.remove('hidden');
    badgeElement.textContent = arbiter.label || ARBITER_MODEL.label;
    chosenElement.textContent = arbiter.chosenModel || 'не выбрана';
    confidenceElement.textContent = typeof arbiter.confidence === 'number' ? `${arbiter.confidence}/100` : '—';
    reasonElement.textContent = arbiter.arbiterReason || 'Без пояснения';

    if (arbiter.thinking) {
        thinkingBlock.classList.remove('hidden');
        thinkingElement.textContent = arbiter.thinking;
    } else {
        thinkingBlock.classList.add('hidden');
        thinkingElement.textContent = '';
    }
}

function renderGroups(groups, arbiter) {
    const container = document.getElementById('ensemble-results');
    if (!container) return;

    if (!Array.isArray(groups) || groups.length === 0) {
        container.innerHTML = '<p class="empty-ensemble">Нет данных по моделям</p>';
        return;
    }

    const chosenTarget = (arbiter?.chosenModel || '').toLowerCase();

    container.innerHTML = groups
        .map((group) => {
            const runsHtml = group.runs
                .map((run) => {
                    const isChosen = chosenTarget
                        ? [run.label, run.modelId].some((value) =>
                              value ? chosenTarget.includes(value.toLowerCase()) : false,
                          )
                        : false;
                    const statusClass = run.error ? 'run-item error' : isChosen ? 'run-item selected' : 'run-item';
                    const statusBadge = run.error
                        ? `<span class="run-status">Ошибка</span>`
                        : isChosen
                        ? `<span class="run-status">Выбор арбитра</span>`
                        : `<span class="run-status muted">${run.elapsedMs} мс</span>`;

                    const body = run.error
                        ? `<p class="run-error">${escapeHtml(run.error)}</p>`
                        : `<div class="run-answer">${formatSolution(run.answer)}</div>
                           <details class="thinking-details" ${isChosen ? 'open' : ''}>
                               <summary>Thinking</summary>
                               <pre>${escapeHtml(run.thinking || 'нет данных')}</pre>
                           </details>`;

                    return `
                        <li class="${statusClass}">
                            <header class="run-header">
                                <div>
                                    <div class="model-name">${escapeHtml(run.label)}</div>
                                    <div class="run-meta">Температура ${run.temperature} • ${run.elapsedMs} мс</div>
                                </div>
                                ${statusBadge}
                            </header>
                            <div class="run-body">${body}</div>
                        </li>
                    `;
                })
                .join('');

            return `
                <section class="ensemble-group">
                    <header>
                        <h3>${escapeHtml(group.title)}</h3>
                        <p>${escapeHtml(group.description || '')}</p>
                    </header>
                    <ul class="run-list">${runsHtml}</ul>
                </section>
            `;
        })
        .join('');
}

function saveCurrentSolution() {
    if (!currentConsensus) {
        showStatus('Нет решения для сохранения', 'warning');
        return;
    }

    saveSolution(currentProblem, currentConsensus, currentRecognizedText).catch((error) => {
        console.error('Ошибка сохранения решения:', error);
        showStatus('Не удалось сохранить решение', 'error');
    });
}

function resetToInput() {
    document.getElementById('solution-section')?.classList.add('hidden');
    document.getElementById('processing-section')?.classList.add('hidden');
    document.getElementById('input-section')?.classList.remove('hidden');
    updateSolveButton();
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
                const answerPreview = (solution.finalAnswer || '').slice(0, 160) +
                    ((solution.finalAnswer || '').length > 160 ? '...' : '');

                return `
                    <div class="history-item" data-id="${solution.id}">
                        <div class="history-date">${escapeHtml(date)}</div>
                        <div class="history-problem">${escapeHtml(problemPreview)}</div>
                        <div class="history-solution">${escapeHtml(answerPreview)}</div>
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
    currentRecognizedText = solution.recognizedText ?? null;
    currentConsensus = {
        finalAnswer: solution.finalAnswer,
        arbiter: solution.arbiter,
        groups: solution.groups || [],
    };

    document.getElementById('history-section')?.classList.add('hidden');
    renderSolution(solution.problem, currentConsensus, solution.recognizedText);
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
        statusElement.textContent = 'Онлайн (OpenRouter доступен)';
        statusElement.classList.remove('offline');
    } else {
        statusElement.textContent = 'Офлайн (запросы к моделям недоступны)';
        statusElement.classList.add('offline');
    }
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

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text ?? '';
    return div.innerHTML;
}

updateOfflineStatus();
