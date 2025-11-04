const OPENROUTER_STORAGE_KEY = 'openrouter_api_key_v1';

export const MODEL_GROUPS = [
    {
        id: 'flash-ensemble',
        title: 'Flash 2.5 — тройной прогон',
        description:
            'Три независимых обращения к Gemini 2.0 Flash Thinking, чтобы поймать разные траектории решения.',
        models: [
            {
                id: 'google/gemini-2.0-flash-thinking-exp',
                label: 'Flash 2.5 • Drift A',
                temperature: 0.2,
                systemInstruction:
                    'Ты выступаешь как быстрый решатель задач. Будь лаконичным, но фиксируй ключевые шаги. Это вариант A.',
            },
            {
                id: 'google/gemini-2.0-flash-thinking-exp',
                label: 'Flash 2.5 • Drift B',
                temperature: 0.5,
                systemInstruction:
                    'Ты вторая независимая копия Flash. Исследуй альтернативные подходы и проверяй арифметику. Это вариант B.',
            },
            {
                id: 'google/gemini-2.0-flash-thinking-exp',
                label: 'Flash 2.5 • Drift C',
                temperature: 0.8,
                systemInstruction:
                    'Ты третья копия Flash с повышенной креативностью. Приводи полную проверку и отмечай риски ошибки. Вариант C.',
            },
        ],
    },
    {
        id: 'duo-specialists',
        title: 'Дуэт сильных open моделей',
        description: 'Qwen 3 Max и DeepSeek R1 дают альтернативные ответы с reasoning.',
        models: [
            {
                id: 'qwen/qwen-max',
                label: 'Qwen 3 Max',
                temperature: 0.4,
                systemInstruction:
                    'Ты эксперт по задачам и обязан подробно объяснять логику. Всегда включай шаг "Проверка".',
            },
            {
                id: 'deepseek/deepseek-r1',
                label: 'DeepSeek R1',
                temperature: 0.35,
                systemInstruction:
                    'Ты аналитический агент DeepSeek. Расписывай reasoning и делай строгую проверку ответа.',
            },
        ],
    },
    {
        id: 'grok-channel',
        title: 'Линия Grok',
        description: 'Если Grok открыт, он добавляет ещё один взгляд на задачу.',
        models: [
            {
                id: 'x-ai/grok-beta',
                label: 'Grok Beta',
                temperature: 0.45,
                systemInstruction:
                    'Ты Grok. Решай дерзко, но в финале дай конкретный ответ и проверь себя.',
            },
        ],
    },
];

export const ARBITER_MODEL = {
    id: 'google/gemini-2.0-flash-thinking-exp',
    label: 'Gemini Flash Arbiter',
};

let cachedApiKey = null;

function readKey() {
    if (cachedApiKey !== null) {
        return cachedApiKey;
    }
    try {
        cachedApiKey = localStorage.getItem(OPENROUTER_STORAGE_KEY) || '';
    } catch (error) {
        console.warn('Не удалось прочитать OpenRouter ключ:', error);
        cachedApiKey = '';
    }
    return cachedApiKey;
}

export function getOpenRouterApiKey() {
    return readKey();
}

export function hasOpenRouterApiKey() {
    return Boolean(getOpenRouterApiKey());
}

export function setOpenRouterApiKey(key) {
    const normalized = (key ?? '').trim();
    cachedApiKey = normalized;
    try {
        if (normalized) {
            localStorage.setItem(OPENROUTER_STORAGE_KEY, normalized);
        } else {
            localStorage.removeItem(OPENROUTER_STORAGE_KEY);
        }
    } catch (error) {
        console.warn('Не удалось сохранить OpenRouter ключ:', error);
    }
    return cachedApiKey;
}

export function clearOpenRouterApiKey() {
    cachedApiKey = '';
    try {
        localStorage.removeItem(OPENROUTER_STORAGE_KEY);
    } catch (error) {
        console.warn('Не удалось удалить OpenRouter ключ:', error);
    }
}

function ensureApiKey() {
    if (!hasOpenRouterApiKey()) {
        throw new Error('Не найден API ключ OpenRouter.');
    }
    return getOpenRouterApiKey();
}

function normalizeContent(choice) {
    if (!choice) return '';
    const message = choice.message || {};
    if (Array.isArray(message.content)) {
        return message.content
            .map((part) => {
                if (typeof part === 'string') return part;
                if (part?.text) return part.text;
                return '';
            })
            .join('')
            .trim();
    }
    if (typeof message.content === 'string') {
        return message.content.trim();
    }
    if (message?.text) {
        return message.text.trim();
    }
    return '';
}

function extractReasoning(choice) {
    if (!choice) return '';
    const message = choice.message || {};
    if (message?.reasoning) {
        if (typeof message.reasoning === 'string') {
            return message.reasoning.trim();
        }
        if (Array.isArray(message.reasoning)) {
            return message.reasoning
                .map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
                .join('\n')
                .trim();
        }
    }
    const metadata = message.metadata || choice.metadata || {};
    if (metadata.reasoning) {
        if (typeof metadata.reasoning === 'string') {
            return metadata.reasoning.trim();
        }
        if (Array.isArray(metadata.reasoning)) {
            return metadata.reasoning
                .map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
                .join('\n')
                .trim();
        }
    }
    if (Array.isArray(message.content)) {
        const reasoningPart = message.content.find((part) => part?.type === 'reasoning' || part?.role === 'assistant_reasoning');
        if (reasoningPart?.text) {
            return reasoningPart.text.trim();
        }
    }
    return '';
}

async function callOpenRouter(modelId, messages, { temperature = 0.4, maxOutputTokens = 2048 } = {}) {
    const apiKey = ensureApiKey();

    const body = {
        model: modelId,
        messages,
        temperature,
        max_output_tokens: maxOutputTokens,
        include_reasoning: true,
    };

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'HTTP-Referer': window?.location?.origin ?? 'https://heavy-study.local',
            'X-Title': 'Heavy Study Ensemble',
        },
        body: JSON.stringify(body),
    });

    const payload = await response.json();
    if (!response.ok) {
        const errorMessage = payload?.error?.message || payload?.message || 'Ошибка OpenRouter.';
        throw new Error(errorMessage);
    }

    const choice = payload?.choices?.[0];
    const text = normalizeContent(choice);
    if (!text) {
        throw new Error('Модель вернула пустой ответ.');
    }

    return {
        text,
        reasoning: extractReasoning(choice),
        raw: payload,
        usage: payload?.usage ?? null,
    };
}

function buildProblemPrompt(problemText) {
    return `Ты помогаешь школьнику решить задачу. Работай пошагово, поясняй рассуждения и фиксируй проверку.

Задача:
${problemText}

Формат:
1. Итоговый ответ.
2. Объяснение шагов.
3. Проверка и вывод.`;
}

async function runModelPass(model, problemText) {
    const messages = [
        {
            role: 'system',
            content:
                model.systemInstruction ||
                'Ты помощник-решатель. Поясняй логику на русском и всегда проводи самопроверку.',
        },
        {
            role: 'user',
            content: buildProblemPrompt(problemText),
        },
    ];

    const started = performance.now();
    try {
        const result = await callOpenRouter(model.id, messages, {
            temperature: model.temperature ?? 0.4,
        });

        return {
            modelId: model.id,
            label: model.label,
            temperature: model.temperature ?? 0.4,
            answer: result.text,
            thinking: result.reasoning,
            usage: result.usage,
            elapsedMs: Math.round(performance.now() - started),
            error: null,
        };
    } catch (error) {
        return {
            modelId: model.id,
            label: model.label,
            temperature: model.temperature ?? 0.4,
            answer: 'Не удалось получить ответ.',
            thinking: '',
            usage: null,
            elapsedMs: Math.round(performance.now() - started),
            error: error.message || String(error),
        };
    }
}

function composeArbiterContext(groups) {
    const sections = [];
    groups.forEach((group) => {
        group.runs.forEach((run) => {
            sections.push(`### ${run.label}
Группа: ${group.title}
Температура: ${run.temperature}
Время: ${run.elapsedMs} мс
Ошибка: ${run.error ?? 'нет'}

Ответ:
${run.answer}

Thinking:
${run.thinking || '—'}
`);
        });
    });
    return sections.join('\n\n');
}

function parseArbiterOutput(text) {
    const [answerBlock, metaBlock] = text.split(/\n---\n/);
    const meta = metaBlock || '';

    const chosenMatch = meta.match(/Выбранная модель\s*:\s*(.+)/i);
    const confidenceMatch = meta.match(/Уверенность\s*:\s*(\d{1,3})/i);
    const reasoningMatch = meta.match(/Обоснование\s*:\s*([\s\S]+)/i);

    return {
        finalAnswer: (answerBlock || '').trim(),
        chosenModel: chosenMatch ? chosenMatch[1].trim() : null,
        confidence: confidenceMatch ? Math.min(100, Math.max(0, parseInt(confidenceMatch[1], 10))) : null,
        arbiterReason: reasoningMatch ? reasoningMatch[1].trim() : meta.trim(),
    };
}

async function runArbiter(problemText, groups) {
    const context = composeArbiterContext(groups);
    const messages = [
        {
            role: 'system',
            content:
                'Ты арбитр, который выбирает лучшее решение из нескольких LLM. Используй Thinking, чтобы внимательно сравнить решения.',
        },
        {
            role: 'user',
            content: `Тебе даны ответы разных моделей на одну задачу.

Задача:
${problemText}

Ответы:
${context}

Проанализируй ответы и верни результат строго в формате:
<Лучший итоговый ответ>
---
Выбранная модель: <название модели или НЕТ>
Уверенность: <число от 0 до 100>
Обоснование: <краткое объяснение почему>
`,
        },
    ];

    const started = performance.now();
    try {
        const result = await callOpenRouter(ARBITER_MODEL.id, messages, {
            temperature: 0.25,
            maxOutputTokens: 1536,
        });
        const parsed = parseArbiterOutput(result.text);
        return {
            modelId: ARBITER_MODEL.id,
            label: ARBITER_MODEL.label,
            finalAnswer: parsed.finalAnswer,
            chosenModel: parsed.chosenModel,
            confidence: parsed.confidence,
            arbiterReason: parsed.arbiterReason,
            rawText: result.text,
            thinking: result.reasoning,
            usage: result.usage,
            elapsedMs: Math.round(performance.now() - started),
            error: null,
        };
    } catch (error) {
        return {
            modelId: ARBITER_MODEL.id,
            label: ARBITER_MODEL.label,
            finalAnswer: 'Арбитр не смог выбрать ответ.',
            chosenModel: null,
            confidence: null,
            arbiterReason: error.message || String(error),
            rawText: '',
            thinking: '',
            usage: null,
            elapsedMs: Math.round(performance.now() - started),
            error: error.message || String(error),
        };
    }
}

export async function runEnsemble(problemText) {
    const groups = [];
    for (const group of MODEL_GROUPS) {
        const groupResult = { id: group.id, title: group.title, description: group.description, runs: [] };
        for (const model of group.models) {
            const run = await runModelPass(model, problemText);
            groupResult.runs.push(run);
        }
        groups.push(groupResult);
    }

    const arbiter = await runArbiter(problemText, groups);

    const finalAnswer = arbiter.finalAnswer || groups[0]?.runs[0]?.answer || '';

    return {
        finalAnswer,
        groups,
        arbiter,
    };
}
