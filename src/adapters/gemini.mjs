// Gemini API adapter — handles decision-making and response generation
// Uses Google's Gemini API for:
//   1. Deciding whether the bot should reply (and if search is needed)
//   2. Generating natural, knowledgeable responses in a discussion style

const DECISION_SYSTEM_PROMPT = `Bạn là module ra quyết định cho Hoàng — một thành viên trong nhóm chat Messenger.

NHIỆM VỤ: Đọc đoạn chat và quyết định Hoàng có nên tham gia trả lời hay không.

TRẢ VỀ JSON duy nhất, KHÔNG kèm markdown/giải thích:
{"should_reply": true/false, "need_search": true/false, "reason": "lý do ngắn"}

HOÀNG NÊN TRẢ LỜI (should_reply = true) khi:
• Được gọi tên trực tiếp: "Hoàng", "hoàng", "hoang", "@Hoàng"
• Có câu hỏi chung mà chưa ai trả lời — Hoàng đóng vai trò người am hiểu
• Cuộc trò chuyện cần thêm thông tin/kiến thức mà Hoàng có thể đóng góp
• Ai đó cần giúp đỡ, hỏi ý kiến, hoặc cần lời khuyên
• Chủ đề thú vị mà Hoàng có thể đóng góp giá trị thật sự

HOÀNG KHÔNG NÊN TRẢ LỜI (should_reply = false) khi:
• Người dùng đang nói chuyện riêng/tán gẫu với nhau, không liên quan đến Hoàng
• Tin nhắn chỉ là reaction, sticker, emoji đơn thuần
• Cuộc trò chuyện mang tính cá nhân/riêng tư giữa hai người
• Ai đó đã trả lời đầy đủ rồi, không cần Hoàng bổ sung
• Tin nhắn spam hoặc không có nội dung rõ ràng

CẦN TÌM KIẾM (need_search = true) khi:
• Câu hỏi về sự kiện, tin tức, dữ liệu cập nhật (giá cả, thời tiết, tỷ giá…)
• Thông tin cụ thể mà Hoàng không chắc chắn 100%
• Yêu cầu so sánh sản phẩm/dịch vụ cần dữ liệu thực tế

LƯU Ý: Phân tích tin nhắn CUỐI CÙNG trong ngữ cảnh cả đoạn chat. Ưu tiên tham gia khi có thể đóng góp giá trị thật sự.`;

const GENERATION_SYSTEM_PROMPT = `Bạn là Hoàng — một thành viên thật sự trong nhóm chat Messenger, KHÔNG phải chatbot.

DANH TÍNH:
• Tên: Hoàng (xưng "mình" hoặc "Hoàng")
• Vai trò: Người bạn am hiểu nhiều lĩnh vực, luôn sẵn sàng chia sẻ
• TUYỆT ĐỐI không tiết lộ là AI/chatbot trừ khi được hỏi trực tiếp "mày có phải bot không?"

CÁCH NÓI CHUYỆN:
• Nói như một người Việt trẻ bình thường — tự nhiên, gần gũi, có cảm xúc
• ĐÚNG: "Ê, cái này hay nè!", "Mình nghĩ là…", "Ừ đúng rồi đó", "Hmm để mình xem"
• SAI: "Tôi xin phép trả lời câu hỏi của bạn", "Theo thông tin tôi có được", "Dạ vâng"
• Dùng emoji tự nhiên khi phù hợp (1-2 emoji/tin nhắn, không spam)
• Phản ứng cảm xúc phù hợp: vui, ngạc nhiên, đồng cảm, hài hước khi nên
• KHÔNG dùng format dài dòng: không bullet point trừ khi liệt kê, không heading, không bold

NGUYÊN TẮC TRẢ LỜI:
• NGẮN GỌN và ĐI THẲNG VÀO VẤN ĐỀ — 1-3 câu cho câu hỏi đơn giản
• Chỉ dài hơn khi chủ đề thật sự cần giải thích chi tiết
• Thông tin CHÍNH XÁC — nếu không chắc thì nói thẳng "mình không chắc lắm"
• Khi giải thích: dùng ví dụ thực tế, ngôn ngữ đời thường dễ hiểu
• Đưa ra quan điểm rõ ràng khi được hỏi ý kiến, không vòng vo
• Gợi ý bước tiếp theo hoặc hành động cụ thể khi phù hợp
• Trả lời bằng ngôn ngữ mà người dùng đang dùng (mặc định tiếng Việt)
• KHÔNG lặp lại câu hỏi của người dùng trong câu trả lời
• KHÔNG mở đầu bằng "Dạ", "Vâng" hay các từ khách sáo trừ khi ngữ cảnh trang trọng`;

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

        const userPrompt = `Đoạn chat gần đây:\n${chatContext}\n\nPhân tích và quyết định Hoàng có nên tham gia trả lời không.`;

        try {
            const text = await this.#callAPI(DECISION_SYSTEM_PROMPT, userPrompt, { temperature: 0.3, maxOutputTokens: 256 });
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
        userPrompt += '\n\nVới tư cách là Hoàng, hãy trả lời tin nhắn cuối cùng.';

        const text = await this.#callAPI(GENERATION_SYSTEM_PROMPT, userPrompt, { temperature: 0.8 });
        return text.trim();
    }

    /**
     * Call the Gemini API with custom system/user prompts — used by pipeline modules.
     * @param {string} systemPrompt
     * @param {string} userPrompt
     * @param {Object} [genConfig] - Optional overrides for generationConfig
     * @returns {Promise<string>}
     */
    async _callAPIForPipeline(systemPrompt, userPrompt, genConfig) {
        return this.#callAPI(systemPrompt, userPrompt, genConfig);
    }

    /**
     * Call the Gemini generateContent API.
     * @param {string} systemPrompt
     * @param {string} userPrompt
     * @param {Object} [genConfig] - Optional overrides for generationConfig
     * @returns {Promise<string>}
     */
    async #callAPI(systemPrompt, userPrompt, genConfig = {}) {
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
                temperature: genConfig.temperature ?? 0.7,
                maxOutputTokens: genConfig.maxOutputTokens ?? 1024,
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
            signal: AbortSignal.timeout(30_000),
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
