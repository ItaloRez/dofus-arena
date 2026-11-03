const { open, saveDataUrl } = require('./harness.cjs');
const OUT = process.argv[2] || '/tmp/shots/swf';
(async () => {
  const { browser, page } = await open();
  const jobs = JSON.parse(process.argv[3] || '[]');
  for (const [url, name, opts, kind] of jobs) {
    const r = await page.evaluate(([u, n, o, k]) => (k === 'sheet' ? R.sheet(u, n, o) : k === 'describe' ? R.describe(u) : R.image(u, n, o)), [url, name, opts || {}, kind]);
    if (!r) { console.log(url, name, 'null'); continue; }
    if (r.data) { const f = `${OUT}/${url.replace(/\W/g, '_')}_${name}.${r.data.startsWith('data:image/webp') ? 'webp' : 'png'}`; saveDataUrl(f, r.data); delete r.data; console.log(f, JSON.stringify(r)); }
    else console.log(url, name, JSON.stringify(r).slice(0, 3000));
  }
  await browser.close();
})();
