const { open, saveDataUrl } = require('./harness.cjs');
const fs = require('fs');
(async () => {
  const maps = JSON.parse(fs.readFileSync(__dirname + '/../out/maps.json'));
  const { browser, page } = await open();
  const m = maps['7362'];
  const r = await page.evaluate(async (m) => { await R.gfxIndex(); const x = await R.renderMap(m, { scale: 1 }); const gs = [...new Set(m.cells.map(c => c.ground))]; return { missing: x.missing, gs: gs.slice(0, 20) }; }, m);
  console.log(JSON.stringify(r));
  const g = r.gs.find(x => x);
  for (const f of ['g1', 'g2']) {
    const d = await page.evaluate(async ([f, g]) => { const s = await R.ready(`clips/gfx/${f}.swf`); const id = s.exports.get(String(g)); if (!id) return 'no'; const def = s.dict.get(id); await s.prepare(id); const sub = def.type === 'sprite' ? def.frames[0].map(e => [e.id, s.dict.get(e.id)?.type, s.dict.get(e.id)?.err, s.dict.get(e.id)?.layers?.length]) : def.layers?.length; return { id, type: def.type, err: def.err, sub, frames: def.frames?.length }; }, [f, g]);
    console.log(f, g, JSON.stringify(d));
  }
  const im = await page.evaluate((g) => R.image('clips/gfx/g1.swf', String(g), { scale: 2 }), g).catch(e => String(e));
  console.log(JSON.stringify(im).slice(0, 200));
  await browser.close();
})();
