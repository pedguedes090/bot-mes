// ReplyPlanner — takes analysis context + user request → produces a reply plan
// Identifies: action type, key points to address, appropriate tone, length guidance.

/**
 * @typedef {Object} ReplyPlan
 * @property {string} action - answer_question | propose_next_step | clarify_missing_info | summarize | greet | discuss
 * @property {string[]} keyPoints - Points the reply should cover
 * @property {string} tone - Target tone (formal, casual, mixed)
 * @property {string} lengthGuidance - concise | medium | detailed
 * @property {boolean} includeGreeting - Whether to start with a greeting
 * @property {string[]} avoidRepeating - Facts already known in the thread
 * @property {string|null} searchQuery - If search is needed, the query
 */

export class ReplyPlanner {
    #logger;
    #metrics;

    /**
     * @param {Object} logger
     * @param {Object} metrics
     */
    constructor(logger, metrics) {
        this.#logger = logger.child('reply-planner');
        this.#metrics = metrics;
    }

    /**
     * Create a reply plan based on conversation analysis and decision.
     * @param {import('./conversation-analyzer.mjs').AnalysisResult} analysis
     * @param {Object} decision - Gemini decision {should_reply, need_search, reason}
     * @param {string} currentMessage - The triggering message
     * @returns {ReplyPlan}
     */
    plan(analysis, decision, currentMessage) {
        const action = this.#determineAction(analysis);
        const keyPoints = this.#extractKeyPoints(analysis, currentMessage);
        const lengthGuidance = this.#determineLengthGuidance(analysis, action);
        const includeGreeting = this.#shouldGreet(analysis);

        const plan = {
            action,
            keyPoints,
            tone: analysis.tone || 'casual',
            lengthGuidance,
            includeGreeting,
            avoidRepeating: analysis.decisionsMade || [],
            searchQuery: decision.need_search ? currentMessage : null,
        };

        this.#logger.debug('Reply plan created', { action, tone: plan.tone, length: lengthGuidance });
        this.#metrics.inc(`reply_planner.action.${action}`);
        return plan;
    }

    /**
     * Determine the primary action for the reply.
     */
    #determineAction(analysis) {
        if (analysis.intent === 'greeting') return 'greet';
        if (analysis.intent === 'question') {
            if (analysis.unresolvedItems.length > 0) return 'answer_question';
            return 'answer_question';
        }
        if (analysis.unresolvedItems.length > 0) return 'clarify_missing_info';
        if (analysis.questionsAsked.length > 0) return 'answer_question';
        if (analysis.decisionsMade.length > 0) return 'propose_next_step';
        return 'discuss';
    }

    /**
     * Extract key points the reply should address.
     */
    #extractKeyPoints(analysis, currentMessage) {
        const points = [];

        // Add unresolved questions
        if (analysis.questionsAsked.length > 0) {
            points.push(`Trả lời câu hỏi: ${analysis.questionsAsked[analysis.questionsAsked.length - 1]}`);
        }

        // Add unresolved items
        for (const item of analysis.unresolvedItems.slice(0, 2)) {
            points.push(`Giải quyết: ${item}`);
        }

        // If no specific points, address the current message
        if (points.length === 0) {
            points.push(`Phản hồi: ${currentMessage.slice(0, 100)}`);
        }

        return points;
    }

    /**
     * Determine how long the reply should be.
     */
    #determineLengthGuidance(analysis, action) {
        if (action === 'greet') return 'concise';
        if (action === 'summarize') return 'detailed';
        if (analysis.messageCount > 50) return 'medium';
        return 'concise';
    }

    /**
     * Determine if a greeting is appropriate.
     */
    #shouldGreet(analysis) {
        // Greet if the conversation just started or it's a greeting intent
        if (analysis.intent === 'greeting') return true;
        if (analysis.messageCount <= 2) return true;
        return false;
    }
}
