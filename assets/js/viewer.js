/**
 * Просмотрщик чертежей.
 *
 * Полноэкранная модалка со своими элементами управления — никакой браузерной
 * панели PDF. Лист рисуется в <canvas> средствами PDF.js в два слоя:
 *   • базовый   — страница целиком в масштабе «вписать», меняется только трансформом;
 *   • детальный — только видимая область в текущем масштабе, поэтому чертёж
 *                 остаётся чётким при любом увеличении, а размер канвы не растёт.
 */

/* --------------------------- мелкие полифилы --------------------------- */
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function withResolvers() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
}

/* ------------------------------ настройки ------------------------------ */
const COARSE = window.matchMedia('(pointer: coarse)').matches;
const MAX_CANVAS_PIXELS = COARSE ? 10e6 : 24e6;
const MAX_CANVAS_SIDE = COARSE ? 4096 : 8192;
const REGION_MARGIN = 0.18;   // запас вокруг видимой области, доли экрана
const ZOOM_STEP = 1.4;
const MAX_ZOOM_FACTOR = 20;   // во сколько раз можно увеличить относительно «вписать»
const RENDER_DEBOUNCE = 130;

/* ------------------------------- иконки -------------------------------- */
const S = 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"';
const ICONS = {
  minus: `<svg viewBox="0 0 24 24" ${S}><path d="M5 12h14"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" ${S}><path d="M12 5v14M5 12h14"/></svg>`,
  fit: `<svg viewBox="0 0 24 24" ${S}><path d="M4 9V4h5M20 15v5h-5M15 4h5v5M9 20H4v-5"/></svg>`,
  full: `<svg viewBox="0 0 24 24" ${S}><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>`,
  prev: `<svg viewBox="0 0 24 24" ${S}><path d="M15 5l-7 7 7 7"/></svg>`,
  next: `<svg viewBox="0 0 24 24" ${S}><path d="M9 5l7 7-7 7"/></svg>`,
  close: `<svg viewBox="0 0 24 24" ${S}><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  grid: `<svg viewBox="0 0 24 24" ${S}><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/></svg>`,
  down: `<svg viewBox="0 0 24 24" ${S}><path d="M12 4v11m0 0 4-4m-4 4-4-4M4 20h16"/></svg>`,
};

/* ------------------------------ PDF.js --------------------------------- */
let pdfjsPromise = null;

function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('../vendor/pdfjs/pdf.min.mjs').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc =
        new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
      return lib;
    });
  }
  return pdfjsPromise;
}

const docCache = new Map();

function loadDocument(file, onProgress) {
  if (!docCache.has(file)) {
    const promise = loadPdfjs().then((lib) => {
      const url = new URL(file, document.baseURI).href;
      const task = lib.getDocument({ url, disableAutoFetch: false });
      if (onProgress) {
        task.onProgress = ({ loaded, total }) => onProgress(total ? loaded / total : 0);
      }
      return task.promise;
    });
    docCache.set(file, promise);
    promise.catch(() => docCache.delete(file));
  }
  return docCache.get(file);
}

/* ------------------------------ состояние ------------------------------ */
const state = {
  project: null,
  pages: [],          // плоский список листов проекта
  current: 0,
  page: null,         // PDFPageProxy текущего листа
  pageSize: { w: 0, h: 0 },
  fitScale: 1,
  scale: 1,
  tx: 0,
  ty: 0,
  baseScale: 1,
  detail: null,       // { scale, x, y, w, h, canvas }
  renderTask: null,   // отрисовка детального слоя
  baseTask: null,     // отрисовка базового слоя
  renderTimer: 0,
  token: 0,           // защита от гонок при быстром переключении листов
  lastFocus: null,
  stripBuilt: false,
};

let ui = null;

/* ------------------------------ разметка ------------------------------- */
function buildUI() {
  const root = document.createElement('div');
  root.className = 'viewer';
  root.id = 'drawingViewer';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Просмотр чертежей');
  root.innerHTML = `
    <div class="viewer__bar">
      <div class="viewer__ident">
        <span class="viewer__title" data-v="title"></span>
        <span class="viewer__sheet" data-v="sheet"></span>
      </div>
      <div class="viewer__tools">
        <div class="zoom-group">
          <button class="vbtn" type="button" data-v="zoomOut" title="Отдалить (−)" aria-label="Отдалить">${ICONS.minus}</button>
          <span class="zoom-group__value" data-v="zoomValue" role="button" tabindex="0"
                title="Вписать в экран (0)">100%</span>
          <button class="vbtn" type="button" data-v="zoomIn" title="Приблизить (+)" aria-label="Приблизить">${ICONS.plus}</button>
        </div>
        <button class="vbtn" type="button" data-v="fit" title="Вписать в экран (0)" aria-label="Вписать в экран">${ICONS.fit}</button>
        <button class="vbtn" type="button" data-v="strip" title="Миниатюры листов" aria-label="Миниатюры листов">${ICONS.grid}</button>
        <button class="vbtn" type="button" data-v="full" title="На весь экран (F)" aria-label="На весь экран">${ICONS.full}</button>
        <span class="viewer__sep" aria-hidden="true"></span>
        <a class="vbtn" data-v="download" title="Скачать лист в PDF" aria-label="Скачать лист в PDF" download>${ICONS.down}</a>
        <button class="vbtn vbtn--accent" type="button" data-v="close" title="Закрыть (Esc)" aria-label="Закрыть">${ICONS.close}</button>
      </div>
    </div>

    <div class="viewer__stage" data-v="stage">
      <canvas class="viewer__layer viewer__layer--base" data-v="base"></canvas>
      <p class="viewer__status" data-v="status" hidden></p>
      <p class="viewer__hint" data-v="hint">
        <span>Колесо — масштаб</span><span>Перетаскивание — сдвиг</span><span>← → — листы</span>
      </p>
    </div>

    <div class="viewer__foot">
      <div class="viewer__nav">
        <button class="vbtn" type="button" data-v="prev" title="Предыдущий лист (←)" aria-label="Предыдущий лист">${ICONS.prev}</button>
        <span class="viewer__counter" data-v="counter"></span>
        <button class="vbtn" type="button" data-v="next" title="Следующий лист (→)" aria-label="Следующий лист">${ICONS.next}</button>
        <span class="viewer__scale" data-v="meta"></span>
      </div>
      <div class="viewer__strip" data-v="stripBox" hidden></div>
    </div>
  `;
  document.body.append(root);

  const el = {};
  root.querySelectorAll('[data-v]').forEach((n) => { el[n.dataset.v] = n; });
  el.root = root;
  el.baseCtx = el.base.getContext('2d', { alpha: false });

  bindEvents(el);
  return el;
}

/* -------------------------- геометрия и масштаб ------------------------- */
function stageSize() {
  const r = ui.stage.getBoundingClientRect();
  return { w: Math.max(1, r.width), h: Math.max(1, r.height) };
}

function computeFit() {
  const { w: sw, h: sh } = stageSize();
  const { w: pw, h: ph } = state.pageSize;
  state.fitScale = Math.min(sw / pw, sh / ph) * 0.94;
}

function clampScale(scale) {
  return Math.min(Math.max(scale, state.fitScale * 0.6), state.fitScale * MAX_ZOOM_FACTOR);
}

/** Не даём листу «уплыть»: мелкий — центрируем, крупный — держим в границах. */
function clampPan() {
  const { w: sw, h: sh } = stageSize();
  const pw = state.pageSize.w * state.scale;
  const ph = state.pageSize.h * state.scale;
  state.tx = pw <= sw ? (sw - pw) / 2 : Math.min(0, Math.max(sw - pw, state.tx));
  state.ty = ph <= sh ? (sh - ph) / 2 : Math.min(0, Math.max(sh - ph, state.ty));
}

function fitPage() {
  computeFit();
  state.scale = state.fitScale;
  clampPan();
  applyTransforms();
  scheduleDetail();
  updateZoomLabel();
}

/** Масштабирование с фиксацией точки (cx, cy) в координатах сцены. */
function zoomAt(nextScale, cx, cy) {
  const scale = clampScale(nextScale);
  if (Math.abs(scale - state.scale) < 1e-6) return;
  const px = (cx - state.tx) / state.scale;
  const py = (cy - state.ty) / state.scale;
  state.scale = scale;
  state.tx = cx - px * scale;
  state.ty = cy - py * scale;
  clampPan();
  applyTransforms();
  scheduleDetail();
  updateZoomLabel();
}

function zoomByStep(factor) {
  const { w, h } = stageSize();
  zoomAt(state.scale * factor, w / 2, h / 2);
}

function updateZoomLabel() {
  const pct = Math.round((state.scale / state.fitScale) * 100);
  ui.zoomValue.textContent = `${pct}%`;
  ui.zoomOut.disabled = state.scale <= state.fitScale * 0.6 + 1e-6;
  ui.zoomIn.disabled = state.scale >= state.fitScale * MAX_ZOOM_FACTOR - 1e-6;
}

/* ------------------------------ отрисовка ------------------------------ */
function applyTransforms() {
  const { tx, ty, scale, baseScale } = state;

  ui.base.style.transform = `translate(${tx}px, ${ty}px) scale(${scale / baseScale})`;

  const d = state.detail;
  if (d && d.canvas) {
    const k = scale / d.scale;
    d.canvas.style.transform =
      `translate(${tx + d.x * scale}px, ${ty + d.y * scale}px) scale(${k})`;
  }
}

/** Базовый слой: вся страница в масштабе «вписать» — быстрый и всегда на месте. */
async function renderBase(token) {
  // PDF.js не разрешает две отрисовки в одну канву: сначала дожидаемся отмены
  // предыдущей — иначе при быстром листании сыплются ошибки и слой остаётся пустым.
  if (state.baseTask) {
    state.baseTask.cancel();
    try {
      await state.baseTask.promise;
    } catch (err) {
      if (err && err.name !== 'RenderingCancelledException') console.error(err);
    }
    state.baseTask = null;
  }
  if (token !== state.token || !state.page) return;

  const { w: sw, h: sh } = stageSize();
  const { w: pw, h: ph } = state.pageSize;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const baseScale = Math.min(sw / pw, sh / ph) * dpr;

  const viewport = state.page.getViewport({ scale: baseScale });
  ui.base.width = Math.max(1, Math.floor(viewport.width));
  ui.base.height = Math.max(1, Math.floor(viewport.height));

  // CSS-размер слоя задаём в единицах PDF, умноженных на baseScale без dpr —
  // дальше масштаб доводится трансформом в applyTransforms().
  state.baseScale = baseScale / dpr;
  ui.base.style.width = `${pw * state.baseScale}px`;
  ui.base.style.height = `${ph * state.baseScale}px`;

  ui.baseCtx.setTransform(1, 0, 0, 1, 0, 0);
  ui.baseCtx.fillStyle = '#ffffff';
  ui.baseCtx.fillRect(0, 0, ui.base.width, ui.base.height);

  const task = state.page.render({ canvasContext: ui.baseCtx, viewport });
  state.baseTask = task;
  try {
    await task.promise;
  } catch (err) {
    if (err && err.name !== 'RenderingCancelledException') throw err;
    return;
  } finally {
    if (state.baseTask === task) state.baseTask = null;
  }
  if (token !== state.token) return;
  ui.base.style.visibility = 'visible';
  applyTransforms();
}

function scheduleDetail() {
  clearTimeout(state.renderTimer);
  state.renderTimer = setTimeout(() => renderDetail(state.token), RENDER_DEBOUNCE);
}

/** Видимая область в единицах PDF, с запасом и с учётом границ листа. */
function visibleRegion() {
  const { w: sw, h: sh } = stageSize();
  const { scale, tx, ty } = state;
  const mx = (sw * REGION_MARGIN) / scale;
  const my = (sh * REGION_MARGIN) / scale;

  const x0 = Math.max(0, (0 - tx) / scale - mx);
  const y0 = Math.max(0, (0 - ty) / scale - my);
  const x1 = Math.min(state.pageSize.w, (sw - tx) / scale + mx);
  const y1 = Math.min(state.pageSize.h, (sh - ty) / scale + my);

  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

function detailIsFresh(region) {
  const d = state.detail;
  if (!d || !d.canvas) return false;
  if (Math.abs(d.scale - state.scale) / state.scale > 0.01) return false;
  const eps = 0.5;
  return (
    d.x <= region.x + eps && d.y <= region.y + eps &&
    d.x + d.w >= region.x + region.w - eps &&
    d.y + d.h >= region.y + region.h - eps
  );
}

async function renderDetail(token) {
  if (!state.page || token !== state.token) return;

  const region = visibleRegion();
  if (detailIsFresh(region)) return;

  if (state.renderTask) {
    state.renderTask.cancel();
    state.renderTask = null;
  }

  const scale = state.scale;
  let dpr = window.devicePixelRatio || 1;

  // Не выходим за ограничения канвы ни по площади, ни по стороне.
  const pxW = region.w * scale;
  const pxH = region.h * scale;
  dpr = Math.min(
    dpr,
    Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, pxW * pxH)),
    MAX_CANVAS_SIDE / Math.max(1, pxW),
    MAX_CANVAS_SIDE / Math.max(1, pxH)
  );
  dpr = Math.max(0.5, dpr);

  const canvas = document.createElement('canvas');
  canvas.className = 'viewer__layer viewer__layer--detail';
  canvas.width = Math.max(1, Math.floor(pxW * dpr));
  canvas.height = Math.max(1, Math.floor(pxH * dpr));
  canvas.style.width = `${pxW}px`;
  canvas.style.height = `${pxH}px`;

  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const viewport = state.page.getViewport({ scale });
  const task = state.page.render({
    canvasContext: ctx,
    viewport,
    transform: [dpr, 0, 0, dpr, -region.x * scale * dpr, -region.y * scale * dpr],
  });
  state.renderTask = task;

  try {
    await task.promise;
  } catch (err) {
    if (err && err.name === 'RenderingCancelledException') return;
    throw err;
  } finally {
    if (state.renderTask === task) state.renderTask = null;
  }
  if (token !== state.token) return;

  const prev = state.detail && state.detail.canvas;
  state.detail = { scale, x: region.x, y: region.y, w: region.w, h: region.h, canvas };
  if (prev) prev.replaceWith(canvas); else ui.stage.append(canvas);
  applyTransforms();
}

function dropDetail() {
  if (state.renderTask) {
    state.renderTask.cancel();
    state.renderTask = null;
  }
  if (state.detail && state.detail.canvas) state.detail.canvas.remove();
  state.detail = null;
}

/* ------------------------------- листы --------------------------------- */
function flattenPages(project) {
  const pages = [];
  project.sheets.forEach((sheet, sheetIndex) => {
    for (let n = 1; n <= sheet.pages; n += 1) {
      pages.push({
        sheetIndex,
        file: sheet.file,
        pageNumber: n,
        title: sheet.title,
        multi: sheet.pages > 1,
      });
    }
  });
  return pages;
}

function showStatus(text, progress) {
  ui.status.hidden = false;
  ui.status.innerHTML = progress === undefined ? text : `${text}<b></b>`;
  if (progress !== undefined) {
    ui.status.style.setProperty('--p', String(Math.max(0, Math.min(1, progress))));
  }
}

function hideStatus() {
  ui.status.hidden = true;
}

async function goToPage(index, { keepView = false } = {}) {
  const total = state.pages.length;
  const next = Math.min(Math.max(index, 0), total - 1);
  const entry = state.pages[next];
  if (!entry) return;

  state.current = next;
  state.token += 1;
  const token = state.token;

  dropDetail();
  ui.base.style.visibility = 'hidden';
  updateChrome();

  showStatus('Загрузка листа');
  let doc;
  try {
    doc = await loadDocument(entry.file, (p) => {
      if (token === state.token) showStatus('Загрузка листа', p);
    });
  } catch (err) {
    if (token !== state.token) return;
    showStatus('Не удалось загрузить лист');
    console.error(err);
    return;
  }
  if (token !== state.token) return;

  let page;
  try {
    page = await doc.getPage(entry.pageNumber);
  } catch (err) {
    if (token !== state.token) return;
    showStatus('Не удалось открыть лист');
    console.error(err);
    return;
  }
  if (token !== state.token) return;

  state.page = page;
  const vp = page.getViewport({ scale: 1 });
  state.pageSize = { w: vp.width, h: vp.height };

  computeFit();
  if (!keepView) {
    state.scale = state.fitScale;
    state.tx = 0;
    state.ty = 0;
  } else {
    state.scale = clampScale(state.scale);
  }
  clampPan();
  updateZoomLabel();
  updateChrome();

  await renderBase(token);
  if (token !== state.token) return;
  hideStatus();
  renderDetail(token).catch((e) => console.error(e));
  markCurrentThumb();
}

function sheetFormat() {
  const { w, h } = state.pageSize;
  const mmW = Math.round((w * 25.4) / 72);
  const mmH = Math.round((h * 25.4) / 72);
  const long = Math.max(mmW, mmH);
  const short = Math.min(mmW, mmH);
  const formats = [
    ['А0', 1189, 841], ['А1', 841, 594], ['А2', 594, 420],
    ['А3', 420, 297], ['А4', 297, 210],
  ];
  const hit = formats.find(([, fl, fs]) => Math.abs(fl - long) <= 6 && Math.abs(fs - short) <= 6);
  const name = hit ? `Формат ${hit[0]} · ` : '';
  return `${name}${mmW} × ${mmH} мм`;
}

function updateChrome() {
  const entry = state.pages[state.current];
  const total = state.pages.length;
  if (!entry) return;

  ui.title.textContent = state.project.title;
  ui.sheet.textContent = entry.multi
    ? `${entry.title} · лист ${entry.pageNumber} из ${state.project.sheets[entry.sheetIndex].pages}`
    : entry.title;

  ui.counter.innerHTML = `${state.current + 1} <em>/ ${total}</em>`;
  ui.prev.disabled = state.current === 0;
  ui.next.disabled = state.current === total - 1;
  ui.download.href = entry.file;

  const singlePage = total === 1;
  ui.prev.hidden = singlePage;
  ui.next.hidden = singlePage;
  ui.counter.hidden = singlePage;
  ui.strip.hidden = singlePage;

  ui.meta.textContent = state.pageSize.w ? sheetFormat() : '';
}

/* ---------------------------- лента миниатюр ---------------------------- */
let thumbObserver = null;

function buildStrip() {
  ui.stripBox.innerHTML = '';
  if (thumbObserver) thumbObserver.disconnect();

  thumbObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        thumbObserver.unobserve(entry.target);
        renderThumb(entry.target).catch(() => {});
      });
    },
    { root: ui.stripBox, rootMargin: '200px' }
  );

  state.pages.forEach((entry, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'thumb';
    btn.dataset.index = String(i);
    btn.setAttribute('aria-label', `Лист ${i + 1}: ${entry.title}`);
    btn.innerHTML = `<span class="thumb__skeleton"></span><span class="thumb__num">${i + 1}</span>`;
    btn.addEventListener('click', () => goToPage(i));
    ui.stripBox.append(btn);
    thumbObserver.observe(btn);
  });

  state.stripBuilt = true;
  markCurrentThumb();
}

async function renderThumb(btn) {
  const entry = state.pages[Number(btn.dataset.index)];
  if (!entry) return;
  const doc = await loadDocument(entry.file);
  const page = await doc.getPage(entry.pageNumber);
  const vp1 = page.getViewport({ scale: 1 });

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const boxW = btn.clientWidth || 92;
  const boxH = btn.clientHeight || 65;
  const scale = Math.min(boxW / vp1.width, boxH / vp1.height) * dpr;
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;

  const skeleton = btn.querySelector('.thumb__skeleton');
  if (skeleton) skeleton.remove();
  btn.prepend(canvas);
}

function markCurrentThumb() {
  if (!state.stripBuilt) return;
  ui.stripBox.querySelectorAll('.thumb').forEach((t) => {
    const active = Number(t.dataset.index) === state.current;
    t.classList.toggle('is-current', active);
    if (active && ui.stripBox.offsetParent !== null) {
      t.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    }
  });
}

/* ------------------------------ управление ------------------------------ */
function bindEvents(el) {
  const pointers = new Map();
  let pinch = null;
  let panned = false;
  let lastTap = 0;

  el.zoomIn.addEventListener('click', () => zoomByStep(ZOOM_STEP));
  el.zoomOut.addEventListener('click', () => zoomByStep(1 / ZOOM_STEP));
  el.fit.addEventListener('click', fitPage);
  el.zoomValue.addEventListener('click', fitPage);
  el.zoomValue.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fitPage(); }
  });
  el.prev.addEventListener('click', () => goToPage(state.current - 1));
  el.next.addEventListener('click', () => goToPage(state.current + 1));
  el.close.addEventListener('click', close);

  el.strip.addEventListener('click', () => {
    const show = el.stripBox.hasAttribute('hidden');
    el.stripBox.toggleAttribute('hidden', !show);
    el.strip.classList.toggle('is-active', show);
    if (show) markCurrentThumb();
  });

  el.full.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (el.root.requestFullscreen) el.root.requestFullscreen().catch(() => {});
  });
  if (!document.documentElement.requestFullscreen) el.full.hidden = true;

  /* --- колесо --- */
  el.stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = el.stage.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    if (e.shiftKey && !e.ctrlKey) {
      state.tx -= e.deltaY;
      clampPan();
      applyTransforms();
      scheduleDetail();
      return;
    }
    const unit = e.deltaMode === 1 ? 18 : e.deltaMode === 2 ? 400 : 1;
    const factor = Math.exp(-e.deltaY * unit * 0.0022);
    zoomAt(state.scale * factor, cx, cy);
  }, { passive: false });

  /* --- указатели: перетаскивание и щипок --- */
  el.stage.addEventListener('pointerdown', (e) => {
    el.stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    panned = false;
    hideHint();

    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = {
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        scale: state.scale,
        mid: midPoint(a, b),
      };
    } else {
      el.stage.classList.add('is-panning');
    }
  });

  el.stage.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const next = { x: e.clientX, y: e.clientY };
    pointers.set(e.pointerId, next);

    if (pointers.size >= 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = midPoint(a, b);
      const rect = el.stage.getBoundingClientRect();

      state.tx += mid.x - pinch.mid.x;
      state.ty += mid.y - pinch.mid.y;
      pinch.mid = mid;
      panned = true;

      zoomAt(pinch.scale * (dist / pinch.dist), mid.x - rect.left, mid.y - rect.top);
      return;
    }

    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) panned = true;
    state.tx += dx;
    state.ty += dy;
    clampPan();
    applyTransforms();
    scheduleDetail();
  });

  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) {
      el.stage.classList.remove('is-panning');
      if (!panned) handleTap(e);
    }
  };
  el.stage.addEventListener('pointerup', endPointer);
  el.stage.addEventListener('pointercancel', endPointer);

  function handleTap(e) {
    const now = Date.now();
    if (now - lastTap < 320) {
      const rect = el.stage.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const zoomed = state.scale > state.fitScale * 1.2;
      if (zoomed) fitPage();
      else zoomAt(state.fitScale * 3, cx, cy);
      lastTap = 0;
    } else {
      lastTap = now;
    }
  }

  function midPoint(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  /* --- клавиатура --- */
  document.addEventListener('keydown', (e) => {
    if (!el.root.classList.contains('is-open')) return;

    switch (e.key) {
      case 'Escape':
        if (document.fullscreenElement) document.exitFullscreen();
        else close();
        break;
      case 'ArrowLeft': e.preventDefault(); goToPage(state.current - 1); break;
      case 'ArrowRight': e.preventDefault(); goToPage(state.current + 1); break;
      case 'Home': e.preventDefault(); goToPage(0); break;
      case 'End': e.preventDefault(); goToPage(state.pages.length - 1); break;
      case '+': case '=': e.preventDefault(); zoomByStep(ZOOM_STEP); break;
      case '-': case '_': e.preventDefault(); zoomByStep(1 / ZOOM_STEP); break;
      case '0': e.preventDefault(); fitPage(); break;
      case 'f': case 'F': case 'а': case 'А': el.full.click(); break;
      case 'Tab': trapFocus(e, el.root); break;
      default: break;
    }
  });

  /* --- изменение размеров сцены --- */
  const ro = new ResizeObserver(() => {
    if (!el.root.classList.contains('is-open') || !state.page) return;
    const wasFit = Math.abs(state.scale - state.fitScale) < 1e-3;
    computeFit();
    if (wasFit) state.scale = state.fitScale;
    else state.scale = clampScale(state.scale);
    clampPan();
    applyTransforms();
    updateZoomLabel();
    dropDetail();
    renderBase(state.token).then(() => scheduleDetail()).catch(() => {});
  });
  ro.observe(el.stage);

  let hintTimer = 0;
  function hideHint() {
    el.hint.classList.add('is-hidden');
    clearTimeout(hintTimer);
  }
  el.showHint = () => {
    if (COARSE) return;
    el.hint.classList.remove('is-hidden');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => el.hint.classList.add('is-hidden'), 4200);
  };
}

function trapFocus(e, root) {
  const focusable = [...root.querySelectorAll(
    'button:not([disabled]):not([hidden]), a[href], [tabindex]:not([tabindex="-1"])'
  )].filter((n) => n.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

/* ----------------------------- открыть/закрыть -------------------------- */
export async function open(project, startPage = 0) {
  if (!ui) ui = buildUI();

  state.lastFocus = document.activeElement;
  state.project = project;
  state.pages = flattenPages(project);
  state.current = Math.min(Math.max(startPage, 0), state.pages.length - 1);
  state.stripBuilt = false;
  state.detail = null;
  state.page = null;
  state.pageSize = { w: 0, h: 0 };

  ui.stripBox.toggleAttribute('hidden', state.pages.length <= 1);
  ui.strip.classList.toggle('is-active', state.pages.length > 1);

  ui.root.classList.add('is-open');
  document.body.classList.add('is-locked');
  ui.close.focus({ preventScroll: true });
  ui.showHint();

  updateChrome();
  await goToPage(startPage);
  if (state.pages.length > 1) buildStrip();
}

export function close() {
  if (!ui) return;
  state.token += 1;
  clearTimeout(state.renderTimer);
  dropDetail();
  if (state.baseTask) {
    state.baseTask.cancel();
    state.baseTask = null;
  }
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});

  ui.root.classList.remove('is-open');
  document.body.classList.remove('is-locked');
  if (thumbObserver) thumbObserver.disconnect();
  ui.stripBox.innerHTML = '';
  state.stripBuilt = false;
  state.page = null;

  if (state.lastFocus && state.lastFocus.focus) {
    state.lastFocus.focus({ preventScroll: true });
  }
}
