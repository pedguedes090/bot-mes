// Media downloader for Facebook & Instagram — no external deps (native fetch)

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// --- Instagram ---

async function getCSRFToken() {
    const res = await fetch('https://www.instagram.com/', {
        headers: { 'User-Agent': USER_AGENT },
        redirect: 'follow',
    });
    const setCookie = res.headers.get('set-cookie') || '';
    const match = setCookie.match(/csrftoken=([^;]+)/);
    if (!match) throw new Error('CSRF token not found');
    return match[1];
}

function getShortcode(url) {
    const parts = url.split('/');
    const tags = ['p', 'reel', 'tv', 'reels'];
    const idx = parts.findIndex(p => tags.includes(p));
    if (idx === -1 || !parts[idx + 1]) throw new Error('Invalid Instagram URL');
    return parts[idx + 1].split('?')[0];
}

async function checkRedirect(url) {
    if (url.includes('/share')) {
        const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': USER_AGENT } });
        return res.url;
    }
    return url;
}

export async function getInstagramMedia(url, retries = 3) {
    url = await checkRedirect(url);
    const shortcode = getShortcode(url);
    const token = await getCSRFToken();

    const body = new URLSearchParams({
        variables: JSON.stringify({
            shortcode,
            fetch_tagged_user_count: null,
            hoisted_comment_id: null,
            hoisted_reply_id: null,
        }),
        doc_id: '9510064595728286',
    });

    const res = await fetch('https://www.instagram.com/graphql/query', {
        method: 'POST',
        headers: {
            'X-CSRFToken': token,
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': USER_AGENT,
        },
        body: body.toString(),
    });

    if ((res.status === 429 || res.status === 403) && retries > 0) {
        const wait = parseInt(res.headers.get('retry-after') || '2') * 1000;
        await new Promise(r => setTimeout(r, wait));
        return getInstagramMedia(url, retries - 1);
    }

    if (!res.ok) throw new Error(`Instagram HTTP ${res.status}`);
    const json = await res.json();
    const media = json.data?.xdt_shortcode_media;
    if (!media) throw new Error('No media found');

    const items = [];

    if (media.__typename === 'XDTGraphSidecar') {
        for (const edge of media.edge_sidecar_to_children.edges) {
            const node = edge.node;
            items.push({
                type: node.is_video ? 'video' : 'image',
                url: node.is_video ? node.video_url : node.display_url,
            });
        }
    } else {
        items.push({
            type: media.is_video ? 'video' : 'image',
            url: media.is_video ? media.video_url : media.display_url,
        });
    }

    return items;
}

// --- Facebook ---

const FB_HEADERS = {
    'sec-fetch-user': '?1',
    'sec-ch-ua-mobile': '?0',
    'sec-fetch-site': 'none',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'cache-control': 'max-age=0',
    'upgrade-insecure-requests': '1',
    'accept-language': 'en-GB,en;q=0.9',
    'user-agent': USER_AGENT,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
};

export async function getFacebookVideo(videoUrl) {
    const res = await fetch(videoUrl, { headers: FB_HEADERS, redirect: 'follow' });
    if (!res.ok) throw new Error(`Facebook HTTP ${res.status}`);

    let data = await res.text();
    data = data.replace(/&quot;/g, '"').replace(/&amp;/g, '&');

    const parseStr = (s) => JSON.parse(`{"text":"${s}"}`).text;

    const sdMatch = data.match(/"browser_native_sd_url":"(.*?)"/)
        || data.match(/"playable_url":"(.*?)"/)
        || data.match(/sd_src\s*:\s*"([^"]*)"/)
        || data.match(/(?<="src":")[^"]*(https:\/\/[^"]*)/);

    const hdMatch = data.match(/"browser_native_hd_url":"(.*?)"/)
        || data.match(/"playable_url_quality_hd":"(.*?)"/)
        || data.match(/hd_src\s*:\s*"([^"]*)"/);

    if (!sdMatch?.[1]) throw new Error('No video URL found');

    // Prefer HD over SD
    const url = (hdMatch?.[1]) ? parseStr(hdMatch[1]) : parseStr(sdMatch[1]);
    return { type: 'video', url };
}

// --- TikTok ---

const TIKTOK_API = 'https://api16-normal-c-useast2a.tiktokv.com/aweme/v1/feed/';
const TIKTOK_UA = 'TikTok 26.2.0 rv:262018 (iPhone; iOS 14.4.2; en_US) Cronet';

async function resolveTikTokUrl(url) {
    const res = await fetch(url, {
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    return res.url;
}

function extractAwemeId(url) {
    const match = url.match(/\/video\/(\d+)/) || url.match(/\/photo\/(\d+)/);
    if (!match) throw new Error('No aweme_id found');
    return match[1];
}

export async function getTikTokMedia(shortUrl) {
    const fullUrl = await resolveTikTokUrl(shortUrl);
    const awemeId = extractAwemeId(fullUrl);

    const res = await fetch(`${TIKTOK_API}?aweme_id=${awemeId}`, {
        method: 'OPTIONS',
        headers: { 'User-Agent': TIKTOK_UA },
    });
    if (!res.ok) throw new Error(`TikTok API HTTP ${res.status}`);

    const json = await res.json();
    const aweme = json.aweme_list?.[0];
    if (!aweme) throw new Error('No TikTok data found');

    // Slideshow (image post)
    const images = aweme.image_post_info?.images;
    if (images && images.length > 0) {
        return images.map(img => ({
            type: 'image',
            url: img.display_image?.url_list?.[0] || img.url_list?.[0],
        })).filter(i => i.url);
    }

    // Video
    const videoUrl = aweme.video?.play_addr?.url_list?.[0];
    if (!videoUrl) throw new Error('No video URL found');
    return [{ type: 'video', url: videoUrl }];
}

// --- Download helper ---

export async function downloadBuffer(url, maxSizeMB = 25) {
    const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        redirect: 'follow',
    });
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);

    const contentLength = parseInt(res.headers.get('content-length') || '0');
    if (contentLength > maxSizeMB * 1024 * 1024) {
        throw new Error(`File too large: ${Math.round(contentLength / 1024 / 1024)}MB > ${maxSizeMB}MB`);
    }

    const arrayBuffer = await res.arrayBuffer();
    if (arrayBuffer.byteLength > maxSizeMB * 1024 * 1024) {
        throw new Error(`File too large after download`);
    }

    const contentType = res.headers.get('content-type') || '';
    return { buffer: Buffer.from(arrayBuffer), contentType };
}
