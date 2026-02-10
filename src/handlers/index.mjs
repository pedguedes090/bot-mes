// Handler registry — order matters: first match wins
import { MediaHandler } from './media.mjs';
import { PingHandler } from './ping.mjs';

export const handlers = [
    MediaHandler,  // Link detection first
    PingHandler,   // Specific commands
];
