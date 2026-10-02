# Ebook lật trang

Trang web cho một quyển sách dạng lật trang, gồm hai phần:

- `/` là trang công khai để mọi người đọc sách.
- `/admin` là trang soạn sách, vào bằng mật khẩu.

Ở trang soạn, bạn tải lên file PDF hoặc ảnh (PNG, JPG, WebP), sắp xếp, thay, xoá trang rồi bấm **Lưu**. Trang công khai tự nạp bản mới trong khoảng 10 giây, người đang đọc không cần tải lại trang.

## Chạy trên máy

Cần Node.js 18 trở lên.

```bash
npm install
ADMIN_PASSWORD='mat-khau-cua-ban' npm start
```

Mở `http://localhost:3000` để đọc và `http://localhost:3000/admin` để soạn.

## Chạy bằng Docker

```bash
cp .env.example .env      # rồi sửa ADMIN_PASSWORD trong .env
docker compose up -d --build
```

Container nghe ở `127.0.0.1:3008` trên máy chủ, dùng reverse proxy (Nginx, Caddy) trỏ tên miền vào cổng này. Khi deploy bằng Komodo, điền `ADMIN_PASSWORD` vào ô Environment của stack.

Dữ liệu nằm trong volume `ebook-data` (thư mục `/data` trong container). Sao lưu volume này là sao lưu toàn bộ sách.

## Cấu hình

| Biến môi trường | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `ADMIN_PASSWORD` | bắt buộc | Mật khẩu vào `/admin`, tối thiểu 8 ký tự |
| `PORT` | `3000` | Cổng chạy server |
| `DATA_DIR` | `./data` | Nơi lưu file sách và `book.json` |
| `MAX_UPLOAD_MB` | `100` | Dung lượng tối đa mỗi file tải lên |
| `SESSION_SECRET` | suy ra từ mật khẩu | Khoá ký phiên đăng nhập |

## Khi đưa lên tên miền thật

- Đặt sau reverse proxy có HTTPS (Caddy, Nginx, Traefik). Cookie đăng nhập tự bật cờ `Secure` khi proxy gửi header `X-Forwarded-Proto: https`.
- Nâng giới hạn kích thước request của proxy cho khớp `MAX_UPLOAD_MB`. Với Nginx là `client_max_body_size 100m;`.
- Đổi mật khẩu bằng cách đổi `ADMIN_PASSWORD` rồi khởi động lại. Mọi phiên đăng nhập cũ sẽ hết hiệu lực.

## Cách dùng trang soạn

- **Thêm trang**: chọn một hoặc nhiều file. Nếu đang chọn một trang thì trang mới chèn ngay sau trang đó, nếu không thì thêm vào cuối sách. PDF nhiều trang được thêm toàn bộ.
- **Thêm vào đầu sách**: dùng để thêm bìa.
- **Thay trang**: thay trang đang chọn bằng file mới.
- **Lên trước / Ra sau**: đổi vị trí trang đang chọn.
- **Xoá trang**: bỏ trang đang chọn.
- **Lưu**: ghi thay đổi. Trước khi bấm Lưu, trang công khai vẫn giữ bản cũ.

## Cấu trúc

```
server.js          Server Express: đăng nhập, nhận file, lưu sách
public/index.html  Trang công khai
public/reader.js   Hiển thị sách lật trang, tự cập nhật
public/admin.html  Trang soạn sách
public/admin.js    Thêm, thay, sắp xếp, xoá trang
public/common.js   Nạp PDF, ảnh và vẽ trang (dùng chung)
data/book.json     Tên sách và thứ tự trang
data/files/        File PDF, ảnh đã tải lên
```

File không còn trang nào dùng tới sẽ tự bị xoá sau 6 giờ, mỗi lần bấm Lưu.

Hiệu ứng lật trang dùng thư viện StPageFlip, đọc PDF dùng pdf.js. Cả hai được phục vụ từ chính server nên trang không phụ thuộc CDN (trừ phông chữ Google Fonts, có phông dự phòng).
