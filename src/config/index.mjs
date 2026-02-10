import { readFileSync, existsSync } from 'node:fs';
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

loadDotEnv(resolve(process.cwd(), '.env'));

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
        maxConcurrentHandlers: envInt('MAX_CONCURRENT_HANDLERS', 10),
        handlerTimeoutMs: envInt('HANDLER_TIMEOUT_MS', 30_000),
        sendRatePerSec: envInt('SEND_RATE_PER_SEC', 5),
        idempotencyCacheSize: envInt('IDEMPOTENCY_CACHE_SIZE', 1000),
        metricsPort: envInt('METRICS_PORT', 9090),
        deviceDataPath: env('DEVICE_DATA_PATH', './device.json'),
        dbPath: env('DB_PATH', './bot.db'),
    });
}
