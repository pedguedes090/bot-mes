// ThreadResolver — resolves user intent to a target thread_id
// Uses keyword matching, recency, and topic overlap to score candidate threads.
// Returns confidence score and disambiguation candidates when ambiguous.

/**
 * @typedef {Object} ThreadCandidate
 * @property {string} threadId
 * @property {string|null} name
 * @property {number} score - 0.0–1.0 confidence
 */

/**
 * @typedef {Object} ThreadResolution
 * @property {string|null} threadId - Resolved thread ID (null if disambiguation needed)
 * @property {number} confidence - 0.0–1.0
 * @property {ThreadCandidate[]} candidates - Top candidates when ambiguous
 * @property {string|null} disambiguationPrompt - Question to ask user if confidence is low
 */

// Phrases that hint the user wants to target a different thread
const THREAD_REFERENCE_PATTERNS = [
    /reply\s+(there|in that|to that)/i,
    /send\s+(to|in)\s+(that|the)\s+(thread|group|chat)/i,
    /answer\s+(in|to)\s+(the|that)\s+(group|thread|chat)/i,
    /message\s+(them|that\s+group|that\s+thread)/i,
    /trả lời\s+(trong|ở)\s+(đó|nhóm|group)/i,
    /gửi\s+(vào|đến)\s+(nhóm|group|đó)/i,
    /nhắn\s+(vào|trong)\s+(đó|nhóm)/i,
];

const HIGH_CONFIDENCE_THRESHOLD = 0.75;
const LOW_CONFIDENCE_THRESHOLD = 0.4;
const MAX_CANDIDATES = 3;

export class ThreadResolver {
    #db;
    #logger;
    #metrics;

    /**
     * @param {Object} db - Database instance
     * @param {Object} logger - Logger instance
     * @param {Object} metrics - Metrics instance
     */
    constructor(db, logger, metrics) {
        this.#db = db;
        this.#logger = logger.child('thread-resolver');
        this.#metrics = metrics;
    }

    /**
     * Resolve the target thread for a user message.
     * @param {string} currentThreadId - The thread the message was received in
     * @param {string} messageText - The user's message text
     * @param {string} senderId - The sender's user ID
     * @returns {ThreadResolution}
     */
    resolve(currentThreadId, messageText, senderId) {
        const hasThreadReference = THREAD_REFERENCE_PATTERNS.some(p => p.test(messageText));

        // If no thread reference detected, the current thread is the target
        if (!hasThreadReference) {
            const resolution = {
                threadId: currentThreadId,
                confidence: 1.0,
                candidates: [],
                disambiguationPrompt: null,
            };
            this.#metrics.inc('thread_resolution.direct');
            this.#logger.debug('Direct thread resolution', {
                threadId: currentThreadId,
                confidence: 1.0,
            });
            return resolution;
        }

        // User referenced another thread — score candidates
        const candidates = this.#scoreCandidates(currentThreadId, messageText);
        this.#metrics.gauge('thread_resolution_confidence',
            candidates.length > 0 ? candidates[0].score : 0);

        if (candidates.length === 0) {
            this.#metrics.inc('thread_resolution.no_match');
            return {
                threadId: null,
                confidence: 0,
                candidates: [],
                disambiguationPrompt: 'Mình không tìm thấy thread phù hợp. Bạn muốn gửi tin nhắn vào thread nào?',
            };
        }

        const best = candidates[0];

        if (best.score >= HIGH_CONFIDENCE_THRESHOLD) {
            this.#metrics.inc('thread_resolution.high_confidence');
            this.#logger.debug('High-confidence thread resolution', {
                threadId: best.threadId,
                confidence: best.score,
            });
            return {
                threadId: best.threadId,
                confidence: best.score,
                candidates: candidates.slice(0, MAX_CANDIDATES),
                disambiguationPrompt: null,
            };
        }

        // Ambiguous — ask the user
        this.#metrics.inc('thread_resolution.ambiguous');
        const topCandidates = candidates.slice(0, MAX_CANDIDATES);
        const listing = topCandidates
            .map((c, i) => `${i + 1}. ${c.name || c.threadId}`)
            .join('\n');

        return {
            threadId: null,
            confidence: best.score,
            candidates: topCandidates,
            disambiguationPrompt: `Mình thấy vài thread có thể phù hợp:\n${listing}\nBạn muốn gửi vào thread nào?`,
        };
    }

    /**
     * Score candidate threads based on message text overlap.
     * @param {string} excludeThreadId - Current thread to deprioritize
     * @param {string} messageText - User's message for topic matching
     * @returns {ThreadCandidate[]}
     */
    #scoreCandidates(excludeThreadId, messageText) {
        if (!this.#db) return [];

        try {
            const threads = this.#db.listThreads(50, 0);
            const textLower = messageText.toLowerCase();
            const words = textLower.split(/\s+/).filter(w => w.length > 2);

            const scored = threads
                .filter(t => t.id !== excludeThreadId && t.enabled !== 0)
                .map(t => {
                    let score = 0;
                    const name = (t.name || '').toLowerCase();

                    // Name overlap scoring
                    if (name) {
                        for (const word of words) {
                            if (name.includes(word)) score += 0.3;
                        }
                        if (textLower.includes(name)) score += 0.4;
                    }

                    // Recency bonus (recently updated threads score higher)
                    if (t.updated_at) {
                        const age = Date.now() - new Date(t.updated_at).getTime();
                        const hoursSinceUpdate = age / (1000 * 60 * 60);
                        if (hoursSinceUpdate < 1) score += 0.2;
                        else if (hoursSinceUpdate < 24) score += 0.1;
                    }

                    // Group threads are more likely targets for "reply there"
                    if (t.is_group) score += 0.1;

                    return {
                        threadId: t.id,
                        name: t.name,
                        score: Math.min(score, 1.0),
                    };
                })
                .filter(c => c.score > LOW_CONFIDENCE_THRESHOLD)
                .sort((a, b) => b.score - a.score);

            return scored;
        } catch (err) {
            this.#logger.error('Failed to score thread candidates', { error: err.message });
            return [];
        }
    }
}

export { HIGH_CONFIDENCE_THRESHOLD, LOW_CONFIDENCE_THRESHOLD, MAX_CANDIDATES, THREAD_REFERENCE_PATTERNS };
