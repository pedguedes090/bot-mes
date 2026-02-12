// Media downloader for Facebook & Instagram — no external deps (native fetch)

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Default timeout for fetch requests (30 seconds)
const FETCH_TIMEOUT_MS = 30_000;

// --- Instagram ---

async function getCSRFToken() {
    const res = await fetch('https://www.instagram.com/', {
        headers: { 'User-Agent': USER_AGENT },
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    // Drain the response body to free native memory (we only need headers)
    await res.body?.cancel();
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
        const res = await fetch(url, {
            redirect: 'follow',
            headers: { 'User-Agent': USER_AGENT },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        // Drain the response body to free native memory (we only need the final URL)
        await res.body?.cancel();
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
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if ((res.status === 429 || res.status === 403) && retries > 0) {
        // Drain the response body to free native memory before retry
        await res.body?.cancel();
        const wait = parseInt(res.headers.get('retry-after') || '2') * 1000;
        await new Promise(r => setTimeout(r, wait));
        return getInstagramMedia(url, retries - 1);
    }

    if (!res.ok) {
        // Drain the response body to free native memory
        await res.body?.cancel();
        throw new Error(`Instagram HTTP ${res.status}`);
    }
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
    const res = await fetch(videoUrl, {
        headers: FB_HEADERS,
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
        // Drain the response body to free native memory
        await res.body?.cancel();
        throw new Error(`Facebook HTTP ${res.status}`);
    }

    // Stream the response with a size cap to prevent huge HTML pages from consuming heap
    const MAX_HTML_BYTES = 5 * 1024 * 1024; // 5 MB cap for HTML parsing
    const chunks = [];
    let totalBytes = 0;
    for await (const chunk of res.body) {
        totalBytes += chunk.byteLength;
        if (totalBytes > MAX_HTML_BYTES) {
            await res.body.cancel();
            break;
        }
        chunks.push(chunk);
    }
    let data = Buffer.concat(chunks).toString('utf-8');
    chunks.length = 0; // Release chunk references
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
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    // Drain the response body to free native memory (we only need the final URL)
    await res.body?.cancel();
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
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
        // Drain the response body to free native memory
        await res.body?.cancel();
        throw new Error(`TikTok API HTTP ${res.status}`);
    }

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
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
        // Drain the response body to free native memory
        await res.body?.cancel();
        throw new Error(`Download failed: ${res.status}`);
    }

    const maxBytes = maxSizeMB * 1024 * 1024;
    const contentLength = parseInt(res.headers.get('content-length') || '0');
    if (contentLength > maxBytes) {
        // Drain body before throwing to free native memory
        await res.body?.cancel();
        throw new Error(`File too large: ${Math.round(contentLength / 1024 / 1024)}MB > ${maxSizeMB}MB`);
    }

    // Stream with size enforcement to prevent OOM when content-length is absent or lying
    const chunks = [];
    let totalBytes = 0;
    for await (const chunk of res.body) {
        totalBytes += chunk.byteLength;
        if (totalBytes > maxBytes) {
            // Cancel remaining stream and reject
            await res.body.cancel();
            chunks.length = 0; // Release chunk references immediately
            throw new Error(`File too large after download`);
        }
        chunks.push(chunk);
    }

    const contentType = res.headers.get('content-type') || '';
    // Combine chunks into a single Buffer, then release the chunks array
    const buffer = Buffer.concat(chunks, totalBytes);
    chunks.length = 0; // Release chunk references so GC can reclaim them
    return { buffer, contentType };
}

// --- Douyin ---

export async function getDouyinMedia(url) {
    const apiUrl = `https://douyin.cuong.one/api/douyin/detail?url=${encodeURIComponent(url)}`;
    
    const res = await fetch(apiUrl, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    
    if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`Douyin API HTTP ${res.status}`);
    }

    const json = await res.json();
    if (json.status !== 'ok' || !json.video) {
        throw new Error(json.message || 'Douyin video not found');
    }

    // The API returns a direct video URL in the `video` field
    // It redirects to the actual video file, so our downloadBuffer will handle it
    return [{ type: 'video', url: json.video }];
}
