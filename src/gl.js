// WebGL tonal-adjustment pipeline (single shared program per canvas).

export const TONAL_FRAG = `
  precision mediump float;
  varying vec2 v_uv;
  uniform sampler2D u_tex;
  uniform float u_exposure, u_contrast, u_saturation, u_temp, u_tint,
                u_highlights, u_shadows;
  const vec3 LUMA = vec3(0.299, 0.587, 0.114);
  void main() {
    vec4 t = texture2D(u_tex, v_uv);
    vec3 c = t.rgb;
    c *= u_exposure;                       // exposure (factor)
    c.r += u_temp * 0.1; c.b -= u_temp * 0.1; // temperature
    c.g += u_tint * 0.1;                   // tint
    c = (c - 0.5) * u_contrast + 0.5;      // contrast
    float l1 = dot(clamp(c, 0.0, 1.0), LUMA);
    c += u_shadows * (1.0 - smoothstep(0.0, 0.5, l1));    // lift/lower shadows
    c += u_highlights * smoothstep(0.5, 1.0, l1);         // recover/boost highlights
    float l2 = dot(clamp(c, 0.0, 1.0), LUMA);
    c = mix(vec3(l2), c, u_saturation);    // saturation
    gl_FragColor = vec4(clamp(c, 0.0, 1.0), t.a);
  }`;

export const TONAL_VERT = `
  attribute vec2 a_pos;
  varying vec2 v_uv;
  void main() {
    v_uv = (a_pos + 1.0) * 0.5;
    gl_Position = vec4(a_pos, 0.0, 1.0);
  }`;

export function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(sh));
  }
  return sh;
}

export function getGL(canvas) {
  if (canvas._glctx) return canvas._glctx;
  const gl = canvas.getContext("webgl", {
    preserveDrawingBuffer: true,
    premultipliedAlpha: false,
  });
  const prog = gl.createProgram();
  gl.attachShader(prog, compileShader(gl, gl.VERTEX_SHADER, TONAL_VERT));
  gl.attachShader(prog, compileShader(gl, gl.FRAGMENT_SHADER, TONAL_FRAG));
  gl.linkProgram(prog);
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  );
  const aPos = gl.getAttribLocation(prog, "a_pos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

  const u = (n) => gl.getUniformLocation(prog, n);
  canvas._glctx = {
    gl,
    tex,
    lastSource: null,
    u: {
      exposure: u("u_exposure"),
      contrast: u("u_contrast"),
      saturation: u("u_saturation"),
      temp: u("u_temp"),
      tint: u("u_tint"),
      highlights: u("u_highlights"),
      shadows: u("u_shadows"),
    },
  };
  return canvas._glctx;
}

// Draw `source` (a canvas) into `canvas` with the tonal adjustments applied.
export function glAdjust(canvas, source, ed) {
  const ctx = getGL(canvas);
  const { gl, u, tex } = ctx;
  gl.viewport(0, 0, canvas.width, canvas.height);
  if (ctx.lastSource !== source) {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    ctx.lastSource = source;
  }
  gl.uniform1f(u.exposure, Math.pow(2, (ed.exposure || 0) / 100));
  gl.uniform1f(u.contrast, 1 + (ed.contrast || 0) / 100);
  gl.uniform1f(u.saturation, 1 + (ed.saturation || 0) / 100);
  gl.uniform1f(u.temp, (ed.temperature || 0) / 100);
  gl.uniform1f(u.tint, (ed.tint || 0) / 100);
  gl.uniform1f(u.highlights, ((ed.highlights || 0) / 100) * 0.5);
  gl.uniform1f(u.shadows, ((ed.shadows || 0) / 100) * 0.5);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}
