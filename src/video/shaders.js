// Shader backgrounds for the video editor: "generator clips" that sit in the
// clip lane like footage but render a GLSL fragment shader instead of a file.
// Authored ONCE here and used by both the live preview and export (the export
// pipeline renders frames with this same code — see docs/video.md).
//
// A shader entry:
//   label  — inspector / add-menu display name
//   params — [{ key, label, type: "color" | "number", default, min?, max?,
//               step? }] — surfaced as inspector controls, stored on the clip
//               as `params`, and passed to the shader as uniforms
//   frag   — fragment source. Available uniforms: u_resolution (vec2, px),
//            u_time (float, seconds into the clip), plus one per param:
//            colors as vec3 (0..1 rgb), numbers as float, named u_<key>.
//
// Claude Code: to add a background, add an entry here — the editor picks it
// up in the "+ Add clip…" menu and the inspector automatically.

const VERT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const PREAMBLE = `
precision highp float;
uniform vec2 u_resolution;
uniform float u_time;
`;

export const SHADERS = {
  drift: {
    label: "Gradient drift",
    params: [
      { key: "colorA", label: "Color A", type: "color", default: "#e8d5c0" },
      { key: "colorB", label: "Color B", type: "color", default: "#a85a4a" },
      { key: "colorC", label: "Color C", type: "color", default: "#6f7d6a" },
      { key: "speed", label: "Speed", type: "number", default: 1, min: 0, max: 3, step: 0.1 },
    ],
    frag: `
uniform vec3 u_colorA; uniform vec3 u_colorB; uniform vec3 u_colorC;
uniform float u_speed;
void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  uv.x *= u_resolution.x / u_resolution.y;
  float t = u_time * u_speed * 0.5;
  vec2 p1 = vec2(0.3 + 0.35 * sin(t * 0.70), 0.4 + 0.30 * cos(t * 0.55));
  vec2 p2 = vec2(0.9 + 0.40 * sin(t * 0.43 + 2.0), 0.6 + 0.35 * cos(t * 0.61 + 1.0));
  vec2 p3 = vec2(0.6 + 0.45 * sin(t * 0.31 + 4.0), 0.2 + 0.35 * cos(t * 0.37 + 3.0));
  float w1 = 1.0 / (0.08 + dot(uv - p1, uv - p1) * 3.0);
  float w2 = 1.0 / (0.08 + dot(uv - p2, uv - p2) * 3.0);
  float w3 = 1.0 / (0.08 + dot(uv - p3, uv - p3) * 3.0);
  vec3 c = (u_colorA * w1 + u_colorB * w2 + u_colorC * w3) / (w1 + w2 + w3);
  gl_FragColor = vec4(c, 1.0);
}`,
  },

  aurora: {
    label: "Aurora",
    params: [
      { key: "base", label: "Base", type: "color", default: "#15171c" },
      { key: "glow", label: "Glow", type: "color", default: "#4ac6a8" },
      { key: "glow2", label: "Glow 2", type: "color", default: "#5a6ac6" },
      { key: "speed", label: "Speed", type: "number", default: 1, min: 0, max: 3, step: 0.1 },
    ],
    frag: `
uniform vec3 u_base; uniform vec3 u_glow; uniform vec3 u_glow2;
uniform float u_speed;
float band(vec2 uv, float t, float seed) {
  float y = 0.5 + 0.22 * sin(uv.x * 2.4 + t + seed) + 0.12 * sin(uv.x * 5.1 - t * 0.7 + seed * 2.0);
  return exp(-pow((uv.y - y) * 4.5, 2.0));
}
void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  float t = u_time * u_speed * 0.6;
  vec3 c = u_base;
  c += u_glow  * band(uv, t, 0.0) * 0.75;
  c += u_glow2 * band(uv, t * 1.3, 2.7) * 0.55;
  c += u_glow  * band(uv, t * 0.8, 5.1) * 0.30;
  gl_FragColor = vec4(c, 1.0);
}`,
  },

  waves: {
    label: "Soft waves",
    params: [
      { key: "colorA", label: "Color A", type: "color", default: "#f7f5f0" },
      { key: "colorB", label: "Color B", type: "color", default: "#ead9c5" },
      { key: "scale", label: "Scale", type: "number", default: 1, min: 0.3, max: 3, step: 0.1 },
      { key: "speed", label: "Speed", type: "number", default: 1, min: 0, max: 3, step: 0.1 },
    ],
    frag: `
uniform vec3 u_colorA; uniform vec3 u_colorB;
uniform float u_scale; uniform float u_speed;
void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  uv.x *= u_resolution.x / u_resolution.y;
  float t = u_time * u_speed * 0.4;
  float d = (uv.x + uv.y) * 2.2 * u_scale;
  float m = 0.5 + 0.5 * sin(d + t + 0.8 * sin(d * 0.5 - t * 0.6));
  m = smoothstep(0.15, 0.85, m);
  gl_FragColor = vec4(mix(u_colorA, u_colorB, m), 1.0);
}`,
  },

  grain: {
    label: "Grain gradient",
    params: [
      { key: "top", label: "Top", type: "color", default: "#2a2a28" },
      { key: "bottom", label: "Bottom", type: "color", default: "#6e6154" },
      { key: "grain", label: "Grain", type: "number", default: 0.08, min: 0, max: 0.3, step: 0.01 },
    ],
    frag: `
uniform vec3 u_top; uniform vec3 u_bottom; uniform float u_grain;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  vec3 c = mix(u_bottom, u_top, uv.y);
  float g = hash(gl_FragCoord.xy + fract(u_time) * 100.0) - 0.5;
  gl_FragColor = vec4(c + g * u_grain, 1.0);
}`,
  },
};

export function shaderDefaults(id) {
  const def = SHADERS[id];
  const out = {};
  if (def) for (const p of def.params) out[p.key] = p.default;
  return out;
}

function hexToRgb(hex) {
  const h = String(hex || "#000").replace("#", "");
  const v =
    h.length === 3
      ? h.split("").map((c) => parseInt(c + c, 16))
      : [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return v.map((n) => (isNaN(n) ? 0 : n / 255));
}

// A WebGL renderer bound to one canvas (pass an on-screen canvas for the
// preview, or none for an offscreen export canvas). Programs are compiled
// once per shader id and cached.
export function createShaderRenderer(canvas = document.createElement("canvas")) {
  const gl = canvas.getContext("webgl", { antialias: false, preserveDrawingBuffer: true });
  if (!gl) return null;

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

  const progs = new Map(); // id -> { prog, uniforms: Map }

  function compile(id) {
    const def = SHADERS[id];
    if (!def) return null;
    const mk = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.error(`shader "${id}":`, gl.getShaderInfoLog(sh));
        return null;
      }
      return sh;
    };
    const vs = mk(gl.VERTEX_SHADER, VERT);
    const fs = mk(gl.FRAGMENT_SHADER, PREAMBLE + def.frag);
    if (!vs || !fs) return null;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error(`shader "${id}":`, gl.getProgramInfoLog(prog));
      return null;
    }
    const entry = { prog, aPos: gl.getAttribLocation(prog, "a_pos"), uniforms: new Map() };
    progs.set(id, entry);
    return entry;
  }

  // Render shader `id` at time `t` (seconds) into the canvas at w×h.
  // Returns the canvas (or null if the shader is unknown/broken).
  function render(id, params, t, w, h) {
    const entry = progs.get(id) || compile(id);
    if (!entry) return null;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    gl.viewport(0, 0, w, h);
    gl.useProgram(entry.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(entry.aPos);
    gl.vertexAttribPointer(entry.aPos, 2, gl.FLOAT, false, 0, 0);

    const loc = (name) => {
      if (!entry.uniforms.has(name)) entry.uniforms.set(name, gl.getUniformLocation(entry.prog, name));
      return entry.uniforms.get(name);
    };
    gl.uniform2f(loc("u_resolution"), w, h);
    gl.uniform1f(loc("u_time"), t);
    const def = SHADERS[id];
    for (const p of def.params) {
      const v = params?.[p.key] ?? p.default;
      if (p.type === "color") gl.uniform3fv(loc(`u_${p.key}`), hexToRgb(v));
      else gl.uniform1f(loc(`u_${p.key}`), Number(v) || 0);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return canvas;
  }

  return { canvas, render };
}
