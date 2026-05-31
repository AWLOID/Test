const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const compression = require('compression');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const iconv = require('iconv-lite');
const dns = require('dns').promises;
const ipaddr = require('ipaddr.js');
const { LRUCache } = require('lru-cache');

const app = express();
const PORT = process.env.PORT || 3000;

const MAX_ELEMENTS = Number(process.env.MAX_ELEMENTS || 450);
const MAX_BYTES = Number(process.env.MAX_BYTES || 3 * 1024 * 1024);
const CACHE_TTL = Number(process.env.CACHE_TTL || 1000 * 60 * 10);
const AXIOS_TIMEOUT = Number(process.env.AXIOS_TIMEOUT || 10000);
const BROWSER_TIMEOUT = Number(process.env.BROWSER_TIMEOUT || 15000);

const cache = new LRUCache({
    max: 300,
    ttl: CACHE_TTL
});

app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));

app.use(cors());
app.use(compression());

app.use(rateLimit({
    windowMs: 60 * 1000,
    limit: 80,
    standardHeaders: true,
    legacyHeaders: false
}));

function cleanText(s, max = 2000) {
    return String(s || '')
        .replace(/\s+/g, ' ')
        .replace(/\u00a0/g, ' ')
        .trim()
        .slice(0, max);
}

function normalizeInputUrl(raw) {
    if (!raw) throw new Error('no url');

    let url = String(raw).trim();

    if (!/^https?:\/\//i.test(url)) {
        url = 'https://' + url;
    }

    const u = new URL(url);

    if (!['http:', 'https:'].includes(u.protocol)) {
        throw new Error('only http/https allowed');
    }

    u.hash = '';

    return u.toString();
}

function isPrivateIp(ip) {
    const addr = ipaddr.parse(ip);
    const range = addr.range();

    return [
        'private',
        'loopback',
        'linkLocal',
        'uniqueLocal',
        'unspecified',
        'broadcast',
        'carrierGradeNat',
        'reserved',
        'multicast'
    ].includes(range);
}

async function assertPublicUrl(rawUrl) {
    const u = new URL(rawUrl);

    if (!['http:', 'https:'].includes(u.protocol)) {
        throw new Error('blocked protocol');
    }

    const records = await dns.lookup(u.hostname, { all: true });

    if (!records.length) {
        throw new Error('dns lookup failed');
    }

    for (const r of records) {
        if (isPrivateIp(r.address)) {
            throw new Error('blocked private/local address');
        }
    }

    return true;
}

function absolutize(value, baseUrl) {
    if (!value) return '';

    try {
        const v = String(value).trim();

        if (!v || v.startsWith('data:') || v.startsWith('javascript:')) {
            return '';
        }

        if (v.startsWith('//')) {
            const base = new URL(baseUrl);
            return base.protocol + v;
        }

        return new URL(v, baseUrl).toString();
    } catch {
        return '';
    }
}

function bestSrcFromSrcset(srcset, baseUrl) {
    if (!srcset) return '';

    const parts = String(srcset)
        .split(',')
        .map(x => x.trim())
        .filter(Boolean);

    if (!parts.length) return '';

    const last = parts[parts.length - 1].split(/\s+/)[0];
    return absolutize(last, baseUrl);
}

function getImageSrc(el, $, baseUrl) {
    const src =
        el.attr('src') ||
        el.attr('data-src') ||
        el.attr('data-original') ||
        el.attr('data-lazy-src') ||
        el.attr('data-url') ||
        '';

    const srcset =
        el.attr('srcset') ||
        el.attr('data-srcset') ||
        '';

    return absolutize(src, baseUrl) || bestSrcFromSrcset(srcset, baseUrl);
}

function decodeHtmlBuffer(buffer, contentType = '') {
    const m = /charset=([^;]+)/i.exec(contentType);
    const charset = m ? m[1].trim().toLowerCase() : 'utf-8';

    if (iconv.encodingExists(charset)) {
        return iconv.decode(buffer, charset);
    }

    return buffer.toString('utf8');
}

async function fetchHtml(rawUrl) {
    let currentUrl = normalizeInputUrl(rawUrl);

    for (let i = 0; i < 6; i++) {
        await assertPublicUrl(currentUrl);

        const response = await axios.get(currentUrl, {
            timeout: AXIOS_TIMEOUT,
            responseType: 'arraybuffer',
            maxContentLength: MAX_BYTES,
            maxBodyLength: MAX_BYTES,
            validateStatus: s => s >= 200 && s < 400,
            maxRedirects: 0,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
                'Cache-Control': 'no-cache'
            }
        });

        const type = String(response.headers['content-type'] || '');

        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const loc = response.headers.location;
            if (!loc) throw new Error('redirect without location');

            currentUrl = new URL(loc, currentUrl).toString();
            continue;
        }

        if (!/text\/html|application\/xhtml\+xml|application\/xml/i.test(type)) {
            throw new Error('not html content');
        }

        return {
            html: decodeHtmlBuffer(Buffer.from(response.data), type),
            finalUrl: currentUrl,
            status: response.status,
            contentType: type
        };
    }

    throw new Error('too many redirects');
}

let browserPromise = null;

async function getBrowser() {
    if (!browserPromise) {
        const { chromium } = require('playwright');

        browserPromise = chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-setuid-sandbox'
            ]
        });
    }

    return browserPromise;
}

async function renderHtml(rawUrl) {
    const targetUrl = normalizeInputUrl(rawUrl);
    await assertPublicUrl(targetUrl);

    const browser = await getBrowser();

    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36',
        viewport: {
            width: 390,
            height: 844,
            isMobile: true
        },
        locale: 'ru-RU',
        javaScriptEnabled: true,
        ignoreHTTPSErrors: true
    });

    const page = await context.newPage();

    await page.route('**/*', async route => {
        const req = route.request();
        const type = req.resourceType();

        try {
            const reqUrl = req.url();

            if (!/^https?:\/\//i.test(reqUrl)) {
                return route.abort();
            }

            if (['image', 'media', 'font'].includes(type)) {
                return route.abort();
            }

            await assertPublicUrl(reqUrl);
            return route.continue();
        } catch {
            return route.abort();
        }
    });

    try {
        const response = await page.goto(targetUrl, {
            waitUntil: 'domcontentloaded',
            timeout: BROWSER_TIMEOUT
        });

        await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(700);

        const html = await page.content();
        const finalUrl = page.url();

        return {
            html,
            finalUrl,
            status: response ? response.status() : 200,
            contentType: 'text/html; rendered=playwright'
        };
    } finally {
        await context.close().catch(() => {});
    }
}

function parseHtml(html, pageUrl, status, contentType, mode) {
    const $ = cheerio.load(html, {
        decodeEntities: true,
        lowerCaseTags: true,
        lowerCaseAttributeNames: true
    });

    const elements = [];
    const seen = new Set();

    function push(obj) {
        if (elements.length >= MAX_ELEMENTS) return;

        if (!obj || !obj.t) return;

        if (obj.v) obj.v = cleanText(obj.v);
        if (obj.v === '') return;

        const key = `${obj.t}:${obj.v || obj.u || JSON.stringify(obj).slice(0, 150)}`;

        if (seen.has(key)) return;
        seen.add(key);

        elements.push(obj);
    }

    function meta(name) {
        return cleanText(
            $(`meta[name="${name}"]`).attr('content') ||
            $(`meta[property="${name}"]`).attr('content') ||
            ''
        );
    }

    $('script, style, noscript, template, canvas').remove();

    const title = cleanText(
        $('title').first().text() ||
        meta('og:title') ||
        meta('twitter:title')
    );

    const description = cleanText(
        meta('description') ||
        meta('og:description') ||
        meta('twitter:description')
    );

    const ogImage = absolutize(
        meta('og:image') || meta('twitter:image'),
        pageUrl
    );

    if (title) push({ t: 'title', v: title });
    if (description) push({ t: 'description', v: description });
    if (ogImage) push({ t: 'img', v: 'preview image', u: ogImage });

    function extractForm(el) {
        const action = absolutize(el.attr('action') || pageUrl, pageUrl);
        const method = cleanText(el.attr('method') || 'get').toLowerCase();

        push({
            t: 'form',
            v: cleanText(el.attr('aria-label') || el.attr('name') || 'form'),
            u: action,
            method
        });
    }

    function extractTable(el) {
        const rows = [];

        el.find('tr').slice(0, 20).each(function () {
            const cells = [];

            $(this).find('td,th').slice(0, 8).each(function () {
                const txt = cleanText($(this).text(), 120);
                if (txt) cells.push(txt);
            });

            if (cells.length) rows.push(cells);
        });

        if (rows.length) {
            push({ t: 'table', v: rows });
        }
    }

    function extractSelect(el) {
        const label =
            el.attr('aria-label') ||
            el.attr('name') ||
            el.attr('id') ||
            'select';

        const options = [];

        el.find('option').slice(0, 30).each(function () {
            const txt = cleanText($(this).text(), 120);
            if (txt) options.push(txt);
        });

        push({
            t: 'select',
            v: cleanText(label),
            options
        });
    }

    function walk(node) {
        if (elements.length >= MAX_ELEMENTS) return;

        $(node).children().each(function () {
            if (elements.length >= MAX_ELEMENTS) return false;

            const el = $(this);
            const tag = this.tagName ? this.tagName.toLowerCase() : '';

            if (!tag) return;

            if (['script', 'style', 'noscript', 'template', 'canvas'].includes(tag)) {
                return;
            }

            if (/^h[1-6]$/.test(tag)) {
                push({ t: tag, v: el.text() });
                return;
            }

            if (tag === 'p') {
                const txt = cleanText(el.text(), 1800);
                if (txt.length > 2) push({ t: 'p', v: txt });
                return;
            }

            if (tag === 'article') {
                const label = cleanText(el.attr('aria-label') || el.find('h1,h2,h3').first().text(), 300);
                if (label) push({ t: 'article', v: label });
                walk(this);
                return;
            }

            if (tag === 'section') {
                const label = cleanText(el.attr('aria-label') || el.find('h1,h2,h3').first().text(), 300);
                if (label) push({ t: 'section', v: label });
                walk(this);
                return;
            }

            if (tag === 'a') {
                const txt = cleanText(
                    el.text() ||
                    el.attr('aria-label') ||
                    el.attr('title'),
                    500
                );

                const href = absolutize(el.attr('href'), pageUrl);

                if (txt && href) {
                    push({ t: 'a', v: txt, u: href });
                } else if (txt) {
                    push({ t: 'p', v: txt });
                }

                return;
            }

            if (tag === 'img') {
                const src = getImageSrc(el, $, pageUrl);
                const alt = cleanText(
                    el.attr('alt') ||
                    el.attr('title') ||
                    el.attr('aria-label') ||
                    src.split('/').pop() ||
                    'image',
                    300
                );

                if (src || alt) {
                    push({ t: 'img', v: alt || 'image', u: src });
                }

                return;
            }

            if (tag === 'picture') {
                const img = el.find('img').first();
                const src = getImageSrc(img, $, pageUrl) ||
                    bestSrcFromSrcset(el.find('source').first().attr('srcset'), pageUrl);

                const alt = cleanText(img.attr('alt') || 'image', 300);

                if (src) {
                    push({ t: 'img', v: alt, u: src });
                }

                return;
            }

            if (tag === 'li') {
                const clone = el.clone();
                clone.children('ul,ol').remove();

                const txt = cleanText(clone.text(), 1000);

                if (txt) {
                    push({ t: 'li', v: txt });
                }

                return;
            }

            if (tag === 'blockquote') {
                const txt = cleanText(el.text(), 1600);
                if (txt) push({ t: 'quote', v: txt });
                return;
            }

            if (tag === 'pre') {
                const txt = cleanText(el.text(), 3000);
                if (txt) push({ t: 'pre', v: txt });
                return;
            }

            if (tag === 'code') {
                const txt = cleanText(el.text(), 1200);
                if (txt) push({ t: 'code', v: txt });
                return;
            }

            if (tag === 'hr') {
                push({ t: 'hr' });
                return;
            }

            if (tag === 'br') {
                push({ t: 'br' });
                return;
            }

            if (tag === 'form') {
                extractForm(el);
                walk(this);
                return;
            }

            if (tag === 'input') {
                const type = cleanText(el.attr('type') || 'text').toLowerCase();
                if (type === 'hidden') return;

                const label = cleanText(
                    el.attr('placeholder') ||
                    el.attr('aria-label') ||
                    el.attr('name') ||
                    el.attr('value') ||
                    type,
                    300
                );

                if (['submit', 'button', 'reset'].includes(type)) {
                    push({ t: 'btn', v: label || 'button' });
                } else {
                    push({ t: 'input', v: label || type, it: type });
                }

                return;
            }

            if (tag === 'button') {
                const txt = cleanText(
                    el.text() ||
                    el.attr('aria-label') ||
                    el.attr('title') ||
                    'button',
                    300
                );

                push({ t: 'btn', v: txt });
                return;
            }

            if (tag === 'textarea') {
                const ph = cleanText(
                    el.attr('placeholder') ||
                    el.attr('aria-label') ||
                    el.attr('name') ||
                    'textarea',
                    300
                );

                push({ t: 'textarea', v: ph });
                return;
            }

            if (tag === 'select') {
                extractSelect(el);
                return;
            }

            if (tag === 'label') {
                const txt = cleanText(el.text(), 300);
                if (txt) push({ t: 'label', v: txt });
                return;
            }

            if (tag === 'table') {
                extractTable(el);
                return;
            }

            if (tag === 'iframe') {
                const src = absolutize(el.attr('src'), pageUrl);
                const name = cleanText(el.attr('title') || el.attr('aria-label') || 'iframe', 300);

                if (src) {
                    push({ t: 'iframe', v: name, u: src });
                }

                return;
            }

            if (tag === 'video' || tag === 'audio') {
                const src = absolutize(el.attr('src') || el.find('source').first().attr('src'), pageUrl);
                const label = cleanText(el.attr('title') || el.attr('aria-label') || tag, 300);

                push({ t: tag, v: label, u: src });
                return;
            }

            walk(this);
        });
    }

    const root =
        $('main').first().length ? $('main').first() :
        $('article').first().length ? $('article').first() :
        $('body').first();

    walk(root);

    return {
        ok: true,
        mode,
        status,
        contentType,
        url: pageUrl,
        title,
        description,
        image: ogImage,
        stats: {
            elements: elements.length,
            cached: false
        },
        elements
    };
}

app.get('/fetch', async (req, res) => {
    const rawUrl = req.query.url;
    const jsMode = ['1', 'true', 'yes', 'browser', 'playwright'].includes(
        String(req.query.js || req.query.mode || '').toLowerCase()
    );

    try {
        const normalizedUrl = normalizeInputUrl(rawUrl);
        const cacheKey = `${jsMode ? 'browser' : 'static'}:${normalizedUrl}`;

        const cached = cache.get(cacheKey);

        if (cached) {
            cached.stats.cached = true;
            return res.json(cached);
        }

        const page = jsMode
            ? await renderHtml(normalizedUrl)
            : await fetchHtml(normalizedUrl);

        const parsed = parseHtml(
            page.html,
            page.finalUrl,
            page.status,
            page.contentType,
            jsMode ? 'browser' : 'static'
        );

        cache.set(cacheKey, parsed);

        res.json(parsed);
    } catch (e) {
        res.status(400).json({
            ok: false,
            error: e.message
        });
    }
});

app.get('/health', (req, res) => {
    res.json({
        ok: true,
        cache: cache.size,
        uptime: process.uptime()
    });
});

app.get('/', (req, res) => {
    res.type('text/plain').send(
        'LurkBrowser Proxy OK\n\n' +
        '/fetch?url=https://example.com\n' +
        '/fetch?url=https://example.com&js=1'
    );
});

process.on('SIGINT', async () => {
    if (browserPromise) {
        const browser = await browserPromise.catch(() => null);
        if (browser) await browser.close().catch(() => {});
    }

    process.exit(0);
});

app.listen(PORT, () => {
    console.log('Server on port', PORT);
});
