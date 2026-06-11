// Registry of animal sprite sheets (Aseprite-style grids, 32x32 cells) used
// for the per-project Workspace badge and the Claude window status bar.
//
// Each animal's `idle` / `movement` entries describe one row of the sheet:
// `row` is that row's y offset in source px, `cols` is how many of its
// frames to use, and `box` is the tight content bbox (x, y, w, h) within a
// single 32x32 cell — used to crop out the empty padding around the sprite.
//
// To add an animal: drop "<name>.png" in src/sprites/ and add an entry here
// with the row/box numbers (find `box` via the frame's alpha bounding box).

export const FRAME = 32;

export const SPRITES = {
  "red-panda": {
    file: "sprites/red-panda.png",
    sheet: { w: 256, h: 224 },
    idle: { row: 32, cols: 6, box: { x: 5, y: 20, w: 19, h: 12 } },
    movement: { row: 64, cols: 8, box: { x: 5, y: 16, w: 20, h: 16 } },
  },
};

export const DEFAULT_SPRITE = "red-panda";

/**
 * Compute the CSS needed to display one animated row of a sprite sheet at a
 * given display height (width follows the cropped frame's aspect ratio).
 * Returns an object of inline style properties.
 */
export function spriteStyle(animal, anim, displayHeight, fps = 8) {
  const def = SPRITES[animal] || SPRITES[DEFAULT_SPRITE];
  const part = def[anim];
  const scale = displayHeight / part.box.h;
  const w = Math.round(part.box.w * scale);
  const h = Math.round(part.box.h * scale);
  const pitch = FRAME * scale;
  const startX = -(part.box.x * scale);
  const startY = -((part.row + part.box.y) * scale);
  const endX = startX - pitch * part.cols;
  return {
    width: `${w}px`,
    height: `${h}px`,
    backgroundImage: `url("${def.file}")`,
    backgroundRepeat: "no-repeat",
    backgroundSize: `${Math.round(def.sheet.w * scale)}px ${Math.round(def.sheet.h * scale)}px`,
    "--sprite-start": `${startX}px ${startY}px`,
    "--sprite-end": `${endX}px ${startY}px`,
    backgroundPosition: "var(--sprite-start)",
    imageRendering: "pixelated",
    animation: `sprite-cycle ${part.cols / fps}s steps(${part.cols}) infinite`,
  };
}
