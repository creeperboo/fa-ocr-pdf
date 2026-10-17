(function () {
  "use strict";

  function el(tag, cls, text) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  }

  function loadProgress(slug) {
    try { return parseInt(localStorage.getItem("fa3:progress:" + slug) || "0", 10) || 0; }
    catch (e) { return 0; }
  }

  function fmt(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function card(book) {
    var a = el(book.ready ? "a" : "div", "card " + (book.ready ? "ready" : "pending"));
    if (book.ready) {
      var p = loadProgress(book.slug);
      a.href = "reader.html?book=" + encodeURIComponent(book.slug) + (p > 1 ? "&page=" + p : "");
    }

    var cover = el("div", "cover");
    if (book.ready) {
      var img = document.createElement("img");
      img.src = "data/" + book.slug + "/cover.webp";
      img.alt = book.title + " 封面";
      img.loading = "lazy";
      cover.appendChild(img);
    } else {
      var ph = el("div", "placeholder");
      ph.appendChild(el("div", "big", book.title));
      ph.appendChild(el("div", "small", "待生成"));
      cover.appendChild(ph);
    }
    if (!book.ready) cover.appendChild(el("div", "badge", "即将上线"));

    var body = el("div", "card-body");
    body.appendChild(el("div", "card-title", book.title));
    body.appendChild(el("div", "card-sub", book.author || ""));

    var foot = el("div", "card-foot");
    var page = loadProgress(book.slug);
    var label = el("span", null, book.pages ? fmt(book.pages) + " 页" : "");
    var go = el("span", "go", book.ready ? (page > 1 ? "读到第 " + page + " 页" : "开始阅读 →") : "整理中");
    foot.appendChild(label);
    foot.appendChild(go);
    body.appendChild(foot);

    if (book.ready && page > 1 && book.pages) {
      var bar = el("div", "progress");
      var fill = el("i");
      fill.style.width = Math.min(100, Math.round(page / book.pages * 100)) + "%";
      bar.appendChild(fill);
      body.appendChild(bar);
    }

    a.appendChild(cover);
    a.appendChild(body);
    return a;
  }

  fetch("books.json").then(function (r) { return r.json(); }).then(function (books) {
    var shelf = document.getElementById("shelf");
    shelf.innerHTML = "";
    var totalPages = 0;
    for (var i = 0; i < books.length; i++) {
      totalPages += books[i].pages || 0;
      shelf.appendChild(card(books[i]));
    }
    var ready = 0;
    for (var j = 0; j < books.length; j++) if (books[j].ready) ready++;
    document.getElementById("stats").textContent =
      books.length + " 本 · " + fmt(totalPages) + " 页 · 已上线 " + ready + " 本";
  }).catch(function () {
    document.getElementById("shelf").innerHTML =
      '<div class="tip"><p>书目数据加载失败，请刷新重试。</p></div>';
  });
})();
