// ConversationAnalyzer — analyzes conversation messages into structured context
// Detects: user intent, questions asked, decisions made, unresolved items,
// tone (formal/casual), and key entities (people, dates, products, numbers).

/**
 * @typedef {Object} AnalysisResult
 * @property {string} intent - Detected user intent (question, request, discussion, greeting)
 * @property {string} tone - Conversation tone (formal, casual, mixed)
 * @property {string[]} questionsAsked - Unresolved questions in the conversation
 * @property {string[]} decisionsMade - Decisions already reached
 * @property {string[]} unresolvedItems - Items needing resolution
 * @property {Object} entities - Key entities: {people: string[], dates: string[], products: string[], numbers: string[]}
 * @property {string} summary - Brief conversation summary
 * @property {number} confidence - Analysis confidence 0.0–1.0
 */

const ANALYSIS_SYSTEM_PROMPT = `Bạn là Hoàng — module phân tích hội thoại.
Nhiệm vụ: đọc đoạn chat và trả về JSON phân tích.

Luôn trả về JSON hợp lệ duy nhất, KHÔNG kèm markdown hay giải thích:
{
  "intent": "question|request|discussion|greeting|other",
  "tone": "formal|casual|mixed",
  "questions_asked": ["..."],
  "decisions_made": ["..."],
  "unresolved_items": ["..."],
  "entities": {
    "people": ["..."],
    "dates": ["..."],
    "products": ["..."],
    "numbers": ["..."]
  },
  "summary": "<tóm tắt ngắn 1-2 câu>",
  "confidence": 0.0-1.0
}

Quy tắc:
- Phân tích chính xác ngữ cảnh cuộc trò chuyện
- Xác định câu hỏi chưa được trả lời
- Nhận diện quyết định đã được đưa ra
- Phát hiện các mục chưa giải quyết
- Đánh giá giọng điệu tổng thể (formal/casual/mixed)
- Trích xuất thực thể quan trọng`;

export class ConversationAnalyzer {
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
        this.#logger = logger.child('conversation-analyzer');
        this.#metrics = metrics;
    }

    /**
     * Analyze conversation context.
     * @param {import('./context-loader.mjs').LoadedContext} context
     * @returns {Promise<AnalysisResult>}
     */
    async analyze(context) {
        // For small contexts, use lightweight heuristic analysis
        if (context.messageCount <= 3) {
            return this.#quickAnalysis(context);
        }

        // For larger contexts, use Gemini
        if (!this.#gemini.enabled) {
            return this.#quickAnalysis(context);
        }

        try {
            const result = await this.#geminiAnalysis(context);
            this.#metrics.inc('conversation_analysis.gemini');
            return result;
        } catch (err) {
            this.#logger.error('Gemini analysis failed, falling back to heuristic', {
                error: err.message,
            });
            this.#metrics.inc('conversation_analysis.fallback');
            return this.#quickAnalysis(context);
        }
    }

    /**
     * Quick heuristic analysis without AI.
     * @param {import('./context-loader.mjs').LoadedContext} context
     * @returns {AnalysisResult}
     */
    #quickAnalysis(context) {
        const messages = context.messages;
        const lastMsg = messages[messages.length - 1];
        const allText = messages.map(m => m.text).join(' ');

        // Detect intent
        const hasQuestion = /\?|hỏi|sao|gì|nào|không|bao giờ|ở đâu|tại sao|what|how|why|when|where/i.test(
            lastMsg?.text || ''
        );
        const hasGreeting = /hello|hi|hey|chào|xin chào|yo|alo/i.test(lastMsg?.text || '');

        let intent = 'discussion';
        if (hasQuestion) intent = 'question';
        else if (hasGreeting) intent = 'greeting';

        // Detect tone
        const hasFormalMarkers = /kính|thưa|xin|vui lòng|please|dear|regards/i.test(allText);
        const hasCasualMarkers = /oke|ok|bro|bạn ơi|á|ạ|nha|nhé|lol|haha|😂|🤣/i.test(allText);
        let tone = 'mixed';
        if (hasFormalMarkers && !hasCasualMarkers) tone = 'formal';
        else if (hasCasualMarkers && !hasFormalMarkers) tone = 'casual';

        // Extract questions
        const questionsAsked = messages
            .filter(m => /\?/.test(m.text))
            .map(m => m.text)
            .slice(-3);

        // Unique senders as "people"
        const people = [...new Set(messages.map(m => m.senderId))];

        // Extract numbers
        const numbers = allText.match(/\d+[\d.,]*/g) || [];

        return {
            intent,
            tone,
            questionsAsked,
            decisionsMade: [],
            unresolvedItems: questionsAsked.length > 0 ? ['Pending questions'] : [],
            entities: { people, dates: [], products: [], numbers: [...new Set(numbers)].slice(0, 5) },
            summary: `${messages.length} messages in conversation. Last message by ${lastMsg?.senderId || 'unknown'}.`,
            confidence: 0.5,
        };
    }

    /**
     * Full AI-powered analysis via Gemini.
     * @param {import('./context-loader.mjs').LoadedContext} context
     * @returns {Promise<AnalysisResult>}
     */
    async #geminiAnalysis(context) {
        const userPrompt = `Đoạn chat cần phân tích:\n${context.formatted}\n\nHãy phân tích cuộc hội thoại này.`;

        const text = await this.#gemini._callAPIForPipeline(ANALYSIS_SYSTEM_PROMPT, userPrompt);
        const parsed = this.#parseJSON(text);

        return {
            intent: String(parsed.intent || 'discussion'),
            tone: String(parsed.tone || 'mixed'),
            questionsAsked: Array.isArray(parsed.questions_asked) ? parsed.questions_asked : [],
            decisionsMade: Array.isArray(parsed.decisions_made) ? parsed.decisions_made : [],
            unresolvedItems: Array.isArray(parsed.unresolved_items) ? parsed.unresolved_items : [],
            entities: {
                people: Array.isArray(parsed.entities?.people) ? parsed.entities.people : [],
                dates: Array.isArray(parsed.entities?.dates) ? parsed.entities.dates : [],
                products: Array.isArray(parsed.entities?.products) ? parsed.entities.products : [],
                numbers: Array.isArray(parsed.entities?.numbers) ? parsed.entities.numbers : [],
            },
            summary: String(parsed.summary || ''),
            confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.7,
        };
    }

    /**
     * Parse JSON from Gemini response (strips markdown fences).
     */
    #parseJSON(text) {
        let cleaned = text.trim();
        if (cleaned.startsWith('```')) {
            cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
        }
        return JSON.parse(cleaned);
    }
}

export { ANALYSIS_SYSTEM_PROMPT };
