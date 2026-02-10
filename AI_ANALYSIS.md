# AI System Analysis — meta-messenger-bot

## 1. AI Components and Modules

- **GeminiAdapter** (`src/adapters/gemini.mjs`)
  - Core adapter interfacing with the Google Generative Language API (Gemini).
  - Encapsulates API key management, model selection, HTTP communication, and response parsing.
  - Exposes two public methods: `decide()` and `generateReply()`.

- **AI Chat Handler** (`src/handlers/chat.mjs`)
  - Application-layer handler that orchestrates the AI conversation flow.
  - Bridges the Gemini adapter with the bot's message pipeline, database, and metrics.
  - Includes a `buildChatContext()` helper that assembles conversation history from the database.

- **System Prompts** (embedded in `src/adapters/gemini.mjs`)
  - `DECISION_SYSTEM_PROMPT` — Vietnamese-language prompt instructing the model to act as a gatekeeper, deciding whether the bot should reply and whether a web search is needed.
  - `GENERATION_SYSTEM_PROMPT` — Vietnamese-language prompt defining the bot's personality as a Gen-Z Vietnamese conversationalist.

## 2. Purpose and Role of Each AI Component

- **GeminiAdapter**
  - **Decision phase** (`decide()`): Receives recent chat context and asks the Gemini model whether the bot should reply. Returns a structured JSON object with `should_reply`, `need_search`, and `reason` fields.
  - **Generation phase** (`generateReply()`): Given the same chat context (and optional search results), generates a natural-language reply in Gen-Z Vietnamese style.
  - **Runtime configuration** (`configure()`): Allows hot-swapping the API key and model name via the admin dashboard without restarting the bot.
  - **Graceful degradation** (`enabled` getter): Returns `false` when no API key is configured, allowing the rest of the bot to operate without AI.

- **AI Chat Handler**
  - **Match logic**: Activates only when Gemini is enabled and the incoming message contains non-empty text. Registered last in the handler chain, making it a catch-all after commands and media handlers.
  - **Orchestration**: Coordinates the two-phase AI pipeline — decision, then generation — and routes the reply to the correct messaging channel (standard or E2EE).
  - **Context assembly**: Fetches the 10 most recent messages from the database for the active thread and appends the current message to build a coherent chat context string.
  - **Metrics instrumentation**: Increments counters for `ai.decisions`, `ai.replies`, `ai.skipped`, and `ai.searches`.

- **System Prompts**
  - Define the behavioral contract between the application and the Gemini model.
  - The decision prompt enforces structured JSON output for reliable parsing.
  - The generation prompt establishes tone, language, and personality constraints.

## 3. AI Integration in the System Architecture

- **Entry point**: `src/main.mjs` instantiates `GeminiAdapter` with the API key and model from the environment configuration, then passes it to `buildHandlers()`.
- **Handler chain** (defined in `src/handlers/index.mjs`):
  1. `CommandHandler` — explicit `!`-prefixed commands (highest priority)
  2. `MediaHandler` — auto-detects Instagram/TikTok/Facebook links
  3. `PingHandler` — legacy bare "ping" response
  4. `ChatHandler` (AI) — catch-all for remaining text messages (lowest priority)
- **First-match-wins dispatch**: `BotCore` (`src/bot/core.mjs`) iterates handlers in order; the first handler whose `match()` returns `true` processes the message. This ensures AI does not interfere with explicit commands or media downloads.
- **Database integration**: The chat handler reads recent messages from SQLite via `db.getMessages()` to provide conversational context to the AI.
- **Dashboard integration**: The admin dashboard (`/api/env`) can update `GEMINI_API_KEY` and `GEMINI_MODEL` at runtime, which triggers `gemini.configure()` to apply changes without a restart.
- **Observability**: AI activity is tracked through the `Metrics` class, exposing counters at the `/metrics` endpoint for monitoring decision rates, reply rates, and skip rates.

## 4. Data Flow Analysis

### Input
1. A Facebook Messenger message arrives via `meta-messenger.js` (event: `message` or `e2eeMessage`).
2. `BotCore` performs deduplication, blocked-user checks, and persists the message to SQLite.
3. The message reaches `ChatHandler.match()`, which checks `gemini.enabled` and that `msg.text` is non-empty.

### Processing
4. `buildChatContext()` queries the database for the 10 most recent messages in the thread and concatenates them with the current message into a formatted string:
   ```
   [senderId1]: message text 1
   [senderId2]: message text 2
   ...
   [currentUser]: current message
   ```
5. **Decision call**: The context string is sent to the Gemini API with `DECISION_SYSTEM_PROMPT`. The model returns JSON:
   ```json
   { "should_reply": true, "need_search": false, "reason": "..." }
   ```
6. If `should_reply` is `false`, the handler returns early (metric: `ai.skipped`).
7. If `need_search` is `true`, a search context placeholder is prepared (currently unimplemented; always `null`).
8. **Generation call**: The context string (plus optional search context) is sent to the Gemini API with `GENERATION_SYSTEM_PROMPT`. The model returns a natural-language reply.

### Output
9. The generated reply text is sent back to the originating thread via `adapter.sendMessage()` or `adapter.sendE2EEMessage()` depending on the encryption mode.
10. Metrics counters are incremented (`ai.decisions`, `ai.replies`).

## 5. Strengths and Limitations

### Strengths
- **Two-phase architecture**: Separating the decision ("should the bot reply?") from generation ("what should it say?") avoids unnecessary API calls and reduces costs when the bot determines it should stay silent.
- **Graceful degradation**: The bot operates fully without an API key — AI features are simply disabled, and other handlers (commands, media, ping) continue to function.
- **Contextual awareness**: Fetching recent thread history provides the model with conversational context, improving response relevance.
- **Runtime reconfiguration**: API key and model can be changed via the admin dashboard without downtime.
- **First-match-wins handler ordering**: Ensures explicit commands always take priority over AI, preventing the AI from intercepting bot commands or media links.
- **Error isolation**: API failures in the decision phase return a safe default (`should_reply: false`), preventing the bot from crashing or sending erroneous replies.
- **Idempotency and backpressure**: Ring-buffer deduplication and concurrency limits in `BotCore` prevent duplicate or overwhelming AI calls.

### Limitations
- **No conversation memory beyond 10 messages**: The context window is fixed at the 10 most recent messages per thread, which may be insufficient for long or complex conversations.
- **Search integration is a placeholder**: The `need_search` decision field is parsed but the search functionality is not implemented (`searchContext` is always `null`).
- **Single-model dependency**: The system relies exclusively on Google Gemini. There is no fallback to an alternative model or provider if the Gemini API is unavailable.
- **No response caching**: Identical or near-identical questions within the same thread produce separate API calls, with no deduplication at the AI layer.
- **No token/cost tracking**: There is no mechanism to track API token usage or enforce spending limits.
- **Fixed generation parameters**: Temperature (0.9) and max output tokens (1024) are hardcoded and cannot be adjusted without code changes.
- **No user-level personalization**: The AI treats all users identically; there is no per-user preference, history, or personality adaptation.
- **JSON parsing fragility**: The decision phase relies on the model returning valid JSON. While markdown fence stripping is implemented, other malformed responses could cause parse failures.

## 6. Potential Risks, Edge Cases, and Failure Scenarios

- **API key exposure**: The `GEMINI_API_KEY` is listed in `EDITABLE_ENV_KEYS` and is accessible via the `/api/env` dashboard endpoint. If the dashboard is exposed without authentication, the API key could be leaked.
- **Prompt injection**: A malicious user could craft a message that manipulates the system prompts, causing the bot to reveal its instructions, behave inappropriately, or bypass the decision gate.
- **Rate limiting by Gemini API**: High message volume could exhaust the Gemini API quota, causing all AI replies to fail. The bot handles this gracefully (returns `should_reply: false` on error), but users would experience silent failures.
- **Malformed JSON from the model**: If the Gemini model returns invalid JSON in the decision phase, the `#parseJSON()` method throws, and the error handler defaults to `should_reply: false`. This is safe but means a model regression could silently disable AI replies.
- **E2EE message context gaps**: End-to-end encrypted messages may not always be stored in the database with full metadata, potentially resulting in incomplete chat context for AI decisions.
- **Concurrent handler race conditions**: While `BotCore` enforces a concurrency limit, rapid sequential messages in the same thread could lead to overlapping AI calls with slightly different context windows, producing inconsistent replies.
- **Cold-start latency**: The first API call after deployment may have higher latency due to network connection setup, potentially causing the handler to time out (default: 30 seconds).
- **Language mismatch**: The system prompts are in Vietnamese and instruct the model to reply in Vietnamese. If a user writes in another language, the generation prompt says to match the user's language, but the decision prompt may not correctly evaluate relevance in non-Vietnamese conversations.

## 7. Suggested Improvements and Optimizations

- **Implement web search integration**: Complete the `need_search` pipeline by integrating a search API (e.g., Google Custom Search, Brave Search) to provide factual, up-to-date information when the model requests it.
- **Add a fallback AI provider**: Introduce support for an alternative model (e.g., OpenAI GPT, Anthropic Claude) to provide redundancy if the Gemini API is unavailable.
- **Make generation parameters configurable**: Expose `temperature`, `maxOutputTokens`, and `topP` as environment variables or dashboard settings to allow runtime tuning without code changes.
- **Implement response caching**: Cache AI responses for identical or semantically similar queries within a short time window (e.g., 5 minutes) to reduce API calls and costs.
- **Add token usage tracking**: Log and expose token consumption metrics (input tokens, output tokens) per API call to enable cost monitoring and budget enforcement.
- **Expand context window dynamically**: Instead of a fixed 10-message history, adapt the context size based on the model's token limit, allowing longer conversations to be captured when possible.
- **Add prompt injection defenses**: Implement input sanitization or a secondary validation step to detect and neutralize prompt injection attempts before they reach the model.
- **Secure the dashboard**: Add authentication (e.g., API key header, basic auth) to the dashboard API endpoints to prevent unauthorized access to configuration and sensitive data like the Gemini API key.
- **Implement per-user or per-thread AI settings**: Allow administrators to enable or disable AI replies on a per-thread basis, or configure different response styles for different contexts.
- **Add structured logging for AI calls**: Log decision and generation latencies, token counts, and model responses (with PII redaction) to enable debugging and performance analysis.
- **Retry with exponential backoff**: Add retry logic with exponential backoff to the `#callAPI()` method to handle transient Gemini API failures more gracefully.
