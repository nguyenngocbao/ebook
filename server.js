'use strict';
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILES_DIR = path.join(DATA_DIR, 'files');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const BOOK_FILE = path.join(DATA_DIR, 'book.json');
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '100', 10);
const SESSION_DAYS = 7;

const PASSWORD = process.env.ADMIN_PASSWORD || '';
if (PASSWORD.length < 8) {
  console.error('Thiếu ADMIN_PASSWORD (tối thiểu 8 ký tự). Đặt biến môi trường này rồi chạy lại.');
  process.exit(1);
}
// Đổi mật khẩu thì mọi phiên đăng nhập cũ tự hết hiệu lực.
const SECRET = process.env.SESSION_SECRET ||
  crypto.createHash('sha256').update('ebook-session:' + PASSWORD).digest('hex');

fs.mkdirSync(FILES_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });

/* ---------------- Sách ---------------- */
const EMPTY_BOOK = { title: 'Sách của tôi', ratio: 1.414, segs: [], pages: 0, updatedAt: 0 };
let book = EMPTY_BOOK;
try {
  book = Object.assign({}, EMPTY_BOOK, JSON.parse(fs.readFileSync(BOOK_FILE, 'utf8')));
} catch (e) {
  if (e.code !== 'ENOENT') console.error('Không đọc được book.json, dùng sách trống:', e.message);
}

async function writeBook(next) {
  const tmp = BOOK_FILE + '.' + process.pid + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(next));
  await fsp.rename(tmp, BOOK_FILE);
  book = next;
}

const ID_RE = /^[a-f0-9]{24}\.(pdf|png|jpg|webp)$/;

function validateBook(body) {
  if (!body || typeof body !== 'object') return 'Dữ liệu không hợp lệ.';
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title || title.length > 200) return 'Tên sách phải có từ 1 đến 200 ký tự.';
  const ratio = Number(body.ratio);
  if (!(ratio >= 0.2 && ratio <= 5)) return 'Tỉ lệ khổ trang không hợp lệ.';
  if (!Array.isArray(body.segs) || body.segs.length > 20000) return 'Danh sách trang không hợp lệ.';
  const segs = [];
  let pages = 0;
  for (const s of body.segs) {
    if (!s || typeof s.a !== 'string' || !ID_RE.test(s.a)) return 'Có trang trỏ tới file không hợp lệ.';
    const isPdf = s.a.endsWith('.pdf');
    if (s.t !== (isPdf ? 'pdf' : 'img')) return 'Loại trang không khớp với file.';
    if (!Number.isInteger(s.f) || s.f < 0 || !Number.isInteger(s.n) || s.n < 1) return 'Phạm vi trang không hợp lệ.';
    if (!isPdf && (s.f !== 0 || s.n !== 1)) return 'Ảnh chỉ có một trang.';
    if (!fs.existsSync(path.join(FILES_DIR, s.a))) return 'Có file đã bị xoá. Hãy tải lại trang soạn sách.';
    segs.push({ a: s.a, t: s.t, f: s.f, n: s.n });
    pages += s.n;
  }
  if (pages > 20000) return 'Sách quá dài.';
  return { title, ratio, segs, pages };
}

// Xoá file không còn trang nào dùng tới (chừa file mới tải lên trong vòng 6 giờ, có thể đang soạn dở).
async function collectGarbage() {
  const used = new Set(book.segs.map(s => s.a));
  const now = Date.now();
  for (const dir of [FILES_DIR, TMP_DIR]) {
    for (const name of await fsp.readdir(dir)) {
      if (dir === FILES_DIR && used.has(name)) continue;
      const p = path.join(dir, name);
      try {
        const st = await fsp.stat(p);
        if (now - st.mtimeMs > 6 * 3600 * 1000) await fsp.unlink(p);
      } catch (e) { /* bỏ qua */ }
    }
  }
}

/* ---------------- Đăng nhập ---------------- */
function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
}
function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
function isAdmin(req) {
  const [exp, sig] = readCookie(req, 'sid').split('.');
  if (!exp || !sig || !/^\d+$/.test(exp)) return false;
  if (Number(exp) < Date.now()) return false;
  return safeEqual(sig, sign(exp));
}
function setSession(req, res, clear) {
  const secure = req.secure ? '; Secure' : '';
  if (clear) {
    res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' + secure);
    return;
  }
  const exp = String(Date.now() + SESSION_DAYS * 86400 * 1000);
  res.setHeader('Set-Cookie',
    'sid=' + exp + '.' + sign(exp) + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + SESSION_DAYS * 86400 + secure);
}
function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Phiên đăng nhập đã hết. Hãy đăng nhập lại.' });
  // Chặn yêu cầu ghi đến từ trang web khác
  const origin = req.headers.origin;
  if (origin) {
    let host = '';
    try { host = new URL(origin).host; } catch (e) { /* origin lạ */ }
    if (host !== req.headers.host) return res.status(403).json({ error: 'Yêu cầu bị từ chối.' });
  }
  next();
}

const attempts = new Map(); // ip -> {count, reset}
function tooManyAttempts(ip) {
  const now = Date.now();
  let a = attempts.get(ip);
  if (!a || a.reset < now) { a = { count: 0, reset: now + 15 * 60 * 1000 }; attempts.set(ip, a); }
  a.count++;
  return a.count > 10;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, a] of attempts) if (a.reset < now) attempts.delete(ip);
}, 10 * 60 * 1000).unref();

/* ---------------- Ứng dụng ---------------- */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; worker-src 'self' blob:; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; " +
    "img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
  next();
});
app.use(express.json({ limit: '2mb' }));

const noStore = (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); };

app.get('/api/book', noStore, (req, res) => res.json(book));

app.get('/api/me', noStore, (req, res) => res.json({ admin: isAdmin(req) }));

app.post('/api/login', noStore, (req, res) => {
  if (tooManyAttempts(req.ip)) {
    return res.status(429).json({ error: 'Nhập sai quá nhiều lần. Hãy thử lại sau 15 phút.' });
  }
  const given = req.body && typeof req.body.password === 'string' ? req.body.password : '';
  if (!safeEqual(given, PASSWORD)) return res.status(401).json({ error: 'Mật khẩu không đúng.' });
  attempts.delete(req.ip);
  setSession(req, res, false);
  res.json({ ok: true });
});

app.post('/api/logout', noStore, (req, res) => {
  setSession(req, res, true);
  res.json({ ok: true });
});

const upload = multer({
  storage: multer.diskStorage({
    destination: TMP_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex') + '.upload'),
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
});

// Nhận diện loại file theo nội dung, không tin tên file
async function sniff(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(1024);
    const { bytesRead } = await fh.read(buf, 0, 1024, 0);
    const b = buf.subarray(0, bytesRead);
    if (b.includes(Buffer.from('%PDF-'))) return 'pdf';
    if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
    if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
    if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
    return null;
  } finally {
    await fh.close();
  }
}

app.post('/api/files', noStore, requireAdmin, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'File nặng hơn ' + MAX_UPLOAD_MB + ' MB. Hãy nén hoặc tách file rồi thử lại.'
        : 'Không nhận được file. Hãy thử lại.';
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'Chưa chọn file.' });
    try {
      const ext = await sniff(req.file.path);
      if (!ext) {
        await fsp.unlink(req.file.path).catch(() => {});
        return res.status(400).json({ error: 'Chỉ nhận file PDF hoặc ảnh PNG, JPG, WebP.' });
      }
      const id = crypto.randomBytes(12).toString('hex') + '.' + ext;
      await fsp.rename(req.file.path, path.join(FILES_DIR, id));
      res.json({ id, type: ext === 'pdf' ? 'pdf' : 'img' });
    } catch (e) {
      console.error(e);
      await fsp.unlink(req.file.path).catch(() => {});
      res.status(500).json({ error: 'Không lưu được file. Hãy thử lại.' });
    }
  });
});

app.put('/api/book', noStore, requireAdmin, async (req, res) => {
  const v = validateBook(req.body);
  if (typeof v === 'string') return res.status(400).json({ error: v });
  try {
    await writeBook(Object.assign(v, { updatedAt: Date.now() }));
    res.json(book);
    collectGarbage().catch(e => console.error(e));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Không lưu được sách. Hãy thử lại.' });
  }
});

// File trang sách: tên file không bao giờ đổi nội dung nên cho trình duyệt lưu đệm lâu dài
app.use('/files', express.static(FILES_DIR, { index: false, immutable: true, maxAge: '365d' }));

const vendor = {
  'pdf.min.js': require.resolve('pdfjs-dist/build/pdf.min.js'),
  'pdf.worker.min.js': require.resolve('pdfjs-dist/build/pdf.worker.min.js'),
  'page-flip.browser.js': path.join(path.dirname(require.resolve('page-flip/package.json')), 'dist/js/page-flip.browser.js'),
};
app.get('/vendor/:name', (req, res) => {
  const f = vendor[req.params.name];
  if (!f) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=604800');
  res.sendFile(f);
});

const PUBLIC_DIR = path.join(__dirname, 'public');
app.get('/admin', noStore, (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});
app.use(express.static(PUBLIC_DIR, { index: 'index.html', extensions: [] }));

app.use((req, res) => res.status(404).send('Không tìm thấy trang.'));

app.listen(PORT, () => console.log('Ebook đang chạy ở cổng ' + PORT + ', dữ liệu lưu tại ' + DATA_DIR));
