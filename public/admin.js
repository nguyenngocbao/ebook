/* Trang soạn sách: thêm, thay, sắp xếp, xoá trang rồi bấm Lưu để cập nhật trang công khai. */
(function(){
  'use strict';
  var $ = function(s){ return document.querySelector(s); };
  var login = $('#login'), editor = $('#editor'), saveBar = $('#saveBar');
  var grid = $('#pages'), picker = $('#picker'), titleInput = $('#bookTitle');
  var busy = $('#busy'), busyText = $('#busyText'), toast = $('#toast');

  var pages = [];        // [{a, t, p}]
  var sel = -1;          // trang đang chọn
  var dirty = false, saving = false, pickMode = 'after';
  var thumbs = new Map();   // "id#trang" -> canvas đã vẽ
  var queue = [], drawing = false;

  /* ---------- Tiện ích ---------- */
  var toastTimer = null;
  function say(m){
    toast.textContent = m; toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ toast.hidden = true; }, 6000);
  }
  function setBusy(m){ if (m){ busyText.textContent = m; busy.hidden = false; } else busy.hidden = true; }
  function keyOf(pg){ return pg.a + '#' + pg.p; }

  function showLogin(){
    editor.hidden = true; saveBar.hidden = true; login.hidden = false;
    $('#pw').value = ''; $('#pw').focus();
  }
  async function api(method, url, body){
    var r = await fetch(url, {
      method: method, cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    var data = null;
    try { data = await r.json(); } catch (e){}
    if (r.status === 401 && url !== '/api/login') showLogin();
    if (!r.ok) throw new Error((data && data.error) || 'Không thực hiện được. Hãy thử lại.');
    return data;
  }
  function uploadFile(file, onProgress){
    return new Promise(function(res, rej){
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/files');
      xhr.responseType = 'json';
      xhr.upload.onprogress = function(e){ if (e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onload = function(){
        var d = xhr.response;
        if (xhr.status === 401) showLogin();
        if (xhr.status >= 200 && xhr.status < 300 && d && d.id) res(d);
        else if (xhr.status === 413) rej(new Error('File quá nặng so với giới hạn của máy chủ.'));
        else rej(new Error((d && d.error) || 'Không tải được file lên. Hãy thử lại.'));
      };
      xhr.onerror = function(){ rej(new Error('Mất kết nối khi tải file lên. Hãy thử lại.')); };
      var fd = new FormData();
      fd.append('file', file);
      xhr.send(fd);
    });
  }

  /* ---------- Danh sách trang ---------- */
  var io = new IntersectionObserver(function(entries){
    entries.forEach(function(en){
      if (en.isIntersecting){ io.unobserve(en.target); queue.push(en.target); drawQueue(); }
    });
  }, { rootMargin: '300px' });

  async function drawQueue(){
    if (drawing) return;
    drawing = true;
    while (queue.length){
      var cell = queue.shift();
      if (!cell.isConnected) continue;
      var k = keyOf(cell._pg);
      try {
        var c = thumbs.get(k);
        if (!c){
          c = document.createElement('canvas');
          await Book.renderPage(cell._pg, c, 240);
          thumbs.set(k, c);
        }
        if (cell.isConnected) cell.firstChild.replaceChildren(c);
      } catch (e){
        console.error(e);
        if (cell.isConnected) cell.firstChild.textContent = 'Lỗi';
      }
    }
    drawing = false;
  }

  function renderGrid(){
    io.disconnect(); queue.length = 0;
    grid.replaceChildren();
    $('#emptyPages').hidden = pages.length > 0;
    pages.forEach(function(pg, i){
      var cell = document.createElement('button');
      cell.type = 'button'; cell.className = 'cell';
      cell.setAttribute('aria-pressed', i === sel ? 'true' : 'false');
      cell.setAttribute('aria-label', 'Trang ' + (i + 1));
      cell._pg = pg;
      var th = document.createElement('div'); th.className = 'thumb';
      var c = thumbs.get(keyOf(pg));
      if (c) th.appendChild(c); else th.textContent = '…';
      var num = document.createElement('span'); num.className = 'num'; num.textContent = String(i + 1);
      cell.appendChild(th); cell.appendChild(num);
      cell.addEventListener('click', function(){ select(i === sel ? -1 : i); });
      grid.appendChild(cell);
      if (!c) io.observe(cell);
    });
    updateTools();
  }
  function select(i){
    var old = grid.children[sel], now = grid.children[i];
    if (old) old.setAttribute('aria-pressed', 'false');
    if (now) now.setAttribute('aria-pressed', 'true');
    sel = i;
    updateTools();
  }
  function updateTools(){
    var has = sel >= 0 && sel < pages.length;
    $('#replace').disabled = !has;
    $('#remove').disabled = !has;
    $('#moveUp').disabled = !has || sel === 0;
    $('#moveDown').disabled = !has || sel === pages.length - 1;
    $('#selInfo').textContent = has
      ? 'Đang chọn trang ' + (sel + 1) + '. Trang mới sẽ chèn ngay sau trang này.'
      : 'Chưa chọn trang nào. Trang mới sẽ thêm vào cuối sách.';
    $('#saveState').textContent = dirty
      ? 'Có thay đổi chưa lưu. Trang công khai chưa đổi.'
      : 'Đã lưu. Trang công khai đang hiển thị bản này.';
    $('#save').disabled = !dirty || saving;
  }
  function markDirty(){ dirty = true; updateTools(); }

  /* ---------- Thêm, thay trang ---------- */
  function pick(mode){ pickMode = mode; picker.value = ''; picker.click(); }
  $('#addAfter').addEventListener('click', function(){ pick('after'); });
  $('#addStart').addEventListener('click', function(){ pick('start'); });
  $('#replace').addEventListener('click', function(){ if (sel >= 0) pick('replace'); });

  picker.addEventListener('change', async function(){
    var files = Array.prototype.slice.call(picker.files || []);
    if (!files.length) return;
    files.sort(function(a, b){ return a.name.localeCompare(b.name, undefined, { numeric: true }); });
    var mode = pickMode;
    var added = [];
    try {
      for (var i = 0; i < files.length; i++){
        var prefix = 'Đang tải lên file ' + (i + 1) + '/' + files.length;
        setBusy(prefix + '…');
        var up = await uploadFile(files[i], function(f){ setBusy(prefix + ' (' + Math.round(f * 100) + '%)…'); });
        setBusy('Đang đọc file ' + (i + 1) + '/' + files.length + '…');
        var n = await Book.pageCount(up.id, up.type);
        for (var p = 0; p < n; p++) added.push({ a: up.id, t: up.type, p: p });
      }
    } catch (e){
      console.error(e);
      say(e.message || 'Không thêm được file.');
    } finally {
      setBusy(null);
    }
    if (!added.length) return;
    var at, removeCount = 0;
    if (mode === 'start') at = 0;
    else if (mode === 'replace' && sel >= 0){ at = sel; removeCount = 1; }
    else at = sel >= 0 ? sel + 1 : pages.length;
    Array.prototype.splice.apply(pages, [at, removeCount].concat(added));
    sel = at;
    dirty = true;
    renderGrid();
    var first = grid.children[at];
    if (first) first.scrollIntoView({ block: 'center' });
    say(mode === 'replace'
      ? 'Đã thay bằng ' + added.length + ' trang. Bấm Lưu để cập nhật trang công khai.'
      : 'Đã thêm ' + added.length + ' trang. Bấm Lưu để cập nhật trang công khai.');
  });

  /* ---------- Sắp xếp, xoá ---------- */
  function move(delta){
    var j = sel + delta;
    if (sel < 0 || j < 0 || j >= pages.length) return;
    var t = pages[sel]; pages[sel] = pages[j]; pages[j] = t;
    sel = j; dirty = true;
    renderGrid();
    var cell = grid.children[sel];
    if (cell) cell.scrollIntoView({ block: 'nearest' });
  }
  $('#moveUp').addEventListener('click', function(){ move(-1); });
  $('#moveDown').addEventListener('click', function(){ move(1); });
  $('#remove').addEventListener('click', function(){
    if (sel < 0) return;
    var removed = sel + 1;
    pages.splice(sel, 1);
    if (sel >= pages.length) sel = pages.length - 1;
    dirty = true;
    renderGrid();
    say('Đã xoá trang ' + removed + '. Bấm Lưu để cập nhật trang công khai.');
  });
  titleInput.addEventListener('input', markDirty);

  /* ---------- Lưu ---------- */
  async function bookRatio(){
    if (!pages.length) return 1.414;
    // Lấy khổ trang của file có nhiều trang nhất làm khổ của cả quyển
    var count = {}, main = pages[0];
    pages.forEach(function(pg){
      count[pg.a] = (count[pg.a] || 0) + 1;
      if (count[pg.a] > count[main.a]) main = pg;
    });
    var firstOfMain = pages.filter(function(pg){ return pg.a === main.a; })[0];
    try { return await Book.pageRatio(firstOfMain); } catch (e){ return 1.414; }
  }
  $('#save').addEventListener('click', async function(){
    var title = titleInput.value.trim();
    if (!title){ say('Hãy nhập tên sách trước khi lưu.'); titleInput.focus(); return; }
    saving = true; updateTools();
    setBusy('Đang lưu…');
    try {
      var ratio = await bookRatio();
      await api('PUT', '/api/book', { title: title, ratio: ratio, segs: Book.compress(pages) });
      dirty = false;
      say('Đã lưu. Trang công khai sẽ hiện bản mới trong vài giây.');
    } catch (e){
      console.error(e);
      say(e.message);
    } finally {
      saving = false; setBusy(null); updateTools();
    }
  });
  window.addEventListener('beforeunload', function(e){
    if (dirty){ e.preventDefault(); e.returnValue = ''; }
  });

  /* ---------- Đăng nhập ---------- */
  async function openEditor(){
    var b = await api('GET', '/api/book');
    pages = Book.expand(b.segs);
    sel = -1; dirty = false;
    titleInput.value = b.title || '';
    login.hidden = true; editor.hidden = false; saveBar.hidden = false;
    renderGrid();
  }
  login.addEventListener('submit', async function(e){
    e.preventDefault();
    $('#loginErr').textContent = '';
    try {
      await api('POST', '/api/login', { password: $('#pw').value });
      await openEditor();
    } catch (err){
      $('#loginErr').textContent = err.message;
    }
  });
  $('#logout').addEventListener('click', async function(){
    if (dirty && !window.confirm('Có thay đổi chưa lưu. Đăng xuất sẽ bỏ các thay đổi này. Vẫn đăng xuất?')) return;
    try { await api('POST', '/api/logout', {}); } catch (e){}
    dirty = false;
    showLogin();
  });

  (async function(){
    try {
      var me = await api('GET', '/api/me');
      if (me.admin) await openEditor(); else showLogin();
    } catch (e){
      console.error(e);
      showLogin();
    }
  })();
})();
