document.documentElement.classList.remove('no-js'); document.documentElement.classList.add('js');

/*
 * Кабинет бухгалтера v4: горизонтальная панорама из 4 сцен.
 * Vanilla JS, без библиотек и внешних запросов.
 * Режимы: desktop (панорама на sticky + transform), mobile (scroll-snap ленты),
 * classic (body.is-classic, обычная вертикальная лента панелей).
 * Код устойчив к отсутствию любого элемента разметки.
 */
(function (start) {
  // запуск после разбора DOM (на случай подключения без defer)
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})(function () {
  'use strict';

  /* ================= Константы ================= */
  var SCROLL_LERP = 0.12;          // доля догонялки за кадр (при 60 fps)
  var DRAG_THRESHOLD = 5;          // порог начала перетаскивания, px
  var DRAG_FACTOR = 1;             // 1 px мыши = 1 px панорамы
  var INERTIA_DECAY = 0.94;        // затухание инерции за кадр
  var INERTIA_MIN = 0.02;          // px/мс, ниже — остановка
  var ARRIVAL_TIMEOUT = 900;       // ждать прибытия к сцене перед открытием панели, мс
  var NAV_MEMORY = 900;            // сколько помнить «куда едем» для стрелок, мс
  var DRAWER_FALLBACK = 600;       // запасной таймер закрытия ящика, мс
  var SWITCH_TIME = 200;           // мягкая смена панели в открытом ящике, мс
  var TOAST_TIME = 2200;           // время показа уведомления, мс
  var STORAGE_KEY = 'v4-view';

  var FOCUSABLE = 'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), ' +
    'select:not([disabled]), textarea:not([disabled]), summary, iframe, audio[controls], video[controls], ' +
    '[contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex="-1"])';
  var NO_DRAG = 'a, button, summary, input, textarea, select, label, [contenteditable], video[controls], audio[controls]';

  /* ================= Утилиты ================= */
  var doc = document;
  var body = doc.body;

  function $(sel, ctx) { return (ctx || doc).querySelector(sel); }
  function $$(sel, ctx) { return Array.prototype.slice.call((ctx || doc).querySelectorAll(sel)); }
  function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
  function noop() {}
  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function closest(el, sel) { return (el && el.closest) ? el.closest(sel) : null; }
  function isRendered(el) { return !!(el && el.getClientRects && el.getClientRects().length); }
  function isFocusVisible(el) {
    if (!el || !el.matches) return false;
    try { return el.matches(':focus-visible'); } catch (e) { return false; }
  }
  function getScrollY() { return window.pageYOffset || doc.documentElement.scrollTop || 0; }

  function media(query) {
    if (window.matchMedia) return window.matchMedia(query);
    return { matches: false };
  }
  function onMediaChange(m, fn) {
    if (!m) return;
    if (m.addEventListener) m.addEventListener('change', fn);
    else if (m.addListener) m.addListener(fn);
  }

  /* Прокрутка окна: 'instant' не зависит от CSS scroll-behavior; старые браузеры — запасной вариант */
  function scrollWindowTo(top, smooth) {
    top = Math.max(0, top);
    try {
      window.scrollTo({ top: top, left: 0, behavior: smooth ? 'smooth' : 'instant' });
    } catch (e) {
      window.scrollTo(0, top);
    }
  }
  function scrollElementTo(el, left, smooth) {
    if (!el) return;
    try {
      el.scrollTo({ left: left, top: 0, behavior: smooth ? 'smooth' : 'instant' });
    } catch (e) {
      el.scrollLeft = left;
    }
  }

  function storageGet() {
    try { return window.localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
  }
  function storageSet(value) {
    try { window.localStorage.setItem(STORAGE_KEY, value); } catch (e) { /* приватный режим и т.п. */ }
  }

  function replaceHash(hash) {
    try {
      var url = location.pathname + location.search + (hash || '');
      history.replaceState(history.state, '', url);
    } catch (e) { /* file:// в некоторых браузерах */ }
  }

  /* ================= Элементы ================= */
  var els = {
    panorama: $('.panorama'),
    sticky: $('.panorama__sticky'),
    track: $('.panorama__track'),
    topbar: $('#topbar') || $('.topbar'),
    walk: $('.walk'),
    toggle: $('[data-view-toggle]'),
    drawer: $('.drawer'),
    drawerPanel: $('.drawer__panel'),
    drawerBody: $('#drawer-body') || $('.drawer__body'),
    drawerTitle: $('#drawer-title'),
    toast: $('#toast'),
    library: $('.library')
  };
  els.toggleLabel = els.toggle ? $('.view-toggle__label', els.toggle) : null;

  var scenes = els.track ? $$('.scene', els.track) : $$('.scene');
  var sceneCount = scenes.length || 4;
  var walkItems = $$('.walk__item');
  var navLinks = $$('.topbar__nav a');
  var videos = $$('[data-scene-video]');

  var mqMobile = media('(max-width: 767px)');
  var mqReduced = media('(prefers-reduced-motion: reduce)');
  var saveData = !!(navigator.connection && navigator.connection.saveData);

  /* ================= Состояние ================= */
  var state = {
    mode: '',              // 'desktop' | 'mobile' | 'classic'
    classic: false,
    reduced: !!mqReduced.matches,
    vw: window.innerWidth || 1,   // ширина сцены (кэш)
    vh: window.innerHeight || 1,
    panoTop: 0,            // кэш смещения .panorama от верха документа
    scrollY: getScrollY(), // кэш, обновляется в scroll
    x: 0,                  // текущее смещение ленты
    target: 0,             // целевое смещение
    raf: 0,
    lastTick: 0,
    active: -1,            // индекс активной сцены
    progress: -1,
    savedScene: 0,         // сцена, на которой был пользователь до classic
    navPending: null,      // { index, time } — куда сейчас едем
    lastNavLink: null,     // последний кликнутый пункт шапки
    interacted: false,
    programmaticFocus: false
  };

  function maxShift() { return (sceneCount - 1) * state.vw; }
  function readTarget() { return clamp(state.scrollY - state.panoTop, 0, maxShift()); }

  /* ================= Замеры ================= */
  function measureSceneWidth() {
    var w = 0;
    if (scenes[0]) w = scenes[0].getBoundingClientRect().width;
    return w > 0 ? w : (window.innerWidth || doc.documentElement.clientWidth || 1);
  }

  function measure() {
    state.vh = window.innerHeight || doc.documentElement.clientHeight || 1;
    state.vw = measureSceneWidth();
    state.scrollY = getScrollY();
    if (els.panorama && state.mode === 'desktop') {
      state.panoTop = els.panorama.getBoundingClientRect().top + state.scrollY;
    } else {
      state.panoTop = els.panorama ? els.panorama.offsetTop : 0;
    }
  }

  function setPanoramaHeight() {
    if (!els.panorama) return;
    els.panorama.style.height = Math.round(state.vh + maxShift()) + 'px';
  }

  function resetPanoramaStyles() {
    if (els.panorama) els.panorama.style.height = '';
    if (els.track) els.track.style.transform = '';
    if (els.panorama) els.panorama.classList.remove('is-dragging');
  }

  /* ================= Активная сцена / прогресс ================= */
  function syncTopbarUi(p, isScrolled) {
    if (!els.topbar) return;
    var clamped = clamp(p, 0, 1);
    els.topbar.style.setProperty('--progress', clamped.toFixed(4));
    els.topbar.classList.toggle('has-progress', clamped > 0.002);
    els.topbar.classList.toggle('is-scrolled', !!isScrolled);
  }

  function updateClassicTopbar() {
    if (state.mode !== 'classic') return;
    var docEl = doc.documentElement;
    var maxY = Math.max(0, (docEl.scrollHeight || body.scrollHeight || 0) - (window.innerHeight || docEl.clientHeight || 0));
    var y = getScrollY();
    var p = maxY > 0 ? y / maxY : 0;
    syncTopbarUi(p, y > 40);
  }

  function setProgress(p) {
    p = clamp(p, 0, 1);
    if (Math.abs(p - state.progress) < 0.0005 && p !== 0 && p !== 1) return;
    if (p === state.progress) return;
    state.progress = p;
    var pStr = p.toFixed(4);
    if (els.walk) els.walk.style.setProperty('--progress', pStr);
    if (state.mode !== 'classic') {
      syncTopbarUi(p, p > 0.03 || state.scrollY > 40);
    }
  }

  function setActive(index, force) {
    index = clamp(index, 0, sceneCount - 1);
    if (index === state.active && !force) return;
    state.active = index;
    var num = String(index + 1);

    scenes.forEach(function (scene, k) {
      scene.classList.toggle('is-active', k === index);
    });

    walkItems.forEach(function (item, k) {
      var goto = item.getAttribute('data-goto');
      var on = goto !== null ? goto === num : k === index;
      item.classList.toggle('is-active', on);
      if (on) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    });

    updateNavActive();
    updateVideos();
  }

  /* Подсветка пункта шапки. Для сцены 4 два пункта: последний кликнутый, иначе первый («Отзывы») */
  function updateNavActive() {
    if (!navLinks.length) return;
    var num = String(Math.max(0, state.active) + 1);
    var candidates = navLinks.filter(function (a) { return a.getAttribute('data-goto') === num; });
    var chosen = candidates.indexOf(state.lastNavLink) !== -1 ? state.lastNavLink : (candidates[0] || null);
    navLinks.forEach(function (a) { a.classList.toggle('is-active', a === chosen); });
  }

  /* ================= Десктоп: rAF-цикл панорамы ================= */
  function renderDesktop() {
    if (els.track) {
      els.track.style.transform = 'translate3d(' + (-Math.round(state.x * 100) / 100) + 'px,0,0)';
    }
    var max = maxShift();
    setProgress(max > 0 ? state.x / max : 0);
    setActive(Math.round(state.x / state.vw));
  }

  function tick(time) {
    state.raf = 0;
    if (state.mode !== 'desktop') { state.lastTick = 0; return; }
    var dt = state.lastTick ? Math.min(64, time - state.lastTick) : 16.667;
    state.lastTick = time;

    state.target = readTarget();
    var diff = state.target - state.x;
    if (state.reduced || Math.abs(diff) < 0.5) {
      state.x = state.target;
    } else {
      // догонялка, нормированная по времени кадра (одинаково на 60 и 144 Гц)
      var k = 1 - Math.pow(1 - SCROLL_LERP, dt / 16.667);
      state.x += diff * k;
    }
    renderDesktop();

    if (state.x !== state.target) state.raf = requestAnimationFrame(tick);
    else state.lastTick = 0; // цикл засыпает до следующего события
  }

  function wake() {
    if (!state.raf && state.mode === 'desktop') state.raf = requestAnimationFrame(tick);
  }

  function stopLoop() {
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = 0;
    state.lastTick = 0;
  }

  /* Мгновенно совместить ленту с текущей прокруткой (без анимации) */
  function syncDesktopImmediately() {
    state.scrollY = getScrollY();
    state.target = readTarget();
    state.x = state.target;
    state.active = -1;
    state.progress = -1;
    renderDesktop();
  }

  function sceneScrollTop(index) { return state.panoTop + index * state.vw; }

  /* ================= Мобильный режим: лента со scroll-snap ================= */
  var trackRaf = 0;

  function syncMobile() {
    if (!els.track) return;
    var w = state.vw || 1;
    var sl = els.track.scrollLeft;
    var max = w * (sceneCount - 1);
    setProgress(max > 0 ? sl / max : 0);
    setActive(Math.round(sl / w));
  }

  function onTrackScroll() {
    if (state.mode !== 'mobile' || trackRaf) return;
    trackRaf = requestAnimationFrame(function () {
      trackRaf = 0;
      if (state.mode === 'mobile') syncMobile();
    });
  }

  /* ================= Переход к сцене ================= */
  function currentSceneIndex() {
    if (state.mode === 'desktop') return Math.round(readTarget() / state.vw);
    if (state.mode === 'mobile' && els.track) return Math.round(els.track.scrollLeft / (state.vw || 1));
    return Math.max(0, state.active);
  }

  /* База для стрелок: если только что поехали к сцене — считаем от неё */
  function baseSceneIndex() {
    if (state.navPending && now() - state.navPending.time < NAV_MEMORY) return state.navPending.index;
    return currentSceneIndex();
  }

  function goToScene(index, smooth) {
    index = clamp(parseInt(index, 10) || 0, 0, sceneCount - 1);
    var useSmooth = !!smooth && !state.reduced;
    stopInertia();
    state.navPending = { index: index, time: now() };
    if (state.mode === 'desktop') {
      scrollWindowTo(sceneScrollTop(index), useSmooth);
      state.scrollY = getScrollY();
      wake();
    } else if (state.mode === 'mobile' && els.track) {
      scrollElementTo(els.track, index * state.vw, useSmooth);
    }
    return index;
  }

  /* Мгновенный прыжок к сцене при смене режима — без проезда по панораме */
  function jumpToScene(index) {
    index = clamp(index, 0, sceneCount - 1);
    if (state.mode === 'desktop') {
      scrollWindowTo(sceneScrollTop(index), false);
      syncDesktopImmediately();
    } else if (state.mode === 'mobile' && els.track) {
      scrollElementTo(els.track, index * state.vw, false);
      state.active = -1;
      state.progress = -1;
      syncMobile();
    }
  }

  function hasArrived(index) {
    if (state.mode === 'desktop') {
      var dest = index * state.vw;
      return Math.abs(readTarget() - dest) < 2 && Math.abs(state.x - dest) < Math.max(2, state.vw * 0.01);
    }
    if (state.mode === 'mobile' && els.track) {
      return Math.abs(els.track.scrollLeft - index * state.vw) < 2;
    }
    return true;
  }

  /* Открыть панель после прибытия к сцене (или по таймауту) */
  var pendingOpen = null;

  function cancelPendingOpen() {
    if (pendingOpen && pendingOpen.raf) cancelAnimationFrame(pendingOpen.raf);
    pendingOpen = null;
  }

  function openAfterArrival(index, name, opener) {
    cancelPendingOpen();
    var job = { raf: 0, start: now() };
    pendingOpen = job;

    function check() {
      if (pendingOpen !== job) return;
      job.raf = 0;
      if (state.mode === 'classic') { pendingOpen = null; return; }
      var arrived = hasArrived(index);
      if (!arrived && now() - job.start < ARRIVAL_TIMEOUT) {
        job.raf = requestAnimationFrame(check);
        return;
      }
      pendingOpen = null;
      if (!arrived && Math.abs(currentSceneIndex() - index) > 0) jumpToScene(index);
      openPanel(name, opener);
    }
    job.raf = requestAnimationFrame(check);
  }

  /* ================= Режимы ================= */
  function computeMode() {
    if (state.classic) return 'classic';
    return mqMobile.matches ? 'mobile' : 'desktop';
  }

  function updateToggleUi() {
    if (els.toggle) els.toggle.setAttribute('aria-pressed', state.classic ? 'true' : 'false');
    if (els.toggleLabel) els.toggleLabel.textContent = state.classic ? 'Панорама' : 'Обычный вид';
  }

  function applyMode(initial) {
    var prev = state.mode;
    var next = computeMode();
    if (prev === next) { relayout(); return; }

    var fromPano = prev === 'desktop' || prev === 'mobile';
    var sceneIndex = fromPano ? Math.max(0, state.active) : state.savedScene;

    if (drawerState.open || drawerState.closing) {
      closeDrawer({ immediate: true, restoreFocus: false });
    }
    cancelPendingOpen();
    endDrag();
    stopInertia();
    stopLoop();

    state.mode = next;
    body.classList.toggle('is-classic', next === 'classic');
    updateToggleUi();

    if (next === 'classic') {
      state.savedScene = sceneIndex;
      resetPanoramaStyles();
      if (!initial) scrollWindowTo(0, false);
      updateClassicTopbar();
      watchClassicStats();
    } else if (next === 'desktop') {
      if (els.track) els.track.style.transform = '';
      measure();
      setPanoramaHeight();
      if (els.sticky) { els.sticky.scrollLeft = 0; els.sticky.scrollTop = 0; }
      if (initial) syncDesktopImmediately();
      else jumpToScene(sceneIndex);
    } else {
      resetPanoramaStyles();
      measure();
      if (initial) {
        state.active = -1;
        state.progress = -1;
        syncMobile();
      } else {
        scrollWindowTo(0, false);
        jumpToScene(sceneIndex);
      }
    }
    updateVideos();
  }

  /* Пересчёт при resize в том же режиме — с сохранением доли прогресса, без рывка */
  function relayout() {
    if (state.mode === 'desktop') {
      var oldMax = maxShift();
      var rel = getScrollY() - state.panoTop;
      var frac = (oldMax > 0 && rel >= 0 && rel <= oldMax) ? rel / oldMax : null;
      var xFrac = oldMax > 0 ? state.x / oldMax : 0;

      measure();
      setPanoramaHeight();
      var newMax = maxShift();
      if (frac !== null) scrollWindowTo(Math.round(state.panoTop + frac * newMax), false);

      state.scrollY = getScrollY();
      state.target = readTarget();
      state.x = clamp(xFrac * newMax, 0, newMax);
      renderDesktop();
      wake();
    } else if (state.mode === 'mobile') {
      var oldW = state.vw;
      var idx = Math.max(0, state.active);
      measure();
      // на мобильных resize летит при скрытии адресной строки: трогаем ленту, только если сменилась ширина
      if (Math.abs(oldW - state.vw) > 0.5) scrollElementTo(els.track, idx * state.vw, false);
      syncMobile();
    }
  }

  var layoutRaf = 0;
  function scheduleLayout() {
    if (layoutRaf) return;
    layoutRaf = requestAnimationFrame(function () {
      layoutRaf = 0;
      applyMode(false);
    });
  }

  function setClassic(on, opts) {
    on = !!on;
    if (on === state.classic) return;
    state.classic = on;
    if (opts && opts.persist) storageSet(on ? 'classic' : 'panorama');
    if (!on && location.hash === '#classic') replaceHash('');
    applyMode(false);
  }

  /* ================= Колесо, клавиши ================= */
  function onWindowScroll() {
    state.scrollY = getScrollY();
    if (state.mode === 'desktop') wake();
    else if (state.mode === 'classic') updateClassicTopbar();
  }

  function onWheel(e) {
    state.interacted = true;
    if (state.mode !== 'desktop' || drawerState.open || e.ctrlKey) return;
    if (closest(e.target, '.drawer')) return;
    cancelPendingOpen();
    stopInertia();
    var ax = Math.abs(e.deltaX);
    var ay = Math.abs(e.deltaY);
    if (ax <= ay) return; // вертикальное колесо — нативный скролл
    var dx = e.deltaX;
    if (e.deltaMode === 1) dx *= 16;
    else if (e.deltaMode === 2) dx *= state.vw;
    e.preventDefault();
    window.scrollBy(0, dx);
  }

  function isEditable(el) {
    if (!el || el === body) return false;
    if (el.isContentEditable) return true;
    return !!closest(el, 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), video, audio');
  }

  function onKeydown(e) {
    if (drawerState.open) {
      if (e.key === 'Escape' || e.key === 'Esc') { e.preventDefault(); closeDrawer(); }
      else if (e.key === 'Tab') trapTab(e);
      return;
    }
    if (e.key === 'Escape' || e.key === 'Esc') { cancelPendingOpen(); return; }
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (state.mode === 'classic') return;
    if (isEditable(e.target)) return;

    var index;
    switch (e.key) {
      case 'ArrowRight': index = baseSceneIndex() + 1; break;
      case 'ArrowLeft': index = baseSceneIndex() - 1; break;
      case 'Home': index = 0; break;
      case 'End': index = sceneCount - 1; break;
      default: return;
    }
    e.preventDefault();
    state.interacted = true;
    cancelPendingOpen();
    goToScene(index, true);
  }

  /* ================= Перетаскивание мышью ================= */
  var drag = { id: null, startX: 0, startScroll: 0, active: false, samples: [], prevUserSelect: '' };
  var inertia = { raf: 0, v: 0, pos: 0, last: 0 };

  function onPointerDown(e) {
    if (state.mode !== 'desktop' || drawerState.open) return;
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    if (closest(e.target, NO_DRAG)) return;

    state.interacted = true;
    stopInertia();
    cancelPendingOpen();
    drag.id = e.pointerId;
    drag.startX = e.clientX;
    drag.startScroll = getScrollY();
    drag.active = false;
    drag.samples = [{ t: now(), y: drag.startScroll }];
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
  }

  function onPointerMove(e) {
    if (e.pointerId !== drag.id) return;
    if (!drag.active) {
      if (Math.abs(e.clientX - drag.startX) < DRAG_THRESHOLD) return;
      drag.active = true;
      drag.startX = e.clientX;           // без скачка на величину порога
      drag.startScroll = getScrollY();
      if (els.panorama) {
        els.panorama.classList.add('is-dragging');
        try { els.panorama.setPointerCapture(e.pointerId); } catch (err) { /* нет поддержки */ }
      }
      drag.prevUserSelect = body.style.userSelect;
      body.style.userSelect = 'none';
      try { var sel = window.getSelection && window.getSelection(); if (sel) sel.removeAllRanges(); } catch (err) { /* ничего */ }
    }
    e.preventDefault();
    var y = drag.startScroll - (e.clientX - drag.startX) * DRAG_FACTOR;
    scrollWindowTo(y, false);
    state.scrollY = getScrollY();
    wake();

    var t = now();
    drag.samples.push({ t: t, y: state.scrollY });
    while (drag.samples.length > 2 && t - drag.samples[0].t > 120) drag.samples.shift();
  }

  function dragVelocity() {
    var t = now();
    drag.samples.push({ t: t, y: getScrollY() });
    var recent = drag.samples.filter(function (s) { return t - s.t <= 100; });
    if (recent.length < 2) return 0;
    var first = recent[0];
    var last = recent[recent.length - 1];
    var dt = last.t - first.t;
    return dt > 0 ? (last.y - first.y) / dt : 0; // px/мс
  }

  function onPointerUp(e) {
    if (e.pointerId !== drag.id) return;
    var wasDrag = drag.active;
    var v = wasDrag ? dragVelocity() : 0;
    endDrag();
    if (wasDrag) {
      suppressNextClick();
      if (!state.reduced && Math.abs(v) > 0.05) startInertia(v);
    }
  }

  function onPointerCancel(e) {
    if (e.pointerId !== drag.id) return;
    endDrag();
  }

  function endDrag() {
    if (drag.id === null) return;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    if (els.panorama) {
      try { if (els.panorama.hasPointerCapture && els.panorama.hasPointerCapture(drag.id)) els.panorama.releasePointerCapture(drag.id); } catch (err) { /* ничего */ }
      els.panorama.classList.remove('is-dragging');
    }
    if (drag.active) body.style.userSelect = drag.prevUserSelect || '';
    drag.id = null;
    drag.active = false;
    drag.samples = [];
  }

  /* После реального drag гасим последующий click (он придёт сразу после pointerup) */
  function suppressNextClick() {
    var timer = 0;
    function handler(ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
      cleanup();
    }
    function cleanup() {
      window.removeEventListener('click', handler, true);
      clearTimeout(timer);
    }
    window.addEventListener('click', handler, true);
    timer = setTimeout(cleanup, 60);
  }

  function startInertia(v) {
    stopInertia();
    inertia.v = v;
    inertia.pos = getScrollY();
    inertia.last = now();
    inertia.raf = requestAnimationFrame(stepInertia);
  }

  function stepInertia(time) {
    inertia.raf = 0;
    if (state.mode !== 'desktop') return;
    var dt = Math.min(64, Math.max(1, time - inertia.last));
    inertia.last = time;
    inertia.v *= Math.pow(INERTIA_DECAY, dt / 16.667);
    if (Math.abs(inertia.v) < INERTIA_MIN) return;

    var min = state.panoTop;
    var max = state.panoTop + maxShift();
    inertia.pos += inertia.v * dt;
    if (inertia.pos <= min || inertia.pos >= max) {
      scrollWindowTo(clamp(inertia.pos, min, max), false);
      return;
    }
    scrollWindowTo(inertia.pos, false);
    inertia.raf = requestAnimationFrame(stepInertia);
  }

  function stopInertia() {
    if (inertia.raf) cancelAnimationFrame(inertia.raf);
    inertia.raf = 0;
    inertia.v = 0;
  }

  /* ================= Фокус внутри панорамы ================= */
  function focusEl(el) {
    if (!el || !el.focus) return;
    state.programmaticFocus = true;
    try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) { /* ничего */ } }
    state.programmaticFocus = false;
  }

  /* Tab по капсулам: браузер пытается прокрутить overflow:hidden-контейнеры — сбрасываем и едем к сцене */
  function onTrackFocus(e) {
    if (state.mode !== 'desktop' || state.programmaticFocus || !els.track) return;
    if (!els.track.contains(e.target)) return;
    if (els.sticky) { els.sticky.scrollLeft = 0; els.sticky.scrollTop = 0; }
    var scene = closest(e.target, '.scene');
    var idx = scenes.indexOf(scene);
    if (idx >= 0 && idx !== currentSceneIndex()) goToScene(idx, true);
  }

  function onAnyElementScroll(e) {
    if (state.mode !== 'desktop') return;
    var t = e.target;
    if (!t || t === doc || !t.classList) return;
    if (t === els.sticky || t === els.track || t.classList.contains('scene') || t.classList.contains('stage')) {
      if (t.scrollLeft) t.scrollLeft = 0;
      if (t.scrollTop) t.scrollTop = 0;
    }
  }

  function onFocusIn(e) {
    if (drawerState.open && els.drawer && !els.drawer.contains(e.target)) {
      focusDrawer();
      return;
    }
    onTrackFocus(e);
  }

  /* ================= Ящик ================= */
  var drawerState = {
    open: false,
    closing: false,
    panel: null,
    homeParent: null,
    homeNext: null,
    opener: null,
    openedByKeyboard: false,
    restoreFocus: true,
    closeTimer: 0,
    endHandler: null,
    switchTimer: 0,
    prevHash: ''
  };
  var resetLamp = noop;
  var resetShelves = noop;

  function isSafeName(name) { return typeof name === 'string' && /^[\w-]+$/.test(name); }

  function findPanel(name) {
    if (!name) return null;
    var list = $$('article[data-panel]');
    for (var i = 0; i < list.length; i++) {
      if (list[i].getAttribute('data-panel') === name) return list[i];
    }
    return null;
  }

  function panelTitle(panel) {
    var t = panel.getAttribute('data-title');
    if (t) return t;
    var h = $('.panel__title', panel) || $('h2, h3', panel);
    return h ? h.textContent.trim() : '';
  }

  function mountPanel(panel) {
    drawerState.panel = panel;
    drawerState.homeParent = panel.parentNode;
    drawerState.homeNext = panel.nextSibling;
    els.drawerBody.appendChild(panel);
    if (els.drawerTitle) els.drawerTitle.textContent = panelTitle(panel);
    resetAccordions(panel);
    watchNote(panel);
    setupDrawerScrollReveal(panel);
    els.drawerBody.scrollTop = 0;
    /* Ещё раз после отрисовки: при смене панели браузер успевает восстановить прокрутку */
    requestAnimationFrame(function () {
      if (drawerState.panel === panel) els.drawerBody.scrollTop = 0;
    });
  }

  /* Аккордеоны в панели: первый раскрыт, остальные закрыты — подсказка, что их можно раскрывать */
  function resetAccordions(panel) {
    var list = $$('details', panel);
    for (var i = 0; i < list.length; i++) {
      if (i === 0) list[i].setAttribute('open', '');
      else list[i].removeAttribute('open');
    }
  }

  /* Каретка у подписи про Claude запускается, когда подпись реально попала в поле зрения */
  var noteObserver = null;
  function watchNote(panel) {
    if (noteObserver) { noteObserver.disconnect(); noteObserver = null; }
    var note = $('.panel__note', panel);
    if (!note || !els.drawerBody) return;
    note.classList.remove('is-typing');
    if (typeof IntersectionObserver !== 'function') { note.classList.add('is-typing'); return; }
    noteObserver = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) {
          note.classList.add('is-typing');
          noteObserver.disconnect();
          noteObserver = null;
          return;
        }
      }
    }, { root: els.drawerBody, threshold: .6 });
    noteObserver.observe(note);
  }

  /* Цифры в «Обо мне» (E18): каскадный счёт от 0 с плавным замедлением и финальным акцентом */
  var statTimers = [];
  var statRafs = [];
  var classicStatsObserver = null;

  function formatCount(n) {
    var s = String(n);
    return s.length > 3 ? s.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0') : s;
  }

  function stopStatsAnimation(container) {
    while (statTimers.length) clearTimeout(statTimers.pop());
    while (statRafs.length) cancelAnimationFrame(statRafs.pop());
    if (!container) return;
    $$('.stat__num', container).forEach(function (el) {
      var orig = el.getAttribute('data-stat-orig');
      if (orig) el.textContent = orig;
      el.classList.remove('is-settled');
      el.removeAttribute('data-counted');
    });
  }

  function animateStats(container, baseDelayMs) {
    if (!container) return;
    var nums = $$('.stat__num', container);
    if (!nums.length) return;

    nums.forEach(function (el) {
      if (!el.getAttribute('data-stat-orig')) {
        el.setAttribute('data-stat-orig', (el.textContent || '').trim());
      }
      el.classList.remove('is-settled');
    });

    if (state.reduced) {
      nums.forEach(function (el) {
        el.textContent = el.getAttribute('data-stat-orig') || el.textContent;
      });
      return;
    }

    var startDelay = typeof baseDelayMs === 'number' ? Math.max(0, baseDelayMs) : 0;

    nums.forEach(function (el, idx) {
      if (el.getAttribute('data-counted') === '1') return;
      var orig = el.getAttribute('data-stat-orig') || (el.textContent || '').trim();
      var digits = orig.replace(/[^\d]/g, '');
      if (!digits) return;
      var to = parseInt(digits, 10);
      var suffix = orig.replace(/[\d\s\u00A0]/g, '');
      el.setAttribute('data-counted', '1');
      el.textContent = '0' + suffix;

      var duration = to < 20 ? 950 : 1200;
      var delay = startDelay + idx * 110;

      var timer = setTimeout(function () {
        var started = 0;
        function step(ts) {
          if (!started) started = ts;
          var p = Math.min(1, (ts - started) / duration);
          var eased = 1 - Math.pow(1 - p, 4);
          el.textContent = formatCount(Math.round(to * eased)) + suffix;
          if (p < 1) {
            statRafs.push(requestAnimationFrame(step));
          } else {
            el.textContent = orig;
            el.classList.add('is-settled');
          }
        }
        statRafs.push(requestAnimationFrame(step));
      }, delay);
      statTimers.push(timer);
    });
  }

  function watchClassicStats() {
    if (classicStatsObserver) {
      classicStatsObserver.disconnect();
      classicStatsObserver = null;
    }
    if (state.mode !== 'classic' || state.reduced) return;
    var aboutHead = $('.library .about-head');
    if (!aboutHead) return;
    if (typeof IntersectionObserver !== 'function') {
      animateStats(aboutHead, 120);
      return;
    }
    classicStatsObserver = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) {
          animateStats(aboutHead, 80);
          classicStatsObserver.disconnect();
          classicStatsObserver = null;
          return;
        }
      }
    }, { threshold: 0.3 });
    classicStatsObserver.observe(aboutHead);
  }

  function unmountPanel() {
    disconnectDrawerObserver();
    var panel = drawerState.panel;
    if (!panel) return;
    if (panel.getAttribute('data-panel') === 'about') stopStatsAnimation(panel);
    var parent = (drawerState.homeParent && doc.contains(drawerState.homeParent)) ? drawerState.homeParent : els.library;
    if (parent) {
      var next = (drawerState.homeNext && drawerState.homeNext.parentNode === parent) ? drawerState.homeNext : null;
      parent.insertBefore(panel, next);
    }
    drawerState.panel = null;
    drawerState.homeParent = null;
    drawerState.homeNext = null;
  }

  function focusDrawer() {
    if (els.drawerPanel) focusEl(els.drawerPanel);
  }

  function setPanelHash(name) {
    replaceHash('#panel-' + name);
  }

  function computeStageZoomVars(sc, name, fx, fy, panelScale) {
    var vw = window.innerWidth || doc.documentElement.clientWidth || 1280;
    var vh = window.innerHeight || doc.documentElement.clientHeight || 800;
    var drawerW = clamp(0.46 * vw, 420, 760);
    var leftW = Math.max(200, vw - drawerW);
    var stageEl = $('.stage', sc);
    var hasZoomClass = !!(stageEl && stageEl.classList.contains('stage--zoom'));
    var stageW = Math.max(vw, vh * 16 / 9);
    var stageH = stageW * 9 / 16;
    var S = (hasZoomClass ? 1.05 : 1.0) * panelScale;
    var fxPct = clamp((parseFloat(fx) || 50) / 100, 0, 1);
    var fyPct = clamp((parseFloat(fy) || 50) / 100, 0, 1);
    var ox = fxPct * stageW;
    var oy = fyPct * stageH;

    var vxTarget = (name === 'services') ? (0.48 * leftW) : (0.5 * leftW);
    var vyTarget = (name === 'services') ? (0.56 * vh) : (0.5 * vh);

    var tx = vxTarget - 0.5 * vw - ox;
    var ty = vyTarget - (vh - stageH) - oy;

    var txMin = 0.5 * vw - leftW - S * stageW + ox * (S - 1);
    var txMax = ox * (S - 1) - 0.5 * vw;
    var tyMin = (1 - S) * (stageH - oy);
    var tyMax = stageH - vh + oy * (S - 1) - (hasZoomClass ? 0.025 * S * stageH : 0);

    if (txMin <= txMax) tx = clamp(tx, txMin, txMax);
    if (tyMin <= tyMax) ty = clamp(ty, tyMin, tyMax);

    return {
      s: S.toFixed(4),
      tx: Math.round(tx) + 'px',
      ty: Math.round(ty) + 'px'
    };
  }

  function setSceneZoom(name, opener) {
    scenes.forEach(function (sc) {
      sc.classList.remove('is-zoomed');
      sc.removeAttribute('data-zoom-panel');
      sc.style.removeProperty('--focus-x');
      sc.style.removeProperty('--focus-y');
      sc.style.removeProperty('--panel-zoom-scale');
      sc.style.removeProperty('--panel-zoom-shift-x');
      sc.style.removeProperty('--panel-zoom-shift-y');
      sc.style.removeProperty('--zoom-s');
      sc.style.removeProperty('--zoom-tx');
      sc.style.removeProperty('--zoom-ty');
    });
    var sceneTrigger = name ? ($('.scene .hotspot[data-open="' + name + '"]') || $('.scene [data-open="' + name + '"]')) : null;
    var trigger = (opener && closest(opener, '.scene')) ? opener : (sceneTrigger || opener);
    var sc = trigger ? closest(trigger, '.scene') : scenes[Math.max(0, state.active)];
    if (!sc) return;
    var fx = (trigger && trigger.getAttribute('data-zoom-x')) || (trigger && trigger.style && trigger.style.getPropertyValue('--x')) || '50%';
    var fy = (trigger && trigger.getAttribute('data-zoom-y')) || (trigger && trigger.style && trigger.style.getPropertyValue('--y')) || '50%';
    var pScale = (trigger && parseFloat(trigger.getAttribute('data-zoom-scale'))) || 1.38;
    sc.style.setProperty('--focus-x', fx);
    sc.style.setProperty('--focus-y', fy);
    sc.style.setProperty('--panel-zoom-scale', String(pScale));
    var zVars = computeStageZoomVars(sc, name, fx, fy, pScale);
    sc.style.setProperty('--zoom-s', zVars.s);
    sc.style.setProperty('--zoom-tx', zVars.tx);
    sc.style.setProperty('--zoom-ty', zVars.ty);
    if (name) sc.setAttribute('data-zoom-panel', name);
    sc.classList.add('is-zoomed');
  }

  function clearSceneZoom() {
    scenes.forEach(function (sc) {
      sc.classList.remove('is-zoomed');
      sc.removeAttribute('data-zoom-panel');
      sc.style.removeProperty('--focus-x');
      sc.style.removeProperty('--focus-y');
      sc.style.removeProperty('--panel-zoom-scale');
      sc.style.removeProperty('--panel-zoom-shift-x');
      sc.style.removeProperty('--panel-zoom-shift-y');
      sc.style.removeProperty('--zoom-s');
      sc.style.removeProperty('--zoom-tx');
      sc.style.removeProperty('--zoom-ty');
    });
  }

  function openPanel(name, opener) {
    if (!isSafeName(name)) return false;
    var panel = findPanel(name);
    if (!panel) return false;

    if (state.mode === 'classic') {
      scrollToElement(panel, true);
      return true;
    }
    if (!els.drawer || !els.drawerBody) return false;

    cancelPendingOpen();
    endDrag();
    stopInertia();

    // если ящик ещё доезжает при закрытии — завершаем закрытие сразу
    if (drawerState.closing) {
      drawerState.restoreFocus = false;
      finishClose();
    }

    if (drawerState.open) {
      if (drawerState.panel === panel) {
        resetAccordions(panel);
        els.drawerBody.scrollTop = 0;
        focusDrawer();
        return true;
      }
      var targetIdx = sceneIndexForPanel(name);
      if (targetIdx >= 0 && targetIdx !== currentSceneIndex()) {
        jumpToScene(targetIdx);
        updateNavActive();
      }
      setSceneZoom(name, opener);
      switchPanel(panel, name);
      return true;
    }

    // первое открытие
    drawerState.opener = opener || (doc.activeElement !== body ? doc.activeElement : null);
    drawerState.openedByKeyboard = !!(opener && isFocusVisible(opener));
    var hash = location.hash || '';
    drawerState.prevHash = /^#panel-/.test(hash) ? '' : hash;

    resetLamp();
    resetShelves();
    setSceneZoom(name, opener);
    updateVideos();
    mountPanel(panel);
    els.drawer.hidden = false;
    body.classList.add('is-drawer-open');
    drawerState.open = true;
    void els.drawer.offsetWidth; // зафиксировать стартовое состояние для transition
    requestAnimationFrame(function () {
      if (!drawerState.open) return;
      els.drawer.classList.add('is-open');
      if (els.drawerPanel && !els.drawerPanel.contains(doc.activeElement)) focusDrawer();
    });
    focusDrawer();
    setPanelHash(name);
    return true;
  }

  function switchPanel(panel, name) {
    clearTimeout(drawerState.switchTimer);
    function swap() {
      drawerState.switchTimer = 0;
      if (!drawerState.open) return;
      unmountPanel();
      mountPanel(panel);
      els.drawerBody.classList.remove('is-switching');
      focusDrawer();
      setPanelHash(name);
    }
    if (state.reduced) { swap(); return; }
    els.drawerBody.classList.add('is-switching');
    drawerState.switchTimer = setTimeout(swap, SWITCH_TIME);
  }

  function closeDrawer(opts) {
    opts = opts || {};
    if (!drawerState.open) {
      if (drawerState.closing && opts.immediate) finishClose();
      return;
    }
    drawerState.open = false;
    drawerState.closing = true;
    drawerState.restoreFocus = opts.restoreFocus === true || (opts.restoreFocus !== false && drawerState.openedByKeyboard);

    clearTimeout(drawerState.switchTimer);
    drawerState.switchTimer = 0;
    if (els.drawerBody) els.drawerBody.classList.remove('is-switching');
    if (els.drawer) els.drawer.classList.remove('is-open');
    clearSceneZoom();
    resetLamp();
    resetShelves();
    body.classList.remove('is-drawer-open');
    updateVideos();
    replaceHash(drawerState.prevHash || '');

    if (opts.immediate || state.reduced || !els.drawer) { finishClose(); return; }

    drawerState.endHandler = function (e) {
      if (e.target === els.drawer || e.target === els.drawerPanel) finishClose();
    };
    els.drawer.addEventListener('transitionend', drawerState.endHandler);
    drawerState.closeTimer = setTimeout(finishClose, DRAWER_FALLBACK);
  }

  function finishClose() {
    if (!drawerState.closing) return;
    drawerState.closing = false;
    clearTimeout(drawerState.closeTimer);
    drawerState.closeTimer = 0;
    if (drawerState.endHandler && els.drawer) els.drawer.removeEventListener('transitionend', drawerState.endHandler);
    drawerState.endHandler = null;

    clearSceneZoom();
    resetLamp();
    resetShelves();
    if (els.drawer) els.drawer.hidden = true;
    unmountPanel();
    if (els.drawerTitle) els.drawerTitle.textContent = '';

    var opener = drawerState.opener;
    drawerState.opener = null;
    drawerState.openedByKeyboard = false;
    if (drawerState.restoreFocus && opener && doc.contains(opener) && isRendered(opener)) {
      focusEl(opener);
    } else if (doc.activeElement && doc.activeElement !== body && doc.activeElement.blur) {
      try { doc.activeElement.blur(); } catch (e) {}
    }
  }

  /* Ловушка фокуса: Tab / Shift+Tab циклятся внутри ящика */
  function getFocusable(container) {
    return $$(FOCUSABLE, container).filter(function (el) {
      return isRendered(el) && !closest(el, '[hidden]');
    });
  }

  function trapTab(e) {
    if (!els.drawerPanel) return;
    var list = getFocusable(els.drawerPanel);
    if (!list.length) { e.preventDefault(); focusDrawer(); return; }
    var first = list[0];
    var last = list[list.length - 1];
    var active = doc.activeElement;
    var inside = els.drawerPanel.contains(active);
    if (e.shiftKey) {
      if (!inside || active === first || active === els.drawerPanel) { e.preventDefault(); focusEl(last); }
    } else if (!inside || active === last) {
      e.preventDefault();
      focusEl(first);
    }
  }

  /* Колесо/тач по фону ящика не должны двигать панораму */
  function onDrawerWheel(e) {
    if (!els.drawerBody || !els.drawerBody.contains(e.target)) e.preventDefault();
  }

  /* ================= Классический режим: прокрутка к панели ================= */
  function scrollToElement(el, smooth) {
    if (!el) return;
    try {
      el.scrollIntoView({ behavior: smooth && !state.reduced ? 'smooth' : 'instant', block: 'start' });
    } catch (e) {
      el.scrollIntoView(true);
    }
  }

  function handleClassicClick(e, el, openName) {
    if (el.classList.contains('topbar__brand')) {
      e.preventDefault();
      scrollWindowTo(0, !state.reduced);
      return;
    }
    var target = isSafeName(openName) ? findPanel(openName) : null;
    if (!target) {
      var href = el.getAttribute('href') || '';
      if (href.charAt(0) === '#' && href.length > 1) {
        try { target = doc.getElementById(decodeURIComponent(href.slice(1))); } catch (err) { target = null; }
      }
    }
    e.preventDefault();
    if (target && isRendered(target)) scrollToElement(target, true);
  }

  /* ================= Делегирование кликов ================= */
  function onDocumentClick(e) {
    if (e.defaultPrevented || e.button !== 0) return;
    var t = e.target;
    if (!t || !t.closest) return;

    var extLink = t.closest('a[target="_blank"], .case__link');
    if (extLink && e.detail > 0 && extLink.blur) {
      setTimeout(function () {
        if (doc.activeElement === extLink) {
          try { extLink.blur(); } catch (err) {}
        }
      }, 0);
    }

    var copyBtn = t.closest('[data-copy]');
    if (copyBtn) { e.preventDefault(); copyFromButton(copyBtn); return; }

    if (t.closest('[data-drawer-close]')) { e.preventDefault(); closeDrawer({ restoreFocus: e.detail === 0 }); return; }

    if (t.closest('[data-view-toggle]')) {
      e.preventDefault();
      setClassic(!state.classic, { persist: true });
      return;
    }

    var el = t.closest('[data-goto], [data-open]');
    if (!el) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // открыть в новой вкладке и т.п.

    var gotoAttr = el.getAttribute('data-goto');
    var openName = el.getAttribute('data-open');

    if (state.mode === 'classic') { handleClassicClick(e, el, openName); return; }

    e.preventDefault();
    state.interacted = true;
    if (navLinks.indexOf(el) !== -1) state.lastNavLink = el;

    if (gotoAttr !== null && gotoAttr !== '' && !isNaN(parseInt(gotoAttr, 10))) {
      var index = clamp(parseInt(gotoAttr, 10) - 1, 0, sceneCount - 1);
      if (drawerState.open && !openName) closeDrawer({ restoreFocus: false });
      if (drawerState.open && openName) {
        // ящик открыт — сразу меняем панель, сцену под ним выставляем мгновенно
        openPanel(openName, el);
        jumpToScene(index);
        updateNavActive();
        return;
      }
      goToScene(index, true);
      updateNavActive();
      if (openName) openAfterArrival(index, openName, el);
      return;
    }

    if (openName) openPanel(openName, el);
  }

  /* ================= Копирование почты ================= */
  function legacyCopy(text, origin) {
    var host = closest(origin, '.drawer__panel') || body;
    var ta = doc.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.setAttribute('aria-hidden', 'true');
    ta.tabIndex = -1;
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;pointer-events:none;';
    host.appendChild(ta);
    var prev = doc.activeElement;
    var ok = false;
    try {
      focusEl(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      ok = doc.execCommand('copy');
    } catch (e) {
      ok = false;
    }
    if (ta.parentNode) ta.parentNode.removeChild(ta);
    if (prev && prev !== body) focusEl(prev);
    return !!ok;
  }

  function copyText(text, origin) {
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext !== false) {
      return navigator.clipboard.writeText(text).catch(function () {
        if (legacyCopy(text, origin)) return undefined;
        throw new Error('copy failed');
      });
    }
    return legacyCopy(text, origin) ? Promise.resolve() : Promise.reject(new Error('copy failed'));
  }

  function copyFromButton(btn) {
    var text = (btn.getAttribute('data-copy') || '').trim();
    if (!text) return;
    copyText(text, btn).then(function () {
      showToast('Email скопирован');
      flashCopied(btn);
    }, function () {
      showToast('Не удалось скопировать — адрес: ' + text);
    });
  }

  /* Кнопка на мгновение превращается в «Скопировано ✓» и возвращается обратно */
  function flashCopied(btn) {
    if (!btn) return;
    if (btn.__copyTimer) clearTimeout(btn.__copyTimer);
    if (btn.__copyOrig == null) btn.__copyOrig = btn.innerHTML;
    btn.classList.add('is-copied');
    btn.textContent = 'Скопировано ✓';
    btn.__copyTimer = setTimeout(function () {
      btn.classList.remove('is-copied');
      btn.innerHTML = btn.__copyOrig;
      btn.__copyTimer = 0;
    }, 1600);
  }

  var toastTimer = 0;
  function showToast(message) {
    if (!els.toast) return;
    clearTimeout(toastTimer);
    els.toast.textContent = message;
    els.toast.classList.add('is-visible');
    toastTimer = setTimeout(function () {
      els.toast.classList.remove('is-visible');
    }, TOAST_TIME);
  }

  /* ================= Видео сцены 1 ================= */
  var videoSources = typeof WeakMap === 'function' ? new WeakMap() : null;

  function videoAllowed() { return !state.reduced && !saveData; }

  function shouldPlayVideo() {
    return videoAllowed() && state.mode !== 'classic' && !doc.hidden && !drawerState.open && Math.max(0, state.active) < 2;
  }

  /* Если видео запрещено (reduced-motion / экономия трафика) — снимаем источники, чтобы не качать 3 МБ */
  function detachSources(v) {
    if (!videoSources || videoSources.has(v)) return;
    var saved = { src: v.getAttribute('src'), sources: [] };
    $$('source', v).forEach(function (s) {
      saved.sources.push({ el: s, src: s.getAttribute('src') });
      s.removeAttribute('src');
    });
    if (saved.src) v.removeAttribute('src');
    videoSources.set(v, saved);
    try { v.load(); } catch (e) { /* ничего */ }
  }

  function attachSources(v) {
    if (!videoSources || !videoSources.has(v)) return;
    var saved = videoSources.get(v);
    videoSources.delete(v);
    saved.sources.forEach(function (item) { if (item.src) item.el.setAttribute('src', item.src); });
    if (saved.src) v.setAttribute('src', saved.src);
    try { v.load(); } catch (e) { /* ничего */ }
  }

  function updateVideos() {
    if (!videos.length) return;
    var allowed = videoAllowed();
    var play = shouldPlayVideo();
    videos.forEach(function (v) {
      if (!allowed) {
        v.classList.remove('is-ready');
        if (!v.paused) v.pause();
        detachSources(v);
        return;
      }
      attachSources(v);
      if (play) {
        if (v.paused) {
          var p = v.play();
          if (p && p.catch) p.catch(noop);
        }
      } else if (!v.paused) {
        v.pause();
      }
    });
  }

  function setupVideos() {
    videos.forEach(function (v) {
      v.muted = true;
      v.playsInline = true;
      v.setAttribute('playsinline', '');
      function markReady() {
        if (videoAllowed() && v.readyState >= 2) v.classList.add('is-ready');
      }
      v.addEventListener('canplay', markReady);
      v.addEventListener('playing', markReady);
    });
  }

  /* ================= Лампа сцены 2 ================= */
  function initLamp() {
    var scene2 = $('.scene--2');
    if (!scene2) return;
    var hovered = [];
    var focused = false;

    function update() {
      var on = !drawerState.open && (hovered.length > 0 || focused);
      scene2.classList.toggle('is-lamp-on', on);
    }
    function reset() {
      hovered.length = 0;
      focused = false;
      scene2.classList.remove('is-lamp-on');
    }
    resetLamp = reset;

    function enter(el) {
      if (drawerState.open) return;
      if (hovered.indexOf(el) === -1) hovered.push(el);
      update();
    }
    function leave(el) {
      var i = hovered.indexOf(el);
      if (i !== -1) hovered.splice(i, 1);
      update();
    }

    $$('.desk-zone, [data-desk-zone], .hotspot', scene2).forEach(function (el) {
      el.addEventListener('mouseenter', function () { enter(el); });
      el.addEventListener('mouseleave', function () { leave(el); });
    });
    scene2.addEventListener('mouseleave', reset);
    window.addEventListener('blur', reset);

    scene2.addEventListener('focusin', function (e) {
      var hs = closest(e.target, '.hotspot');
      if (hs && !state.programmaticFocus && isFocusVisible(hs)) {
        focused = true;
        update();
      }
    });
    scene2.addEventListener('focusout', function (e) {
      var next = e.relatedTarget;
      var hs = next && scene2.contains(next) ? closest(next, '.hotspot') : null;
      focused = !!(hs && isFocusVisible(hs));
      update();
    });
  }

  /* ================= Подсветка полок сцены 3 ================= */
  function initShelves() {
    var zones = $$('.hl-zone[data-zone]');
    if (!zones.length) return;
    var resetters = [];
    $$('.hotspot[data-zone-target]').forEach(function (btn) {
      var name = btn.getAttribute('data-zone-target');
      var mine = zones.filter(function (z) { return z.getAttribute('data-zone') === name; });
      if (!mine.length) return;
      var hover = false;
      var focus = false;
      function update() {
        var on = !drawerState.open && (hover || focus);
        mine.forEach(function (z) { z.classList.toggle('is-lit', on); });
      }
      function reset() {
        hover = false;
        focus = false;
        mine.forEach(function (z) { z.classList.remove('is-lit'); });
      }
      resetters.push(reset);
      btn.addEventListener('mouseenter', function () { if (!drawerState.open) { hover = true; update(); } });
      btn.addEventListener('mouseleave', function () { hover = false; update(); });
      btn.addEventListener('focus', function () { if (!state.programmaticFocus && isFocusVisible(btn)) { focus = true; update(); } });
      btn.addEventListener('blur', function () { focus = false; update(); });
    });
    resetShelves = function () {
      resetters.forEach(function (fn) { fn(); });
    };
  }

  
/* ================= Пословный вход заголовка (A1) ================= */
function collectTextNodes(node, out) {
  if (!node) return;
  if (node.nodeType === 3) { out.push(node); return; }
  for (var c = node.firstChild; c; c = c.nextSibling) collectTextNodes(c, out);
}

function splitHeadlineWords() {
  $$('.hero-title, .classic-intro__title').forEach(function (el) {
    if (el.__words) return;
    el.__words = true;
    var i = 0;
    var textNodes = [];
    collectTextNodes(el, textNodes);
    textNodes.forEach(function (node) {
      var parent = node.parentNode;
      if (!parent) return;
      var parts = (node.nodeValue || '').split(/(\s+)/);
      var frag = doc.createDocumentFragment();
      parts.forEach(function (part) {
        if (part === '') return;
        if (/^\s+$/.test(part)) {
          frag.appendChild(doc.createTextNode(part));
        } else {
          var span = doc.createElement('span');
          span.className = 'hero-word';
          span.textContent = part;
          span.style.setProperty('--i', String(i++));
          frag.appendChild(span);
        }
      });
      parent.replaceChild(frag, node);
    });
  });
}

/* ================= Прогресс чтения и постепенное появление текста в панелях ящика ================= */
var drawerRevealTimers = [];
var aiFlowTimers = [];
var drawerHintDismissed = false;
var activeDrawerPanel = null;
var activeDrawerItems = [];
var scrollRevealRaf = 0;

function clearDrawerTimers() {
  while (drawerRevealTimers.length) clearTimeout(drawerRevealTimers.pop());
  while (aiFlowTimers.length) clearTimeout(aiFlowTimers.pop());
  if (scrollRevealRaf) {
    cancelAnimationFrame(scrollRevealRaf);
    scrollRevealRaf = 0;
  }
}

function disconnectDrawerObserver() {
  clearDrawerTimers();
  activeDrawerPanel = null;
  activeDrawerItems = [];
}

function updateDrawerScrollUi() {
  if (!els.drawerBody || !els.drawerPanel) return;
  var el = els.drawerBody;
  var maxScroll = el.scrollHeight - el.clientHeight;
  var scrollable = maxScroll > 24;
  els.drawerPanel.classList.toggle('is-scrollable', scrollable);
  if (!scrollable) {
    els.drawerPanel.style.setProperty('--read-progress', '0');
    els.drawerPanel.classList.remove('has-more', 'show-hint');
    return;
  }
  var st = el.scrollTop;
  var progress = clamp(st / maxScroll, 0, 1);
  els.drawerPanel.style.setProperty('--read-progress', progress.toFixed(4));
  var atBottom = (maxScroll - st) < 20;
  els.drawerPanel.classList.toggle('has-more', !atBottom);
  if (st > 20) drawerHintDismissed = true;
  els.drawerPanel.classList.toggle('show-hint', !atBottom && !drawerHintDismissed);
}

function triggerAiFlowIgnition(flowEl) {
  if (!flowEl || flowEl.__ignited) return;
  flowEl.__ignited = true;
  var nodes = $$('.ai-flow__node', flowEl);
  nodes.forEach(function (node, idx) {
    node.classList.remove('is-lit');
    node.style.setProperty('--node-i', String(idx));
  });
  if (state.reduced) return;
  flowEl.classList.add('is-active');
}

function collectAccBodyItems(accEl, out) {
  var bodyEl = $('.acc__body', accEl);
  if (!bodyEl) return;
  for (var c = bodyEl.firstElementChild; c; c = c.nextElementSibling) {
    if (c.tagName === 'UL' || c.tagName === 'OL') {
      for (var li = c.firstElementChild; li; li = li.nextElementSibling) {
        if (li.tagName === 'LI') out.push(li);
      }
    } else {
      out.push(c);
    }
  }
}

/* Строгий порядок сверху вниз внутри любой панели:
   заголовок → подзаголовок/лид/тег → текст, пункты списков, карточки, аккордеоны, схема, кнопки */
function collectDrawerItems(panel) {
  var out = [];
  if (!panel) return out;

  function walkChildren(container) {
    for (var el = container.firstElementChild; el; el = el.nextElementSibling) {
      var cls = el.classList;
      if (cls.contains('block')) {
        walkChildren(el);
      } else if (cls.contains('accs')) {
        for (var det = el.firstElementChild; det; det = det.nextElementSibling) {
          if (det.tagName === 'DETAILS') {
            if (det.hasAttribute('open')) {
              var sum = det.querySelector(':scope > summary');
              if (sum) out.push(sum);
              collectAccBodyItems(det, out);
            } else {
              out.push(det);
            }
          } else {
            out.push(det);
          }
        }
      } else if (
        cls.contains('cases') ||
        cls.contains('reviews') ||
        cls.contains('contacts') ||
        cls.contains('facts') ||
        cls.contains('dash')
      ) {
        for (var item = el.firstElementChild; item; item = item.nextElementSibling) {
          out.push(item);
        }
      } else {
        out.push(el);
      }
    }
  }

  walkChildren(panel);
  return out;
}

function scheduleItemReveal(target, delayMs) {
  if (!target || target.dataset.revealScheduled === '1') return;
  target.dataset.revealScheduled = '1';
  var safeDelay = Math.max(0, Math.round(delayMs));
  target.style.setProperty('--item-delay', safeDelay + 'ms');

  var t = setTimeout(function () {
    target.classList.add('is-shown');
    if (target.classList.contains('about-head')) {
      animateStats(target, safeDelay + 120);
    }
    if (target.classList.contains('ai-flow')) {
      var flowTimer = setTimeout(function () {
        triggerAiFlowIgnition(target);
      }, safeDelay + 220);
      aiFlowTimers.push(flowTimer);
    }
    var settleTimer = setTimeout(function () {
      target.style.setProperty('--item-delay', '0ms');
      target.classList.add('is-revealed');
    }, safeDelay + 560);
    drawerRevealTimers.push(settleTimer);
  }, 24);
  drawerRevealTimers.push(t);
}

function evaluateVisibleDrawerItems(isInitialOpen) {
  if (!activeDrawerPanel || !els.drawerBody || !activeDrawerItems.length) return;
  if (state.reduced) {
    activeDrawerItems.forEach(function (el) {
      el.classList.add('is-shown', 'is-revealed');
      if (el.classList.contains('ai-flow')) triggerAiFlowIgnition(el);
    });
    return;
  }

  var bodyRect = els.drawerBody.getBoundingClientRect();
  var viewTop = bodyRect.top - 24;
  var viewBottom = bodyRect.bottom - 12;
  var batchIdx = 0;

  // Сначала выезжает сам ящик, затем строго по очереди: заголовок → подзаголовок → текст
  var baseDelay = isInitialOpen ? 200 : 20;
  var stepDelay = isInitialOpen ? 90 : 75;

  for (var i = 0; i < activeDrawerItems.length; i++) {
    var el = activeDrawerItems[i];
    if (el.dataset.revealScheduled === '1') continue;
    var r = el.getBoundingClientRect();
    if (r.top <= viewBottom && r.bottom >= viewTop) {
      var delay = baseDelay + Math.min(batchIdx, 14) * stepDelay;
      batchIdx++;
      scheduleItemReveal(el, delay);
    }
  }
}

function onDrawerScrollReveal() {
  updateDrawerScrollUi();
  if (!activeDrawerPanel || !activeDrawerItems.length) return;
  if (scrollRevealRaf) return;
  scrollRevealRaf = requestAnimationFrame(function () {
    scrollRevealRaf = 0;
    evaluateVisibleDrawerItems(false);
  });
}

function setupDrawerScrollReveal(panel) {
  disconnectDrawerObserver();
  drawerHintDismissed = false;
  if (!panel || !els.drawerBody) return;

  activeDrawerPanel = panel;

  // Снимаем старые классы со всех узлов панели
  $$('.drawer-item', panel).forEach(function (el) {
    el.classList.remove('drawer-item', 'is-shown', 'is-revealed');
    el.style.removeProperty('--item-delay');
    delete el.dataset.revealScheduled;
  });
  $$('.ai-flow', panel).forEach(function (flowEl) {
    flowEl.__ignited = false;
    flowEl.classList.remove('is-active');
    $$('.ai-flow__node', flowEl).forEach(function (n) { n.classList.remove('is-lit'); });
  });

  var items = collectDrawerItems(panel);
  activeDrawerItems = items;
  if (!items.length) return;

  if (state.reduced) {
    items.forEach(function (el) {
      el.classList.add('is-shown', 'is-revealed');
      if (el.classList.contains('ai-flow')) triggerAiFlowIgnition(el);
    });
    updateDrawerScrollUi();
    return;
  }

  // Прячем все элементы панели синхронно ДО первого кадра отрисовки
  items.forEach(function (el) {
    el.classList.add('drawer-item');
  });

  var wasAlreadyOpen = !!(els.drawer && els.drawer.classList.contains('is-open'));

  requestAnimationFrame(function () {
    updateDrawerScrollUi();
    evaluateVisibleDrawerItems(!wasAlreadyOpen);

    // Повторная проверка, когда выезд панели почти завершён (на случай изменения высоты шрифтов/картинок)
    var tFollow = setTimeout(function () {
      updateDrawerScrollUi();
      evaluateVisibleDrawerItems(false);
    }, 360);
    drawerRevealTimers.push(tFollow);
  });
}
/* ================= Адрес (#scene-N, #panel-name, #classic) ================= */
  function sceneIndexForPanel(name) {
    if (!isSafeName(name)) return -1;
    var el = $('.scene .hotspot[data-open="' + name + '"]') ||
      $('.scene [data-open="' + name + '"]:not([data-goto])') ||
      $('.scene [data-open="' + name + '"]');
    return el ? scenes.indexOf(closest(el, '.scene')) : -1;
  }

  function handleHash(hash, initial) {
    if (!hash || hash === '#') return false;
    if (hash === '#classic') {
      if (!initial) setClassic(true);
      return true;
    }
    var m = /^#scene-(\d+)$/.exec(hash);
    if (m) {
      if (state.mode !== 'classic') {
        if (initial) jumpToScene(parseInt(m[1], 10) - 1);
        else goToScene(parseInt(m[1], 10) - 1, true);
      }
      return true;
    }
    m = /^#panel-([\w-]+)$/.exec(hash);
    if (m) {
      var name = m[1];
      var panel = findPanel(name);
      if (!panel) return false;
      if (state.mode === 'classic') {
        scrollToElement(panel, !initial);
        return true;
      }
      if (drawerState.open && drawerState.panel === panel) return true;
      var idx = sceneIndexForPanel(name);
      var opener = null;
      if (idx >= 0) {
        jumpToScene(idx);
        opener = $('.scene .hotspot[data-open="' + name + '"]');
      }
      openPanel(name, opener);
      return true;
    }
    return false;
  }

  /* ================= Инициализация ================= */
  function onLoad() {
    // браузер восстанавливает прокрутку / прыгает к якорю уже после load — выполняемся следующим тиком
    setTimeout(afterLoad, 0);
  }

  function afterLoad() {
    // шрифты/картинки могли сдвинуть раскладку; если пользователь ещё ничего не трогал — совмещаем без проезда
    if (state.mode === 'classic') return;
    measure();
    if (state.mode === 'desktop') setPanoramaHeight();
    if (!state.interacted) {
      var hash = location.hash;
      if (/^#scene-\d+$/.test(hash)) handleHash(hash, true);
      if (state.mode === 'desktop') syncDesktopImmediately();
      else syncMobile();
    } else {
      relayout();
    }
  }

  function bindEvents() {
    window.addEventListener('scroll', onWindowScroll, { passive: true });
    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('resize', scheduleLayout, { passive: true });
    window.addEventListener('orientationchange', scheduleLayout, { passive: true });
    window.addEventListener('load', onLoad);
    window.addEventListener('pageshow', function (e) { if (e.persisted) { scheduleLayout(); updateVideos(); } });
    window.addEventListener('blur', endDrag);
    window.addEventListener('hashchange', function () { handleHash(location.hash, false); });

    doc.addEventListener('click', onDocumentClick);
    doc.addEventListener('keydown', onKeydown);
    doc.addEventListener('focusin', onFocusIn);
    doc.addEventListener('scroll', onAnyElementScroll, { capture: true, passive: true });
    doc.addEventListener('visibilitychange', updateVideos);

    if (els.panorama) {
      els.panorama.addEventListener('pointerdown', onPointerDown);
      els.panorama.addEventListener('dragstart', function (e) {
        if (state.mode === 'desktop' && e.target && e.target.tagName === 'IMG') e.preventDefault();
      });
    }
    if (els.track) {
      els.track.addEventListener('scroll', onTrackScroll, { passive: true });
      els.track.addEventListener('touchstart', function () {
        state.interacted = true;
        cancelPendingOpen();
      }, { passive: true });
    }
    if (els.drawer) {
      els.drawer.addEventListener('wheel', onDrawerWheel, { passive: false });
    }
    if (els.drawerBody) {
      els.drawerBody.addEventListener('scroll', onDrawerScrollReveal, { passive: true });
      els.drawerBody.addEventListener('toggle', function (ev) {
        var det = ev.target;
        if (det && det.tagName === 'DETAILS' && det.open && activeDrawerPanel) {
          var inner = [];
          collectAccBodyItems(det, inner);
          if (state.reduced) {
            updateDrawerScrollUi();
            return;
          }
          inner.forEach(function (el) {
            el.classList.remove('is-shown', 'is-revealed');
            delete el.dataset.revealScheduled;
            el.classList.add('drawer-item');
            if (activeDrawerItems.indexOf(el) === -1) activeDrawerItems.push(el);
          });
          requestAnimationFrame(function () {
            updateDrawerScrollUi();
            inner.forEach(function (el, idx) {
              scheduleItemReveal(el, 30 + Math.min(idx, 10) * 65);
            });
          });
        } else if (det && det.tagName === 'DETAILS') {
          requestAnimationFrame(updateDrawerScrollUi);
        }
      }, true);
    }
    $$('.drawer__backdrop').forEach(function (bd) {
      bd.addEventListener('wheel', function (e) { e.preventDefault(); }, { passive: false });
      bd.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });
    });

    onMediaChange(mqMobile, scheduleLayout);
    onMediaChange(mqReduced, function (e) {
      state.reduced = !!(e && typeof e.matches === 'boolean' ? e.matches : mqReduced.matches);
      if (state.reduced) {
        stopInertia();
        if (state.mode === 'desktop') { state.target = readTarget(); state.x = state.target; renderDesktop(); }
      }
      updateVideos();
    });
  }

  function finishBoot() {
    var root = doc.documentElement;
    var done = false;
    function reveal() {
      if (done) return;
      done = true;
      requestAnimationFrame(function () {
        root.classList.remove('is-booting');
        root.classList.add('is-ready');
      });
    }
    var safety = setTimeout(reveal, 450);
    if (doc.fonts && typeof doc.fonts.load === 'function' && typeof Promise === 'function') {
      var tasks = [
        doc.fonts.load('500 48px "Cormorant Garamond"', 'Бухгалтерия, которой'),
        doc.fonts.load('italic 500 48px "Cormorant Garamond"', 'доверяют'),
        doc.fonts.load('400 16px "Inter"', 'Меня зовут Марина'),
        doc.fonts.load('500 15px "Inter"', 'Связаться со мной'),
        doc.fonts.ready
      ];
      Promise.all(tasks.map(function (p) {
        return Promise.resolve(p).catch(noop);
      })).then(function () {
        clearTimeout(safety);
        reveal();
      });
    } else {
      clearTimeout(safety);
      reveal();
    }
  }

  function init() {
    doc.documentElement.setAttribute('data-app-ready', '1');
    var hash = location.hash || '';
    state.classic = hash === '#classic' || storageGet() === 'classic';

    setupVideos();
    splitHeadlineWords();
    initLamp();
    initShelves();
    bindEvents();
    applyMode(true);
    handleHash(hash, true);
    updateNavActive();
    finishBoot();
  }

  init();
});
