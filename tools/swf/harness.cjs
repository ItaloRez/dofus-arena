// Opens a blank page that can load swf.js and SWF files from disk via routes.
// Usage from other scripts: const h = await require('./harness.cjs').open(); await h.page.evaluate(...)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOTS = {
  '/client/': process.env.CLIENT || '/home/claude/assets-src/client/',
  '/lib/': __dirname + '/',
};

async function open() {
  const browser = await chromium.launch({ args: ['--js-flags=--max-old-space-size=8192'] });
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || process.env.VERBOSE) console.log('[page]', m.text()); });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  const http = require('http');
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/') { res.setHeader('content-type', 'text/html'); return res.end('<!doctype html><body></body>'); }
    for (const [pre, dir] of Object.entries(ROOTS)) {
      if (u.pathname.startsWith(pre)) {
        const f = path.join(dir, decodeURIComponent(u.pathname.slice(pre.length)));
        if (fs.existsSync(f) && fs.statSync(f).isFile()) { res.setHeader('content-type', f.endsWith('.js') ? 'text/javascript' : 'application/octet-stream'); return fs.createReadStream(f).pipe(res); }
      }
    }
    res.statusCode = 404; res.end('nf');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  browser.on('disconnected', () => server.close());
  await page.goto(base + '/');
  await page.addScriptTag({ type: 'module', content: `import * as S from '/lib/swf.js'; import * as R from '/lib/render.js'; window.S = S; window.R = R; window.ready = true;` });
  await page.waitForFunction(() => window.ready);
  return { browser, page };
}

function saveDataUrl(file, url) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
}

module.exports = { open, saveDataUrl };
