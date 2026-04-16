import sharp from 'sharp';

const RGB_TOL = 30;

/**
 * Make pixels connected to the image border transparent when they match the
 * average border color (typical matte fill from segmentation APIs).
 */
export async function floodTransparentBorderMatte(pngBuffer: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(pngBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const stride = 4;
  const ix = (x: number, y: number) => (y * w + x) * stride;

  let br = 0;
  let bg = 0;
  let bb = 0;
  let bn = 0;
  const sampleBorder = (x: number, y: number) => {
    const i = ix(x, y);
    br += data[i];
    bg += data[i + 1];
    bb += data[i + 2];
    bn += 1;
  };
  for (let x = 0; x < w; x++) {
    sampleBorder(x, 0);
    if (h > 1) sampleBorder(x, h - 1);
  }
  for (let y = 1; y < h - 1; y++) {
    sampleBorder(0, y);
    sampleBorder(w - 1, y);
  }
  br /= bn;
  bg /= bn;
  bb /= bn;

  const nearBg = (i: number) =>
    Math.abs(data[i] - br) < RGB_TOL &&
    Math.abs(data[i + 1] - bg) < RGB_TOL &&
    Math.abs(data[i + 2] - bb) < RGB_TOL;

  const vis = new Uint8Array(w * h);
  const qx: number[] = [];
  const qy: number[] = [];

  const push = (x: number, y: number) => {
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const k = y * w + x;
    if (vis[k]) return;
    const i = ix(x, y);
    if (data[i + 3] < 8) {
      vis[k] = 1;
      qx.push(x);
      qy.push(y);
      return;
    }
    if (!nearBg(i)) return;
    vis[k] = 1;
    qx.push(x);
    qy.push(y);
  };

  for (let x = 0; x < w; x++) {
    push(x, 0);
    if (h > 1) push(x, h - 1);
  }
  for (let y = 1; y < h - 1; y++) {
    push(0, y);
    push(w - 1, y);
  }

  let head = 0;
  while (head < qx.length) {
    const x = qx[head];
    const y = qy[head++];
    const i = ix(x, y);
    data[i + 3] = 0;
    const neighbors = [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ] as const;
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const k = ny * w + nx;
      if (vis[k]) continue;
      const ni = ix(nx, ny);
      if (data[ni + 3] < 8) {
        vis[k] = 1;
        qx.push(nx);
        qy.push(ny);
        continue;
      }
      if (!nearBg(ni)) continue;
      vis[k] = 1;
      qx.push(nx);
      qy.push(ny);
    }
  }

  return sharp(data, { raw: { width: w, height: h, channels: 4 } })
    .png()
    .toBuffer();
}
