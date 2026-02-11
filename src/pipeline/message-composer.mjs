// MessageComposer — composes the final reply message using Gemini
// Adapts to the thread's tone and reply plan, always identifying as "Hoàng".

const COMPOSER_SYSTEM_PROMPT = `Bạn là Hoàng — viết tin nhắn trả lời trong nhóm chat Messenger.

QUY TẮC BẮT BUỘC:
• Xưng "mình" hoặc "Hoàng", nói chuyện như người thật
• KHÔNG tiết lộ là AI/chatbot
• Tuân thủ chính xác kế hoạch trả lời được cung cấp (hành động, giọng điệu, độ dài)
• Trả lời bằng ngôn ngữ người dùng đang dùng (mặc định tiếng Việt)

PHONG CÁCH:
• Tự nhiên, gần gũi — như đang chat với bạn bè
• Emoji vừa phải (1-2 cái khi phù hợp)
• KHÔNG format phức tạp (không heading, không bold, hạn chế bullet point)
• KHÔNG mở đầu bằng "Dạ/Vâng" trừ ngữ cảnh trang trọng
• KHÔNG lặp lại thông tin đã có trong cuộc trò chuyện

NỘI DUNG:
• Thông tin chính xác, có căn cứ — không bịa đặt
• Đi thẳng vào vấn đề, không vòng vo
• Khi giải thích: ví dụ thực tế, ngôn ngữ dễ hiểu
• Quan điểm rõ ràng khi được hỏi ý kiến
• Gợi ý bước tiếp theo khi phù hợp
• Không chắc → nói thẳng "mình không chắc lắm"

CHỈ trả về nội dung tin nhắn, KHÔNG giải thích hay ghi chú thêm.`;

export class MessageComposer {
    #gemini;
    #logger;
    #metrics;

    /**
     * @param {import('../adapters/gemini.mjs').GeminiAdapter} gemini
     * @param {Object} logger
     * @param {Object} metrics
     */
    constructor(gemini, logger, metrics) {
        this.#gemini = gemini;
        this.#logger = logger.child('message-composer');
        this.#metrics = metrics;
    }

    /**
     * Compose a reply message based on the plan and context.
     * @param {import('./reply-planner.mjs').ReplyPlan} plan
     * @param {import('./context-loader.mjs').LoadedContext} context
     * @param {string} [searchContext] - Optional search results
     * @returns {Promise<string>}
     */
    async compose(plan, context, searchContext) {
        if (!this.#gemini.enabled) {
            throw new Error('Gemini not available for message composition');
        }

        const userPrompt = this.#buildPrompt(plan, context, searchContext);
        const reply = await this.#gemini._callAPIForPipeline(COMPOSER_SYSTEM_PROMPT, userPrompt, { temperature: 0.8 });
        const trimmed = reply.trim();

        this.#logger.debug('Message composed', {
            action: plan.action,
            replyLength: trimmed.length,
        });
        this.#metrics.inc('message_composer.generated');

        return trimmed;
    }

    /**
     * Build the user prompt for Gemini based on the plan.
     */
    #buildPrompt(plan, context, searchContext) {
        const parts = [];

        parts.push(`Đoạn chat gần đây:\n${context.formatted}`);

        if (searchContext) {
            parts.push(`\nThông tin bổ sung từ tìm kiếm:\n${searchContext}`);
        }

        parts.push(`\nKế hoạch trả lời:`);
        parts.push(`- Hành động: ${plan.action}`);
        parts.push(`- Giọng điệu: ${plan.tone}`);
        parts.push(`- Độ dài: ${plan.lengthGuidance}`);

        if (plan.keyPoints.length > 0) {
            parts.push(`- Điểm chính cần đề cập: ${plan.keyPoints.join('; ')}`);
        }

        if (plan.avoidRepeating.length > 0) {
            parts.push(`- Tránh lặp lại: ${plan.avoidRepeating.join('; ')}`);
        }

        if (plan.includeGreeting) {
            parts.push(`- Bắt đầu bằng lời chào ngắn nếu phù hợp`);
        }

        parts.push(`\nDựa trên kế hoạch trên, viết tin nhắn trả lời với tư cách là Hoàng. CHỈ trả về nội dung tin nhắn.`);

        return parts.join('\n');
    }
}

export { COMPOSER_SYSTEM_PROMPT };
