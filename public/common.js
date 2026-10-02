/* Phần dùng chung cho trang đọc và trang soạn: nạp file, vẽ trang. */
(function(){
  'use strict';
  if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.js';

  var pdfCache = new Map();   // id -> Promise<tài liệu pdf.js>
  var imgCache = new Map();   // id -> Promise<HTMLImageElement>

  function fileUrl(id){ return '/files/' + encodeURIComponent(id); }

  function pdfDoc(id){
    if (!pdfCache.has(id)){
      var p = pdfjsLib.getDocument({ url: fileUrl(id) }).promise;
      p.catch(function(){ pdfCache.delete(id); });
      pdfCache.set(id, p);
    }
    return pdfCache.get(id);
  }
  function image(id){
    if (!imgCache.has(id)){
      var p = new Promise(function(res, rej){
        var im = new Image();
        im.onload = function(){ res(im); };
        im.onerror = function(){ rej(new Error('Không tải được ảnh ' + id)); };
        im.src = fileUrl(id);
      });
      p.catch(function(){ imgCache.delete(id); });
      imgCache.set(id, p);
    }
    return imgCache.get(id);
  }

  // Sách lưu dạng các đoạn {a: id file, t: 'pdf'|'img', f: trang bắt đầu, n: số trang}.
  // Khi làm việc thì trải ra thành từng trang {a, t, p}.
  function expand(segs){
    var pages = [];
    (segs || []).forEach(function(s){
      for (var i = 0; i < s.n; i++) pages.push({ a: s.a, t: s.t, p: s.f + i });
    });
    return pages;
  }
  function compress(pages){
    var segs = [];
    pages.forEach(function(pg){
      var last = segs[segs.length - 1];
      if (last && last.a === pg.a && last.t === 'pdf' && last.f + last.n === pg.p) last.n++;
      else segs.push({ a: pg.a, t: pg.t, f: pg.p, n: 1 });
    });
    return segs;
  }

  async function renderPage(pg, canvas, w){
    var ctx;
    if (pg.t === 'pdf'){
      var doc = await pdfDoc(pg.a);
      var page = await doc.getPage(pg.p + 1);
      var v1 = page.getViewport({ scale: 1 });
      var vp = page.getViewport({ scale: w / v1.width });
      canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
      ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
    } else {
      var im = await image(pg.a);
      canvas.width = w; canvas.height = Math.round(w * im.naturalHeight / im.naturalWidth);
      ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(im, 0, 0, canvas.width, canvas.height);
    }
  }

  async function pageRatio(pg){
    if (pg.t === 'pdf'){
      var doc = await pdfDoc(pg.a);
      var page = await doc.getPage(pg.p + 1);
      var v = page.getViewport({ scale: 1 });
      return v.height / v.width;
    }
    var im = await image(pg.a);
    return im.naturalHeight / im.naturalWidth;
  }

  async function pageCount(id, type){
    if (type !== 'pdf') return 1;
    return (await pdfDoc(id)).numPages;
  }

  window.Book = {
    expand: expand, compress: compress, renderPage: renderPage,
    pageRatio: pageRatio, pageCount: pageCount
  };
})();
