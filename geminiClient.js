const STORAGE_KEY = 'geminiApiKey';
const MODEL = 'gemini-1.5-flash-latest';
const BASE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

let apiKeyCache = null;

function loadStoredKey() {
    if (apiKeyCache !== null) {
        return apiKeyCache;
    }
    try {
        const stored = typeof localStorage !== 'undefined'
            ? localStorage.getItem(STORAGE_KEY)
            : null;
        apiKeyCache = stored ? stored : '';
    } catch (error) {
        console.warn('Не удалось прочитать ключ Gemini из localStorage:', error);
        apiKeyCache = '';
    }
    return apiKeyCache;
}

export function getGeminiApiKey() {
    return loadStoredKey();
}

export function hasGeminiApiKey() {
    return Boolean(getGeminiApiKey());
}

export function setGeminiApiKey(key) {
    const normalized = (key ?? '').trim();
    apiKeyCache = normalized;
    try {
        if (normalized) {
            localStorage.setItem(STORAGE_KEY, normalized);
        } else {
            localStorage.removeItem(STORAGE_KEY);
        }
    } catch (error) {
        console.warn('Не удалось сохранить ключ Gemini в localStorage:', error);
    }
    return apiKeyCache;
}

export function clearGeminiApiKey() {
    apiKeyCache = '';
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
        console.warn('Не удалось удалить ключ Gemini из localStorage:', error);
    }
}

export function ensureGeminiApiKey() {
    if (!hasGeminiApiKey()) {
        throw new Error('Требуется указать Gemini API ключ.');
    }
    return getGeminiApiKey();
}

async function callGemini(prompt, config = {}) {
    const apiKey = ensureGeminiApiKey();

    const generationConfig = {
        temperature: config.temperature ?? 0.7,
        topP: config.topP ?? 0.95,
        maxOutputTokens: config.maxOutputTokens ?? 2048,
    };

    if (typeof config.seed === 'number') {
        generationConfig.seed = config.seed;
    }

    const body = {
        contents: [
            {
                role: 'user',
                parts: [{ text: prompt }],
            }
        ],
        generationConfig,
    };

    const response = await fetch(`${BASE_URL}?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });

    const payload = await response.json();

    if (!response.ok) {
        const message = payload?.error?.message || 'Не удалось получить ответ от Gemini.';
        throw new Error(message);
    }

    const text = payload?.candidates?.[0]?.content?.parts
        ?.map((part) => part.text ?? '')
        .join('')
        .trim();

    if (!text) {
        throw new Error('Пустой ответ Gemini. Попробуйте снова.');
    }

    return text;
}

export async function generateGeminiSolution(problemText, config = {}) {
    const prompt = `Ты эксперт по школьной математике, физике и химии. Реши задачу аккуратно, объясняя каждый шаг на русском.

Задача:
${problemText}

Формат ответа:
1. Краткий итоговый ответ.
2. Пошаговое объяснение решения.
3. Дополнительная проверка (если применимо).

Ответ:`;

    return callGemini(prompt, config);
}

export async function reviewGeminiSolution(problemText, candidateSolution, config = {}) {
    const prompt = `Ты строгий проверяющий. Оцени решение задачи по шкале 0-100 и объясни почему. Если ответ полностью корректен, ставь 100/100.

Задача:
${problemText}

Решение кандидата:
${candidateSolution}

Верни отзыв в формате:
Оценка: <число>/100
Комментарий: <краткий анализ>`;

    return callGemini(prompt, {
        temperature: config.temperature ?? 0.2,
        topP: config.topP ?? 0.5,
        maxOutputTokens: config.maxOutputTokens ?? 1024,
        seed: config.seed,
    });
}
