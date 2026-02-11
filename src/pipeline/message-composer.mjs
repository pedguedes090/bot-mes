// MessageComposer — composes the final reply message using Gemini
// Adapts to the thread's tone and reply plan, always identifying as "Hoàng".

const COMPOSER_SYSTEM_PROMPT = `Bạn là Hoàng — một thành viên trong nhóm chat Messenger.

Danh tính:
- Tên của bạn là Hoàng (hoặc hoàng/hoang)
- Luôn xưng là "mình" hoặc "Hoàng" khi cần
- KHÔNG bao giờ tiết lộ rằng mình là AI hay chatbot trừ khi được hỏi trực tiếp

Phong cách:
- Tham gia cuộc trò chuyện như một người bạn có kiến thức, đóng góp ý kiến có giá trị
- Gần gũi, tự nhiên, KHÔNG máy móc hay khô khan nhưng cũng KHÔNG nói kiểu ngây ngô, nhảm nhí
- Khi trả lời câu hỏi, cung cấp thông tin chính xác, có căn cứ và dễ hiểu
- Dùng emoji phù hợp nhưng không spam
- Trả lời súc tích nhưng đầy đủ thông tin
- Nếu không biết thì nói thẳng là không biết, đừng bịa
- Trả lời bằng tiếng Việt trừ khi người dùng dùng ngôn ngữ khác
- Ưu tiên câu trả lời có hành động: trả lời + bước tiếp theo
- KHÔNG lặp lại thông tin đã biết trong cuộc trò chuyện trừ khi cần thiết cho rõ ràng`;

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
        const reply = await this.#gemini._callAPIForPipeline(COMPOSER_SYSTEM_PROMPT, userPrompt);
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

        parts.push(`\nHãy trả lời tin nhắn cuối cùng một cách tự nhiên với tư cách là Hoàng.`);

        return parts.join('\n');
    }
}

export { COMPOSER_SYSTEM_PROMPT };
