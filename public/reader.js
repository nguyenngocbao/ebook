/* Trang công khai: đọc sách dạng lật trang, tự cập nhật khi admin lưu. */
(function(){
  'use strict';
  var $ = function(s){ return document.querySelector(s); };
  var stage = $('#stage'), box = $('#box'), note = $('#note');
  var slider = $('#slider'), label = $('#label'), bottom = $('#bottom');

  var AHEAD = 5, KEEP = 10, POLL_MS = 10000;
  var book = null, pages = [], flip = null;
  var pageEls = [], state = {}, current = 0, gen = 0, pxW = 800;
  var pumping = false, lastW = 0, lastH = 0;

  async function load(first){
    var r = await fetch('/api/book', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var b = await r.json();
    if (!first && book && b.updatedAt === book.updatedAt) return;
    book = b;
    pages = Book.expand(b.segs);
    document.title = b.title || 'Sách';
    $('#title').textContent = b.title || '';
    if (!pages.length){
      teardown();
      note.hidden = false; note.textContent = 'Sách đang được soạn. Hãy quay lại sau.';
      bottom.hidden = true;
      return;
    }
    note.hidden = true; bottom.hidden = false;
    build();
  }

  function teardown(){
    gen++;
    if (flip){ try { flip.destroy(); } catch(e){} flip = null; }
    box.replaceChildren(); pageEls = []; state = {};
  }

  function build(){
    teardown();
    var count = pages.length;
    var pad = window.innerWidth < 640 ? 10 : 24;
    var availW = Math.max(120, stage.clientWidth - pad * 2);
    var availH = Math.max(120, stage.clientHeight - pad * 2);
    lastW = stage.clientWidth; lastH = stage.clientHeight;

    var r = +book.ratio || 1.414;
    var landW = Math.min(availW / 2, availH / r);
    var portW = Math.min(availW, availH / r);
    var portrait = count < 2 || availW < 640 || landW < portW * 0.62;
    var pageW = Math.floor(portrait ? portW : landW);
    var pageH = Math.round(pageW * r);
    box.style.width = (portrait ? pageW : pageW * 2) + 'px';

    var el0 = document.createElement('div');
    box.replaceChildren(el0);
    for (var i = 0; i < count; i++){
      var el = document.createElement('div');
      el.className = 'page';
      if (i === 0 || i === count - 1) el.setAttribute('data-density', 'hard');
      el.appendChild(placeholder(i));
      el0.appendChild(el);
      pageEls.push(el);
    }

    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    current = Math.max(0, Math.min(current, count - 1));
    flip = new St.PageFlip(el0, {
      width: pageW, height: pageH, size: 'stretch',
      minWidth: portrait ? pageW : 50, maxWidth: 4000, minHeight: 50, maxHeight: 6000,
      showCover: true, usePortrait: true, autoSize: true,
      drawShadow: true, maxShadowOpacity: 0.5,
      flippingTime: reduce ? 200 : 800,
      mobileScrollSupport: false,
      startPage: current
    });
    flip.loadFromHTML(pageEls);
    flip.on('flip', function(e){ current = e.data; updateUI(); pump(); });
    current = flip.getCurrentPageIndex();

    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    pxW = Math.max(400, Math.min(1800, Math.round(pageW * dpr)));
    slider.max = String(count);
    updateUI();
    pump();
  }

  function placeholder(i){
    var d = document.createElement('div');
    d.className = 'ph'; d.textContent = String(i + 1);
    return d;
  }
  function nextWanted(){
    for (var d = 0; d <= AHEAD; d++){
      var a = current + d, b = current - d;
      if (a < pages.length && !state[a]) return a;
      if (b >= 0 && !state[b]) return b;
    }
    return -1;
  }
  async function pump(){
    if (pumping) return;
    pumping = true;
    try {
      while (flip){
        var myGen = gen, myState = state, myEls = pageEls, myPages = pages;
        var i = nextWanted();
        if (i < 0) break;
        myState[i] = 'busy';
        var c = document.createElement('canvas');
        try { await Book.renderPage(myPages[i], c, pxW); }
        catch (e){ console.error(e); myState[i] = 'error'; continue; }
        if (myGen !== gen) continue;
        myEls[i].replaceChildren(c);
        myState[i] = 'done';
        evict();
      }
    } finally { pumping = false; }
  }
  function evict(){
    for (var k in state){
      var i = +k;
      if (state[i] === 'done' && Math.abs(i - current) > KEEP){
        var c = pageEls[i].querySelector('canvas');
        if (c){ c.width = 0; c.height = 0; }
        pageEls[i].replaceChildren(placeholder(i));
        delete state[i];
      }
    }
  }
  function updateUI(){
    if (!flip) return;
    var n = pages.length, a = current + 1, text;
    var two = flip.getOrientation() === 'landscape';
    if (two && current > 0 && a < n) text = a + '–' + (a + 1) + ' / ' + n;
    else text = a + ' / ' + n;
    label.textContent = 'Trang ' + text;
    slider.value = String(a);
    $('#prev').disabled = current <= 0;
    $('#next').disabled = two ? (current + 2 >= n && !(current === 0 && n > 1)) : (current + 1 >= n);
  }
  function goTo(i){
    if (!flip) return;
    flip.turnToPage(Math.max(0, Math.min(pages.length - 1, i)));
    current = flip.getCurrentPageIndex();
    updateUI(); pump();
  }

  $('#prev').addEventListener('click', function(){ if (flip) flip.flipPrev(); });
  $('#next').addEventListener('click', function(){ if (flip) flip.flipNext(); });
  slider.addEventListener('input', function(){ goTo(parseInt(slider.value, 10) - 1); });
  document.addEventListener('keydown', function(e){
    if (!flip || e.target === slider) return;
    if (e.key === 'ArrowRight') flip.flipNext();
    else if (e.key === 'ArrowLeft') flip.flipPrev();
  });
  var resizeTimer = null;
  window.addEventListener('resize', function(){
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function(){
      if (!flip) return;
      var w = stage.clientWidth, h = stage.clientHeight;
      if (Math.abs(w - lastW) > 8 || Math.abs(h - lastH) > 100) build();
    }, 250);
  });

  if (!window.St || !window.pdfjsLib){
    note.textContent = 'Không tải được thư viện hiển thị sách. Hãy tải lại trang.';
    return;
  }
  load(true).catch(function(e){
    console.error(e);
    note.hidden = false; note.textContent = 'Không mở được sách. Hãy tải lại trang.';
  });
  // Admin lưu xong thì trang này tự nạp bản mới trong vài giây
  setInterval(function(){
    if (!document.hidden) load(false).catch(function(){});
  }, POLL_MS);
})();
