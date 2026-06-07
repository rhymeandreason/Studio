//! Minimal multi-scale PatchMatch image completion, used to *outpaint*
//! (extend) image backgrounds.
//!
//! Input is an RGBA buffer whose pixels to synthesize ("holes") are marked by
//! alpha < 128; known pixels are opaque. We run a coarse-to-fine pyramid: at
//! each level we alternate a PatchMatch nearest-neighbour search (the "E" step)
//! with a similarity-weighted reconstruction of the hole (the "M" step). The
//! result is a fully opaque RGBA buffer with the holes filled from the image's
//! own content — exactly what works well for backgrounds (skies, walls,
//! foliage, gradients).

const R: i32 = 3; // patch radius → 7×7 patches
const MIN_SIDE: usize = 24; // stop the pyramid here
const MAX_LEVELS: usize = 6;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        (x >> 32) as u32
    }
    fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            0
        } else {
            (self.next() as usize) % n
        }
    }
}

/// One pyramid level: dimensions + which pixels are known + their colours.
struct Level {
    w: usize,
    h: usize,
    known: Vec<bool>,
    color: Vec<f32>, // rgb, len w*h*3 (hole entries undefined until solved)
}

#[inline]
fn idx(x: usize, y: usize, w: usize) -> usize {
    y * w + x
}

/// Public entry: fill the holes of `rgba` (w×h) and return an opaque RGBA buffer.
pub fn outpaint(rgba: &[u8], w: usize, h: usize) -> Vec<u8> {
    let mut known = vec![false; w * h];
    let mut color = vec![0f32; w * h * 3];
    for i in 0..w * h {
        if rgba[i * 4 + 3] >= 128 {
            known[i] = true;
            color[i * 3] = rgba[i * 4] as f32;
            color[i * 3 + 1] = rgba[i * 4 + 1] as f32;
            color[i * 3 + 2] = rgba[i * 4 + 2] as f32;
        }
    }
    let finest = Level { w, h, known, color };

    // Pyramid, coarse → fine.
    let mut pyramid = vec![finest];
    while {
        let l = pyramid.last().unwrap();
        l.w.min(l.h) > MIN_SIDE && pyramid.len() < MAX_LEVELS
    } {
        pyramid.push(downsample(pyramid.last().unwrap()));
    }
    pyramid.reverse();

    // Coarsest: seed holes by mirror-reflecting the known region. This keeps
    // low-frequency gradients (vignettes) and straight structure continuous at
    // the boundary, giving PatchMatch a coherent start instead of a flat block.
    let mut solved = {
        let l = &pyramid[0];
        let mut color = l.color.clone();
        reflect_seed(l, &mut color);
        em_solve(l, color, None, 6, 1)
    };

    // Refine down to the finest level.
    for (li, l) in pyramid.iter().enumerate().skip(1) {
        let mut color = l.color.clone();
        upsample_into_holes(&solved, l, &mut color);
        let nnf = upsample_nnf(&solved, l.w, l.h);
        let seed = 1 + li as u64;
        solved = em_solve(l, color, Some(nnf), 4, seed);
    }

    // Pack to opaque RGBA.
    let mut out = vec![0u8; w * h * 4];
    for i in 0..w * h {
        out[i * 4] = solved.color[i * 3].round().clamp(0.0, 255.0) as u8;
        out[i * 4 + 1] = solved.color[i * 3 + 1].round().clamp(0.0, 255.0) as u8;
        out[i * 4 + 2] = solved.color[i * 3 + 2].round().clamp(0.0, 255.0) as u8;
        out[i * 4 + 3] = 255;
    }
    out
}

struct Solved {
    w: usize,
    h: usize,
    color: Vec<f32>,
    nx: Vec<i32>, // source-patch centre x for each target pixel
    ny: Vec<i32>,
}

/// Triangle-wave reflection of `v` into the inclusive range [lo, hi].
fn reflect(v: i32, lo: i32, hi: i32) -> i32 {
    if hi <= lo {
        return lo;
    }
    let period = 2 * (hi - lo);
    let mut t = (v - lo) % period;
    if t < 0 {
        t += period;
    }
    if t > hi - lo {
        t = period - t;
    }
    lo + t
}

/// Seed hole pixels by mirror-reflecting the known region's bounding box.
/// Falls back to the mean colour for any reflected sample that isn't known
/// (only possible with a non-rectangular known region).
fn reflect_seed(l: &Level, color: &mut [f32]) {
    let (mut minx, mut miny, mut maxx, mut maxy) = (l.w, l.h, 0usize, 0usize);
    let mut any = false;
    for y in 0..l.h {
        for x in 0..l.w {
            if l.known[idx(x, y, l.w)] {
                any = true;
                minx = minx.min(x);
                maxx = maxx.max(x);
                miny = miny.min(y);
                maxy = maxy.max(y);
            }
        }
    }
    let mean = mean_known(l);
    if !any {
        for i in 0..l.w * l.h {
            color[i * 3] = mean[0];
            color[i * 3 + 1] = mean[1];
            color[i * 3 + 2] = mean[2];
        }
        return;
    }
    for y in 0..l.h {
        for x in 0..l.w {
            let i = idx(x, y, l.w);
            if l.known[i] {
                continue;
            }
            let sx = reflect(x as i32, minx as i32, maxx as i32) as usize;
            let sy = reflect(y as i32, miny as i32, maxy as i32) as usize;
            let s = idx(sx, sy, l.w);
            if l.known[s] {
                color[i * 3] = l.color[s * 3];
                color[i * 3 + 1] = l.color[s * 3 + 1];
                color[i * 3 + 2] = l.color[s * 3 + 2];
            } else {
                color[i * 3] = mean[0];
                color[i * 3 + 1] = mean[1];
                color[i * 3 + 2] = mean[2];
            }
        }
    }
}

fn mean_known(l: &Level) -> [f32; 3] {
    let mut s = [0f64; 3];
    let mut n = 0u64;
    for i in 0..l.w * l.h {
        if l.known[i] {
            s[0] += l.color[i * 3] as f64;
            s[1] += l.color[i * 3 + 1] as f64;
            s[2] += l.color[i * 3 + 2] as f64;
            n += 1;
        }
    }
    if n == 0 {
        return [128.0; 3];
    }
    [
        (s[0] / n as f64) as f32,
        (s[1] / n as f64) as f32,
        (s[2] / n as f64) as f32,
    ]
}

/// Box-downsample a level by 2×. A coarse pixel is known if any of its four
/// fine pixels are known; its colour is the average of those known pixels.
fn downsample(l: &Level) -> Level {
    let w2 = (l.w + 1) / 2;
    let h2 = (l.h + 1) / 2;
    let mut known = vec![false; w2 * h2];
    let mut color = vec![0f32; w2 * h2 * 3];
    for y2 in 0..h2 {
        for x2 in 0..w2 {
            let mut s = [0f32; 3];
            let mut n = 0f32;
            for dy in 0..2 {
                for dx in 0..2 {
                    let x = x2 * 2 + dx;
                    let y = y2 * 2 + dy;
                    if x < l.w && y < l.h && l.known[idx(x, y, l.w)] {
                        let p = idx(x, y, l.w);
                        s[0] += l.color[p * 3];
                        s[1] += l.color[p * 3 + 1];
                        s[2] += l.color[p * 3 + 2];
                        n += 1.0;
                    }
                }
            }
            let o = idx(x2, y2, w2);
            if n > 0.0 {
                known[o] = true;
                color[o * 3] = s[0] / n;
                color[o * 3 + 1] = s[1] / n;
                color[o * 3 + 2] = s[2] / n;
            }
        }
    }
    Level {
        w: w2,
        h: h2,
        known,
        color,
    }
}

/// Bilinearly upsample the solved (coarse) colours into the holes of `dst`
/// (the finer level), leaving known pixels untouched.
fn upsample_into_holes(src: &Solved, dst: &Level, color: &mut [f32]) {
    let (sw, sh) = (src.w, src.h);
    for y in 0..dst.h {
        for x in 0..dst.w {
            let p = idx(x, y, dst.w);
            if dst.known[p] {
                continue;
            }
            let fx = (x as f32 * sw as f32 / dst.w as f32).min(sw as f32 - 1.0);
            let fy = (y as f32 * sh as f32 / dst.h as f32).min(sh as f32 - 1.0);
            let x0 = fx.floor() as usize;
            let y0 = fy.floor() as usize;
            let x1 = (x0 + 1).min(sw - 1);
            let y1 = (y0 + 1).min(sh - 1);
            let tx = fx - x0 as f32;
            let ty = fy - y0 as f32;
            for ch in 0..3 {
                let c00 = src.color[idx(x0, y0, sw) * 3 + ch];
                let c10 = src.color[idx(x1, y0, sw) * 3 + ch];
                let c01 = src.color[idx(x0, y1, sw) * 3 + ch];
                let c11 = src.color[idx(x1, y1, sw) * 3 + ch];
                let top = c00 + (c10 - c00) * tx;
                let bot = c01 + (c11 - c01) * tx;
                color[p * 3 + ch] = top + (bot - top) * ty;
            }
        }
    }
}

/// Scale the coarse NNF up to the finer resolution (×2 coordinates).
fn upsample_nnf(src: &Solved, w: usize, h: usize) -> (Vec<i32>, Vec<i32>) {
    let mut nx = vec![0i32; w * h];
    let mut ny = vec![0i32; w * h];
    for y in 0..h {
        for x in 0..w {
            let sx = (x / 2).min(src.w - 1);
            let sy = (y / 2).min(src.h - 1);
            let s = idx(sx, sy, src.w);
            nx[idx(x, y, w)] = (src.nx[s] * 2).clamp(R, w as i32 - 1 - R);
            ny[idx(x, y, w)] = (src.ny[s] * 2).clamp(R, h as i32 - 1 - R);
        }
    }
    (nx, ny)
}

#[inline]
fn patch_dist(
    color: &[f32],
    w: usize,
    tx: i32,
    ty: i32,
    sx: i32,
    sy: i32,
    best: f32,
) -> f32 {
    let mut sum = 0f32;
    for dy in -R..=R {
        for dx in -R..=R {
            let tp = idx((tx + dx) as usize, (ty + dy) as usize, w) * 3;
            let sp = idx((sx + dx) as usize, (sy + dy) as usize, w) * 3;
            let dr = color[tp] - color[sp];
            let dg = color[tp + 1] - color[sp + 1];
            let db = color[tp + 2] - color[sp + 2];
            sum += dr * dr + dg * dg + db * db;
        }
        if sum >= best {
            return sum;
        }
    }
    sum
}

/// Run a few EM iterations on one level. `init` is an optional NNF seed; `color`
/// already has known pixels + an initial hole guess.
fn em_solve(
    l: &Level,
    mut color: Vec<f32>,
    init: Option<(Vec<i32>, Vec<i32>)>,
    iters: usize,
    seed: u64,
) -> Solved {
    let (w, h) = (l.w, l.h);
    let inner_x = R..(w as i32 - R);
    let inner_y = R..(h as i32 - R);

    // Centres whose 5×5 patch lies fully in the known region → valid sources.
    let mut valid_src = vec![false; w * h];
    let mut src_list: Vec<(i32, i32)> = Vec::new();
    // Centres whose patch overlaps a hole → the targets we synthesize.
    let mut overlap = vec![false; w * h];
    let mut targets: Vec<(i32, i32)> = Vec::new();
    for y in inner_y.clone() {
        for x in inner_x.clone() {
            let mut any_hole = false;
            'p: for dy in -R..=R {
                for dx in -R..=R {
                    if !l.known[idx((x + dx) as usize, (y + dy) as usize, w)] {
                        any_hole = true;
                        break 'p;
                    }
                }
            }
            let i = idx(x as usize, y as usize, w);
            if any_hole {
                overlap[i] = true;
                targets.push((x, y));
            } else {
                valid_src[i] = true;
                src_list.push((x, y));
            }
        }
    }

    let mut nx = vec![0i32; w * h];
    let mut ny = vec![0i32; w * h];
    let mut rng = Rng(seed.wrapping_mul(0x9E3779B97F4A7C15).max(1));

    // Seed the NNF for every target.
    if let Some((ix, iy)) = init {
        for &(x, y) in &targets {
            let i = idx(x as usize, y as usize, w);
            let (mut cx, mut cy) = (ix[i], iy[i]);
            if !(cx >= R && cx < w as i32 - R && cy >= R && cy < h as i32 - R
                && valid_src[idx(cx as usize, cy as usize, w)])
            {
                if src_list.is_empty() {
                    return solved_from(w, h, color, nx, ny);
                }
                let s = src_list[rng.below(src_list.len())];
                cx = s.0;
                cy = s.1;
            }
            nx[i] = cx;
            ny[i] = cy;
        }
    } else {
        if src_list.is_empty() {
            return solved_from(w, h, color, nx, ny);
        }
        for &(x, y) in &targets {
            let i = idx(x as usize, y as usize, w);
            let s = src_list[rng.below(src_list.len())];
            nx[i] = s.0;
            ny[i] = s.1;
        }
    }

    if src_list.is_empty() || targets.is_empty() {
        return solved_from(w, h, color, nx, ny);
    }

    for it in 0..iters {
        // --- E step: improve each target's match (propagation + random tries).
        let forward = it % 2 == 0;
        let order: Vec<usize> = if forward {
            (0..targets.len()).collect()
        } else {
            (0..targets.len()).rev().collect()
        };
        for &ti in &order {
            let (x, y) = targets[ti];
            let i = idx(x as usize, y as usize, w);
            let mut bx = nx[i];
            let mut by = ny[i];
            let mut bd = patch_dist(&color, w, x, y, bx, by, f32::INFINITY);

            // Propagate from the already-updated neighbour.
            let step = if forward { -1 } else { 1 };
            for &(ddx, ddy) in &[(step, 0), (0, step)] {
                let (nxp, nyp) = (x + ddx, y + ddy);
                if nxp < R || nxp >= w as i32 - R || nyp < R || nyp >= h as i32 - R {
                    continue;
                }
                let ni = idx(nxp as usize, nyp as usize, w);
                if !overlap[ni] {
                    continue;
                }
                // Candidate source = neighbour's source shifted back toward us.
                let cx = nx[ni] - ddx;
                let cy = ny[ni] - ddy;
                if cx >= R
                    && cx < w as i32 - R
                    && cy >= R
                    && cy < h as i32 - R
                    && valid_src[idx(cx as usize, cy as usize, w)]
                {
                    let d = patch_dist(&color, w, x, y, cx, cy, bd);
                    if d < bd {
                        bd = d;
                        bx = cx;
                        by = cy;
                    }
                }
            }

            // Random search: probe a window around the current best, halving
            // the radius each step. This is what lets matches refine so straight
            // structure (shelf edges, book tops) stays continuous.
            let mut radius = (w.max(h)) as i32;
            while radius >= 1 {
                let cx = bx + rng.below((2 * radius + 1) as usize) as i32 - radius;
                let cy = by + rng.below((2 * radius + 1) as usize) as i32 - radius;
                if cx >= R
                    && cx < w as i32 - R
                    && cy >= R
                    && cy < h as i32 - R
                    && valid_src[idx(cx as usize, cy as usize, w)]
                {
                    let d = patch_dist(&color, w, x, y, cx, cy, bd);
                    if d < bd {
                        bd = d;
                        bx = cx;
                        by = cy;
                    }
                }
                radius /= 2;
            }

            // A couple of fully-random restarts to escape local minima.
            for _ in 0..2 {
                let s = src_list[rng.below(src_list.len())];
                let d = patch_dist(&color, w, x, y, s.0, s.1, bd);
                if d < bd {
                    bd = d;
                    bx = s.0;
                    by = s.1;
                }
            }
            nx[i] = bx;
            ny[i] = by;
        }

        // --- M step: rebuild hole colours by similarity-weighted patch voting.
        let mut acc = vec![0f32; w * h * 3];
        let mut wsum = vec![0f32; w * h];
        // Weight scale from the mean match cost this iteration.
        let mut mean_d = 0f64;
        for &(x, y) in &targets {
            let i = idx(x as usize, y as usize, w);
            mean_d += patch_dist(&color, w, x, y, nx[i], ny[i], f32::INFINITY) as f64;
        }
        mean_d /= targets.len().max(1) as f64;
        let sigma = (mean_d as f32).max(1.0);

        for &(x, y) in &targets {
            let i = idx(x as usize, y as usize, w);
            let (sx, sy) = (nx[i], ny[i]);
            let d = patch_dist(&color, w, x, y, sx, sy, f32::INFINITY);
            let wt = (-d / sigma).exp();
            for dy in -R..=R {
                for dx in -R..=R {
                    let px = (x + dx) as usize;
                    let py = (y + dy) as usize;
                    let p = idx(px, py, w);
                    if l.known[p] {
                        continue;
                    }
                    let sp = idx((sx + dx) as usize, (sy + dy) as usize, w) * 3;
                    acc[p * 3] += color[sp] * wt;
                    acc[p * 3 + 1] += color[sp + 1] * wt;
                    acc[p * 3 + 2] += color[sp + 2] * wt;
                    wsum[p] += wt;
                }
            }
        }
        for p in 0..w * h {
            if !l.known[p] && wsum[p] > 0.0 {
                color[p * 3] = acc[p * 3] / wsum[p];
                color[p * 3 + 1] = acc[p * 3 + 1] / wsum[p];
                color[p * 3 + 2] = acc[p * 3 + 2] / wsum[p];
            }
        }
    }

    solved_from(w, h, color, nx, ny)
}

fn solved_from(w: usize, h: usize, color: Vec<f32>, nx: Vec<i32>, ny: Vec<i32>) -> Solved {
    Solved {
        w,
        h,
        color,
        nx,
        ny,
    }
}
