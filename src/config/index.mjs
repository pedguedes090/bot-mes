import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Load .env file manually (no external dep)
function loadDotEnv(filePath) {
    if (!existsSync(filePath)) return;
    const content = readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        // Strip surrounding quotes
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        if (!process.env[key]) process.env[key] = val;
    }
}

const ENV_FILE_PATH = resolve(process.cwd(), '.env');
loadDotEnv(ENV_FILE_PATH);

// Keys that are safe to view/edit via the dashboard (excludes secrets)
const EDITABLE_ENV_KEYS = [
    'LOG_LEVEL',
    'ENABLE_E2EE',
    'AUTO_RECONNECT',
    'MAX_CONCURRENT_HANDLERS',
    'HANDLER_TIMEOUT_MS',
    'SEND_RATE_PER_SEC',
    'IDEMPOTENCY_CACHE_SIZE',
    'DB_PATH',
    'METRICS_PORT',
    'DEVICE_DATA_PATH',
    'GEMINI_ENABLED',
    'GEMINI_API_KEY',
    'GEMINI_MODEL',
    'AUTO_RESTART_MINUTES',
];

// Keys whose values should be masked in API responses to prevent leaking secrets
const MASKED_ENV_KEYS = new Set(['GEMINI_API_KEY']);

function env(key, fallback) {
    return process.env[key] ?? fallback;
}

function envInt(key, fallback) {
    const val = process.env[key];
    if (val === undefined) return fallback;
    const n = parseInt(val, 10);
    return Number.isNaN(n) ? fallback : n;
}

function envBool(key, fallback) {
    const val = process.env[key];
    if (val === undefined) return fallback;
    return val === 'true' || val === '1';
}

// Parse cookie header string: "key1=val1;key2=val2" → { key1: "val1", key2: "val2" }
function parseCookieString(str) {
    const cookies = {};
    for (const part of str.split(';')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        cookies[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
    }
    return cookies;
}

export function loadConfig() {
    // Support full cookie string via FB_COOKIES or individual vars
    let cookies;
    const fbCookies = env('FB_COOKIES', '');
    if (fbCookies) {
        cookies = parseCookieString(fbCookies);
        if (!cookies.c_user || !cookies.xs) {
            throw new Error('FB_COOKIES must contain at least c_user and xs');
        }
    } else {
        const fbCUser = env('FB_C_USER', '');
        const fbXs = env('FB_XS', '');
        if (!fbCUser || !fbXs) {
            throw new Error('Missing required env: FB_COOKIES or FB_C_USER + FB_XS');
        }
        cookies = {
            c_user: fbCUser,
            xs: fbXs,
            datr: env('FB_DATR', ''),
            fr: env('FB_FR', ''),
        };
    }

    return Object.freeze({
        cookies,
        logLevel: env('LOG_LEVEL', 'info'),
        enableE2EE: envBool('ENABLE_E2EE', true),
        autoReconnect: envBool('AUTO_RECONNECT', true),
        maxConcurrentHandlers: envInt('MAX_CONCURRENT_HANDLERS', 50),
        handlerTimeoutMs: envInt('HANDLER_TIMEOUT_MS', 30_000),
        sendRatePerSec: envInt('SEND_RATE_PER_SEC', 5),
        idempotencyCacheSize: envInt('IDEMPOTENCY_CACHE_SIZE', 1000),
        metricsPort: envInt('METRICS_PORT', 9090),
        deviceDataPath: env('DEVICE_DATA_PATH', './device.json'),
        dbPath: env('DB_PATH', './bot.db'),
        geminiEnabled: envBool('GEMINI_ENABLED', true),
        geminiApiKey: env('GEMINI_API_KEY', ''),
        geminiModel: env('GEMINI_MODEL', 'gemini-2.0-flash'),
        autoRestartMinutes: envInt('AUTO_RESTART_MINUTES', 60),
    });
}

/**
 * Read current values for editable env keys.
 * @returns {Record<string, string>}
 */
export function getEditableEnv() {
    const result = {};
    for (const key of EDITABLE_ENV_KEYS) {
        const val = process.env[key] ?? '';
        result[key] = MASKED_ENV_KEYS.has(key) && val ? '********' : val;
    }
    return result;
}

/**
 * Update editable env vars — writes to process.env and persists to .env file.
 * Only keys in EDITABLE_ENV_KEYS are accepted; unknown keys are silently ignored.
 * @param {Record<string, string>} updates
 * @returns {{ applied: string[] }}
 */
export function updateEnv(updates) {
    const applied = [];
    const safeUpdates = {};
    for (const [key, value] of Object.entries(updates)) {
        if (!EDITABLE_ENV_KEYS.includes(key)) continue;
        // Sanitize: strip newlines/carriage returns to prevent .env corruption
        const strVal = String(value).replace(/[\r\n]/g, '');
        safeUpdates[key] = strVal;
        process.env[key] = strVal;
        applied.push(key);
    }

    if (applied.length > 0) {
        persistEnvFile(safeUpdates);
    }

    return { applied };
}

function quoteEnvValue(val) {
    if (val.includes(' ') || val.includes('"') || val.includes("'") || val.includes('#')) {
        return '"' + val.replace(/"/g, '\\"') + '"';
    }
    return val;
}

/**
 * Merge updates into the .env file, preserving comments and unrelated keys.
 */
function persistEnvFile(updates) {
    const remaining = { ...updates };
    let lines = [];

    if (existsSync(ENV_FILE_PATH)) {
        const content = readFileSync(ENV_FILE_PATH, 'utf-8');
        lines = content.split('\n');
    }

    // Update existing lines in-place
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        if (key in remaining) {
            lines[i] = `${key}=${quoteEnvValue(remaining[key])}`;
            delete remaining[key];
        }
    }

    // Append any new keys that weren't already in the file
    for (const [key, value] of Object.entries(remaining)) {
        lines.push(`${key}=${quoteEnvValue(value)}`);
    }

    writeFileSync(ENV_FILE_PATH, lines.join('\n'), 'utf-8');
}
