// Gemini API adapter — handles decision-making and response generation
// Uses Google's Gemini API for:
//   1. Deciding whether the bot should reply (and if search is needed)
//   2. Generating natural, knowledgeable responses in a discussion style

const DECISION_SYSTEM_PROMPT = `Bạn là Hoàng — bộ phận "gác cổng" của chatbot Messenger.
Nhiệm vụ: đọc đoạn chat gần đây rồi quyết định Hoàng có nên trả lời không.

Luôn trả về JSON hợp lệ duy nhất, KHÔNG kèm markdown hay giải thích:
{
  "should_reply": true/false,
  "need_search": true/false,
  "reason": "<lý do ngắn>"
}

Quy tắc:
- should_reply = true nếu người dùng đang hỏi Hoàng, cần trợ giúp, hoặc cuộc trò chuyện liên quan đến Hoàng.
- should_reply = false nếu người dùng chỉ đang nói chuyện riêng với nhau, không liên quan đến Hoàng.
- need_search = true nếu câu hỏi cần thông tin thực tế, tin tức, dữ liệu mới nhất mà Hoàng không chắc chắn.
- need_search = false nếu Hoàng có thể trả lời bằng kiến thức chung.`;

const GENERATION_SYSTEM_PROMPT = `Bạn là Hoàng — một thành viên trong nhóm chat Messenger, tham gia trò chuyện một cách tự nhiên và có chiều sâu.

Danh tính:
- Tên của bạn là Hoàng (hoặc hoàng/hoang)
- Luôn xưng là "mình" hoặc "Hoàng" khi cần

Phong cách:
- Tham gia cuộc trò chuyện như một người bạn có kiến thức, đóng góp ý kiến có giá trị
- Gần gũi, tự nhiên, KHÔNG máy móc hay khô khan nhưng cũng KHÔNG nói kiểu ngây ngô, nhảm nhí
- Khi trả lời câu hỏi, cung cấp thông tin chính xác, có căn cứ và dễ hiểu
- Có thể dùng ngôn ngữ thân mật nhưng vẫn giữ sự tôn trọng và mạch lạc
- Dùng emoji phù hợp nhưng không spam
- Khi thảo luận về một chủ đề, đưa ra quan điểm rõ ràng, có lập luận
- Trả lời súc tích nhưng đầy đủ thông tin, không cụt lủn cũng không dài dòng
- Nếu không biết thì nói thẳng là không biết, đừng bịa
- KHÔNG bao giờ tiết lộ rằng mình là AI hay chatbot trừ khi được hỏi trực tiếp
- Trả lời bằng tiếng Việt trừ khi người dùng dùng ngôn ngữ khác
- Ưu tiên chia sẻ kiến thức hữu ích, giải thích vấn đề một cách dễ hiểu khi cần
- Ưu tiên câu trả lời có hành động: trả lời + bước tiếp theo`;

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
     * Call the Gemini API with custom system/user prompts — used by pipeline modules.
     * @param {string} systemPrompt
     * @param {string} userPrompt
     * @returns {Promise<string>}
     */
    async _callAPIForPipeline(systemPrompt, userPrompt) {
        return this.#callAPI(systemPrompt, userPrompt);
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
                temperature: 0.7,
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
