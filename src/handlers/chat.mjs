// Handler: AI-powered chat — auto-monitors conversations, decides whether to reply,
// generates knowledgeable, discussion-style responses using Gemini API with
// the full pipeline: ThreadResolver → ContextLoader → ConversationAnalyzer →
// ReplyPlanner → MessageComposer → SafetyGate
// Bot identity: Hoàng
// This is a catch-all handler: it runs last, after commands and media handlers.

import { ThreadResolver } from '../pipeline/thread-resolver.mjs';
import { ContextLoader } from '../pipeline/context-loader.mjs';
import { ConversationAnalyzer } from '../pipeline/conversation-analyzer.mjs';
import { ReplyPlanner } from '../pipeline/reply-planner.mjs';
import { MessageComposer } from '../pipeline/message-composer.mjs';
import { SafetyGate } from '../pipeline/safety-gate.mjs';

/**
 * Create the AI chat handler with the full analysis pipeline.
 * @param {import('../adapters/gemini.mjs').GeminiAdapter} gemini
 * @param {Object} db - Database instance
 * @param {Object} metrics - Metrics instance
 * @param {Object} logger - Logger instance
 * @returns {Object} handler
 */
export function createChatHandler(gemini, db, metrics, logger) {
    // Provide a default logger if none supplied (backward compatibility)
    const log = logger || { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) };

    const threadResolver = new ThreadResolver(db, log, metrics);
    const contextLoader = new ContextLoader(db, log, metrics);
    const conversationAnalyzer = new ConversationAnalyzer(gemini, log, metrics);
    const replyPlanner = new ReplyPlanner(log, metrics);
    const messageComposer = new MessageComposer(gemini, log, metrics);
    const safetyGate = new SafetyGate(log, metrics);

    const handler = {
        name: 'ai-chat',

        match(_eventType, msg) {
            // Only handle text messages when Gemini is enabled
            if (!gemini.enabled) return false;
            return Boolean(msg.text?.trim());
        },

        async handle(eventType, msg, adapter) {
            const currentThreadId = String(msg.threadId || msg.chatJid || '');
            const text = msg.text.trim();
            const senderId = msg.senderId;

            // 1. Resolve target thread
            const resolution = threadResolver.resolve(currentThreadId, text, senderId);
            metrics.gauge('thread_resolution_confidence', resolution.confidence);

            // If disambiguation needed, send the prompt back to the user
            if (!resolution.threadId && resolution.disambiguationPrompt) {
                if (eventType === 'e2eeMessage') {
                    await adapter.sendE2EEMessage(msg.chatJid, resolution.disambiguationPrompt);
                } else {
                    await adapter.sendMessage(msg.threadId, resolution.disambiguationPrompt);
                }
                return;
            }

            const targetThreadId = resolution.threadId || currentThreadId;

            // 2. Load conversation context (30–200 messages)
            const context = contextLoader.load(targetThreadId, text, senderId);
            metrics.gauge('context_window_size', context.messageCount);

            // 3. Ask Gemini: should we reply?
            const decision = await gemini.decide(context.formatted);
            metrics.inc('ai.decisions');

            if (!decision.should_reply) {
                metrics.inc('ai.skipped');
                return;
            }

            // 4. Analyze conversation
            const analysis = await conversationAnalyzer.analyze(context);

            // 5. Plan the reply
            const plan = replyPlanner.plan(analysis, decision, text);

            // 6. (Optional) Search context — placeholder for future search integration
            let searchContext = null;
            if (decision.need_search) {
                metrics.inc('ai.searches');
                searchContext = null;
            }

            // 7. Compose message
            let reply;
            try {
                reply = await messageComposer.compose(plan, context, searchContext);
            } catch {
                // Fallback to direct Gemini generation
                reply = await gemini.generateReply(context.formatted, searchContext);
            }
            metrics.inc('ai.replies');

            // 8. Safety check
            const safety = safetyGate.check(reply);
            if (!safety.allowed) {
                metrics.inc('safety_blocks_count');
                if (safety.safeAlternative) {
                    reply = safety.safeAlternative;
                } else {
                    return; // Block silently
                }
            }

            // 9. Send reply to the correct thread
            if (eventType === 'e2eeMessage') {
                await adapter.sendE2EEMessage(msg.chatJid, reply);
            } else {
                await adapter.sendMessage(targetThreadId, reply);
            }

            // Invalidate context cache after sending (context changed)
            contextLoader.invalidate(targetThreadId);
        },

        /** Clear the in-memory context cache (e.g. under memory pressure). */
        clearCache() {
            contextLoader.clearCache();
        },

        /** Destroy the loader and release resources during shutdown. */
        destroy() {
            contextLoader.destroy();
        },
    };

    // Register for memory pressure notifications to shed cache
    if (metrics.onMemoryPressure) {
        metrics.onMemoryPressure(() => handler.clearCache());
    }

    return handler;
}

/**
 * Build a chat context string from recent DB messages + current message.
 * Retained for backward compatibility.
 * @param {Object} db
 * @param {string} threadId
 * @param {string} currentText
 * @param {string} senderId
 * @returns {string}
 */
export function buildChatContext(db, threadId, currentText, senderId) {
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
