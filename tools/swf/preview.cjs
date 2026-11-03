const { open, saveDataUrl } = require('./harness.cjs');
const fs = require('fs');
(async () => {
  const maps = JSON.parse(fs.readFileSync(__dirname + '/../out/maps.json'));
  const { browser, page } = await open();
  console.log(await page.evaluate(() => R.gfxIndex()));
  for (const id of Object.keys(maps)) {
    const t = Date.now();
    const url = await page.evaluate((m) => R.previewMap(m, 1), maps[id]);
    saveDataUrl(`/tmp/shots/maps/${id}.jpg`, url);
    console.log(id, Date.now() - t, 'ms');
  }
  await browser.close();
})();
