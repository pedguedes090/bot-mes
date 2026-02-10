// Command registry: maps command names to their definitions

export class CommandRegistry {
    /** @type {Map<string, Object>} */
    #commands = new Map();

    /**
     * Register a command.
     * @param {Object} def - { name, description, usage, permission, execute }
     */
    register(def) {
        this.#commands.set(def.name, def);
    }

    /**
     * Get a command by name.
     * @param {string} name
     * @returns {Object | undefined}
     */
    get(name) {
        return this.#commands.get(name);
    }

    /**
     * Get all registered commands.
     * @returns {Object[]}
     */
    all() {
        return [...this.#commands.values()];
    }

    /**
     * Get commands visible to a given permission level.
     * @param {'user' | 'admin'} permission
     * @returns {Object[]}
     */
    forPermission(permission) {
        return this.all().filter(cmd => {
            if (permission === 'admin') return true;
            return cmd.permission === 'user';
        });
    }
}
