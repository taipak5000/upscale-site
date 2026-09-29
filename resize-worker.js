'use strict';
// 画像のリサンプリングを行う Web Worker。
// メインスレッドから RGBA のバッファを受け取り、指定サイズに拡大(縮小)して返す。

const FILTERS = {
  // Lanczos3: 輪郭がくっきり残る高画質フィルター
  lanczos3: {
    support: 3,
    fn(x) {
      if (x === 0) return 1;
      if (x <= -3 || x >= 3) return 0;
      const p = Math.PI * x;
      return (3 * Math.sin(p) * Math.sin(p / 3)) / (p * p);
    },
  },
  // Catmull-Rom 系バイキュービック: なめらかでリンギングが少ない
  bicubic: {
    support: 2,
    fn(x) {
      const a = -0.5;
      x = Math.abs(x);
      if (x < 1) return ((a + 2) * x - (a + 3)) * x * x + 1;
      if (x < 2) return ((a * x - 5 * a) * x + 8 * a) * x - 4 * a;
      return 0;
    },
  },
};

// 1 次元方向の重みテーブルを作る
function buildWeights(srcSize, dstSize, filter) {
  const scale = dstSize / srcSize;
  const fs = Math.min(1, scale); // 縮小時はフィルターを広げてエイリアスを防ぐ
  const support = filter.support / fs;
  const maxTaps = Math.ceil(support * 2) + 1;
  const starts = new Int32Array(dstSize);
  const counts = new Int32Array(dstSize);
  const weights = new Float32Array(dstSize * maxTaps);

  for (let i = 0; i < dstSize; i++) {
    const center = (i + 0.5) / scale - 0.5;
    let lo = Math.max(0, Math.ceil(center - support));
    let hi = Math.min(srcSize - 1, Math.floor(center + support));
    if (hi < lo) lo = hi = Math.min(srcSize - 1, Math.max(0, Math.round(center)));
    const n = hi - lo + 1;
    const o = i * maxTaps;
    let sum = 0;
    for (let k = 0; k < n; k++) {
      const w = filter.fn((lo + k - center) * fs);
      weights[o + k] = w;
      sum += w;
    }
    if (Math.abs(sum) < 1e-8) {
      weights.fill(0, o, o + n);
      weights[o + Math.min(n - 1, Math.max(0, Math.round(center) - lo))] = 1;
    } else {
      for (let k = 0; k < n; k++) weights[o + k] /= sum;
    }
    starts[i] = lo;
    counts[i] = n;
  }
  return { starts, counts, weights, maxTaps };
}

// 分離型フィルターでリサンプリングする。
// 横方向に処理した行をキャッシュしつつ縦方向を処理するので、巨大な中間バッファを持たない。
// 半透明部分のにじみを防ぐため、乗算済みアルファで計算する。
function resample(src, sw, sh, dw, dh, filter, onProgress) {
  const wx = buildWeights(sw, dw, filter);
  const wy = buildWeights(sh, dh, filter);
  const out = new Uint8ClampedArray(dw * dh * 4);
  const cache = new Map();
  const tmp = new Float32Array(sw * 4);
  const xStarts = wx.starts, xCounts = wx.counts, xW = wx.weights, xTaps = wx.maxTaps;

  function hrow(y) {
    let r = cache.get(y);
    if (r) return r;
    const base = y * sw * 4;
    for (let x = 0, i = base, o = 0; x < sw; x++, i += 4, o += 4) {
      const a = src[i + 3] / 255;
      tmp[o] = src[i] * a;
      tmp[o + 1] = src[i + 1] * a;
      tmp[o + 2] = src[i + 2] * a;
      tmp[o + 3] = src[i + 3];
    }
    r = new Float32Array(dw * 4);
    for (let x = 0; x < dw; x++) {
      const s = xStarts[x], c = xCounts[x], wo = x * xTaps;
      let R = 0, G = 0, B = 0, A = 0;
      for (let k = 0; k < c; k++) {
        const w = xW[wo + k];
        const p = (s + k) * 4;
        R += tmp[p] * w;
        G += tmp[p + 1] * w;
        B += tmp[p + 2] * w;
        A += tmp[p + 3] * w;
      }
      const q = x * 4;
      r[q] = R; r[q + 1] = G; r[q + 2] = B; r[q + 3] = A;
    }
    cache.set(y, r);
    return r;
  }

  const rows = [];
  const step = Math.max(1, Math.floor(dh / 40));
  for (let y = 0; y < dh; y++) {
    const s = wy.starts[y], c = wy.counts[y], wo = y * wy.maxTaps;
    for (const key of cache.keys()) if (key < s) cache.delete(key);
    rows.length = c;
    for (let k = 0; k < c; k++) rows[k] = hrow(s + k);

    const ob = y * dw * 4;
    for (let x = 0; x < dw; x++) {
      const q = x * 4;
      let R = 0, G = 0, B = 0, A = 0;
      for (let k = 0; k < c; k++) {
        const w = wy.weights[wo + k];
        const row = rows[k];
        R += row[q] * w;
        G += row[q + 1] * w;
        B += row[q + 2] * w;
        A += row[q + 3] * w;
      }
      const p = ob + q;
      if (A <= 0.5) {
        out[p] = out[p + 1] = out[p + 2] = out[p + 3] = 0;
      } else {
        if (A > 255) A = 255;
        const inv = 255 / A;
        out[p] = R * inv;
        out[p + 1] = G * inv;
        out[p + 2] = B * inv;
        out[p + 3] = A;
      }
    }
    if (y % step === 0) onProgress(y / dh);
  }
  return out;
}

// ニアレストネイバー: 画素をそのまま大きくする(ドット絵・アイコン向け)
function nearest(src, sw, sh, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh * 4);
  const s32 = new Uint32Array(src.buffer, src.byteOffset, sw * sh);
  const o32 = new Uint32Array(out.buffer);
  const xs = new Int32Array(dw);
  for (let x = 0; x < dw; x++) xs[x] = Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / dw));
  for (let y = 0; y < dh; y++) {
    const row = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / dh)) * sw;
    const ob = y * dw;
    for (let x = 0; x < dw; x++) o32[ob + x] = s32[row + xs[x]];
  }
  return out;
}

// アンシャープマスク(輝度のみ)。拡大で甘くなった輪郭を少し締める。
function sharpen(out, w, h, amount, sigma, onProgress) {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const g = new Float32Array(r * 2 + 1);
  let gs = 0;
  for (let i = 0; i < g.length; i++) {
    g[i] = Math.exp(-((i - r) ** 2) / (2 * sigma * sigma));
    gs += g[i];
  }
  for (let i = 0; i < g.length; i++) g[i] /= gs;

  const n = w * h;
  // 輝度を 256 倍の固定小数で保持する(77+150+29=256)
  const L = new Uint16Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) L[i] = out[p] * 77 + out[p + 1] * 150 + out[p + 2] * 29;

  const T = new Uint16Array(n);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) {
        let xx = x + k;
        if (xx < 0) xx = 0; else if (xx >= w) xx = w - 1;
        acc += L[row + xx] * g[k + r];
      }
      T[row + x] = acc + 0.5;
    }
  }

  const col = new Float32Array(w);
  const step = Math.max(1, Math.floor(h / 20));
  for (let y = 0; y < h; y++) {
    col.fill(0);
    for (let k = -r; k <= r; k++) {
      let yy = y + k;
      if (yy < 0) yy = 0; else if (yy >= h) yy = h - 1;
      const base = yy * w, gk = g[k + r];
      for (let x = 0; x < w; x++) col[x] += T[base + x] * gk;
    }
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const p = (row + x) * 4;
      if (out[p + 3] === 0) continue;
      const d = (L[row + x] - col[x]) / 256;
      if (d > -1 && d < 1) continue; // 平坦部のノイズは強調しない
      const delta = amount * d;
      out[p] += delta;
      out[p + 1] += delta;
      out[p + 2] += delta;
    }
    if (y % step === 0) onProgress(y / h);
  }
}

self.onmessage = (e) => {
  const { buffer, sw, sh, dw, dh, method, sharpen: sharp } = e.data;
  const report = (v) => self.postMessage({ type: 'progress', value: v });
  try {
    const src = new Uint8ClampedArray(buffer);
    let out;
    if (method === 'nearest') {
      out = nearest(src, sw, sh, dw, dh);
    } else {
      const filter = FILTERS[method] || FILTERS.lanczos3;
      const useSharpen = sharp > 0;
      out = resample(src, sw, sh, dw, dh, filter, (p) => report(p * (useSharpen ? 0.8 : 1)));
      if (useSharpen) {
        const scale = Math.max(dw / sw, dh / sh);
        const sigma = Math.min(2.5, Math.max(0.7, Math.sqrt(scale) * 0.6));
        sharpen(out, dw, dh, (sharp / 100) * 1.5, sigma, (p) => report(0.8 + p * 0.2));
      }
    }
    self.postMessage({ type: 'done', buffer: out.buffer }, [out.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};
