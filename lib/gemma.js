// lib/gemma.js
// ─────────────────────────────────────────────────────────────────────────────
// Arka plan çıkarımları için Gemma (Gemini API üzerinden, aynı GEMINI_API_KEY).
// services/learner.js ve services/serverProfile.js buradan geçer; Chamy'nin
// sohbet / tool-calling tarafı Gemini'de kalır.
//
// • System instruction yerine sistem metni kullanıcı mesajının başına konur —
//   Gemma'da her yerde güvenilir değil.
// • 429/5xx'te API'nin söylediği kadar bekleyip tekrar dener (free tier'da
//   dakikalık token limiti düşük), olmazsa listedeki sonraki modele geçer.
// • Model listesi GEMMA_MODELS env'i ile değiştirilebilir (virgüllü).
// ─────────────────────────────────────────────────────────────────────────────

const API = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODELS = (process.env.GEMMA_MODELS || 'gemma-4-31b-it,gemma-4-26b-a4b-it')
    .split(',').map(s => s.trim()).filter(Boolean);
const MAX_RETRIES  = 3;
const MAX_WAIT_MS  = 90_000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function retryDelayMs(res, bodyText, attempt) {
    const header = Number(res.headers.get('retry-after'));
    if (header > 0) return header * 1000;
    const m = (bodyText || '').match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
    if (m) return Math.ceil(parseFloat(m[1]) * 1000) + 500;
    return 5000 * 2 ** attempt;
}

// images: [{ base64, mimeType }]
async function generate(systemPrompt, userPrompt, images = [], maxTokens = 2048) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY env var is missing.');

    const parts = [];
    for (const img of (images || []).slice(0, 5)) {
        parts.push({ inlineData: { mimeType: img.mimeType || 'image/jpeg', data: img.base64 } });
    }
    parts.push({ text: `${systemPrompt}\n\n---\n\n${userPrompt}` });

    // Gemma 4 spends part of maxOutputTokens on hidden "thinking"; a long prompt can
    // leave nothing for the answer (finishReason MAX_TOKENS, empty text). We retry
    // with a doubled budget up to MAX_BUDGET.
    let budget = maxTokens;
    const makeBody = () => JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { maxOutputTokens: budget, temperature: 0.2 },
    });
    let body = makeBody();

    let lastErr = null;
    for (const model of MODELS) {
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            let res;
            try {
                res = await fetch(`${API}/${model}:generateContent`, {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
                    body,
                    signal:  AbortSignal.timeout(120_000),
                });
            } catch (err) {
                lastErr = err;
                if (attempt < MAX_RETRIES) { await sleep(3000); continue; }
                break;
            }

            if (res.ok) {
                const data = await res.json();
                const text = (data.candidates?.[0]?.content?.parts || [])
                    .filter(p => !p.thought && typeof p.text === 'string')
                    .map(p => p.text)
                    .join('');
                if (text.trim()) return text;
                lastErr = new Error(`${model}: empty response (${data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason || 'unknown'})`);
                break;
            }

            const errText = await res.text().catch(() => '');
            lastErr = new Error(`${model} ${res.status}: ${errText.slice(0, 200)}`);
            if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
                await sleep(Math.min(retryDelayMs(res, errText, attempt), MAX_WAIT_MS));
                continue;
            }
            break; // diğer 4xx (model yok, istek hatalı) → sonraki model
        }
    }
    throw lastErr || new Error('Gemma call failed');
}

module.exports = { generate, MODELS };
