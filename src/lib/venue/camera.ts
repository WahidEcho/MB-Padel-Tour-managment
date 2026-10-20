/**
 * The map's orbit camera: a point on the ground it looks at, a distance, a
 * heading (yaw) and a tilt, turned into the matrices the renderer draws with,
 * and back (a screen point to the ground, for taps and drags). Pure.
 *
 * World axes: X = plan x, Y = up, Z = −plan y (so plan north is away from a
 * camera looking from the south with yaw 0).
 */

export type Mat4 = Float32Array;

export interface Camera {
  /** Ground point looked at, plan metres. */
  tx: number;
  ty: number;
  distance: number;
  /** Radians; 0 looks plan-north. */
  yaw: number;
  /** Radians above the ground: π/2 is straight down. */
  pitch: number;
  fovY: number;
}

export const MIN_PITCH = (22 * Math.PI) / 180;
export const MAX_PITCH = (89 * Math.PI) / 180;
export const MIN_DISTANCE = 25;
export const MAX_DISTANCE = 1400;

export function clampCamera(c: Camera): Camera {
  return {
    ...c,
    distance: Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, c.distance)),
    pitch: Math.min(MAX_PITCH, Math.max(MIN_PITCH, c.pitch)),
  };
}

export function perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  const nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) * nf;
  m[11] = -1;
  m[14] = 2 * far * near * nf;
  return m;
}

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const crossV = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function lookAt(eye: V3, center: V3, up: V3): Mat4 {
  const z = norm(sub(eye, center));
  const x = norm(crossV(up, z));
  const y = crossV(z, x);
  const m = new Float32Array(16);
  m[0] = x[0];
  m[1] = y[0];
  m[2] = z[0];
  m[4] = x[1];
  m[5] = y[1];
  m[6] = z[1];
  m[8] = x[2];
  m[9] = y[2];
  m[10] = z[2];
  m[12] = -dot(x, eye);
  m[13] = -dot(y, eye);
  m[14] = -dot(z, eye);
  m[15] = 1;
  return m;
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k];
      out[i * 4 + j] = s;
    }
  }
  return out;
}

export function invert(m: Mat4): Mat4 | null {
  const inv = new Float32Array(16);
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  const d = 1 / det;
  inv[0] = (a11 * b11 - a12 * b10 + a13 * b09) * d;
  inv[1] = (a02 * b10 - a01 * b11 - a03 * b09) * d;
  inv[2] = (a31 * b05 - a32 * b04 + a33 * b03) * d;
  inv[3] = (a22 * b04 - a21 * b05 - a23 * b03) * d;
  inv[4] = (a12 * b08 - a10 * b11 - a13 * b07) * d;
  inv[5] = (a00 * b11 - a02 * b08 + a03 * b07) * d;
  inv[6] = (a32 * b02 - a30 * b05 - a33 * b01) * d;
  inv[7] = (a20 * b05 - a22 * b02 + a23 * b01) * d;
  inv[8] = (a10 * b10 - a11 * b08 + a13 * b06) * d;
  inv[9] = (a01 * b08 - a00 * b10 - a03 * b06) * d;
  inv[10] = (a30 * b04 - a31 * b02 + a33 * b00) * d;
  inv[11] = (a21 * b02 - a20 * b04 - a23 * b00) * d;
  inv[12] = (a11 * b07 - a10 * b09 - a12 * b06) * d;
  inv[13] = (a00 * b09 - a01 * b07 + a02 * b06) * d;
  inv[14] = (a31 * b01 - a30 * b03 - a32 * b00) * d;
  inv[15] = (a20 * b03 - a21 * b01 + a22 * b00) * d;
  return inv;
}

/** The camera's eye in world coordinates. */
export function eyeOf(c: Camera): V3 {
  const h = c.distance * Math.cos(c.pitch);
  // Yaw 0: the eye is south of the target (plan −y = world +Z), looking north.
  return [c.tx - h * Math.sin(c.yaw), c.distance * Math.sin(c.pitch), -c.ty + h * Math.cos(c.yaw)];
}

export function viewProjection(c: Camera, aspect: number): { viewProj: Mat4; inv: Mat4 | null; eye: V3 } {
  const eye = eyeOf(c);
  const view = lookAt(eye, [c.tx, 0, -c.ty], [0, 1, 0]);
  const proj = perspective(c.fovY, aspect, Math.max(1, c.distance * 0.02), c.distance * 6 + 2000);
  const viewProj = multiply(proj, view);
  return { viewProj, inv: invert(viewProj), eye };
}

/** A plan point (with height) to CSS pixels; null when behind the camera. */
export function project(viewProj: Mat4, x: number, y: number, h: number, width: number, height: number): { sx: number; sy: number; depth: number } | null {
  const wx = x;
  const wy = h;
  const wz = -y;
  const cx = viewProj[0] * wx + viewProj[4] * wy + viewProj[8] * wz + viewProj[12];
  const cy = viewProj[1] * wx + viewProj[5] * wy + viewProj[9] * wz + viewProj[13];
  const cw = viewProj[3] * wx + viewProj[7] * wy + viewProj[11] * wz + viewProj[15];
  if (cw <= 0.0001) return null;
  return { sx: ((cx / cw) * 0.5 + 0.5) * width, sy: (1 - ((cy / cw) * 0.5 + 0.5)) * height, depth: cw };
}

/** Where a screen point's ray meets the ground (plan metres); null when it points at the sky. */
export function screenToGround(inv: Mat4, sx: number, sy: number, width: number, height: number): { x: number; y: number } | null {
  const nx = (sx / width) * 2 - 1;
  const ny = 1 - (sy / height) * 2;
  const unproj = (z: number): V3 => {
    const x = inv[0] * nx + inv[4] * ny + inv[8] * z + inv[12];
    const y = inv[1] * nx + inv[5] * ny + inv[9] * z + inv[13];
    const zz = inv[2] * nx + inv[6] * ny + inv[10] * z + inv[14];
    const w = inv[3] * nx + inv[7] * ny + inv[11] * z + inv[15];
    return [x / w, y / w, zz / w];
  };
  const a = unproj(-1);
  const b = unproj(1);
  const dy = b[1] - a[1];
  if (Math.abs(dy) < 1e-9) return null;
  const t = -a[1] / dy;
  if (t < 0) return null;
  return { x: a[0] + (b[0] - a[0]) * t, y: -(a[2] + (b[2] - a[2]) * t) };
}

/** A camera that shows the box at a pleasant tilt, its extent measured along the view's own axes (any yaw). */
export function fitCamera(b: { minX: number; minY: number; maxX: number; maxY: number }, aspect: number, base: Pick<Camera, "yaw" | "pitch" | "fovY">): Camera {
  const right = { x: Math.cos(base.yaw), y: -Math.sin(base.yaw) };
  const fwd = { x: Math.sin(base.yaw), y: Math.cos(base.yaw) };
  const corners = [
    { x: b.minX, y: b.minY },
    { x: b.maxX, y: b.minY },
    { x: b.maxX, y: b.maxY },
    { x: b.minX, y: b.maxY },
  ];
  const along = (d: { x: number; y: number }) => {
    const v = corners.map((c) => c.x * d.x + c.y * d.y);
    return Math.max(...v) - Math.min(...v);
  };
  const w = Math.max(10, along(right));
  // Depth is foreshortened by the tilt.
  const h = Math.max(10, along(fwd)) * (0.6 + 0.4 * Math.sin(base.pitch));
  const span = Math.max(h, w / Math.max(0.3, aspect));
  const distance = (span / 2 / Math.tan(base.fovY / 2)) * 1.12;
  return clampCamera({ ...base, tx: (b.minX + b.maxX) / 2, ty: (b.minY + b.maxY) / 2, distance });
}

/** A portrait screen and a wide venue: look along the venue's long side (east), so it fills the phone. */
export function bestYaw(b: { minX: number; minY: number; maxX: number; maxY: number }, aspect: number): number {
  const wide = b.maxX - b.minX > (b.maxY - b.minY) * 1.15;
  const tall = b.maxY - b.minY > (b.maxX - b.minX) * 1.15;
  if (aspect < 0.9 && wide) return Math.PI / 2;
  if (aspect > 1.2 && tall) return Math.PI / 2;
  return 0;
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** The camera part-way through a fly-to (t from 0 to 1), the shorter way round. */
export function interpolate(a: Camera, b: Camera, t: number): Camera {
  const k = ease(Math.max(0, Math.min(1, t)));
  let dyaw = b.yaw - a.yaw;
  while (dyaw > Math.PI) dyaw -= 2 * Math.PI;
  while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
  // Zoom out a little mid-flight for long hops.
  const hop = Math.hypot(b.tx - a.tx, b.ty - a.ty);
  const lift = Math.sin(Math.PI * k) * Math.min(hop * 0.4, 200);
  return {
    tx: a.tx + (b.tx - a.tx) * k,
    ty: a.ty + (b.ty - a.ty) * k,
    distance: a.distance + (b.distance - a.distance) * k + lift,
    yaw: a.yaw + dyaw * k,
    pitch: a.pitch + (b.pitch - a.pitch) * k,
    fovY: b.fovY,
  };
}
