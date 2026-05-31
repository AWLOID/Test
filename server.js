const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/fetch', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.json({ error: 'no url' });

    try {
        const response = await axios.get(url, {
            timeout: 8000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'ru,en;q=0.9',
            },
            maxRedirects: 5,
        });

        const $ = cheerio.load(response.data);
        const base = new URL(url);

        // Убираем мусор
        $('script, style, noscript, svg, iframe, nav, footer, aside, form > input[type=hidden]').remove();

        const elements = [];

        // Title
        const title = $('title').text().trim();
        if (title) elements.push({ t: 'title', v: title });

        // Рекурсивный обход body
        function walk(node) {
            $(node).children().each(function() {
                const el = $(this);
                const tag = this.tagName ? this.tagName.toLowerCase() : '';

                if (['script','style','noscript','svg','iframe'].includes(tag)) return;

                if (['h1','h2','h3','h4','h5'].indexOf(tag) !== -1) {
                    const txt = el.text().trim().replace(/\s+/g,' ');
                    if (txt) elements.push({ t: tag, v: txt });

                } else if (tag === 'p') {
                    const txt = el.text().trim().replace(/\s+/g,' ');
                    if (txt.length > 2) elements.push({ t: 'p', v: txt });

                } else if (tag === 'a') {
                    const txt = el.text().trim().replace(/\s+/g,' ');
                    let href = el.attr('href') || '';
                    if (href.startsWith('//')) href = 'https:' + href;
                    else if (href.startsWith('/')) href = base.origin + href;
                    else if (!href.startsWith('http')) href = '';
                    if (txt && href) elements.push({ t: 'a', v: txt, u: href });
                    else if (txt) elements.push({ t: 'p', v: txt });

                } else if (tag === 'img') {
                    const alt = el.attr('alt') || '';
                    const src = el.attr('src') || '';
                    elements.push({ t: 'img', v: alt || src.split('/').pop() || 'image' });

                } else if (tag === 'li') {
                    const txt = el.clone().children('ul,ol').remove().end().text().trim().replace(/\s+/g,' ');
                    if (txt) elements.push({ t: 'li', v: txt });

                } else if (tag === 'hr') {
                    elements.push({ t: 'hr' });

                } else if (tag === 'br') {
                    elements.push({ t: 'br' });

                } else if (tag === 'input') {
                    const itype = (el.attr('type') || 'text').toLowerCase();
                    const ph = el.attr('placeholder') || el.attr('name') || '';
                    const val = el.attr('value') || '';
                    if (itype === 'submit' || itype === 'button') {
                        elements.push({ t: 'btn', v: val || 'Submit' });
                    } else if (itype !== 'hidden') {
                        elements.push({ t: 'input', v: ph, it: itype });
                    }

                } else if (tag === 'button') {
                    const txt = el.text().trim();
                    if (txt) elements.push({ t: 'btn', v: txt });

                } else if (tag === 'textarea') {
                    const ph = el.attr('placeholder') || '';
                    elements.push({ t: 'textarea', v: ph });

                } else if (tag === 'table') {
                    const rows = [];
                    el.find('tr').each(function() {
                        const cells = [];
                        $(this).find('td,th').each(function() {
                            cells.push($(this).text().trim().replace(/\s+/g,' ').substring(0,40));
                        });
                        if (cells.length) rows.push(cells);
                    });
                    if (rows.length) elements.push({ t: 'table', v: rows });

                } else {
                    walk(this);
                }

                if (elements.length > 300) return false;
            });
        }

        walk($('body'));

        res.json({
            ok: true,
            url: url,
            title: title,
            elements: elements.slice(0, 300)
        });

    } catch(e) {
        res.json({ error: e.message });
    }
});

app.get('/', (req, res) => res.send('LurkBrowser Proxy OK'));

app.listen(PORT, () => console.log('Server on port', PORT));
