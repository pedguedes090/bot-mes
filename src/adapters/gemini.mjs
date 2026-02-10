// Gemini API adapter — handles decision-making and response generation
// Uses Google's Gemini API for:
//   1. Deciding whether the bot should reply (and if search is needed)
//   2. Generating natural, gen-z style responses

const DECISION_SYSTEM_PROMPT = `Bạn là bộ phận "gác cổng" của một chatbot Messenger.
Nhiệm vụ: đọc đoạn chat gần đây rồi quyết định bot có nên trả lời không.

Luôn trả về JSON hợp lệ duy nhất, KHÔNG kèm markdown hay giải thích:
{
  "should_reply": true/false,
  "need_search": true/false,
  "reason": "<lý do ngắn>"
}

Quy tắc:
- should_reply = true nếu người dùng đang hỏi bot, cần trợ giúp, hoặc cuộc trò chuyện liên quan đến bot.
- should_reply = false nếu người dùng chỉ đang nói chuyện riêng với nhau, không liên quan đến bot.
- need_search = true nếu câu hỏi cần thông tin thực tế, tin tức, dữ liệu mới nhất mà bot không chắc chắn.
- need_search = false nếu bot có thể trả lời bằng kiến thức chung.`;

const GENERATION_SYSTEM_PROMPT = `Bạn là một chatbot Messenger siêu thân thiện, nói chuyện kiểu gen-z Việt Nam.

Phong cách:
- Gần gũi, tự nhiên, KHÔNG máy móc hay khô khan
- Có thể dùng ngôn ngữ thân mật (mày tao, bro, fen, chill, vibe, slay, real, cap, no cap...)
- Dùng emoji phù hợp nhưng không spam
- Có thể đùa giỡn, châm biếm nhẹ, nói chuyện tế nhị
- Trả lời ngắn gọn, đi thẳng vào vấn đề
- Nếu không biết thì nói thẳng là không biết, đừng bịa
- Có thể chửi bới nhẹ nhàng kiểu bạn bè nếu ngữ cảnh cho phép
- KHÔNG bao giờ tiết lộ rằng mình là AI hay chatbot trừ khi được hỏi trực tiếp
- Trả lời bằng tiếng Việt trừ khi người dùng dùng ngôn ngữ khác`;

export class GeminiAdapter {
    #apiKey;
    #model;
    #logger;

    /**
     * @param {string} apiKey - Gemini API key
     * @param {string} model - Gemini model name (e.g. gemini-2.0-flash)
     * @param {Object} logger - Logger instance
     */
    constructor(apiKey, model, logger) {
        this.#apiKey = apiKey;
        this.#model = model;
        this.#logger = logger.child('gemini');
    }

    get enabled() {
        return Boolean(this.#apiKey);
    }

    /**
     * Update API key and model at runtime (e.g. from dashboard).
     */
    configure(apiKey, model) {
        if (apiKey !== undefined) this.#apiKey = apiKey;
        if (model !== undefined) this.#model = model;
    }

    /**
     * Ask Gemini whether the bot should reply and if search is needed.
     * @param {string} chatContext - Recent chat messages as text
     * @returns {Promise<{ should_reply: boolean, need_search: boolean, reason: string }>}
     */
    async decide(chatContext) {
        if (!this.#apiKey) {
            return { should_reply: false, need_search: false, reason: 'No API key configured' };
        }

        const userPrompt = `Đoạn chat gần đây:\n${chatContext}\n\nHãy quyết định bot có nên trả lời không.`;

        try {
            const text = await this.#callAPI(DECISION_SYSTEM_PROMPT, userPrompt);
            const parsed = this.#parseJSON(text);
            return {
                should_reply: Boolean(parsed.should_reply),
                need_search: Boolean(parsed.need_search),
                reason: String(parsed.reason || ''),
            };
        } catch (err) {
            this.#logger.error('Decision request failed', { error: err.message });
            return { should_reply: false, need_search: false, reason: `Error: ${err.message}` };
        }
    }

    /**
     * Generate a reply using Gemini.
     * @param {string} chatContext - Recent chat messages as text
     * @param {string} [searchContext] - Optional search results to include
     * @returns {Promise<string>} The generated reply text
     */
    async generateReply(chatContext, searchContext) {
        if (!this.#apiKey) {
            throw new Error('No API key configured');
        }

        let userPrompt = `Đoạn chat gần đây:\n${chatContext}`;
        if (searchContext) {
            userPrompt += `\n\nThông tin bổ sung từ tìm kiếm:\n${searchContext}`;
        }
        userPrompt += '\n\nHãy trả lời tin nhắn cuối cùng một cách tự nhiên.';

        const text = await this.#callAPI(GENERATION_SYSTEM_PROMPT, userPrompt);
        return text.trim();
    }

    /**
     * Call the Gemini generateContent API.
     * @param {string} systemPrompt
     * @param {string} userPrompt
     * @returns {Promise<string>}
     */
    async #callAPI(systemPrompt, userPrompt) {
        const model = this.#model || 'gemini-2.0-flash';
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

        const body = {
            system_instruction: {
                parts: [{ text: systemPrompt }],
            },
            contents: [
                {
                    role: 'user',
                    parts: [{ text: userPrompt }],
                },
            ],
            generationConfig: {
                temperature: 0.9,
                maxOutputTokens: 1024,
            },
        };

        this.#logger.debug('Calling Gemini API', { model });

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': this.#apiKey,
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Gemini API ${response.status}: ${errText.slice(0, 200)}`);
        }

        const data = await response.json();
        const candidate = data.candidates?.[0];
        const text = candidate?.content?.parts?.[0]?.text;

        if (!text) {
            throw new Error('Empty response from Gemini');
        }

        return text;
    }

    /**
     * Parse JSON from Gemini response text (strips markdown fences if present).
     */
    #parseJSON(text) {
        // Strip markdown code fences
        let cleaned = text.trim();
        if (cleaned.startsWith('```')) {
            cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
        }
        return JSON.parse(cleaned);
    }
}
