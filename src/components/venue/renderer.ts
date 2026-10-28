/**
 * The venue map's WebGL renderer: one static mesh (the venue, from
 * src/lib/venue/scene.ts), the route as a glowing animated ribbon, and flat
 * translucent overlays (the accuracy circle, the heading cone, highlights).
 * Plain WebGL 1 with three tiny shaders: no library, a few kilobytes, smooth on
 * mid-range phones. Browser-only.
 */
import { viewProjection, type Camera } from "@/lib/venue/camera";
import { rgb, type Theme } from "@/lib/venue/scene";

const SOLID_VS = `
attribute vec3 p; attribute vec3 n; attribute vec3 c;
uniform mat4 vp; uniform vec3 light; uniform vec3 eye;
varying vec3 vc; varying float fog;
void main() {
  float l = abs(dot(normalize(n), light));
  vc = c * (0.66 + 0.34 * l) + 0.04 * n.y;
  fog = clamp((distance(eye, p) - 900.0) / 1400.0, 0.0, 1.0);
  gl_Position = vp * vec4(p, 1.0);
}`;
const SOLID_FS = `
precision mediump float;
varying vec3 vc; varying float fog; uniform vec3 sky;
void main() { gl_FragColor = vec4(mix(vc, sky, fog), 1.0); }`;

const ROUTE_VS = `
attribute vec3 p; attribute float along; attribute float side;
uniform mat4 vp; varying float va; varying float vs;
void main() { va = along; vs = side; gl_Position = vp * vec4(p, 1.0); }`;
const ROUTE_FS = `
precision mediump float;
varying float va; varying float vs; uniform float time; uniform vec3 core; uniform vec3 glow; uniform vec3 alt;
void main() {
  float s = abs(vs);
  // A dark rim so the ribbon reads on pale walkways, a soft halo outside it.
  float halo = pow(1.0 - s, 1.4);
  float inner = smoothstep(0.62, 0.5, s);
  float rim = smoothstep(0.78, 0.62, s) - inner;
  // The colour slides between the two route colours along the way.
  float wave = 0.5 + 0.5 * sin(va * 0.09 - time * 1.6);
  vec3 body = mix(core, alt, wave);
  // Chevrons marching toward the destination: a V whose tip leads (side 0 ahead of the edges).
  float u = va - time * 6.0 + s * 2.2;
  float chev = smoothstep(0.35, 0.0, abs(mod(u, 5.0) - 2.5) - 0.7) * inner;
  vec3 col = mix(mix(glow, body, inner), vec3(1.0), chev * 0.95);
  col = mix(col, vec3(0.06, 0.08, 0.14), rim * 0.85);
  float a = max(max(halo * 0.45, inner * 0.96), rim * 0.9);
  gl_FragColor = vec4(col, a);
}`;

const FLAT_VS = `attribute vec3 p; uniform mat4 vp; void main() { gl_Position = vp * vec4(p, 1.0); }`;
const FLAT_FS = `precision mediump float; uniform vec4 color; void main() { gl_FragColor = color; }`;

type GL = WebGLRenderingContext;

function compile(gl: GL, vs: string, fs: string): WebGLProgram {
  const prog = gl.createProgram()!;
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? "shader");
    gl.attachShader(prog, sh);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link");
  return prog;
}

export interface Overlay {
  tris: Float32Array;
  color: [number, number, number, number];
}

export class VenueRenderer {
  private gl: GL;
  private solid: WebGLProgram;
  private route: WebGLProgram;
  private flat: WebGLProgram;
  private sceneBufs: { p: WebGLBuffer; n: WebGLBuffer; c: WebGLBuffer; count: number } | null = null;
  private routeBufs: { p: WebGLBuffer; a: WebGLBuffer; s: WebGLBuffer; count: number } | null = null;
  private overlayBuf: WebGLBuffer;
  private overlays: Overlay[] = [];
  private theme: Theme;
  readonly ok: boolean;

  constructor(private canvas: HTMLCanvasElement, theme: Theme) {
    const gl = (canvas.getContext("webgl", { antialias: true, alpha: false, preserveDrawingBuffer: true }) ??
      canvas.getContext("experimental-webgl")) as GL | null;
    if (!gl) throw new Error("WebGL is not available on this device.");
    this.gl = gl;
    this.solid = compile(gl, SOLID_VS, SOLID_FS);
    this.route = compile(gl, ROUTE_VS, ROUTE_FS);
    this.flat = compile(gl, FLAT_VS, FLAT_FS);
    this.overlayBuf = gl.createBuffer()!;
    this.theme = theme;
    this.ok = true;
  }

  setTheme(theme: Theme) {
    this.theme = theme;
  }

  private buffer(data: Float32Array): WebGLBuffer {
    const gl = this.gl;
    const b = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return b;
  }

  setScene(s: { position: Float32Array; normal: Float32Array; color: Float32Array; count: number }) {
    const gl = this.gl;
    if (this.sceneBufs) for (const b of [this.sceneBufs.p, this.sceneBufs.n, this.sceneBufs.c]) gl.deleteBuffer(b);
    this.sceneBufs = { p: this.buffer(s.position), n: this.buffer(s.normal), c: this.buffer(s.color), count: s.count };
  }

  setRoute(r: { position: Float32Array; along: Float32Array; side: Float32Array; count: number } | null) {
    const gl = this.gl;
    if (this.routeBufs) for (const b of [this.routeBufs.p, this.routeBufs.a, this.routeBufs.s]) gl.deleteBuffer(b);
    this.routeBufs = r && r.count ? { p: this.buffer(r.position), a: this.buffer(r.along), s: this.buffer(r.side), count: r.count } : null;
  }

  setOverlays(o: Overlay[]) {
    this.overlays = o;
  }

  /** Canvas pixels for its CSS size (device pixel ratio capped at 2). */
  resize(): { width: number; height: number } {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    return { width: w, height: h };
  }

  private attrib(prog: WebGLProgram, name: string, buf: WebGLBuffer, size: number) {
    const gl = this.gl;
    const loc = gl.getAttribLocation(prog, name);
    if (loc < 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  }

  private disableAttribs() {
    const gl = this.gl;
    for (let i = 0; i < 4; i++) gl.disableVertexAttribArray(i);
  }

  render(cam: Camera, timeSec: number) {
    const gl = this.gl;
    const { width, height } = this.resize();
    if (!width || !height) return;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const sky = rgb(this.theme.sky);
    gl.clearColor(sky[0], sky[1], sky[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    const { viewProj, eye } = viewProjection(cam, width / height);

    if (this.sceneBufs) {
      gl.useProgram(this.solid);
      gl.disable(gl.BLEND);
      gl.depthMask(true);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.solid, "vp"), false, viewProj);
      const l = [0.45, 0.8, 0.35];
      const len = Math.hypot(l[0], l[1], l[2]);
      gl.uniform3f(gl.getUniformLocation(this.solid, "light"), l[0] / len, l[1] / len, l[2] / len);
      gl.uniform3f(gl.getUniformLocation(this.solid, "eye"), eye[0], eye[1], eye[2]);
      gl.uniform3f(gl.getUniformLocation(this.solid, "sky"), sky[0], sky[1], sky[2]);
      this.attrib(this.solid, "p", this.sceneBufs.p, 3);
      this.attrib(this.solid, "n", this.sceneBufs.n, 3);
      this.attrib(this.solid, "c", this.sceneBufs.c, 3);
      gl.drawArrays(gl.TRIANGLES, 0, this.sceneBufs.count);
      this.disableAttribs();
    }

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);

    if (this.overlays.length) {
      gl.useProgram(this.flat);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.flat, "vp"), false, viewProj);
      const loc = gl.getAttribLocation(this.flat, "p");
      gl.bindBuffer(gl.ARRAY_BUFFER, this.overlayBuf);
      for (const o of this.overlays) {
        if (!o.tris.length) continue;
        gl.bufferData(gl.ARRAY_BUFFER, o.tris, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
        gl.uniform4f(gl.getUniformLocation(this.flat, "color"), ...o.color);
        gl.drawArrays(gl.TRIANGLES, 0, o.tris.length / 3);
      }
      this.disableAttribs();
    }

    if (this.routeBufs) {
      gl.useProgram(this.route);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.route, "vp"), false, viewProj);
      gl.uniform1f(gl.getUniformLocation(this.route, "time"), timeSec);
      const core = rgb(this.theme.route);
      const glow = rgb(this.theme.routeGlow);
      gl.uniform3f(gl.getUniformLocation(this.route, "core"), core[0], core[1], core[2]);
      gl.uniform3f(gl.getUniformLocation(this.route, "glow"), glow[0], glow[1], glow[2]);
      const alt = rgb(this.theme.routeAlt);
      gl.uniform3f(gl.getUniformLocation(this.route, "alt"), alt[0], alt[1], alt[2]);
      this.attrib(this.route, "p", this.routeBufs.p, 3);
      this.attrib(this.route, "along", this.routeBufs.a, 1);
      this.attrib(this.route, "side", this.routeBufs.s, 1);
      gl.drawArrays(gl.TRIANGLES, 0, this.routeBufs.count);
      this.disableAttribs();
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    return viewProj;
  }

  dispose() {
    const ext = this.gl.getExtension("WEBGL_lose_context");
    ext?.loseContext();
  }
}
