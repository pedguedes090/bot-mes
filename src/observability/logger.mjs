const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

export class Logger {
    #minLevel;
    #component;

    constructor(component = 'bot', level = 'info') {
        this.#component = component;
        this.#minLevel = LEVELS[level] ?? LEVELS.info;
    }

    child(component) {
        const child = new Logger(component);
        child.#minLevel = this.#minLevel;
        return child;
    }

    #write(level, msg, extra) {
        if (LEVELS[level] < this.#minLevel) return;
        const entry = {
            ts: new Date().toISOString(),
            level,
            component: this.#component,
            msg,
            ...extra,
        };
        const out = level === 'error' ? process.stderr : process.stdout;
        out.write(JSON.stringify(entry) + '\n');
    }

    debug(msg, extra) { this.#write('debug', msg, extra); }
    info(msg, extra) { this.#write('info', msg, extra); }
    warn(msg, extra) { this.#write('warn', msg, extra); }
    error(msg, extra) { this.#write('error', msg, extra); }
}
