// Handler: responds "pong" to "ping"
export const PingHandler = {
    name: 'ping',

    match(eventType, msg) {
        const text = msg.text?.trim().toLowerCase();
        return text === 'ping';
    },

    async handle(eventType, msg, adapter) {
        if (eventType === 'e2eeMessage') {
            await adapter.sendE2EEMessage(msg.chatJid, 'pong 🏓');
        } else {
            await adapter.sendMessage(msg.threadId, 'pong 🏓');
        }
    },
};
