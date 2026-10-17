(function () {
  "use strict";

  var $ = function (sel) { return document.querySelector(sel); };
  var clamp = function (v, a, b) { return Math.min(b, Math.max(a, v)); };
  var norm = function (s) { return (s || "").replace(/\s+/g, ""); };

  var state = {
    slug: null,
    book: null,
    meta: null,
    toc: [],
    page: 1,
    mode: "single",
    fit: "width",
    zoom: 1,
    scale: 1,
    pageWidthPx: 0,
    pageHeightPx: 0,
    step: 0,
    chunks: new Map(),
    chunkPending: new Map(),
    search: null,
    searchPending: null,
    searchShards: new Map(),
    searchShardPending: new Map(),
    searchLines: new Map(),
    searchLinePending: new Map(),
    searchSeq: 0,
    highlightQuery: "",
    anchor: null,
    selectionInfo: null,
    selectionTimer: 0,
    selectionHideTimer: 0,
    pageEls: new Map(),
    activeToc: -1,
    collapsed: new Set(),
    tocOpen: false,
    searchOpen: false,
    rafScroll: 0,
    lastActiveScroll: 0
  };

  var els = {};
  var programmaticCopy = 0;

  function el(tag, cls, text) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  }

  function toast(msg) {
    var t = els.toast;
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.classList.remove("show"); }, 1800);
  }

  function store(key, value) {
    try { localStorage.setItem("fa3:" + key, value); } catch (e) { /* ignore */ }
  }

  function load(key) {
    try { return localStorage.getItem("fa3:" + key); } catch (e) { return null; }
  }

  function slugFromSrc(src) {
    var map = [
      ["minfa", "minfa"], ["fazhishi", "fazhishi"], ["falixianfa", "falixianfa"],
      ["xingfa", "xingfa"], ["xingsu", "xingsu"], ["xingzheng", "xingzheng"],
      ["sanguo", "sanguo"]
    ];
    var s = String(src || "").toLowerCase();
    for (var i = 0; i < map.length; i++) {
      if (s.indexOf(map[i][0]) >= 0) return map[i][1];
    }
    return null;
  }

  function showError(title, detail) {
    var box = el("div", "error-box");
    box.appendChild(el("h2", null, title));
    var p = el("p", null, detail || "");
    box.appendChild(p);
    var a = el("a", null, "返回书目首页");
    a.href = "./index.html";
    box.appendChild(a);
    els.viewport.innerHTML = "";
    els.viewport.appendChild(box);
    els.loading.classList.add("hidden");
  }

  function imgUrl(p) {
    return "data/" + state.slug + "/pages/" + String(p).padStart(4, "0") + ".webp";
  }

  function chunkIndex(p) {
    return Math.floor((p - 1) / state.meta.chunkSize);
  }

  function chunkUrl(c) {
    return "data/" + state.slug + "/text/chunk-" + String(c).padStart(4, "0") + ".json";
  }

  function ensureChunk(c) {
    if (state.chunks.has(c)) return Promise.resolve(state.chunks.get(c));
    if (state.chunkPending.has(c)) return state.chunkPending.get(c);
    var pr = fetch(chunkUrl(c)).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (data) {
      state.chunks.set(c, data);
      state.chunkPending.delete(c);
      return data;
    }).catch(function (err) {
      state.chunkPending.delete(c);
      throw err;
    });
    state.chunkPending.set(c, pr);
    return pr;
  }

  function ensurePageText(p) {
    var c = chunkIndex(p);
    return ensureChunk(c).then(function (data) {
      for (var i = 0; i < data.pages.length; i++) {
        if (data.pages[i].p === p) return data.pages[i];
      }
      return null;
    }).catch(function () {
      return null;
    });
  }

  function prefetch(p) {
    if (p < 1 || p > state.meta.pages) return;
    var im = new Image();
    im.src = imgUrl(p);
    var c = chunkIndex(p);
    if (!state.chunks.has(c)) ensureChunk(c).catch(function () {});
  }

  function normMap(s) {
    var out = "";
    var map = [];
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (/\s/.test(ch)) continue;
      if (ch >= "A" && ch <= "Z") ch = ch.toLowerCase();
      out += ch;
      map.push(i);
    }
    return { out: out, map: map };
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function markSnippet(line, q) {
    var qn = norm(q);
    if (!qn) return escapeHtml(line);
    var nm = normMap(line);
    var at = nm.out.indexOf(qn);
    if (at < 0) return escapeHtml(line);
    var s = nm.map[at];
    var e = nm.map[at + qn.length - 1] + 1;
    return escapeHtml(line.slice(0, s)) + "<mark>" + escapeHtml(line.slice(s, e)) + "</mark>" +
      escapeHtml(line.slice(e));
  }

  function pageDataOf(p) {
    var c = chunkIndex(p);
    var chunk = state.chunks.get(c);
    if (!chunk) return null;
    for (var i = 0; i < chunk.pages.length; i++) {
      if (chunk.pages[i].p === p) return chunk.pages[i];
    }
    return null;
  }

  function formatCoord(v) {
    return String(Math.round((parseFloat(v) || 0) * 10) / 10);
  }

  function parseSelParam(raw) {
    var m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(String(raw || ""));
    if (!m) return null;
    var a = parseInt(m[1], 10) - 1;
    var b = m[2] ? parseInt(m[2], 10) - 1 : a;
    if (a > b) { var t = a; a = b; b = t; }
    return [a, b];
  }

  function normalizeSel(sel, pd) {
    if (!sel || !pd || !pd.lines || sel.length !== 2) return null;
    var a = sel[0], b = sel[1];
    if (a < 0 || b < 0 || a >= pd.lines.length || b >= pd.lines.length) return null;
    var hasText = false;
    for (var i = a; i <= b; i++) {
      if (pd.lines[i] && pd.lines[i][7] !== "hf" && pd.lines[i][5]) {
        hasText = true;
        break;
      }
    }
    return hasText ? [a, b] : null;
  }

  function anchorForPage(p) {
    return state.anchor && state.anchor.page === p ? state.anchor : null;
  }

  function paintSelection(wrap, pd) {
    var layer = wrap.querySelector(".hl-layer");
    var anchor = anchorForPage(pd.p);
    if (!layer || !anchor || !anchor.sel) return;
    var old = layer.querySelectorAll(".hl.sel");
    for (var k = 0; k < old.length; k++) old[k].remove();
    for (var li = anchor.sel[0]; li <= anchor.sel[1]; li++) {
      var l = pd.lines[li];
      if (!l || l[7] === "hf" || !l[5]) continue;
      var d = el("div", "hl sel");
      d.style.left = (l[0] - 1) + "px";
      d.style.top = (l[1] - 0.5) + "px";
      d.style.width = Math.max(2, l[2] - l[0] + 2) + "px";
      d.style.height = (l[3] - l[1] + 1) + "px";
      layer.appendChild(d);
    }
  }

  function refreshAnchorPaint() {
    state.pageEls.forEach(function (pageEl) {
      if (pageEl._pd) paintHighlights(pageEl, pageEl._pd);
    });
  }

  function paintHighlights(wrap, pd) {
    var layer = wrap.querySelector(".hl-layer");
    if (!layer) return;
    layer.innerHTML = "";
    var q = norm(state.highlightQuery);
    if (q) {
      var count = 0;
      for (var li = 0; li < pd.lines.length && count < 80; li++) {
        var l = pd.lines[li];
        var x0 = l[0], y0 = l[1], y1 = l[3], text = l[5], widths = l[6], flags = l[7];
        if (flags === "hf") continue;
        var nm = normMap(text);
        var at = 0;
        while ((at = nm.out.indexOf(q, at)) >= 0) {
          var s = nm.map[at];
          var e = nm.map[at + q.length - 1] + 1;
          var ox = 0, w = 0, i;
          for (i = 0; i < s; i++) ox += widths[i] || 0;
          for (i = s; i < e; i++) w += widths[i] || 0;
          var d = el("div", "hl");
          d.style.left = (x0 + ox - 1) + "px";
          d.style.top = (y0 - 0.5) + "px";
          d.style.width = Math.max(2, w + 2) + "px";
          d.style.height = (y1 - y0 + 1) + "px";
          layer.appendChild(d);
          count++;
          at += q.length;
          if (count >= 80) break;
        }
      }
    }
    paintSelection(wrap, pd);
  }

  function renderTextLayer(pd, wrap) {
    var tl = wrap.querySelector(".text-layer");
    if (!tl) return;
    var frag = document.createDocumentFragment();
    var items = [];
    for (var i = 0; i < pd.lines.length; i++) {
      var l = pd.lines[i];
      var size = l[4], text = l[5], widths = l[6], baseline = l[8];
      if (!text) continue;
      var span = document.createElement("span");
      span.textContent = text;
      span.style.left = l[0] + "px";
      span.style.top = (baseline - size * 0.88) + "px";
      span.style.fontSize = size + "px";
      span.dataset.i = i;
      span.dataset.p = pd.p;
      frag.appendChild(span);
      var target = 0;
      for (var k = 0; k < widths.length; k++) target += widths[k];
      items.push([span, target]);
    }
    tl.appendChild(frag);
    for (var j = 0; j < items.length; j++) {
      var span2 = items[j][0];
      var natural = span2.offsetWidth;
      if (natural > 0 && items[j][1] > 0) {
        span2.style.transform = "scaleX(" + (items[j][1] / natural) + ")";
      }
    }
    wrap._pd = pd;
    var anchor = anchorForPage(pd.p);
    if (anchor && anchor.sel) {
      var fixed = normalizeSel(anchor.sel, pd);
      if (!fixed) {
        anchor.sel = null;
      } else {
        anchor.sel = fixed;
        if (!(anchor.y > 0.5)) anchor.y = pd.lines[fixed[0]][1] || 0;
      }
      if (state.page === pd.p) syncUrl();
    }
    paintHighlights(wrap, pd);
  }

  function offsetInside(span, pointNode, pointOffset) {
    var r = document.createRange();
    r.selectNodeContents(span);
    try {
      r.setEnd(pointNode, pointOffset);
      return clamp(r.toString().length, 0, span.textContent.length);
    } catch (e) {
      return 0;
    }
  }

  function currentSelectionInfo() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    var range = sel.getRangeAt(0);
    var spans = Array.prototype.slice.call(
      document.querySelectorAll(".page .text-layer span[data-i]")
    );
    var chosen = [];
    for (var i = 0; i < spans.length; i++) {
      if (range.intersectsNode(spans[i])) chosen.push(spans[i]);
    }
    if (!chosen.length) return null;
    chosen.sort(function (a, b) {
      var pa = parseInt(a.dataset.p, 10) || 0;
      var pb = parseInt(b.dataset.p, 10) || 0;
      if (pa !== pb) return pa - pb;
      return (parseInt(a.dataset.i, 10) || 0) - (parseInt(b.dataset.i, 10) || 0);
    });

    var out = "";
    var lastPage = null;
    var lines = [];
    for (var j = 0; j < chosen.length; j++) {
      var span = chosen[j];
      var text = span.textContent || "";
      var start = 0;
      var end = text.length;
      if (span === range.startContainer || span.contains(range.startContainer)) {
        start = offsetInside(span, range.startContainer, range.startOffset);
      }
      if (span === range.endContainer || span.contains(range.endContainer)) {
        end = offsetInside(span, range.endContainer, range.endOffset);
      }
      if (end <= start) continue;
      var page = parseInt(span.dataset.p, 10) || 0;
      var lineNo = parseInt(span.dataset.i, 10) || 0;
      var pageEl = span.closest ? span.closest(".page") : null;
      var pd = pageEl && pageEl._pd;
      var line = pd && pd.lines[lineNo];
      if (!line || line[7] === "hf") continue;
      if (lastPage !== null) out += page !== lastPage ? "\n\n" : "\n";
      var piece = text.slice(start, end);
      out += piece;
      lastPage = page;
      lines.push({ p: page, i: lineNo, y0: line[1] || 0, text: piece });
    }
    if (!lines.length) return null;
    return { text: out, lines: lines };
  }

  function buildPage(p) {
    var wrap = el("div", "page");
    wrap.dataset.page = p;
    wrap.style.width = state.pageWidthPx + "px";
    wrap.style.height = state.pageHeightPx + "px";

    var img = document.createElement("img");
    img.alt = "第 " + p + " 页";
    img.decoding = "async";
    img.draggable = false;
    img.src = imgUrl(p);

    var hl = el("div", "hl-layer");
    var tl = el("div", "text-layer");
    var pw = state.meta.pageW + "px";
    var ph = state.meta.pageH + "px";
    hl.style.width = pw; hl.style.height = ph;
    tl.style.width = pw; tl.style.height = ph;
    hl.style.transform = "scale(" + state.scale + ")";
    tl.style.transform = "scale(" + state.scale + ")";

    var loading = el("div", "page-loading", "加载第 " + p + " 页…");
    img.addEventListener("load", function () { loading.remove(); });
    img.addEventListener("error", function () {
      loading.textContent = "图片加载失败，点此重试";
      loading.style.cursor = "pointer";
      loading.onclick = function () {
        loading.textContent = "重新加载…";
        img.src = imgUrl(p) + "?r=" + Date.now();
      };
    });

    wrap.appendChild(img);
    wrap.appendChild(hl);
    wrap.appendChild(tl);
    wrap.appendChild(loading);

    ensurePageText(p).then(function (pd) {
      if (pd && wrap.isConnected) renderTextLayer(pd, wrap);
    });
    return wrap;
  }

  function computeSizes() {
    var aspect = state.meta.pageH / state.meta.pageW;
    var vw = els.viewport.clientWidth;
    var vh = els.viewport.clientHeight;
    var w;
    if (state.mode === "scroll") {
      w = Math.min(vw - 24, 1100);
    } else if (state.fit === "page") {
      w = Math.min(vw - 32, (vh - 32) / aspect);
    } else {
      w = Math.min(vw - 32, 1100);
    }
    w = Math.max(180, w);
    if (state.fit === "custom" && state.mode === "single") {
      w = Math.max(180, w * state.zoom);
    }
    state.pageWidthPx = Math.round(w);
    state.pageHeightPx = Math.round(w * aspect);
    state.scale = state.pageWidthPx / state.meta.pageW;
    state.step = state.pageHeightPx + 16;
  }

  function renderSingle() {
    els.stage.className = "stage single";
    els.stage.innerHTML = "";
    state.pageEls.clear();
    computeSizes();
    // 放大后页面可能比视口宽；让 stage 跟着变宽，浏览器才能横向滚动到整页。
    els.stage.style.minWidth = (state.pageWidthPx + 36) + "px";
    var pageEl = buildPage(state.page);
    els.stage.appendChild(pageEl);
    state.pageEls.set(state.page, pageEl);
    var anchor = anchorForPage(state.page);
    scrollToCoord(anchor ? anchor.y : 0);
    prefetch(state.page - 1);
    prefetch(state.page + 1);
    prefetch(state.page + 2);
    updateChrome();
  }

  function placeScrollPage(p) {
    var existing = state.pageEls.get(p);
    if (existing) return existing;
    var pageEl = buildPage(p);
    pageEl.style.top = ((p - 1) * state.step + 12) + "px";
    els.stage.appendChild(pageEl);
    state.pageEls.set(p, pageEl);
    return pageEl;
  }

  function updateScrollWindow() {
    var lo = Math.max(1, state.page - 2);
    var hi = Math.min(state.meta.pages, state.page + 3);
    state.pageEls.forEach(function (pageEl, p) {
      if (p < lo - 3 || p > hi + 3) {
        pageEl.remove();
        state.pageEls.delete(p);
      }
    });
    for (var p = lo; p <= hi; p++) placeScrollPage(p);
    prefetch(state.page + 3);
    prefetch(state.page - 3);
  }

  function renderScroll(anchor) {
    els.stage.className = "stage scroll";
    els.stage.innerHTML = "";
    els.stage.style.minWidth = "";
    state.pageEls.clear();
    computeSizes();
    els.stage.style.height = (state.meta.pages * state.step + 24) + "px";
    var top = (state.page - 1) * state.step + 12;
    var anchor = anchorForPage(state.page);
    if (anchor && anchor.y) top += anchor.y * state.scale - 70;
    els.viewport.scrollTop = Math.max(0, top);
    updateScrollWindow();
    updateChrome();
  }

  function scrollToCoord(y) {
    if (!(y > 0)) {
      els.viewport.scrollTop = 0;
      return;
    }
    var lead = Math.min(220, Math.max(20, els.viewport.clientHeight * 0.28));
    els.viewport.scrollTop = Math.max(0, y * state.scale - lead);
  }

  function scrollToPage(p, y) {
    var top = (p - 1) * state.step + 12;
    if (y) top += y * state.scale - 70;
    els.viewport.scrollTop = Math.max(0, top);
  }

  function onScroll() {
    if (state.mode !== "scroll") return;
    if (state.rafScroll) return;
    state.rafScroll = requestAnimationFrame(function () {
      state.rafScroll = 0;
      var top = els.viewport.scrollTop;
      var p = clamp(Math.floor((top - 12) / state.step) + 1, 1, state.meta.pages);
      if (p !== state.page) {
        state.page = p;
        if (state.anchor && state.anchor.page !== p) {
          state.anchor = null;
          refreshAnchorPaint();
        }
        updateChrome();
        setActiveToc();
        saveProgress();
        syncUrl();
      }
      updateScrollWindow();
    });
  }

  function updateChrome() {
    if (document.activeElement !== els.pageInput) els.pageInput.value = state.page;
    els.pageTotal.textContent = state.meta.pages;
    els.btnPrev.disabled = state.page <= 1;
    els.btnNext.disabled = state.page >= state.meta.pages;
    els.bookName.textContent = state.meta.title + (state.meta.partial ? "（样张）" : "");
    document.title = state.meta.title + " · 第 " + state.page + " 页";

    var zl = state.fit === "width" ? "适宽" : state.fit === "page" ? "整页" : Math.round(state.zoom * 100) + "%";
    els.zoomLabel.textContent = zl;
  }

  function saveProgress() {
    store("progress:" + state.slug, state.page);
  }

  function syncUrl() {
    var u = new URL(location.href);
    u.searchParams.set("book", state.slug);
    u.searchParams.set("page", state.page);
    if (state.mode === "scroll") u.searchParams.set("mode", "scroll");
    else u.searchParams.delete("mode");
    var anchor = anchorForPage(state.page);
    if (anchor && anchor.y > 0.5) u.searchParams.set("y", formatCoord(anchor.y));
    else u.searchParams.delete("y");
    if (anchor && anchor.sel) {
      u.searchParams.set("sel", (anchor.sel[0] + 1) + "-" + (anchor.sel[1] + 1));
    } else {
      u.searchParams.delete("sel");
    }
    if (state.highlightQuery) u.searchParams.set("q", state.highlightQuery);
    else u.searchParams.delete("q");
    history.replaceState(null, "", u.pathname + u.search + u.hash);
  }

  function goToPage(p, opts) {
    opts = opts || {};
    p = clamp(parseInt(p, 10) || 1, 1, state.meta.pages);
    state.highlightQuery = opts.q || "";
    var prev = state.page;
    var changed = p !== prev;
    if (opts.anchor !== undefined) state.anchor = opts.anchor;
    else if (opts.clearAnchor || changed) state.anchor = null;
    state.page = p;
    state.selectionInfo = null;
    hideSelectionBar();

    if (state.mode === "single") {
      renderSingle();
      if (opts.y && !anchorForPage(p)) scrollToCoord(opts.y);
    } else {
      if (changed || opts.force) {
        updateScrollWindow();
      }
      scrollToPage(p, opts.y || (anchorForPage(p) ? anchorForPage(p).y : 0));
      updateChrome();
    }
    refreshAnchorPaint();
    setActiveToc();
    saveProgress();
    syncUrl();
  }

  function setMode(mode) {
    if (mode !== "single" && mode !== "scroll") return;
    if (mode === state.mode) return;
    state.mode = mode;
    store("mode", mode);
    var buttons = document.querySelectorAll("#modeSeg button");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].classList.toggle("active", buttons[i].dataset.mode === mode);
    }
    if (mode === "single") renderSingle();
    else renderScroll();
    syncUrl();
  }

  function setFit(fit) {
    state.fit = fit;
    if (fit !== "custom") state.zoom = 1;
    if (state.mode === "single") renderSingle();
    store("fit", fit);
  }

  function zoomBy(delta) {
    if (state.mode !== "single") setMode("single");
    var base = state.fit === "custom" ? state.zoom : 1;
    state.fit = "custom";
    state.zoom = clamp(base + delta, 0.5, 3);
    renderSingle();
    store("fit", "custom");
    store("zoom", state.zoom);
  }

  function toggleToc(force) {
    state.tocOpen = force == null ? !state.tocOpen : !!force;
    document.body.classList.toggle("toc-open", state.tocOpen);
    if (state.tocOpen) {
      hideSelectionBar();
      closeSearch();
      els.backdrop.classList.toggle("show", window.innerWidth < 1000);
      setActiveToc(true);
    } else {
      els.backdrop.classList.remove("show");
    }
  }

  function openSearch() {
    hideSelectionBar();
    state.searchOpen = true;
    els.searchPanel.classList.add("open");
    els.searchInput.focus();
    els.searchInput.select();
    loadSearchIndex();
    closeToc();
  }

  function closeSearch() {
    state.searchOpen = false;
    els.searchPanel.classList.remove("open");
  }

  function closeToc() {
    if (!state.tocOpen) return;
    state.tocOpen = false;
    document.body.classList.remove("toc-open");
    els.backdrop.classList.remove("show");
  }

  function buildTocParents() {
    var l1 = -1, l2 = -1;
    for (var i = 0; i < state.toc.length; i++) {
      var e = state.toc[i];
      if (e.level === 1) { l1 = i; l2 = -1; e._parent = -1; }
      else if (e.level === 2) { e._parent = l1; l2 = i; }
      else { e._parent = l2 >= 0 ? l2 : l1; }
      e._children = [];
    }
    for (var j = 0; j < state.toc.length; j++) {
      var par = state.toc[j]._parent;
      if (par >= 0) state.toc[par]._children.push(j);
    }
  }

  function renderToc() {
    buildTocParents();
    var list = els.tocList;
    list.innerHTML = "";
    var frag = document.createDocumentFragment();
    for (var i = 0; i < state.toc.length; i++) {
      var e = state.toc[i];
      var row = el("div", "toc-item toc-l" + e.level);
      row.dataset.i = i;
      var caret = el("span", "toc-caret" + (e._children.length ? "" : " empty"));
      caret.textContent = e._children.length ? "▾" : "·";
      caret.dataset.caret = "1";
      var title = el("span", "toc-title", e.title);
      var pg = el("span", "toc-page", e.printedPage ? "/" + e.printedPage : "");
      var copy = el("button", "toc-copy", "⧉");
      copy.type = "button";
      copy.dataset.copy = "1";
      copy.title = "复制本节链接";
      copy.setAttribute("aria-label", "复制“" + e.title + "”的链接");
      row.appendChild(caret);
      row.appendChild(title);
      row.appendChild(pg);
      row.appendChild(copy);
      frag.appendChild(row);
    }
    list.appendChild(frag);
    applyCollapse();
  }

  function applyCollapse() {
    var rows = els.tocList.children;
    for (var i = 0; i < rows.length; i++) {
      var idx = parseInt(rows[i].dataset.i, 10);
      var hidden = false;
      var p = state.toc[idx]._parent;
      var guard = 0;
      while (p >= 0 && guard++ < 10) {
        if (state.collapsed.has(p)) { hidden = true; break; }
        p = state.toc[p]._parent;
      }
      rows[i].classList.toggle("hidden", hidden);
      var caret = rows[i].querySelector(".toc-caret");
      if (caret && state.toc[idx]._children.length) {
        caret.textContent = state.collapsed.has(idx) ? "▸" : "▾";
      }
    }
  }

  function setActiveToc(forceScroll) {
    var idx = -1;
    for (var i = 0; i < state.toc.length; i++) {
      if (state.toc[i].page <= state.page) idx = i;
      else break;
    }
    if (idx === state.activeToc && !forceScroll) return;
    state.activeToc = idx;
    var rows = els.tocList.children;
    for (var j = 0; j < rows.length; j++) {
      rows[j].classList.toggle("active", parseInt(rows[j].dataset.i, 10) === idx);
    }
    if (idx >= 0 && state.tocOpen) {
      var row = rows[idx];
      if (row) {
        var box = els.tocList.getBoundingClientRect();
        var rb = row.getBoundingClientRect();
        if (rb.top < box.top + 4 || rb.bottom > box.bottom - 4 || forceScroll) {
          row.scrollIntoView({ block: "center" });
        }
      }
    }
  }

  function filterToc(q) {
    var qn = norm(q);
    var rows = els.tocList.children;
    if (!qn) { applyCollapse(); return; }
    var visible = new Set();
    for (var i = 0; i < state.toc.length; i++) {
      if (norm(state.toc[i].title).indexOf(qn) >= 0) {
        visible.add(i);
        var p = state.toc[i]._parent;
        while (p >= 0) { visible.add(p); p = state.toc[p]._parent; }
      }
    }
    for (var j = 0; j < rows.length; j++) {
      rows[j].classList.toggle("hidden", !visible.has(parseInt(rows[j].dataset.i, 10)));
    }
  }

  function loadSearchIndex() {
    if (state.search) return Promise.resolve(state.search);
    if (state.searchPending) return state.searchPending;
    els.searchMeta.textContent = "正在读取检索索引…";
    state.searchPending = fetch("data/" + state.slug + "/search.json").then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (data) {
      state.search = data;
      state.searchPending = null;
      els.searchMeta.textContent = "";
      return data;
    }).catch(function () {
      state.searchPending = null;
      els.searchMeta.textContent = "全文索引加载失败，请刷新重试。";
      return null;
    });
    return state.searchPending;
  }

  function searchBucket(term) {
    var value = term.charCodeAt(0);
    if (term.length > 1) value = value * 31 + term.charCodeAt(1);
    return value % state.search.buckets;
  }

  function hex3(value) {
    var s = value.toString(16);
    return "000".slice(0, Math.max(0, 3 - s.length)) + s;
  }

  function loadSearchShard(term) {
    var gram = term.length > 1 ? 2 : 1;
    var kind = gram === 2 ? "b" : "u";
    var name = kind + "-" + hex3(searchBucket(term)) + ".json";
    if (state.searchShards.has(name)) return Promise.resolve(state.searchShards.get(name));
    if (state.searchShardPending.has(name)) return state.searchShardPending.get(name);
    var pr = fetch("data/" + state.slug + "/search/" + name).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (data) {
      state.searchShards.set(name, data);
      state.searchShardPending.delete(name);
      return data;
    }).catch(function (err) {
      state.searchShardPending.delete(name);
      throw err;
    });
    state.searchShardPending.set(name, pr);
    return pr;
  }

  function loadSearchLines(group) {
    if (state.searchLines.has(group)) return Promise.resolve(state.searchLines.get(group));
    if (state.searchLinePending.has(group)) return state.searchLinePending.get(group);
    var name = "lines-" + String(group).padStart(4, "0") + ".json";
    var pr = fetch("data/" + state.slug + "/search/" + name).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (data) {
      var byPage = new Map();
      for (var i = 0; i < data.pages.length; i++) byPage.set(data.pages[i].p, data.pages[i].lines);
      state.searchLines.set(group, byPage);
      state.searchLinePending.delete(group);
      return byPage;
    }).catch(function (err) {
      state.searchLinePending.delete(group);
      throw err;
    });
    state.searchLinePending.set(group, pr);
    return pr;
  }

  function searchBody(q, limit) {
    var qn = norm(q);
    if (!qn) return Promise.resolve({ hits: [], totalPages: 0, qn: qn });
    return loadSearchIndex().then(function () {
      var term = qn.slice(0, Math.min(2, qn.length));
      var terms = [term];
      if (qn.length > 2) {
        for (var i = 1; i < qn.length - 1 && terms.length < 8; i++) {
          var gram = qn.slice(i, i + 2);
          if (terms.indexOf(gram) < 0) terms.push(gram);
        }
      }
      return Promise.all(terms.map(loadSearchShard)).then(function (shards) {
        var base = shards[0].t && shards[0].t[terms[0]] ? shards[0].t[terms[0]] : [];
        var sets = [];
        for (var i = 1; i < shards.length; i++) {
          var value = shards[i].t && shards[i].t[terms[i]] ? shards[i].t[terms[i]] : [];
          var set = new Set();
          for (var j = 0; j < value.length; j++) set.add(value[j][0] + ":" + value[j][1]);
          sets.push(set);
        }
        var postings = [];
        for (var k = 0; k < base.length; k++) {
          var key = base[k][0] + ":" + base[k][1];
          var keep = true;
          for (var s = 0; s < sets.length; s++) {
            if (!sets[s].has(key)) { keep = false; break; }
          }
          if (keep) postings.push(base[k]);
        }
        var byPage = new Map();
        for (var n = 0; n < postings.length; n++) {
          var p = postings[n][0];
          var lineNo = postings[n][1];
          if (!byPage.has(p)) byPage.set(p, { page: p, lineNos: [] });
          byPage.get(p).lineNos.push(lineNo);
        }
        var pages = Array.from(byPage.values());
        return {
          qn: qn,
          term: term,
          hits: pages.slice(0, limit || 80),
          totalPages: pages.length,
          postings: postings
        };
      });
    }).catch(function () {
      return { hits: [], totalPages: 0, qn: qn };
    });
  }

  function fillSearchSnippets(hits, qn, seq) {
    var groups = [];
    var byGroup = new Map();
    for (var i = 0; i < hits.length; i++) {
      var group = Math.floor((hits[i].page - 1) / state.search.lineChunkSize);
      if (!byGroup.has(group)) {
        byGroup.set(group, []);
        groups.push(group);
      }
      byGroup.get(group).push(hits[i]);
    }

    var cursor = 0;
    function worker() {
      if (cursor >= groups.length || seq !== state.searchSeq) return Promise.resolve();
      var group = groups[cursor++];
      return loadSearchLines(group).then(function (byPage) {
        if (seq !== state.searchSeq) return;
        var list = byGroup.get(group);
        for (var i = 0; i < list.length; i++) {
          var hit = list[i];
          var pageLines = byPage.get(hit.page) || [];
          var found = null;
          for (var j = 0; j < pageLines.length; j++) {
            if (norm(pageLines[j][1]).indexOf(qn) >= 0) {
              found = pageLines[j][1];
              break;
            }
          }
          if (found) {
            hit.text = found;
            if (hit.textEl) hit.textEl.innerHTML = markSnippet(found.length > 110 ? found.slice(0, 110) + "…" : found, qn);
            if (hit.row) hit.row.classList.remove("hidden");
          } else {
            if (hit.textEl && qn.length <= 2) hit.textEl.textContent = "第 " + hit.page + " 页 · 点击查看";
            if (hit.row && qn.length > 2) hit.row.classList.add("hidden");
          }
        }
      }).catch(function () {
        for (var i = 0; i < byGroup.get(group).length; i++) {
          var hit = byGroup.get(group)[i];
          if (hit.textEl) hit.textEl.textContent = "第 " + hit.page + " 页 · 点击查看";
        }
      }).then(worker);
    }
    var workers = [];
    for (var k = 0; k < Math.min(4, groups.length); k++) workers.push(worker());
    return Promise.all(workers);
  }

  function firstSearchPage(q) {
    var qn = norm(q);
    if (!qn) return Promise.resolve(0);
    return searchBody(qn, 1).then(function (result) {
      if (!result.postings || !result.postings.length) return 0;
      if (qn.length <= 2) return result.postings[0][0];
      var seenGroups = new Set();
      var postings = result.postings;
      function tryAt(index) {
        if (index >= postings.length) return 0;
        var p = postings[index][0];
        var group = Math.floor((p - 1) / state.search.lineChunkSize);
        if (seenGroups.has(group)) return tryAt(index + 1);
        seenGroups.add(group);
        return loadSearchLines(group).then(function (byPage) {
          for (var i = index; i < postings.length; i++) {
            var page = postings[i][0];
            var lineNo = postings[i][1];
            var lines = byPage.get(page) || [];
            for (var j = 0; j < lines.length; j++) {
              if (lines[j][0] === lineNo && norm(lines[j][1]).indexOf(qn) >= 0) return page;
            }
          }
          return tryAt(index + 1);
        }).catch(function () { return tryAt(index + 1); });
      }
      return tryAt(0);
    }).catch(function () { return 0; });
  }

  function runSearch(q) {
    var seq = ++state.searchSeq;
    var qn = norm(q);
    if (!qn) {
      els.searchResults.innerHTML = "";
      els.searchMeta.textContent = "输入关键词，搜索全书正文。";
      return;
    }
    els.searchMeta.textContent = "正在搜索…";
    searchBody(q, 80).then(function (result) {
      if (seq !== state.searchSeq) return;
      var titleHits = [];
      for (var i = 0; i < state.toc.length; i++) {
        if (norm(state.toc[i].title).indexOf(qn) >= 0) titleHits.push(state.toc[i]);
      }
      var hits = result.hits;
      var totalPages = result.totalPages;
      els.searchResults.innerHTML = "";
      var frag = document.createDocumentFragment();

      if (titleHits.length) {
        frag.appendChild(el("div", "sr-section", "目录命中"));
        titleHits.slice(0, 12).forEach(function (t) {
          var item = el("div", "sr-item");
          var meta = el("div", "sr-page", "第 " + t.page + " 页" + (t.printedPage ? " · 书内 /" + t.printedPage : ""));
          var tx = el("div", "sr-text");
          tx.innerHTML = markSnippet(t.title, q);
          item.appendChild(meta);
          item.appendChild(tx);
          item.addEventListener("click", function () {
            navigateFromSearch(t.page, q, t.y);
          });
          frag.appendChild(item);
        });
      }

      if (hits.length) {
        frag.appendChild(el("div", "sr-section", "正文命中 · 约 " + totalPages + " 页"));
        hits.forEach(function (h) {
          var item = el("div", "sr-item");
          var meta = el("div", "sr-page", "第 " + h.page + " 页");
          var tx = el("div", "sr-text");
          tx.textContent = "正在读取摘录…";
          item.appendChild(meta);
          item.appendChild(tx);
          h.row = item;
          h.textEl = tx;
          item.addEventListener("click", function () {
            navigateFromSearch(h.page, q, 0);
          });
          frag.appendChild(item);
        });
      }

      if (!titleHits.length && !hits.length) {
        var empty = el("div", "sr-item");
        empty.appendChild(el("div", "sr-text", "没有找到“" + q + "”。换个词试试，或检查 OCR 识别差异。"));
        frag.appendChild(empty);
      } else if (hits.length >= 80) {
        frag.appendChild(el("div", "sr-section", "仅显示前 80 页结果"));
      }
      els.searchResults.appendChild(frag);
      els.searchMeta.textContent = "目录 " + titleHits.length + " 条；正文约 " +
        totalPages + " 页。摘录按需加载。";
      fillSearchSnippets(hits, qn, seq);
    });
  }

  function navigateFromSearch(p, q, y) {
    state.highlightQuery = q || "";
    goToPage(p, { q: q || "", y: y || 0, force: true, clearAnchor: true });
    if (window.innerWidth < 900) closeSearch();
    else els.searchResults.scrollTop = 0;
  }

  function copyToClipboard(text) {
    programmaticCopy++;
    var finish = function () {
      setTimeout(function () { programmaticCopy = Math.max(0, programmaticCopy - 1); }, 0);
    };
    var fallback = function () {
      var ok = legacyCopy(text);
      if (ok) toast("已复制");
      else showCopyFallback(text);
      finish();
    };
    if (navigator.clipboard && window.isSecureContext) {
      try {
        return navigator.clipboard.writeText(text).then(function () {
          toast("已复制");
          finish();
        }).catch(fallback);
      } catch (e) {
        fallback();
        return;
      }
    }
    fallback();
  }

  function legacyCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.setAttribute("aria-hidden", "true");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "0";
    ta.style.width = "1px";
    ta.style.height = "1px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    var ok = false;
    try {
      ta.focus();
      ta.select();
      ok = document.execCommand("copy");
    } catch (e) {
      ok = false;
    }
    ta.remove();
    return ok;
  }

  function showCopyFallback(text) {
    if (!els.copyFallback || !els.copyFallbackText) {
      window.prompt("复制失败，请长按下面的内容复制", text);
      return;
    }
    els.copyFallbackText.value = text;
    els.copyFallback.classList.remove("hidden");
    setTimeout(function () {
      els.copyFallbackText.focus();
      els.copyFallbackText.select();
    }, 30);
  }

  function hideCopyFallback() {
    if (!els.copyFallback || !els.copyFallbackText) return;
    els.copyFallback.classList.add("hidden");
    els.copyFallbackText.value = "";
  }

  function copyPageText() {
    ensurePageText(state.page).then(function (pd) {
      if (!pd) { toast("这一页的文字还没加载好"); return; }
      var lines = [];
      for (var i = 0; i < pd.lines.length; i++) {
        if (pd.lines[i][7] !== "hf") lines.push(pd.lines[i][5]);
      }
      copyToClipboard(lines.join("\n"));
    });
  }

  function buildLink(opts) {
    opts = opts || {};
    var u = new URL(location.href);
    u.searchParams.set("book", state.slug);
    u.searchParams.set("page", String(opts.page || state.page));
    u.searchParams.delete("src");
    u.searchParams.delete("q");
    u.searchParams.delete("y");
    u.searchParams.delete("sel");
    if (opts.y > 0.5) u.searchParams.set("y", formatCoord(opts.y));
    if (opts.sel && opts.sel.length === 2) {
      u.searchParams.set("sel", (opts.sel[0] + 1) + "-" + (opts.sel[1] + 1));
    }
    u.searchParams.delete("mode");
    u.hash = "";
    return u.toString();
  }

  function copyPageLink() {
    copyToClipboard(buildLink({ page: state.page }));
  }

  function copySectionLink(entry) {
    if (!entry || !entry.page) {
      toast("这一行没有对应页码");
      return;
    }
    copyToClipboard(buildLink({ page: entry.page, y: entry.y || 0 }));
  }

  function copyCurrentSection() {
    var entry = state.toc[state.activeToc];
    if (!entry) {
      toast("当前页不在目录范围内");
      return;
    }
    copySectionLink(entry);
  }

  function copySelectionLink(info) {
    info = info || state.selectionInfo || currentSelectionInfo();
    if (!info || !info.lines.length) {
      toast("先在正文里选中文字");
      return;
    }
    var first = info.lines[0];
    var a = Infinity, b = -1;
    for (var i = 0; i < info.lines.length; i++) {
      var line = info.lines[i];
      if (line.p !== first.p) continue;
      a = Math.min(a, line.i);
      b = Math.max(b, line.i);
    }
    if (b < 0) return;
    copyToClipboard(buildLink({ page: first.p, y: first.y0, sel: [a, b] }));
  }

  function copySelectedText() {
    var info = state.selectionInfo || currentSelectionInfo();
    if (!info || !info.text) {
      toast("先在正文里选中文字");
      return;
    }
    copyToClipboard(info.text);
  }

  function hideSelectionBar() {
    if (els.selToolbar) els.selToolbar.classList.add("hidden");
    state.selectionInfo = null;
  }

  function updateSelectionBar() {
    var info = currentSelectionInfo();
    if (info && info.lines.length) {
      clearTimeout(state.selectionHideTimer);
      state.selectionInfo = info;
      els.selToolbar.classList.remove("hidden");
      return;
    }
    clearTimeout(state.selectionHideTimer);
    state.selectionHideTimer = setTimeout(function () {
      if (!currentSelectionInfo()) hideSelectionBar();
    }, 260);
  }

  function updateModeButtons() {
    var buttons = document.querySelectorAll("#modeSeg button");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].classList.toggle("active", buttons[i].dataset.mode === state.mode);
    }
  }

  function bind() {
    els.btnPrev.addEventListener("click", function () { goToPage(state.page - 1); });
    els.btnNext.addEventListener("click", function () { goToPage(state.page + 1); });
    els.pageInput.addEventListener("change", function () { goToPage(els.pageInput.value); });
    els.pageInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); goToPage(els.pageInput.value); els.pageInput.blur(); }
    });
    els.btnToc.addEventListener("click", function () { toggleToc(); });
    els.tocClose.addEventListener("click", function () { toggleToc(false); });
    els.btnSearch.addEventListener("click", openSearch);
    els.searchClose.addEventListener("click", closeSearch);
    els.btnCopyText.addEventListener("click", copyPageText);
    els.btnLink.addEventListener("click", copyPageLink);
    ["pointerdown", "mousedown"].forEach(function (name) {
      els.selToolbar.addEventListener(name, function (e) { e.preventDefault(); });
    });
    els.selLink.addEventListener("click", function () {
      copySelectionLink(state.selectionInfo || currentSelectionInfo());
    });
    els.selText.addEventListener("click", copySelectedText);
    if (els.copyFallbackClose) els.copyFallbackClose.addEventListener("click", hideCopyFallback);
    if (els.copyFallback) {
      els.copyFallback.addEventListener("click", function (e) {
        if (e.target === els.copyFallback) hideCopyFallback();
      });
    }
    els.zoomIn.addEventListener("click", function () { zoomBy(0.15); });
    els.zoomOut.addEventListener("click", function () { zoomBy(-0.15); });
    els.zoomLabel.addEventListener("click", function () { setFit("width"); });
    els.fitPage.addEventListener("click", function () {
      setFit(state.fit === "page" ? "width" : "page");
    });
    els.viewport.addEventListener("scroll", onScroll, { passive: true });

    var segButtons = document.querySelectorAll("#modeSeg button");
    for (var i = 0; i < segButtons.length; i++) {
      segButtons[i].addEventListener("click", function () { setMode(this.dataset.mode); });
    }

    els.btnMore.addEventListener("click", function (e) {
      e.stopPropagation();
      els.moreMenu.classList.toggle("hidden");
    });
    document.addEventListener("click", function () { els.moreMenu.classList.add("hidden"); });
    els.moreMenu.addEventListener("click", function (e) {
      var btn = e.target.closest("button");
      if (!btn) return;
      var act = btn.dataset.act;
      els.moreMenu.classList.add("hidden");
      if (act === "mode-single") setMode("single");
      else if (act === "mode-scroll") setMode("scroll");
      else if (act === "fit-width") setFit("width");
      else if (act === "fit-page") setFit("page");
      else if (act === "zoom-in") zoomBy(0.15);
      else if (act === "zoom-out") zoomBy(-0.15);
      else if (act === "copy-text") copyPageText();
      else if (act === "copy-link") copyPageLink();
      else if (act === "copy-section") copyCurrentSection();
      else if (act === "home") location.href = "./index.html";
    });

    els.tocList.addEventListener("click", function (e) {
      var row = e.target.closest(".toc-item");
      if (!row) return;
      var idx = parseInt(row.dataset.i, 10);
      var entry = state.toc[idx];
      if (e.target.closest(".toc-copy")) {
        copySectionLink(entry);
        return;
      }
      if (e.target.dataset.caret) {
        if (state.collapsed.has(idx)) state.collapsed.delete(idx);
        else state.collapsed.add(idx);
        applyCollapse();
        return;
      }
      if (!entry || !entry.page) return;
      goToPage(entry.page, {
        y: entry.y || 0,
        anchor: { page: entry.page, y: entry.y || 0, sel: null }
      });
      if (window.innerWidth < 1000) toggleToc(false);
    });

    els.tocFilter.addEventListener("input", function () { filterToc(this.value); });

    var searchTimer = 0;
    els.searchInput.addEventListener("input", function () {
      var v = this.value.trim();
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () { runSearch(v); }, 170);
    });
    els.searchInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        var q = this.value.trim();
        if (!q) return;
        var tocHit = null;
        for (var i = 0; i < state.toc.length; i++) {
          if (norm(state.toc[i].title).indexOf(norm(q)) >= 0) { tocHit = state.toc[i]; break; }
        }
        if (tocHit) {
          navigateFromSearch(tocHit.page, q, tocHit.y);
        } else {
          firstSearchPage(q).then(function (page) {
            if (page) navigateFromSearch(page, q, 0);
            else toast("没有找到“" + q + "”");
          });
        }
      }
    });

    els.backdrop.addEventListener("click", function () {
      toggleToc(false);
      closeSearch();
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && els.copyFallback && !els.copyFallback.classList.contains("hidden")) {
        e.preventDefault();
        hideCopyFallback();
        return;
      }
      var tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea") {
        if (e.key === "Escape") e.target.blur();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        openSearch();
        return;
      }
      if (e.key === "/") { e.preventDefault(); openSearch(); return; }
      if (e.key === "Escape") {
        closeSearch();
        toggleToc(false);
        els.moreMenu.classList.add("hidden");
        hideSelectionBar();
        return;
      }
      if (e.key === "ArrowRight" || e.key === "PageDown") {
        e.preventDefault(); goToPage(state.page + 1);
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault(); goToPage(state.page - 1);
      } else if (e.key === "Home") {
        e.preventDefault(); goToPage(1);
      } else if (e.key === "End") {
        e.preventDefault(); goToPage(state.meta.pages);
      }
    });

    document.addEventListener("copy", function (e) {
      if (programmaticCopy > 0) return;
      var target = e.target;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      var info = currentSelectionInfo() || state.selectionInfo;
      if (!info || !info.text) return;
      e.preventDefault();
      if (e.clipboardData) e.clipboardData.setData("text/plain", info.text);
    });

    document.addEventListener("selectionchange", function () {
      clearTimeout(state.selectionTimer);
      state.selectionTimer = setTimeout(updateSelectionBar, 70);
    });

    var touch = null;
    els.viewport.addEventListener("touchstart", function (e) {
      if (state.mode !== "single" || e.touches.length !== 1) return;
      touch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }, { passive: true });
    els.viewport.addEventListener("touchend", function (e) {
      if (!touch || state.mode !== "single") return;
      var t = e.changedTouches[0];
      var dx = t.clientX - touch.x;
      var dy = t.clientY - touch.y;
      touch = null;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.6) return;
      var sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      if (dx < 0) goToPage(state.page + 1);
      else goToPage(state.page - 1);
    }, { passive: true });

    var resizeTimer = 0;
    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (!state.meta) return;
        if (state.mode === "single") {
          renderSingle();
        } else {
          var ratio = els.viewport.scrollHeight > 0 ? els.viewport.scrollTop / els.viewport.scrollHeight : 0;
          computeSizes();
          els.stage.style.height = (state.meta.pages * state.step + 24) + "px";
          state.pageEls.forEach(function (pageEl, p) {
            pageEl.style.width = state.pageWidthPx + "px";
            pageEl.style.height = state.pageHeightPx + "px";
            pageEl.style.top = ((p - 1) * state.step + 12) + "px";
            var tl = pageEl.querySelector(".text-layer");
            var hl = pageEl.querySelector(".hl-layer");
            if (tl) tl.style.transform = "scale(" + state.scale + ")";
            if (hl) hl.style.transform = "scale(" + state.scale + ")";
          });
          els.viewport.scrollTop = ratio * els.viewport.scrollHeight;
        }
      }, 160);
    });
  }

  function boot() {
    els = {
      viewport: $("#viewport"),
      stage: $("#stage"),
      loading: $("#readerLoading"),
      loadingText: $("#loadingText"),
      toast: $("#toast"),
      bookName: $("#bookName"),
      pageInput: $("#pageInput"),
      pageTotal: $("#pageTotal"),
      btnPrev: $("#btnPrev"),
      btnNext: $("#btnNext"),
      btnToc: $("#btnToc"),
      tocClose: $("#tocClose"),
      tocPanel: $("#tocPanel"),
      tocList: $("#tocList"),
      tocFilter: $("#tocFilter"),
      btnSearch: $("#btnSearch"),
      searchPanel: $("#searchPanel"),
      searchClose: $("#searchClose"),
      searchInput: $("#searchInput"),
      searchMeta: $("#searchMeta"),
      searchResults: $("#searchResults"),
      btnCopyText: $("#btnCopyText"),
      btnLink: $("#btnLink"),
      zoomIn: $("#zoomIn"),
      zoomOut: $("#zoomOut"),
      zoomLabel: $("#zoomLabel"),
      fitPage: $("#fitPage"),
      btnMore: $("#btnMore"),
      moreMenu: $("#moreMenu"),
      backdrop: $("#backdrop"),
      selToolbar: $("#selToolbar"),
      selLink: $("#selLink"),
      selText: $("#selText"),
      copyFallback: $("#copyFallback"),
      copyFallbackText: $("#copyFallbackText"),
      copyFallbackClose: $("#copyFallbackClose")
    };

    var params = new URLSearchParams(location.search);
    var slug = params.get("book");
    var src = params.get("src");
    var pageParam = parseInt(params.get("page") || "", 10);
    var q = params.get("q") || "";
    var modeParam = params.get("mode");

    if (!slug && src) {
      slug = slugFromSrc(src);
      if (slug) {
        var u = new URL(location.href);
        u.search = "?book=" + slug + (pageParam ? "&page=" + pageParam : "") + (q ? "&q=" + encodeURIComponent(q) : "");
        history.replaceState(null, "", u.pathname + u.search);
        params = new URLSearchParams(location.search);
      }
    }
    if (!slug) {
      showError("缺少书名", "链接里没有 book 参数。请从书目页选择一本书。");
      return;
    }
    state.slug = slug;

    bind();

    var savedMode = load("mode");
    state.mode = modeParam === "scroll" ? "scroll" : modeParam === "single" ? "single" : (savedMode === "scroll" ? "scroll" : "single");
    state.fit = load("fit") || "width";
    state.zoom = parseFloat(load("zoom") || "1") || 1;
    if (state.fit === "custom" && state.mode === "scroll") state.fit = "width";

    Promise.all([
      fetch("books.json").then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; }),
      fetch("data/" + slug + "/meta.json").then(function (r) {
        if (!r.ok) throw new Error("找不到这本书的数据");
        return r.json();
      }),
      fetch("data/" + slug + "/toc.json").then(function (r) {
        if (!r.ok) throw new Error("找不到目录数据");
        return r.json();
      })
    ]).then(function (res) {
      var books = res[0] || [];
      state.meta = res[1];
      state.toc = res[2] || [];
      for (var i = 0; i < books.length; i++) {
        if (books[i].slug === slug) state.book = books[i];
      }
      if (state.book && state.book.title && !state.meta.title) state.meta.title = state.book.title;

      var savedPage = parseInt(load("progress:" + slug) || "1", 10) || 1;
      var target = pageParam || savedPage;
      state.page = clamp(target, 1, state.meta.pages);
      if (modeParam === "scroll") state.page = clamp(target, 1, state.meta.pages);

      var initialAnchor = null;
      if (params.has("y") || params.has("sel")) {
        var rawY = parseFloat(params.get("y") || "");
        var anchorY = isFinite(rawY) ? clamp(rawY, 0, state.meta.pageH) : 0;
        var anchorSel = parseSelParam(params.get("sel"));
        if (anchorY > 0 || anchorSel) {
          initialAnchor = { page: state.page, y: anchorY, sel: anchorSel };
        }
      }

      renderToc();
      updateModeButtons();

      if (window.innerWidth >= 1100) {
        state.tocOpen = true;
        document.body.classList.add("toc-open");
      }

      if (q && !pageParam) {
        var tocHit = null;
        for (var j = 0; j < state.toc.length; j++) {
          if (norm(state.toc[j].title).indexOf(norm(q)) >= 0) { tocHit = state.toc[j]; break; }
        }
        if (tocHit) {
          state.page = tocHit.page;
        } else {
          firstSearchPage(q).then(function (page) {
            if (page) state.page = page;
            startReader(q, initialAnchor);
          });
          return;
        }
      }
      startReader(q, initialAnchor);
    }).catch(function (err) {
      showError("打不开这本书", (err && err.message ? err.message + "。" : "") +
        "如果这是第一次生成，请先在本地运行转换脚本。");
    });
  }

  function startReader(q, anchor) {
    state.highlightQuery = q || "";
    state.anchor = anchor && anchor.page === state.page ? anchor : null;
    els.loading.classList.add("hidden");
    if (state.mode === "scroll") renderScroll();
    else renderSingle();
    setActiveToc(true);
    saveProgress();
    syncUrl();
    if (!q) {
      setTimeout(function () { loadSearchIndex(); }, 1200);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
