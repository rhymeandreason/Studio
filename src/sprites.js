// Registry of animal sprite sheets (Aseprite-style grids, 32x32 cells) used
// for the per-project Workspace badge and the Claude window status bar.
//
// Each animation entry describes a horizontal run of frames within the
// sheet: `row` is that row's y offset in source px, `col` is the starting
// column (0 by default), `cols` is how many frames to use, and `box` is the
// tight content bbox (x, y, w, h) within a single 32x32 cell — used to crop
// out the empty padding around the sprite.
//
// `idle` and `movement` are the two keys the rest of the app looks up by
// default (Workspace badge / project card / Claude status bar); other named
// animations are kept here for reference and future use.
//
// To add an animal: drop "<name>.png" in src/sprites/ and add an entry here
// with the row/col/box numbers (find `box` via each frame's alpha bbox).

export const FRAME = 32;

const catSittingIdle = {
  row: 96,
  cols: 4,
  box: { x: 5, y: 8, w: 20, h: 19 },
};
const catJump = { row: 0, cols: 4, box: { x: 8, y: 6, w: 17, h: 18 } };

// All cat sheets (Black/Calico/Grey/Orange/White) share this 128x256 layout:
// row0 Jump, row1 Idle + Sit Down, row2 Stand Up, row3 Sitting Idle,
// row4 Laying Idle, row5 Laying Down, row6 Sitting Up,
// row7 Going to Sleep + Waking Up + Sleeping Idle.
function catSprite(file) {
  return {
    file,
    sheet: { w: 128, h: 256 },
    idle: catSittingIdle,
    movement: catJump,
    jump: catJump,
    "idle-stand": { row: 32, cols: 1, box: { x: 8, y: 8, w: 17, h: 16 } },
    "sit-down": { row: 32, col: 1, cols: 1, box: { x: 8, y: 9, w: 17, h: 15 } },
    "stand-up": { row: 64, cols: 1, box: { x: 8, y: 8, w: 17, h: 16 } },
    "sitting-idle": catSittingIdle,
    "laying-idle": { row: 128, cols: 2, box: { x: 9, y: 9, w: 16, h: 19 } },
    "laying-down": { row: 160, cols: 4, box: { x: 8, y: 10, w: 17, h: 18 } },
    "sitting-up": { row: 192, cols: 1, box: { x: 9, y: 11, w: 16, h: 15 } },
    "going-to-sleep": { row: 224, cols: 1, box: { x: 9, y: 11, w: 16, h: 15 } },
    "waking-up": { row: 224, col: 1, cols: 1, box: { x: 9, y: 11, w: 16, h: 16 } },
    "sleeping-idle": { row: 224, col: 2, cols: 1, box: { x: 9, y: 11, w: 16, h: 17 } },
  };
}

export const SPRITES = {
  "red-panda": {
    file: "sprites/red-panda.png",
    sheet: { w: 256, h: 224 },
    idle: { row: 32, cols: 6, box: { x: 5, y: 20, w: 19, h: 12 } },
    movement: { row: 64, cols: 8, box: { x: 5, y: 16, w: 20, h: 16 } },
  },
  "black-cat": catSprite("sprites/Black-Cat.png"),
  "calico-cat": catSprite("sprites/Calico-Cat.png"),
  "grey-cat": catSprite("sprites/Grey-Cat.png"),
  "orange-cat": catSprite("sprites/Orange-Cat.png"),
  "white-cat": catSprite("sprites/White-Cat.png"),
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
  const col = part.col || 0;
  const scale = displayHeight / part.box.h;
  const w = Math.round(part.box.w * scale);
  const h = Math.round(part.box.h * scale);
  const pitch = FRAME * scale;
  const startX = -((col * FRAME + part.box.x) * scale);
  const startY = -((part.row + part.box.y) * scale);
  const endX = startX - pitch * part.cols;
  const style = {
    width: `${w}px`,
    height: `${h}px`,
    backgroundImage: `url("${def.file}")`,
    backgroundRepeat: "no-repeat",
    backgroundSize: `${Math.round(def.sheet.w * scale)}px ${Math.round(def.sheet.h * scale)}px`,
    "--sprite-start": `${startX}px ${startY}px`,
    "--sprite-end": `${endX}px ${startY}px`,
    backgroundPosition: "var(--sprite-start)",
    imageRendering: "pixelated",
  };
  if (part.cols > 1) {
    style.animation = `sprite-cycle ${part.cols / fps}s steps(${part.cols}) infinite`;
  }
  return style;
}
