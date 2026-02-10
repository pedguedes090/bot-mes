// Handler: detect Facebook/Instagram/TikTok links → download media → send
// Silent on errors — if anything fails, just do nothing
import { getInstagramMedia, getFacebookVideo, getTikTokMedia, downloadBuffer } from '../adapters/media.mjs';

const IG_REGEX = /https?:\/\/(?:www\.)?(?:instagram\.com|instagr\.am)\/(p|reel|tv|reels|share)\/[^\s]+/i;
const FB_REGEX = /https?:\/\/(?:www\.)?(?:facebook\.com|fb\.watch|fb\.com|m\.facebook\.com)\/[^\s]*(?:video|watch|reel|share|story)[^\s]*/i;
const FB_SIMPLE = /https?:\/\/(?:www\.)?(?:facebook\.com|fb\.watch|fb\.com|m\.facebook\.com)\/[^\s]+/i;
const TT_REGEX = /https?:\/\/(?:(?:www|vt|vm)\.)?tiktok\.com\/[^\s]+/i;

export const MediaHandler = {
    name: 'media-download',

    match(eventType, msg) {
        const text = msg.text?.trim();
        if (!text) return false;
        return IG_REGEX.test(text) || FB_REGEX.test(text) || FB_SIMPLE.test(text) || TT_REGEX.test(text);
    },

    async handle(eventType, msg, adapter) {
        const text = msg.text.trim();

        try {
            // Instagram — download all items in parallel, then send rapidly
            const igMatch = text.match(IG_REGEX);
            if (igMatch) {
                await sendBatch(await getInstagramMedia(igMatch[0]), msg, adapter);
                return;
            }

            // TikTok — video or slideshow
            const ttMatch = text.match(TT_REGEX);
            if (ttMatch) {
                await sendBatch(await getTikTokMedia(ttMatch[0]), msg, adapter);
                return;
            }

            // Facebook
            const fbMatch = text.match(FB_REGEX) || text.match(FB_SIMPLE);
            if (fbMatch) {
                const item = await getFacebookVideo(fbMatch[0]);
                const { buffer, contentType } = await downloadBuffer(item.url);
                const ext = contentType.includes('video') ? 'mp4' : 'jpg';
                await adapter.sendVideo(msg.threadId, buffer, `media_${Date.now()}.${ext}`);
                return;
            }
        } catch {
            // Silent — no error message sent
        }
    },
};

// Download all items in parallel, then send rapidly (no rate-limit delay)
async function sendBatch(items, msg, adapter) {
    const downloaded = (await Promise.allSettled(
        items.map(item => downloadBuffer(item.url).then(dl => ({ ...item, ...dl })))
    )).filter(r => r.status === 'fulfilled').map(r => r.value);

    if (!downloaded.length) return;

    for (const item of downloaded) {
        const isVideo = item.type === 'video' || item.contentType.includes('video');
        const ext = isVideo ? 'mp4' : (item.contentType.includes('png') ? 'png' : 'jpg');
        const filename = `media_${Date.now()}.${ext}`;
        if (isVideo) {
            await adapter.sendVideoDirect(msg.threadId, item.buffer, filename);
        } else {
            await adapter.sendImageDirect(msg.threadId, item.buffer, filename);
        }
    }
}
