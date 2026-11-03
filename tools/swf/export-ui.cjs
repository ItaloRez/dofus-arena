// Exports the fight HUD art of the 1.29 client into server/public/assets/ui/:
//   effects/<c>.png   effect category icons (clips/effectsicons.swf, Icon_<c>; the lang "effects" file gives each effect its c)
//   states/<id>.png   state icons (clips/statesicons.swf, State_<id>)
//   hud/<name>.png    banner pieces of modules/core.swf (heart, AP star, MP icon, timeline items, buttons...)
//   hud.json          size and registration point of each hud piece
// Usage: CLIENT=<client folder> node tools/swf/export-ui.cjs
const { open, saveDataUrl } = require('./harness.cjs');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '../../server/public/assets/ui');
const HUD = [
  'UI_Banner', 'Heart', 'Star', 'StarSymbol', 'IconMP', 'PointsViewerAP', 'PointsViewerMP', 'TimelineItem', 'TimelineItemSummonedBg',
  'TimelinePointer', 'ButtonNextTurnUp', 'ButtonNextTurnDown', 'ButtonGiveUpUp', 'ButtonGiveUpDown', 'UI_FightOptionTacticModeUp',
  'UI_FightOptionTacticModeDown', 'UI_BannerContainerBackground', 'UI_BannerContainerBorder', 'UI_BannerContainerHighLight',
  'ButtonTimelineUp', 'ButtonTimelineDown', 'UI_BuffHighlight', 'ButtonBuffUp', 'IconAir', 'IconEarth', 'IconFire', 'IconWater',
  'IconNeutral', 'IconVita', 'IconForbidden', 'NonDispellableIcon', 'ButtonBannerRoundUp', 'ButtonBannerRoundDown', 'VerticalChrono',
  'CircleChronoHalfDefault', 'IconWisdom', 'IconInit', 'IconPlacaje', 'IconHuida', 'IconAlcance', 'IconSummons', 'IconCritico',
];

(async () => {
  const { browser, page } = await open();
  const meta = {};
  const list = async (url, prefix) => page.evaluate(async ([u, p]) => { const s = await R.ready(u); return s ? [...s.exports.keys()].filter((k) => k.startsWith(p)) : []; }, [url, prefix]);
  const save = async (url, name, file, scale) => {
    const r = await page.evaluate(([u, n, s]) => R.image(u, n, { scale: s, size: 2048 }), [url, name, scale]);
    if (!r || !r.data) return null;
    saveDataUrl(file, r.data);
    delete r.data;
    return r;
  };
  let n = 0;
  for (const name of await list('clips/effectsicons.swf', 'Icon_')) {
    if (await save('clips/effectsicons.swf', name, `${OUT}/effects/${name.slice(5)}.png`, 2)) n++;
  }
  console.log('effect icons', n);
  n = 0;
  for (const name of await list('clips/statesicons.swf', 'State_')) {
    if (await save('clips/statesicons.swf', name, `${OUT}/states/${name.slice(6)}.png`, 2)) n++;
  }
  console.log('state icons', n);
  for (const name of HUD) {
    const r = await save('modules/core.swf', name, `${OUT}/hud/${name}.png`, name === 'UI_Banner' ? 2 : 2);
    if (r) meta[name] = { w: r.w, h: r.h, ox: r.ox, oy: r.oy, scale: 2 };
    else console.log('empty', name);
  }
  fs.writeFileSync(`${OUT}/hud.json`, JSON.stringify(meta, null, 1));
  console.log('hud pieces', Object.keys(meta).length);
  await browser.close();
})();
