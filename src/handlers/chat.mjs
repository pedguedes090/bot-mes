// Handler: AI-powered chat — auto-monitors conversations, decides whether to reply,
// generates knowledgeable, discussion-style responses using Gemini API
// This is a catch-all handler: it runs last, after commands and media handlers.

/**
 * Create the AI chat handler.
 * @param {import('../adapters/gemini.mjs').GeminiAdapter} gemini
 * @param {Object} db - Database instance
 * @param {Object} metrics - Metrics instance
 * @returns {Object} handler
 */
export function createChatHandler(gemini, db, metrics) {
    return {
        name: 'ai-chat',

        match(_eventType, msg) {
            // Only handle text messages when Gemini is enabled
            if (!gemini.enabled) return false;
            return Boolean(msg.text?.trim());
        },

        async handle(eventType, msg, adapter) {
            const threadId = String(msg.threadId || msg.chatJid || '');
            const text = msg.text.trim();

            // 1. Build chat context from recent messages
            const chatContext = buildChatContext(db, threadId, text, msg.senderId);

            // 2. Ask Gemini: should we reply?
            const decision = await gemini.decide(chatContext);
            metrics.inc('ai.decisions');

            if (!decision.should_reply) {
                metrics.inc('ai.skipped');
                return;
            }

            // 3. (Optional) Search context — placeholder for future search integration
            let searchContext = null;
            if (decision.need_search) {
                metrics.inc('ai.searches');
                // Future: implement web search / knowledge base query
                searchContext = null;
            }

            // 4. Generate reply
            const reply = await gemini.generateReply(chatContext, searchContext);
            metrics.inc('ai.replies');

            // 5. Send reply to the correct thread
            if (eventType === 'e2eeMessage') {
                await adapter.sendE2EEMessage(msg.chatJid, reply);
            } else {
                await adapter.sendMessage(msg.threadId, reply);
            }
        },
    };
}

/**
 * Build a chat context string from recent DB messages + current message.
 * @param {Object} db
 * @param {string} threadId
 * @param {string} currentText
 * @param {string} senderId
 * @returns {string}
 */
function buildChatContext(db, threadId, currentText, senderId) {
    const lines = [];

    if (db && threadId) {
        try {
            const recent = db.getMessages(threadId, 10);
            // Messages are returned newest-first, reverse for chronological order
            for (let i = recent.length - 1; i >= 0; i--) {
                const m = recent[i];
                const sender = m.sender_id || 'unknown';
                if (m.text) {
                    lines.push(`[${sender}]: ${m.text}`);
                }
            }
        } catch {
            // DB errors should not break the handler
        }
    }

    // Append current message (may already be in DB, but ensures it's included)
    lines.push(`[${senderId || 'user'}]: ${currentText}`);

    return lines.join('\n');
}
