# System Performance & Architecture Analysis — meta-messenger-bot

> Generated: 2026-02-11 | Scope: Full repository static analysis
> Covers: all source files, adapters, handlers, pipeline, commands, dashboard, observability, tests

---

## A) Executive Summary

### Top 3 Performance Risks
1. **Media download OOM** — `downloadBuffer()` previously called `res.arrayBuffer()` which could allocate unbounded memory when `Content-Length` is absent or lying. **Fixed**: now uses streaming with per-chunk size enforcement.
2. **WAL checkpoint blocks event loop** — `PRAGMA wal_checkpoint(TRUNCATE)` in `database.mjs:#runMaintenance()` is synchronous and can stall the main thread for 100ms–2s on large WAL files, blocking all message processing.
3. **Redundant DB calls per message** — Every incoming message from a known user triggered two synchronous SQLite calls (`getUser` + `ensureUser`) in `BotCore.#dispatch()`. **Fixed**: skips the second call when user already exists.

### Top 3 Memory-Leak / Memory-Growth Risks
1. **ContextLoader cache** — Stores up to 50 threads × 200 messages each. Under sustained traffic this can hold ~10–50 MB of formatted context strings in memory. Properly bounded with TTL + LRU eviction but still the largest in-memory data structure.
2. **Dashboard HTML constant** — The `DASHBOARD_HTML` string literal (~15 KB) is allocated once and retained for the process lifetime. Not a leak, but a permanent allocation.
3. **No explicit cleanup of pipeline module instances** — `ThreadResolver`, `ContextLoader`, `ConversationAnalyzer`, `ReplyPlanner`, `MessageComposer`, `SafetyGate` are instantiated once in `createChatHandler()` and live forever. **Partially fixed**: `ContextLoader.destroy()` added for explicit cache cleanup during shutdown.

### Top 3 Architecture / Structure Issues Blocking Extensibility
1. **Handler chain is hardcoded** — Adding/removing handlers requires editing `src/handlers/index.mjs`. No plugin system or dynamic registration.
2. **Dashboard has no authentication** — All API endpoints are publicly accessible. Any network exposure leaks user data, thread data, and configuration.
3. **Single AI provider** — Gemini is the only AI backend; no adapter interface for swapping providers (OpenAI, Anthropic, local models).

---

## B) System Map

### Component Diagram

```
                    ┌──────────────────┐
                    │   .env / Config   │
                    │ src/config/       │
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │     main.mjs     │  ← Entrypoint
                    └──┬──┬──┬──┬──┬──┘
                       │  │  │  │  │
        ┌──────────────┘  │  │  │  └───────────────┐
        ▼                 ▼  │  ▼                   ▼
┌──────────────┐ ┌──────────┐│┌──────────┐ ┌──────────────┐
│MessengerAdapt│ │ Database ││ │  Gemini  │ │   Metrics    │
│  er (WS)     │ │ (SQLite) │││ Adapter  │ │  + HTTP Srv  │
│src/adapters/ │ │src/adapt/│││src/adapt/ │ │src/observ/   │
│messenger.mjs │ │database  │││gemini.mjs│ │metrics.mjs   │
└──────┬───────┘ └──────────┘│└──────────┘ └──────┬───────┘
       │                     │                     │
       │  ┌──────────────────┘                     │
       ▼  ▼                                        ▼
┌─────────────────────┐                 ┌──────────────────┐
│      BotCore        │                 │    Dashboard     │
│   src/bot/core.mjs  │                 │ src/dashboard/   │
│  - Dedup ring buffer│                 │  handler.mjs     │
│  - Backpressure     │                 │  (HTML + API)    │
│  - Handler dispatch │                 └──────────────────┘
└──────────┬──────────┘
           │
    ┌──────▼──────┐
    │Handler Chain│  (first-match-wins)
    ├─────────────┤
    │1. Command   │  src/handlers/command.mjs
    │2. Media     │  src/handlers/media.mjs
    │3. Ping      │  src/handlers/ping.mjs
    │4. AI Chat   │  src/handlers/chat.mjs  ← catch-all
    └──────┬──────┘
           │
    ┌──────▼───────────────────────────┐
    │        AI Pipeline               │
    │  src/pipeline/                   │
    │  ThreadResolver → ContextLoader  │
    │  → ConversationAnalyzer          │
    │  → ReplyPlanner → MessageComposer│
    │  → SafetyGate                    │
    └──────────────────────────────────┘
```

### Key Entrypoints and Runtime Modes
| Mode | Entrypoint | Description |
|------|-----------|-------------|
| Bot server | `src/main.mjs` | Single-process Node.js app — connects to Messenger WS, runs HTTP server for metrics/dashboard |
| Docker | `Dockerfile` | Same as above with `--max-old-space-size=96` for 128 MB containers |
| Tests | `npm test` | `node --test tests/**/*.mjs tests/*.mjs` |

### Data Flow Summary
1. **Inbound**: Facebook Messenger → `meta-messenger.js` WebSocket → `MessengerAdapter` (event emitter) → `BotCore.#dispatch()`
2. **Dedup + Auth**: Ring buffer idempotency check → blocked-user check → save message to SQLite
3. **Handler dispatch**: Iterate handler chain (command → media → ping → AI chat), first match wins
4. **AI pipeline** (for chat handler): ThreadResolver → ContextLoader (DB query + cache) → Gemini `decide()` → ConversationAnalyzer → ReplyPlanner → MessageComposer (Gemini `generateContent`) → SafetyGate
5. **Outbound**: `adapter.sendMessage()` or `adapter.sendE2EEMessage()` → rate-limited → Messenger API
6. **Persistence**: SQLite WAL mode, 7-day message retention, 30-min maintenance cycle

### Dependency Map
| Module | Internal Deps | External Deps |
|--------|--------------|---------------|
| `main.mjs` | config, logger, metrics, database, messenger, gemini, bot/core, handlers, dashboard | — |
| `bot/core.mjs` | — | — |
| `adapters/messenger.mjs` | — | `meta-messenger.js`, `node:fs`, `node:events` |
| `adapters/database.mjs` | — | `node:sqlite` (experimental) |
| `adapters/gemini.mjs` | — | `fetch` (global) |
| `adapters/media.mjs` | — | `fetch` (global) |
| `handlers/chat.mjs` | pipeline/* | — |
| `handlers/command.mjs` | commands/parser, commands/registry | — |
| `dashboard/handler.mjs` | config (getEditableEnv, updateEnv) | `node:http` |
| `observability/metrics.mjs` | — | `node:http` |

---

## C) Performance Findings

### C1. Media Download OOM Risk — **FIXED**

- **Symptom**: A malicious or misconfigured CDN returning no `Content-Length` header could cause `res.arrayBuffer()` to buffer the entire response into memory, potentially allocating hundreds of MB.
- **Root cause**: `downloadBuffer()` relied on `Content-Length` header for pre-check, then called `res.arrayBuffer()` which buffers the full response before checking size.
- **Location**: `src/adapters/media.mjs`, `downloadBuffer()` function
- **Fix applied**: Replaced `res.arrayBuffer()` with streaming `for await (const chunk of res.body)` with per-chunk size enforcement. Stream is cancelled immediately when threshold exceeded.
- **Expected improvement**: Prevents OOM under adversarial CDN responses. Risk: low — streams are well-supported in Node.js 22.
- **Risk**: Low.

### C2. WAL Checkpoint Blocks Event Loop

- **Symptom**: During the 30-minute maintenance cycle, `PRAGMA wal_checkpoint(TRUNCATE)` blocks the event loop. On a busy bot with large WAL files, this can cause 100ms–2s stalls, during which no messages are processed.
- **Root cause**: `node:sqlite` `DatabaseSync` is synchronous — all SQL operations block the main thread.
- **Location**: `src/adapters/database.mjs`, `#runMaintenance()` (line ~271)
- **Suggested fix**: Run maintenance checkpoint in a `Worker` thread, or switch to `PASSIVE` checkpoint which is non-blocking (won't truncate WAL but prevents unbounded growth):
  ```js
  // Less blocking alternative
  this.#db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  ```
- **Expected improvement**: Eliminates event loop stalls during maintenance. Risk: medium — `PASSIVE` may not fully truncate WAL; `Worker` thread adds complexity.

### C3. Redundant ensureUser DB Call — **FIXED**

- **Symptom**: Every incoming message from a known user triggered `getUser()` + `ensureUser()` — two synchronous SQLite operations.
- **Root cause**: `BotCore.#ensureUser()` called `ensureUser()` even when the user already existed, just to update `updated_at`.
- **Location**: `src/bot/core.mjs`, `#ensureUser()` method
- **Fix applied**: Skip `ensureUser()` when `getUser()` returns a non-null result. The `updated_at` timestamp update is deferred to the next time user info changes.
- **Expected improvement**: ~50% reduction in per-message DB calls for repeat users. Risk: low — `updated_at` becomes less precise but is only used for sorting in dashboard.

### C4. ThreadResolver Queries All Threads on Every Cross-Thread Reference

- **Symptom**: When a user's message matches a thread-reference pattern, `ThreadResolver.#scoreCandidates()` calls `db.listThreads(50, 0)` and iterates all of them.
- **Root cause**: No caching of thread list; each resolution fetches fresh data.
- **Location**: `src/pipeline/thread-resolver.mjs`, `#scoreCandidates()` (line ~133)
- **Suggested fix**: Add a short-lived cache (30s TTL) for the thread list, similar to `ContextLoader`:
  ```js
  if (this.#threadCache && Date.now() - this.#threadCacheTime < 30_000) {
      return this.#threadCache;
  }
  ```
- **Expected improvement**: Eliminates redundant DB queries for rapid cross-thread resolutions. Risk: low.

### C5. Gemini API Has No Per-User Rate Limiting

- **Symptom**: A single user can trigger unlimited Gemini API calls by sending rapid messages.
- **Root cause**: The outbound message rate limiter applies to Messenger sends, not to Gemini API calls. The handler timeout (30s) is the only throttle.
- **Location**: `src/handlers/chat.mjs`, `handle()` method
- **Suggested fix**: Add a per-thread or per-user cooldown (e.g., 5s between AI calls for the same thread):
  ```js
  const lastCallTime = this.#lastAICall.get(threadId) || 0;
  if (Date.now() - lastCallTime < 5000) return; // cooldown
  this.#lastAICall.set(threadId, Date.now());
  ```
- **Expected improvement**: Prevents API quota exhaustion and cost spikes. Risk: low.

---

## D) Memory Leak / Memory Growth Findings

### D1. ContextLoader Cache

- **Leak pattern**: Bounded cache (Map) holding up to 50 entries, each containing up to 200 messages with formatted text strings.
- **Trigger**: High-traffic bot with many active threads.
- **Evidence**: `src/pipeline/context-loader.mjs`, `#cache = new Map()` with `MAX_CACHE_ENTRIES = 50` and `CACHE_TTL_MS = 5 * 60 * 1000`.
- **Status**: Properly bounded with TTL eviction + size limit. Not a leak, but the largest in-memory data structure.
- **Fix**: `destroy()` method added for explicit cleanup during shutdown. Cache is already bounded.
- **Verification**: Monitor `memory.heap_mb` gauge in metrics; compare before/after context cache clear.

### D2. Metrics Counters and Gauges Grow Unbounded

- **Leak pattern**: `Metrics.#counters` and `Metrics.#gauges` are Maps that grow with each unique metric name.
- **Trigger**: Dynamic metric names like `reply_planner.action.${action}` create new entries per action type.
- **Evidence**: `src/observability/metrics.mjs`, lines 3–4; `src/pipeline/reply-planner.mjs`, line 52.
- **Status**: Low risk — action types are a small finite set (greet, answer_question, discuss, etc.). Map size is bounded by the number of distinct metric names, which is ~30-50.
- **Fix**: No action needed unless dynamic metric names are introduced.
- **Verification**: Check `Object.keys(metrics.snapshot()).length` stays bounded over time.

### D3. Event Listeners on MessengerAdapter

- **Leak pattern**: `BotCore.start()` adds `message` and `e2eeMessage` listeners. If `start()` is called multiple times, listeners accumulate.
- **Trigger**: Code bug calling `bot.start()` more than once.
- **Evidence**: `src/bot/core.mjs`, `start()` (line ~27); `src/adapters/messenger.mjs`, `disconnect()` calls `removeAllListeners()`.
- **Status**: Low risk — `start()` is called once in `main.mjs`. `disconnect()` properly cleans up.
- **Fix**: Guard against double-start:
  ```js
  start() {
      if (this.#started) return;
      this.#started = true;
      // ... register listeners
  }
  ```
- **Verification**: Check `adapter.listenerCount('message')` stays at 1.

### D4. Dashboard HTML String

- **Leak pattern**: `DASHBOARD_HTML` is a ~15 KB string literal allocated at module load time.
- **Trigger**: Always present once `dashboard/handler.mjs` is imported.
- **Evidence**: `src/dashboard/handler.mjs`, line ~265.
- **Status**: Not a leak — constant allocation, never grows. Acceptable for an embedded dashboard.
- **Fix**: No action needed. If memory is critical, serve from a file instead.

### D5. Database Prepared Statements

- **Leak pattern**: 18 prepared statements created once in `#prepareStatements()`.
- **Trigger**: Constructor.
- **Evidence**: `src/adapters/database.mjs`, `#prepareStatements()`.
- **Status**: Not a leak — statements are created once, reused for the process lifetime, and freed when `db.close()` is called.

---

## E) Refactor & Folder Re-Architecture Proposal

### Current Structure
```
src/
├── main.mjs              # Entrypoint + wiring
├── config/index.mjs      # Config + .env parsing + env update API
├── bot/core.mjs          # Message dispatch + dedup + backpressure
├── adapters/
│   ├── database.mjs      # SQLite adapter
│   ├── gemini.mjs        # Gemini AI adapter
│   ├── media.mjs         # Media download functions
│   └── messenger.mjs     # Messenger WebSocket adapter
├── handlers/
│   ├── index.mjs         # Handler builder
│   ├── chat.mjs          # AI chat handler
│   ├── command.mjs       # Command handler
│   ├── echo.mjs          # Debug echo handler
│   ├── media.mjs         # Media link handler
│   └── ping.mjs          # Ping handler
├── pipeline/
│   ├── index.mjs         # Re-exports
│   ├── context-loader.mjs
│   ├── conversation-analyzer.mjs
│   ├── message-composer.mjs
│   ├── reply-planner.mjs
│   ├── safety-gate.mjs
│   └── thread-resolver.mjs
├── commands/
│   ├── definitions.mjs   # Built-in commands
│   ├── parser.mjs        # Command parser
│   └── registry.mjs      # Command registry
├── dashboard/
│   └── handler.mjs       # HTTP API + embedded HTML
└── observability/
    ├── logger.mjs         # Structured JSON logger
    └── metrics.mjs        # Counters + gauges + HTTP server
```

### Proposed Target Structure
```
src/
├── main.mjs                    # Entrypoint (unchanged)
├── config/
│   ├── index.mjs               # Config loading (unchanged)
│   └── env-editor.mjs          # Extract env read/write/persist from index.mjs
├── bot/
│   └── core.mjs                # Dispatch (unchanged)
├── adapters/
│   ├── database.mjs            # SQLite (unchanged)
│   ├── gemini.mjs              # Gemini (unchanged)
│   ├── media.mjs               # Media download (unchanged)
│   └── messenger.mjs           # Messenger WS (unchanged)
├── handlers/
│   ├── index.mjs               # Handler builder (unchanged)
│   ├── chat.mjs                # AI chat (unchanged)
│   ├── command.mjs             # Commands (unchanged)
│   ├── media.mjs               # Media links (unchanged)
│   └── ping.mjs                # Ping (unchanged)
├── pipeline/
│   ├── index.mjs               # Re-exports (unchanged)
│   ├── context-loader.mjs      # (unchanged)
│   ├── conversation-analyzer.mjs
│   ├── message-composer.mjs
│   ├── reply-planner.mjs
│   ├── safety-gate.mjs
│   └── thread-resolver.mjs
├── commands/
│   ├── definitions.mjs         # (unchanged)
│   ├── parser.mjs              # (unchanged)
│   └── registry.mjs            # (unchanged)
├── dashboard/
│   ├── handler.mjs             # HTTP routing only
│   └── ui.html                 # Extract HTML to separate file (optional)
└── observability/
    ├── logger.mjs              # (unchanged)
    └── metrics.mjs             # (unchanged)
```

### Rationale
The current structure is already well-organized with clear boundaries:
- **adapters/**: External system interfaces (DB, AI, messaging, media)
- **handlers/**: Message processing (command, media, ping, AI chat)
- **pipeline/**: AI conversation pipeline stages
- **commands/**: Command system (registry, parser, definitions)
- **dashboard/**: Admin UI and API
- **observability/**: Logging and metrics

**No major restructuring is needed.** The existing layout follows clean layering:
- `adapters/` = infrastructure layer
- `pipeline/` + `handlers/` = application layer
- `commands/` = domain layer
- `observability/` = cross-cutting concern

### Recommended Incremental Changes
1. **Extract env editor** from `config/index.mjs` into `config/env-editor.mjs` to separate config loading (read-only, startup) from env editing (read-write, runtime). This reduces the surface area of `config/index.mjs`.
2. **Extract dashboard HTML** into a separate `.html` file loaded at startup, making the dashboard easier to edit and test independently.
3. **Add handler registration interface** to allow dynamic handler loading without editing `handlers/index.mjs`.

### Module Boundaries & Dependency Direction Rules
```
main.mjs
  ↓ depends on
config/ ← pure functions, no side effects after init
  ↓
adapters/ ← I/O boundary (DB, network, filesystem)
  ↓
bot/core ← orchestration, no direct I/O
  ↓
handlers/ ← message processing
  ↓
pipeline/ ← AI conversation stages
  ↓
commands/ ← command system

observability/ ← injected everywhere, depends on nothing
dashboard/ ← depends on config/, adapters/database (read-only)
```

**Rule**: Dependencies flow downward. No module should import from a higher layer. `observability/` is a cross-cutting concern injected via constructor parameters.

### Backwards Compatibility
- No public API exists (this is a standalone bot, not a library).
- All changes are internal and do not affect the `meta-messenger.js` package interface.
- The `.env` file format and environment variables remain unchanged.

---

## F) Testing & Verification Plan

### Current Test Coverage
- **154 tests** across 22 suites, all passing
- Coverage: adapters (gemini, messenger), commands (registry, parser, definitions), config, dashboard (API endpoints), handlers (chat, echo, ping, command), pipeline (all 6 modules), optimizations (metrics, caching, maintenance)

### Benchmarks to Create

| Benchmark | Type | What to Measure |
|-----------|------|----------------|
| Message dispatch throughput | Micro | Messages/sec through `BotCore.#dispatch()` with mock adapter |
| Context loading | Micro | Time to load 200 messages from SQLite + format |
| Safety gate check | Micro | Regex checks/sec on typical message sizes |
| Command parse + dispatch | Micro | Parse + registry lookup + execute for `!ping` |
| Media download streaming | Integration | Memory peak during 25 MB download with streaming enforcement |
| Full AI pipeline | Integration | End-to-end latency: message → decision → analysis → compose → safety → send |

### Profiling Plan

#### CPU Profiling
```bash
# Generate V8 CPU profile
node --experimental-sqlite --expose-gc --cpu-prof --cpu-prof-dir=/tmp/profiles src/main.mjs

# Analyze with Chrome DevTools
# Open chrome://inspect → Open dedicated DevTools for Node
# Load the .cpuprofile file

# Or use clinic.js
npx clinic doctor -- node --experimental-sqlite src/main.mjs
npx clinic flame -- node --experimental-sqlite src/main.mjs
```

#### Memory Profiling
```bash
# Heap snapshot on demand
node --experimental-sqlite --expose-gc --inspect src/main.mjs
# In Chrome DevTools: Memory → Take heap snapshot

# Track RSS over time
while true; do
  curl -s http://localhost:9090/metrics | jq '.memory_rss, .memory_heap_used'
  sleep 60
done

# Trigger GC and check baseline
curl -s http://localhost:9090/health
# Send 1000 messages, then wait 5 minutes for GC
# Compare heap before/after
```

#### Load Testing
```bash
# Simulate message load (requires mock adapter or test harness)
# Test: 100 concurrent messages, 10 messages/sec for 5 minutes
# Endpoints: internal dispatch (via test harness)
# Monitor: RSS, heap, latency p95/p99, error rate, GC pauses
```

### Observability Upgrades

| Metric | Type | Location |
|--------|------|----------|
| `gemini.latency_ms` | Histogram | `src/adapters/gemini.mjs` — **Added** (logged) |
| `handler.latency_ms` | Histogram | `src/bot/core.mjs` — measure handler execution time |
| `context_loader.cache_size` | Gauge | `src/pipeline/context-loader.mjs` — expose cache.size |
| `db.query_count` | Counter | `src/adapters/database.mjs` — count per-query-type calls |
| `memory.gc_pause_ms` | Gauge | `src/observability/metrics.mjs` — track GC duration |

| Log Enhancement | Location |
|----------------|----------|
| `msgId` correlation in handler errors | `src/bot/core.mjs` — **Added** |
| Gemini API latency in debug logs | `src/adapters/gemini.mjs` — **Added** |
| Handler match/skip trace | `src/bot/core.mjs` — add debug log for handler selection |

### Acceptance Criteria
1. All 154 tests pass after changes
2. No new security vulnerabilities introduced (CodeQL clean)
3. `GEMINI_API_KEY` is masked in `/api/env` response
4. Media downloads abort early on oversized responses (streaming enforcement)
5. Known user dispatch path executes 1 DB call instead of 2
6. Gemini API calls log latency in debug mode
7. Handler errors include `msgId` for correlation

---

## G) Prioritized Backlog

| # | Item | Category | Priority | Effort | Risk | Dependencies | Notes |
|---|------|----------|----------|--------|------|-------------|-------|
| 1 | Mask GEMINI_API_KEY in /api/env | Security | P0 | S | Low | None | **Done** — prevents secret leakage via unauthenticated dashboard |
| 2 | Streaming download size enforcement | Perf/Memory | P0 | S | Low | None | **Done** — prevents OOM on adversarial CDN responses |
| 3 | Eliminate redundant ensureUser DB call | Perf | P1 | S | Low | None | **Done** — reduces per-message DB calls by ~50% for known users |
| 4 | Add Gemini API latency logging | Observability | P1 | S | Low | None | **Done** — enables API performance monitoring |
| 5 | Add msgId to handler error logs | Observability | P1 | S | Low | None | **Done** — enables error correlation |
| 6 | Add ContextLoader.destroy() | Memory | P1 | S | Low | None | **Done** — explicit cleanup during shutdown |
| 7 | Add dashboard authentication | Security | P0 | M | Med | None | Add API key header or basic auth to `/api/*` and `/dashboard` |
| 8 | Switch WAL checkpoint to PASSIVE | Perf | P1 | S | Med | None | Prevents event loop blocking during maintenance |
| 9 | Add per-thread AI rate limiting | Perf | P1 | S | Low | None | Prevents Gemini API quota exhaustion |
| 10 | Cache thread list in ThreadResolver | Perf | P2 | S | Low | None | Eliminates redundant DB queries for cross-thread references |
| 11 | Add prompt injection detection | Security | P1 | M | Med | None | Detect and sanitize adversarial prompt patterns |
| 12 | Implement search integration | Feature | P2 | L | Med | Gemini API | Complete `need_search` pipeline with search API |
| 13 | Add fallback AI provider | Resilience | P2 | L | Med | None | Support OpenAI/Anthropic as Gemini fallback |
| 14 | Add token/cost tracking | Observability | P2 | M | Low | None | Track Gemini API token usage per call |
| 15 | Extract env-editor module | Refactor | P2 | S | Low | None | Separate config loading from env editing |
| 16 | Extract dashboard HTML to file | Refactor | P2 | S | Low | None | Make dashboard easier to edit independently |
| 17 | Add handler registration interface | Refactor | P2 | M | Low | None | Dynamic handler loading without code changes |
| 18 | Add guard against double bot.start() | Memory | P2 | S | Low | None | Prevent listener accumulation |
| 19 | Add CPU/memory profiling benchmarks | Testing | P2 | M | Low | None | Establish performance baseline |
| 20 | Add load testing harness | Testing | P2 | L | Low | None | Validate throughput under sustained load |

---

## Previous AI Analysis (retained for reference)

### AI Components and Modules

- **GeminiAdapter** (`src/adapters/gemini.mjs`)
  - Core adapter interfacing with the Google Generative Language API (Gemini).
  - Encapsulates API key management, model selection, HTTP communication, and response parsing.
  - Exposes two public methods: `decide()` and `generateReply()`, plus `_callAPIForPipeline()` for pipeline modules.

- **AI Chat Handler** (`src/handlers/chat.mjs`)
  - Application-layer handler that orchestrates the AI conversation flow.
  - Uses the full 6-stage pipeline: ThreadResolver → ContextLoader → ConversationAnalyzer → ReplyPlanner → MessageComposer → SafetyGate.
  - Includes a `buildChatContext()` helper retained for backward compatibility.

- **System Prompts** (embedded in `src/adapters/gemini.mjs` and `src/pipeline/`)
  - `DECISION_SYSTEM_PROMPT` — Vietnamese-language prompt for reply gating.
  - `GENERATION_SYSTEM_PROMPT` — Vietnamese-language prompt defining bot personality.
  - `ANALYSIS_SYSTEM_PROMPT` — Vietnamese-language prompt for conversation analysis.
  - `COMPOSER_SYSTEM_PROMPT` — Vietnamese-language prompt for message composition.

### Data Flow (AI Pipeline)

1. Message arrives → `BotCore` dedup + auth → handler chain → `ChatHandler.match()`
2. `ThreadResolver.resolve()` — detect cross-thread intent, score candidates
3. `ContextLoader.load()` — fetch 30–200 messages from DB with 5-min LRU cache
4. `gemini.decide()` — should bot reply? (structured JSON response)
5. `ConversationAnalyzer.analyze()` — extract intent, tone, entities (Gemini or heuristic)
6. `ReplyPlanner.plan()` — determine action, key points, tone, length guidance
7. `MessageComposer.compose()` — generate reply via Gemini with plan context
8. `SafetyGate.check()` — block sensitive data, harmful content, oversized messages
9. Send reply via `adapter.sendMessage()` or `adapter.sendE2EEMessage()`

### Strengths
- Two-phase AI architecture (decide → generate) avoids unnecessary API calls
- Graceful degradation when Gemini is unavailable
- Full pipeline with analysis, planning, composition, and safety stages
- Runtime reconfiguration via dashboard
- First-match-wins handler ordering prevents AI interference with commands
- Error isolation with safe defaults
- Idempotency (ring buffer) and backpressure (concurrency limit)

### Limitations
- Search integration is a placeholder (`need_search` parsed but not implemented)
- Single-model dependency (Gemini only)
- No response caching at the AI layer
- No token/cost tracking
- No per-user personalization
- JSON parsing fragility (relies on model returning valid JSON)
