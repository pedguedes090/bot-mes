// Handler: echoes back any text message
export const EchoHandler = {
    name: 'echo',

    match(eventType, msg) {
        return !!msg.text;
    },

    async handle(eventType, msg, adapter) {
        const reply = `Echo: ${msg.text}`;
        if (eventType === 'e2eeMessage') {
            await adapter.sendE2EEMessage(msg.chatJid, reply);
        } else {
            await adapter.sendMessage(msg.threadId, reply);
        }
    },
};
