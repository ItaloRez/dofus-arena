// Pre-rendered Dofus 1.29 graphics (made by tools/swf/export.cjs from the client SWFs)
const images = new Map();
export function image(url) {
  if (!images.has(url)) {
    images.set(url, new Promise((res) => {
      const img = new Image();
      img.onload = () => { ready.set(url, img); res(img); };
      img.onerror = () => res(null);
      img.src = url;
    }));
  }
  return images.get(url);
}

// Synchronous access for the render loop: returns the image once loaded, else null (and starts loading)
const ready = new Map();
export function imageNow(url) {
  if (ready.has(url)) return ready.get(url);
  ready.set(url, null);
  image(url).then((img) => ready.set(url, img));
  return null;
}

const jsons = new Map();
export function json(url) {
  if (!jsons.has(url)) jsons.set(url, fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  return jsons.get(url);
}

const metas = new Map();
// Sprite meta per gfx id: { staticR: {w,h,ox,oy,frames,cols}, ... } (null until loaded)
export function spriteMeta(gfx) {
  if (!metas.has(gfx)) { metas.set(gfx, null); json(`/assets/sprites/${gfx}.json`).then((m) => metas.set(gfx, m || {})); }
  return metas.get(gfx);
}
// Loads the meta and every animation sheet of a sprite, so no animation shows up blank the first time it plays
const preloads = new Map();
export function loadSprite(gfx) {
  if (!preloads.has(gfx)) {
    preloads.set(gfx, json(`/assets/sprites/${gfx}.json`).then((m) => {
      metas.set(gfx, m || {});
      return Promise.all(Object.keys(m || {}).map((a) => image(`/assets/sprites/${gfx}/${a}.webp`))).then(() => m);
    }));
  }
  return preloads.get(gfx);
}

export let FX = {}, GFX = {}, FXP = {};
export const assetsReady = Promise.all([
  json('/assets/fx/index.json').then((m) => { FX = m || {}; }),
  // pieces of spell effects placed by the client itself (move, shoot, duplicate, rotate): see VisualEffectHandler
  json('/assets/fx/parts.json').then((m) => { FXP = m || {}; }),
  json('/assets/gfx/index.json').then((m) => { GFX = m || {}; }),
]);

// The client's sprite SWFs are authored at 60 fps
export const SPRITE_FPS = 60;

// Draws a sprite animation frame with its feet at (x, y) in world units (1 unit = 1 Dofus pixel; images are 2x)
export function drawSprite(ctx, gfx, anim, frame, x, y, flip, alpha = 1) {
  const meta = spriteMeta(gfx);
  if (!meta) return false;
  const m = meta[anim];
  if (!m) return false;
  const img = imageNow(`/assets/sprites/${gfx}/${anim}.webp`);
  if (!img) return false;
  const f = Math.max(0, Math.min(m.frames - 1, frame));
  const sx = (f % m.cols) * m.w, sy = Math.floor(f / m.cols) * m.h;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(x, y);
  if (flip) ctx.scale(-1, 1);
  ctx.drawImage(img, sx, sy, m.w, m.h, -m.ox / 2, -m.oy / 2, m.w / 2, m.h / 2);
  ctx.restore();
  return true;
}

export function itemIcon(item) {
  return item && item.gfx ? `/assets/items/${item.type}/${item.gfx}.png` : '';
}
