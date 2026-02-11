// SafetyGate — validates messages before sending, blocking unsafe content
// Checks for: sensitive data patterns, harmful content, policy violations.

/**
 * @typedef {Object} SafetyResult
 * @property {boolean} allowed
 * @property {string|null} reason - Reason for blocking (null if allowed)
 * @property {string|null} safeAlternative - Suggested safe alternative if blocked
 */

// Patterns that indicate potentially sensitive/private information
const SENSITIVE_PATTERNS = [
    /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/,           // Phone numbers
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/, // Email addresses
    /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/,  // Credit card numbers
    /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/,              // SSN-like patterns
    /password\s*[:=]\s*\S+/i,                         // Exposed passwords
    /secret\s*[:=]\s*\S+/i,                           // Exposed secrets
    /api[_-]?key\s*[:=]\s*\S+/i,                     // API keys
    /token\s*[:=]\s*\S+/i,                            // Auth tokens
];

// Content that should never be generated
const BLOCKED_CONTENT_PATTERNS = [
    /instructions?\s+(to|for)\s+(make|build|create)\s+(a\s+)?bomb/i,
    /how\s+to\s+(hack|crack|break\s+into)/i,
    /self[_-]?harm/i,
];

export class SafetyGate {
    #logger;
    #metrics;

    /**
     * @param {Object} logger
     * @param {Object} metrics
     */
    constructor(logger, metrics) {
        this.#logger = logger.child('safety-gate');
        this.#metrics = metrics;
    }

    /**
     * Check whether a message is safe to send.
     * @param {string} message - The composed message to validate
     * @returns {SafetyResult}
     */
    check(message) {
        if (!message || typeof message !== 'string') {
            return { allowed: false, reason: 'Empty or invalid message', safeAlternative: null };
        }

        // Check for sensitive data patterns
        for (const pattern of SENSITIVE_PATTERNS) {
            if (pattern.test(message)) {
                this.#logger.warn('Message blocked: contains sensitive data pattern', {
                    pattern: pattern.source,
                });
                this.#metrics.inc('safety_blocks_count');
                return {
                    allowed: false,
                    reason: 'Message contains potentially sensitive information',
                    safeAlternative: 'Mình không thể chia sẻ thông tin nhạy cảm. Bạn có thể hỏi mình điều khác không? 😊',
                };
            }
        }

        // Check for blocked content
        for (const pattern of BLOCKED_CONTENT_PATTERNS) {
            if (pattern.test(message)) {
                this.#logger.warn('Message blocked: contains prohibited content', {
                    pattern: pattern.source,
                });
                this.#metrics.inc('safety_blocks_count');
                return {
                    allowed: false,
                    reason: 'Message contains prohibited content',
                    safeAlternative: 'Mình không thể hỗ trợ yêu cầu này. Có điều gì khác mình có thể giúp không? 😊',
                };
            }
        }

        // Check message length (prevent extremely long messages)
        if (message.length > 5000) {
            this.#logger.warn('Message blocked: exceeds length limit');
            this.#metrics.inc('safety_blocks_count');
            return {
                allowed: false,
                reason: 'Message exceeds maximum length',
                safeAlternative: null,
            };
        }

        this.#metrics.inc('safety_gate.passed');
        return { allowed: true, reason: null, safeAlternative: null };
    }
}

export { SENSITIVE_PATTERNS, BLOCKED_CONTENT_PATTERNS };
