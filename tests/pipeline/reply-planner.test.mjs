import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ReplyPlanner } from '../../src/pipeline/reply-planner.mjs';

function createLogger() {
    return {
        child: () => createLogger(),
        debug() {}, info() {}, warn() {}, error() {},
    };
}

function createMetrics() {
    return { inc: mock.fn(), gauge: mock.fn() };
}

describe('ReplyPlanner', () => {
    it('plans greeting action for greeting intent', () => {
        const planner = new ReplyPlanner(createLogger(), createMetrics());
        const analysis = {
            intent: 'greeting',
            tone: 'casual',
            questionsAsked: [],
            decisionsMade: [],
            unresolvedItems: [],
            entities: { people: [], dates: [], products: [], numbers: [] },
            summary: '',
            confidence: 0.8,
        };
        const decision = { should_reply: true, need_search: false, reason: 'greeting' };

        const plan = planner.plan(analysis, decision, 'chào mọi người');

        assert.strictEqual(plan.action, 'greet');
        assert.strictEqual(plan.includeGreeting, true);
        assert.strictEqual(plan.lengthGuidance, 'concise');
    });

    it('plans answer_question action for question intent', () => {
        const planner = new ReplyPlanner(createLogger(), createMetrics());
        const analysis = {
            intent: 'question',
            tone: 'casual',
            questionsAsked: ['What time is the meeting?'],
            decisionsMade: [],
            unresolvedItems: ['Meeting time'],
            entities: { people: [], dates: [], products: [], numbers: [] },
            summary: '',
            confidence: 0.8,
        };
        const decision = { should_reply: true, need_search: false, reason: 'question asked' };

        const plan = planner.plan(analysis, decision, 'What time is the meeting?');

        assert.strictEqual(plan.action, 'answer_question');
        assert.ok(plan.keyPoints.length > 0);
    });

    it('includes search query when search is needed', () => {
        const planner = new ReplyPlanner(createLogger(), createMetrics());
        const analysis = {
            intent: 'question',
            tone: 'casual',
            questionsAsked: ['What is the weather?'],
            decisionsMade: [],
            unresolvedItems: [],
            entities: { people: [], dates: [], products: [], numbers: [] },
            summary: '',
            confidence: 0.7,
        };
        const decision = { should_reply: true, need_search: true, reason: 'needs search' };

        const plan = planner.plan(analysis, decision, 'What is the weather?');

        assert.strictEqual(plan.searchQuery, 'What is the weather?');
    });

    it('sets avoidRepeating from decisions already made', () => {
        const planner = new ReplyPlanner(createLogger(), createMetrics());
        const analysis = {
            intent: 'discussion',
            tone: 'formal',
            questionsAsked: [],
            decisionsMade: ['Use React for the frontend', 'Deploy on Friday'],
            unresolvedItems: [],
            entities: { people: [], dates: [], products: [], numbers: [] },
            summary: '',
            confidence: 0.9,
        };
        const decision = { should_reply: true, need_search: false, reason: 'discussion' };

        const plan = planner.plan(analysis, decision, 'What about the backend?');

        assert.deepStrictEqual(plan.avoidRepeating, ['Use React for the frontend', 'Deploy on Friday']);
    });

    it('plans clarify_missing_info when there are unresolved items', () => {
        const planner = new ReplyPlanner(createLogger(), createMetrics());
        const analysis = {
            intent: 'discussion',
            tone: 'casual',
            questionsAsked: [],
            decisionsMade: [],
            unresolvedItems: ['Budget not decided', 'Timeline unclear'],
            entities: { people: [], dates: [], products: [], numbers: [] },
            summary: '',
            confidence: 0.7,
        };
        const decision = { should_reply: true, need_search: false, reason: 'needs clarity' };

        const plan = planner.plan(analysis, decision, 'What do we do next?');

        assert.strictEqual(plan.action, 'clarify_missing_info');
    });

    it('tracks action metrics', () => {
        const metrics = createMetrics();
        const planner = new ReplyPlanner(createLogger(), metrics);
        const analysis = {
            intent: 'greeting',
            tone: 'casual',
            questionsAsked: [],
            decisionsMade: [],
            unresolvedItems: [],
            entities: { people: [], dates: [], products: [], numbers: [] },
            summary: '',
            confidence: 0.8,
        };
        const decision = { should_reply: true, need_search: false, reason: '' };

        planner.plan(analysis, decision, 'hi');

        const incCalls = metrics.inc.mock.calls.map(c => c.arguments[0]);
        assert.ok(incCalls.includes('reply_planner.action.greet'));
    });
});
