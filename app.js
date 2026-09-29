// 画像サイズ拡大ツール
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const MAX_SIDE = 16384;
// iOS Safari は canvas の総画素数が約1677万画素までに制限されている
const MAX_AREA = isIOS ? 16777216 : 64000000;

const PAPERS = {
  a3: [297, 420], a4: [210, 297], a5: [148, 210], b4: [257, 364], b5: [182, 257],
  hagaki: [100, 148], l: [89, 127], '2l': [127, 178],
};
const STORE_KEY = 'upsize-settings-v1';

const items = [];
let currentId = null;
let nextId = 1;

/* ---------- 設定の読み書き ---------- */

const radio = (name) => ($(`input[name="${name}"]:checked`) || {}).value;
function num(id, def) {
  const v = parseFloat($(id).value);
  return Number.isFinite(v) && v > 0 ? v : def;
}

function readSettings() {
  return {
    mode: radio('mode'),
    scale: num('#scale', 2),
    pxBase: $('#pxBase').value,
    pxValue: num('#pxValue', 1920),
    boxW: num('#boxW', 1920),
    boxH: num('#boxH', 1080),
    fit: radio('fit'),
    paper: $('#paper').value,
    mmW: num('#mmW', 210),
    mmH: num('#mmH', 297),
    dpi: num('#dpi', 350),
    autoRotate: $('#autoRotate').checked,
    method: radio('method'),
    sharpen: +$('#sharpen').value,
    format: $('#format').value,
    quality: +$('#quality').value,
    bg: $('#bg').value,
    transparent: $('#transparent').checked,
    dpiMeta: parseFloat($('#dpiMeta').value) || 0,
  };
}

const PERSIST = ['scale', 'pxBase', 'pxValue', 'boxW', 'boxH', 'paper', 'mmW', 'mmH', 'dpi',
  'autoRotate', 'sharpen', 'format', 'quality', 'bg', 'transparent', 'dpiMeta'];
const PERSIST_RADIO = ['mode', 'fit', 'method', 'zoom'];

function saveSettings() {
  try {
    const data = {};
    for (const id of PERSIST) {
      const el = document.getElementById(id);
      data[id] = el.type === 'checkbox' ? el.checked : el.value;
    }
    for (const name of PERSIST_RADIO) data['r:' + name] = radio(name);
    localStorage.setItem(STORE_KEY, JSON.stringify(data));
  } catch { /* 保存できない環境では何もしない */ }
}

function loadSettings() {
  let data = null;
  try { data = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { data = null; }
  if (!data) return;
  for (const id of PERSIST) {
    if (!(id in data)) continue;
    const el = document.getElementById(id);
    if (el.type === 'checkbox') el.checked = !!data[id];
    else el.value = data[id];
  }
  for (const name of PERSIST_RADIO) {
    const v = data['r:' + name];
    const el = v && $(`input[name="${name}"][value="${v}"]`);
    if (el) el.checked = true;
  }
}

/* ---------- 出力サイズの計算 ---------- */

function computePlan(sw, sh, s) {
  let W, H;
  let uniform = true;
  let fit = 'stretch';

  if (s.mode === 'scale') {
    W = sw * s.scale; H = sh * s.scale;
  } else if (s.mode === 'px') {
    const v = s.pxValue;
    let k;
    switch (s.pxBase) {
      case 'short': k = v / Math.min(sw, sh); W = sw * k; H = sh * k; break;
      case 'width': k = v / sw; W = v; H = sh * k; break;
      case 'height': k = v / sh; W = sw * k; H = v; break;
      case 'box': W = s.boxW; H = s.boxH; uniform = false; fit = s.fit; break;
      default: k = v / Math.max(sw, sh); W = sw * k; H = sh * k;
    }
  } else {
    W = (s.mmW / 25.4) * s.dpi;
    H = (s.mmH / 25.4) * s.dpi;
    if (s.autoRotate && sw !== sh && W !== H && (sw > sh) !== (W > H)) [W, H] = [H, W];
    uniform = false; fit = s.fit;
  }

  W = Math.max(1, Math.round(W));
  H = Math.max(1, Math.round(H));
  let limited = false;
  const k = Math.min(1, MAX_SIDE / W, MAX_SIDE / H, Math.sqrt(MAX_AREA / (W * H)));
  if (k < 1) {
    W = Math.max(1, Math.floor(W * k));
    H = Math.max(1, Math.floor(H * k));
    limited = true;
  }

  let crop = { x: 0, y: 0, w: sw, h: sh };
  let cw = W, ch = H, ox = 0, oy = 0;
  if (!uniform) {
    if (fit === 'contain') {
      const r = Math.min(W / sw, H / sh);
      cw = Math.min(W, Math.max(1, Math.round(sw * r)));
      ch = Math.min(H, Math.max(1, Math.round(sh * r)));
      ox = Math.floor((W - cw) / 2);
      oy = Math.floor((H - ch) / 2);
    } else if (fit === 'cover') {
      const r = Math.max(W / sw, H / sh);
      const w = Math.min(sw, Math.max(1, Math.round(W / r)));
      const h = Math.min(sh, Math.max(1, Math.round(H / r)));
      crop = { x: Math.floor((sw - w) / 2), y: Math.floor((sh - h) / 2), w, h };
    }
  }
  return { W, H, cw, ch, ox, oy, crop, limited, padded: cw !== W || ch !== H };
}

/* ---------- 画像の読み込み ---------- */

function looksLikeImage(f) {
  return (f.type && f.type.startsWith('image/')) ||
    /\.(png|jpe?g|webp|gif|bmp|avif|svg|ico|tiff?|heic|heif)$/i.test(f.name || '');
}

async function addFiles(fileList) {
  const files = [...fileList].filter(looksLikeImage);
  if (!files.length) {
    setStatus('画像ファイルが見つかりませんでした。', true);
    return;
  }
  let firstNew = null;
  const failed = [];
  for (const file of files) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    try {
      await img.decode();
    } catch {
      URL.revokeObjectURL(url);
      failed.push(file.name || '貼り付けた画像');
      continue;
    }
    let w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) { w = 300; h = 150; }
    const item = {
      id: nextId++,
      name: file.name || `image-${Date.now()}.png`,
      type: file.type || '',
      url, img, w, h,
      srcCanvas: null,
      cache: null,
    };
    items.push(item);
    if (!firstNew) firstNew = item;
  }
  if (failed.length) {
    setStatus(`読み込めなかった画像があります: ${failed.join('、')}（このブラウザが対応していない形式の可能性があります）`, true);
  } else {
    setStatus('');
  }
  if (firstNew) selectItem(firstNew.id);
  renderThumbs();
}

function removeItem(id) {
  const i = items.findIndex((it) => it.id === id);
  if (i < 0) return;
  const [it] = items.splice(i, 1);
  URL.revokeObjectURL(it.url);
  it.srcCanvas = null; it.cache = null;
  if (currentId === id) {
    const next = items[Math.min(i, items.length - 1)];
    currentId = null;
    if (next) selectItem(next.id);
    else showEmpty();
  }
  renderThumbs();
}

function clearAll() {
  for (const it of items) URL.revokeObjectURL(it.url);
  items.length = 0;
  currentId = null;
  showEmpty();
  renderThumbs();
}

function current() {
  return items.find((it) => it.id === currentId) || null;
}

function selectItem(id) {
  // 選択していない画像のキャッシュはメモリ節約のため捨てる
  for (const it of items) {
    if (it.id !== id) { it.srcCanvas = null; it.cache = null; }
  }
  currentId = id;
  document.body.classList.add('has-image');
  renderThumbs();
  scheduleRender(0);
}

function renderThumbs() {
  const wrap = $('#thumbsWrap');
  const box = $('#thumbs');
  wrap.hidden = items.length === 0;
  box.replaceChildren(...items.map((it) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'thumb';
    b.title = `${it.name}（${it.w}×${it.h}）`;
    b.setAttribute('aria-pressed', String(it.id === currentId));
    const im = document.createElement('img');
    im.src = it.url; im.alt = it.name;
    const x = document.createElement('span');
    x.className = 'x'; x.textContent = '×'; x.title = '外す';
    x.setAttribute('role', 'button');
    x.setAttribute('aria-label', `${it.name} を外す`);
    x.addEventListener('click', (e) => { e.stopPropagation(); removeItem(it.id); });
    b.append(im, x);
    b.addEventListener('click', () => selectItem(it.id));
    return b;
  }));
  $('#zipBtn').hidden = items.length < 2;
  $('#saveBtn').disabled = items.length === 0;
  if (!items.length) document.body.classList.remove('has-image');
  updateShareVisibility();
}

function getSourceCanvas(item) {
  if (item.srcCanvas) return item.srcCanvas;
  const c = document.createElement('canvas');
  c.width = item.w; c.height = item.h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(item.img, 0, 0, item.w, item.h);
  item.srcCanvas = c;
  return c;
}

/* ---------- Worker でのリサンプリング ---------- */

// プレビュー用と保存用で Worker を分け、プレビューの作り直しが保存を中断しないようにする
function makeChannel() { return { worker: null, reject: null }; }
const previewChannel = makeChannel();
const exportChannel = makeChannel();

function runResample(ch, imageData, sw, sh, dw, dh, method, sharpen, onProgress) {
  return new Promise((resolve, reject) => {
    if (ch.worker) ch.worker.terminate();
    if (ch.reject) ch.reject(new DOMException('中断しました', 'AbortError'));
    const w = new Worker('resize-worker.js');
    ch.worker = w;
    ch.reject = reject;
    const finish = () => { if (ch.worker === w) { w.terminate(); ch.worker = null; ch.reject = null; } };
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') { onProgress && onProgress(m.value); return; }
      finish();
      if (m.type === 'done') resolve(new ImageData(new Uint8ClampedArray(m.buffer), dw, dh));
      else reject(new Error(m.message));
    };
    w.onerror = (e) => { finish(); reject(new Error(e.message || '処理中にエラーが起きました')); };
    w.postMessage(
      { buffer: imageData.data.buffer, sw, sh, dw, dh, method, sharpen },
      [imageData.data.buffer],
    );
  });
}

function resolveFormat(item, s) {
  if (s.format === 'png') return 'image/png';
  if (s.format === 'jpeg') return 'image/jpeg';
  if (s.format === 'webp') return 'image/webp';
  if (item.type === 'image/jpeg') return 'image/jpeg';
  if (item.type === 'image/webp') return 'image/webp';
  return 'image/png';
}

async function renderItem(item, s, ch, onProgress) {
  const plan = computePlan(item.w, item.h, s);
  const rkey = JSON.stringify([plan.crop, plan.cw, plan.ch, s.method, s.method === 'nearest' ? 0 : s.sharpen]);
  let content;
  if (item.cache && item.cache.rkey === rkey) {
    content = item.cache.canvas;
  } else {
    const src = getSourceCanvas(item);
    const { x, y, w, h } = plan.crop;
    const data = src.getContext('2d', { willReadFrequently: true }).getImageData(x, y, w, h);
    const out = await runResample(ch, data, w, h, plan.cw, plan.ch, s.method, s.sharpen, onProgress);
    content = document.createElement('canvas');
    content.width = plan.cw; content.height = plan.ch;
    content.getContext('2d').putImageData(out, 0, 0);
    item.cache = { rkey, canvas: content };
  }

  const fmt = resolveFormat(item, s);
  let canvas = content;
  if (plan.padded || fmt === 'image/jpeg') {
    canvas = document.createElement('canvas');
    canvas.width = plan.W; canvas.height = plan.H;
    const ctx = canvas.getContext('2d');
    if (!(s.transparent && fmt !== 'image/jpeg')) {
      ctx.fillStyle = s.bg;
      ctx.fillRect(0, 0, plan.W, plan.H);
    }
    ctx.drawImage(content, plan.ox, plan.oy);
  }
  return { plan, canvas, fmt };
}

/* ---------- プレビュー ---------- */

let renderTimer = 0;
let renderSeq = 0;

function scheduleRender(delay = 250) {
  clearTimeout(renderTimer);
  updateVisibility();
  const item = current();
  if (item) updateInfo(item, readSettings());
  saveSettings();
  renderTimer = setTimeout(renderPreview, delay);
}

async function renderPreview() {
  const item = current();
  if (!item) { showEmpty(); return; }
  const s = readSettings();
  const seq = ++renderSeq;
  setBusy(true, 0);
  try {
    const r = await renderItem(item, s, previewChannel, (p) => { if (seq === renderSeq) setBusy(true, p); });
    if (seq !== renderSeq || item !== current()) return;
    showResult(item, r, s);
    setStatus('');
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    if (seq === renderSeq) setStatus(errorText(err), true);
  } finally {
    if (seq === renderSeq) setBusy(false);
  }
}

function errorText(err) {
  const msg = String((err && err.message) || err || '');
  if (/memory|allocation|Array buffer|RangeError|invalid array length/i.test(msg)) {
    return 'メモリが足りず処理できませんでした。出力サイズを小さくしてください。';
  }
  return `処理に失敗しました: ${msg}`;
}

function showEmpty() {
  $('#stage').hidden = true;
  $('#empty').hidden = false;
  $('#info').innerHTML = '<p class="info-main">画像を選ぶと、ここに拡大後のサイズとプレビューが出ます。</p>';
  $('#saveBtn').disabled = true;
  document.body.classList.remove('has-image');
}

function showResult(item, r, s) {
  const { plan, canvas } = r;
  const stage = $('#stage');
  stage.style.setProperty('--ar', String(plan.W / plan.H));
  stage.style.setProperty('--w', plan.W + 'px');
  stage.classList.toggle('pixel', s.method === 'nearest');
  $('#after').replaceChildren(canvas);

  const c = plan.crop;
  const box = $('#beforeBox');
  box.style.left = (plan.ox / plan.W) * 100 + '%';
  box.style.top = (plan.oy / plan.H) * 100 + '%';
  box.style.width = (plan.cw / plan.W) * 100 + '%';
  box.style.height = (plan.ch / plan.H) * 100 + '%';
  const img = $('#beforeImg');
  if (img.getAttribute('src') !== item.url) img.src = item.url;
  img.style.width = (item.w / c.w) * 100 + '%';
  img.style.height = (item.h / c.h) * 100 + '%';
  img.style.left = (-c.x / c.w) * 100 + '%';
  img.style.top = (-c.y / c.h) * 100 + '%';

  $('#empty').hidden = true;
  stage.hidden = false;
  $('#saveBtn').disabled = false;
}

function fmtNum(n) { return n.toLocaleString('ja-JP'); }

function updateInfo(item, s) {
  const plan = computePlan(item.w, item.h, s);
  const kx = plan.cw / plan.crop.w;
  const ky = plan.ch / plan.crop.h;
  const ratio = Math.abs(kx - ky) < 0.01
    ? `${trim(kx)}倍`
    : `横${trim(kx)}倍・縦${trim(ky)}倍`;

  const lines = [];
  lines.push(`<p class="info-main">${fmtNum(item.w)} × ${fmtNum(item.h)} px → <b>${fmtNum(plan.W)} × ${fmtNum(plan.H)} px</b>（${ratio}）</p>`);

  const subs = [];
  const man = (plan.W * plan.H) / 1e4;
  subs.push(`${man < 10 ? man.toFixed(1) : fmtNum(Math.round(man))}万画素`);
  if (s.mode === 'print') {
    subs.push(`${mm(plan.W, s.dpi)} × ${mm(plan.H, s.dpi)} mm を ${s.dpi}dpi で印刷できるサイズ`);
  } else if (s.dpiMeta) {
    subs.push(`${s.dpiMeta}dpiで印刷すると約 ${mm(plan.W, s.dpiMeta)} × ${mm(plan.H, s.dpiMeta)} mm`);
  }
  if (plan.padded) subs.push('縦横比の差は余白で埋めます');
  if (plan.crop.w !== item.w || plan.crop.h !== item.h) subs.push('はみ出た部分は切り取ります');
  lines.push(`<p class="info-sub">${escapeHtml(item.name)}・${subs.join('・')}</p>`);

  if (plan.limited) {
    lines.push(`<p class="note">この端末で扱える上限（${isIOS ? '約1,670万' : '6,400万'}画素・一辺${fmtNum(MAX_SIDE)}px）を超えるため、縦横比を保ったまま縮めています。</p>`);
  }
  if (Math.max(kx, ky) > 8 && s.method !== 'nearest') {
    lines.push('<p class="note">8倍を超えると輪郭がぼやけやすくなります。ドット絵やアイコンなら「ドット絵」を選ぶとくっきり仕上がります。</p>');
  }
  if (Math.max(kx, ky) < 1) {
    lines.push('<p class="note">この設定では元の画像より小さくなります。</p>');
  }
  $('#info').innerHTML = lines.join('');
}

function trim(n) {
  return (Math.round(n * 100) / 100).toLocaleString('ja-JP', { maximumFractionDigits: 2 });
}

function mm(px, dpi) {
  return ((px / dpi) * 25.4).toLocaleString('ja-JP', { maximumFractionDigits: 1 });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function setBusy(on, p = 0) {
  $('#busy').hidden = !on;
  $('#barFill').style.width = Math.round(p * 100) + '%';
}

function setStatus(text, isErr = false) {
  const el = $('#status');
  el.textContent = text;
  el.classList.toggle('err', isErr);
}

function updateVisibility() {
  const s = readSettings();
  for (const pane of $$('[data-pane]')) pane.hidden = pane.dataset.pane !== s.mode;
  const isBox = s.pxBase === 'box';
  $('[data-sub="single"]').hidden = isBox;
  $('[data-sub="box"]').hidden = !isBox;
  $('#fitRow').hidden = !(s.mode === 'print' || (s.mode === 'px' && isBox));
  $('#sharpenRow').hidden = s.method === 'nearest';
  $('#sharpenVal').textContent = s.sharpen;
  $('#qualityVal').textContent = s.quality;
  const item = current();
  const fmt = item ? resolveFormat(item, s) : (s.format === 'jpeg' ? 'image/jpeg' : s.format === 'webp' ? 'image/webp' : 'image/png');
  $('#qualityRow').hidden = fmt === 'image/png';
  $('#transparentRow').hidden = fmt === 'image/jpeg';
  $('#dpiMetaRow').hidden = s.mode === 'print' || fmt === 'image/webp';

  // プリセットの選択状態
  for (const b of $$('#scaleChips button')) b.classList.toggle('on', +b.dataset.scale === s.scale);
  for (const b of $$('#pxChips button')) b.classList.toggle('on', +b.dataset.px === s.pxValue);
  for (const b of $$('#boxChips button')) b.classList.toggle('on', b.dataset.box === `${s.boxW}x${s.boxH}`);
  for (const b of $$('#dpiChips button')) b.classList.toggle('on', +b.dataset.dpi === s.dpi);

  $('#viewport').classList.toggle('zoom-actual', radio('zoom') === 'actual');
}

/* ---------- 保存 ---------- */

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('画像の書き出しに失敗しました（サイズが大きすぎる可能性があります）'))), type, quality);
  });
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes, crc = 0) {
  crc = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}

// PNG に pHYs チャンク、JPEG に JFIF の密度情報を書き込む
async function setDpi(blob, type, dpi) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const d = Math.max(1, Math.min(65535, Math.round(dpi)));
  if (type === 'image/png') {
    const ppm = Math.round(d / 0.0254);
    const chunk = new Uint8Array(21);
    const dv = new DataView(chunk.buffer);
    dv.setUint32(0, 9);
    chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
    dv.setUint32(8, ppm);
    dv.setUint32(12, ppm);
    chunk[16] = 1; // 単位: メートル
    dv.setUint32(17, crc32(chunk.subarray(4, 17)));
    const at = 33; // シグネチャ(8) + IHDR(25) の直後
    return new Blob([bytes.subarray(0, at), chunk, bytes.subarray(at)], { type });
  }
  if (type === 'image/jpeg') {
    const isJfif = bytes[2] === 0xff && bytes[3] === 0xe0 &&
      bytes[6] === 0x4a && bytes[7] === 0x46 && bytes[8] === 0x49 && bytes[9] === 0x46 && bytes[10] === 0;
    if (isJfif) {
      bytes[13] = 1;
      bytes[14] = d >> 8; bytes[15] = d & 0xff;
      bytes[16] = d >> 8; bytes[17] = d & 0xff;
      return new Blob([bytes], { type });
    }
    const app0 = new Uint8Array([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01,
      d >> 8, d & 0xff, d >> 8, d & 0xff, 0x00, 0x00]);
    return new Blob([bytes.subarray(0, 2), app0, bytes.subarray(2)], { type });
  }
  return blob;
}

function outName(item, plan, fmt) {
  const base = item.name.replace(/\.[^./\\]+$/, '') || 'image';
  const ext = fmt === 'image/jpeg' ? 'jpg' : fmt === 'image/webp' ? 'webp' : 'png';
  return `${base}_${plan.W}x${plan.H}.${ext}`;
}

async function exportItem(item, s, onProgress) {
  const r = await renderItem(item, s, exportChannel, onProgress);
  let blob = await canvasToBlob(r.canvas, r.fmt, s.quality / 100);
  const dpi = s.mode === 'print' ? s.dpi : s.dpiMeta;
  if (dpi) blob = await setDpi(blob, r.fmt, dpi);
  return { blob, name: outName(item, r.plan, r.fmt), type: r.fmt };
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

function makeZip(files) {
  const enc = new TextEncoder();
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true); // UTF-8 ファイル名
    lh.setUint16(8, 0, true); // 無圧縮
    lh.setUint16(10, dosTime, true);
    lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true);
    lh.setUint32(22, size, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    parts.push(lh.buffer, name, f.data);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, size, true);
    ch.setUint32(24, size, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(ch.buffer, name);
    offset += 30 + name.length + size;
  }
  const cdSize = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

function uniqueNames(list) {
  const seen = new Map();
  for (const f of list) {
    const n = seen.get(f.name) || 0;
    seen.set(f.name, n + 1);
    if (n) f.name = f.name.replace(/(\.[^.]+)$/, `(${n + 1})$1`);
  }
  return list;
}

let exporting = false;

async function exportMany(list, label) {
  const s = readSettings();
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    setStatus(`${label}（${i + 1} / ${list.length}）: ${item.name}`);
    const r = await exportItem(item, s);
    out.push(r);
    if (item.id !== currentId) { item.srcCanvas = null; item.cache = null; }
  }
  return out;
}

async function withExport(fn) {
  if (exporting) return;
  exporting = true;
  for (const b of $$('.actions .btn')) b.disabled = true;
  try {
    await fn();
  } catch (err) {
    if (err && err.name === 'AbortError') setStatus('中断しました。', true);
    else setStatus(errorText(err), true);
  } finally {
    exporting = false;
    for (const b of $$('.actions .btn')) b.disabled = false;
    $('#saveBtn').disabled = items.length === 0;
  }
}

async function saveCurrent() {
  const item = current();
  if (!item) return;
  await withExport(async () => {
    setStatus('保存用の画像を作っています…');
    const r = await exportItem(item, readSettings());
    download(r.blob, r.name);
    setStatus(`保存しました: ${r.name}（${sizeText(r.blob.size)}）`);
  });
}

async function saveZip() {
  if (items.length < 2) return;
  await withExport(async () => {
    const results = await exportMany([...items], '変換中');
    setStatus('ZIPにまとめています…');
    const files = uniqueNames(await Promise.all(results.map(async (r) => ({
      name: r.name,
      data: new Uint8Array(await r.blob.arrayBuffer()),
    }))));
    const zip = makeZip(files);
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    download(zip, `resized_${stamp}.zip`);
    setStatus(`${files.length}枚をZIPで保存しました（${sizeText(zip.size)}）`);
  });
}

async function shareImages() {
  const list = items.length > 1 ? [...items] : [current()].filter(Boolean);
  if (!list.length) return;
  await withExport(async () => {
    const results = await exportMany(list, '準備中');
    const files = uniqueNames(results.map((r) => ({ name: r.name, blob: r.blob, type: r.type })))
      .map((r) => new File([r.blob], r.name, { type: r.type }));
    try {
      await navigator.share({ files });
      setStatus('共有メニューを開きました。');
    } catch (err) {
      if (err && err.name === 'AbortError') setStatus('');
      else throw err;
    }
  });
}

function updateShareVisibility() {
  let ok = false;
  try {
    ok = !!(navigator.canShare && navigator.canShare({ files: [new File([''], 'a.png', { type: 'image/png' })] }));
  } catch { ok = false; }
  $('#shareBtn').hidden = !ok || items.length === 0;
}

function sizeText(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  return Math.max(1, Math.round(n / 1024)) + ' KB';
}

/* ---------- イベント ---------- */

function bind() {
  $('#file').addEventListener('change', (e) => {
    addFiles(e.target.files);
    e.target.value = '';
  });
  $('#clearAll').addEventListener('click', clearAll);

  // ドラッグ&ドロップ(ページ全体)
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) document.body.classList.remove('dragging');
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    addFiles(e.dataTransfer.files);
  });

  // 貼り付け
  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData ? e.clipboardData.items : [])]
      .filter((it) => it.kind === 'file')
      .map((it) => it.getAsFile())
      .filter(Boolean);
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  });

  // 設定の変更
  const controls = $('.controls');
  controls.addEventListener('input', (e) => {
    if (e.target.id === 'file') return;
    if (e.target.id === 'mmW' || e.target.id === 'mmH') $('#paper').value = 'custom';
    scheduleRender();
  });
  controls.addEventListener('change', (e) => {
    if (e.target.id === 'paper') {
      const p = PAPERS[e.target.value];
      if (p) { $('#mmW').value = p[0]; $('#mmH').value = p[1]; }
    }
    if (e.target.id === 'file') return;
    scheduleRender();
  });

  $('#scaleChips').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    $('#scale').value = b.dataset.scale; scheduleRender(0);
  });
  $('#pxChips').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    $('#pxValue').value = b.dataset.px; scheduleRender(0);
  });
  $('#boxChips').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const [w, h] = b.dataset.box.split('x');
    $('#boxW').value = w; $('#boxH').value = h; scheduleRender(0);
  });
  $('#dpiChips').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    $('#dpi').value = b.dataset.dpi; scheduleRender(0);
  });

  // 表示倍率
  for (const r of $$('input[name="zoom"]')) {
    r.addEventListener('change', () => { updateVisibility(); saveSettings(); });
  }

  // 比較スライダー
  const stage = $('#stage');
  const setSplit = (v) => {
    const clamped = Math.max(0, Math.min(100, v));
    stage.style.setProperty('--split', String(clamped));
    $('#split').value = String(Math.round(clamped));
  };
  $('#split').addEventListener('input', (e) => setSplit(+e.target.value));
  let dragging = false;
  const fromPointer = (e) => {
    const rect = stage.getBoundingClientRect();
    setSplit(((e.clientX - rect.left) / rect.width) * 100);
  };
  stage.addEventListener('pointerdown', (e) => {
    if (radio('zoom') === 'actual') return;
    dragging = true;
    stage.setPointerCapture(e.pointerId);
    fromPointer(e);
  });
  stage.addEventListener('pointermove', (e) => { if (dragging) fromPointer(e); });
  const stop = () => { dragging = false; };
  stage.addEventListener('pointerup', stop);
  stage.addEventListener('pointercancel', stop);

  $('#saveBtn').addEventListener('click', saveCurrent);
  $('#zipBtn').addEventListener('click', saveZip);
  $('#shareBtn').addEventListener('click', shareImages);
}

loadSettings();
bind();
updateVisibility();
renderThumbs();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* 登録できなくても通常どおり動く */ });
  });
}
