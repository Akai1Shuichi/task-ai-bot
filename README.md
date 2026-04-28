# Codex Todo Telegram Bot

Telegram bot để chạy Codex theo từng task trong `todo.md` của một project local.

Bot này phù hợp cho flow:
- bạn có một project local
- bạn ghi task trong `todo.md`
- bạn dùng Telegram để xem task, chạy task, theo dõi trạng thái, dừng job, và approve commit

## Repo Structure

- [bot/](/home/trtoan/Documents/GIAITRI/CONTENT/botAITodo/bot) - Telegram bot
- [project/](/home/trtoan/Documents/GIAITRI/CONTENT/botAITodo/project) - project demo mẫu

## Requirements

- Node.js 18+
- `codex` CLI có sẵn trong `PATH`
- Telegram bot token từ BotFather
- Telegram chat id được phép dùng bot

## Setup

1. Cài dependencies:

```bash
cd bot
npm install
```

2. Tạo file env từ mẫu:

```bash
cp .env.example .env
```

Điền các giá trị:
- `TELEGRAM_BOT_TOKEN`
- `ALLOWED_CHAT_ID`
- `DIFF_VIEWER_TUNNEL` - chọn cách public diff viewer, xem mục `Diff Viewer Tunnel` bên dưới

3. Tạo config từ mẫu:

```bash
cp config.example.json config.json
```

Sửa:
- `path`: đường dẫn tuyệt đối tới project bạn muốn Codex làm việc trên
- `todoFile`: file task bên trong project đó, mặc định là `todo.md`

4. Chạy bot:

```bash
node bot.js
```

## Diff Viewer Tunnel

Bot có thể public diff viewer local ra internet để bạn mở từ Telegram. Cấu hình này dùng biến môi trường `DIFF_VIEWER_TUNNEL`.

Các giá trị hỗ trợ:
- `none` - tắt public tunnel
- `cloudflared` - dùng Cloudflare Tunnel
- `ngrok` - dùng ngrok
- `auto` - bot thử `cloudflared` trước, nếu không có thì thử `ngrok`

Ví dụ trong `.env`:

```env
DIFF_VIEWER_TUNNEL=cloudflared
```

Lưu ý:
- Repo này không tự cài tunnel tool giúp bạn.
- Khi bật `cloudflared` hoặc `ngrok`, binary tương ứng phải được cài sẵn và có trong `PATH`.
- Bot hiện gọi trực tiếp CLI hệ thống, không dùng package npm để mở tunnel.

### Cài `cloudflared`

Phù hợp nếu bạn muốn mở nhanh một public URL dạng `trycloudflare.com` cho local development.

1. Cài `cloudflared` theo hướng dẫn chính thức của Cloudflare:
   https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
2. Kiểm tra đã cài xong:

```bash
cloudflared --version
```

3. Đặt trong `.env`:

```env
DIFF_VIEWER_TUNNEL=cloudflared
```

Bot sẽ chạy lệnh tương đương:

```bash
cloudflared tunnel --url http://127.0.0.1:3210 --no-autoupdate
```

Tham khảo quick tunnel của Cloudflare:
https://developers.cloudflare.com/tunnel/setup/

### Cài `ngrok`

Phù hợp nếu bạn đã dùng ngrok sẵn hoặc muốn dùng account/auth token của ngrok.

1. Cài `ngrok` theo hướng dẫn chính thức:
   https://ngrok.com/docs/getting-started
2. Nếu ngrok yêu cầu, thêm auth token vào máy:

```bash
ngrok config add-authtoken <your-token>
```

3. Kiểm tra đã cài xong:

```bash
ngrok help
```

4. Đặt trong `.env`:

```env
DIFF_VIEWER_TUNNEL=ngrok
```

Bot sẽ chạy `ngrok http http://127.0.0.1:3210 --log stdout` và đọc public URL từ local API của ngrok.

### Cấu hình đề xuất

- Muốn đơn giản, không cần account: dùng `DIFF_VIEWER_TUNNEL=cloudflared`
- Đã có ngrok account hoặc muốn giữ flow cũ: dùng `DIFF_VIEWER_TUNNEL=ngrok`
- Muốn bot tự chọn theo tool nào đang có sẵn trên máy: dùng `DIFF_VIEWER_TUNNEL=auto`
- Không cần truy cập diff viewer từ ngoài: dùng `DIFF_VIEWER_TUNNEL=none`

## Commands

- `/start` - màn hình welcome và onboarding ngắn
- `/help` - hướng dẫn dùng bot
- `/tasks` - xem danh sách task và nút `Run`
- `/run <id>` - chạy task theo id, ví dụ `/run 2` hoặc `/run 1.3`
- `/reply <nội dung>` - gửi prompt follow-up cho Codex trong thread hiện tại
- `/status` - xem trạng thái Codex hiện tại
- `/stop` - dừng job đang chạy hoặc xóa session đã lưu
- `/approve_commit` - yêu cầu Codex kiểm tra diff và tạo commit nếu phù hợp

## Current Behavior

- Bot đọc project path từ `bot/config.json`
- Bot đọc `todo.md` của project để lấy task
- `/tasks` hiển thị task dễ đọc hơn và có inline button `Run`
- Bot giữ lại Codex thread id giữa các lần chạy
- `/reply <nội dung>` gửi prompt follow-up vào thread Codex đã lưu
- Bot stream output chạy task về Telegram
- Bot validate startup config trước khi bắt đầu polling

## Follow-up Sau Khi Chạy Task

Sau khi chạy `/run <id>`, bot sẽ lưu `threadId` của Codex. Từ đó có thể gửi prompt follow-up trực tiếp trong cùng thread.

```bash
/reply Sửa lại phần step 1, UI còn rối và đổi nút save thành màu xanh đậm.
```

Ví dụ khác:

```bash
/reply Giải thích đoạn code vừa sửa trong auth middleware.
/reply Tóm tắt phần changes vừa làm.
/reply Sửa lại step 1 theo góp ý mới của dev.
```

Lưu ý:
- `/reply` chỉ hoạt động khi đã có thread Codex được lưu từ lần chạy trước.
- Nếu chưa từng chạy `/run`, bot sẽ yêu cầu chạy task trước.
- Trong lúc Codex đang chạy, cần đợi xong hoặc dùng `/stop` trước khi gửi `/reply`.

## Security Notes

- Bot chỉ trả lời chat id khớp với `ALLOWED_CHAT_ID`
- Không commit `.env`
- Không dùng bot này cho máy hoặc project mà bạn không tin tưởng mức truy cập của Codex

## Limitations

- Hiện chỉ hỗ trợ một chat được phép dùng bot
- Hiện chỉ xử lý một Codex job tại một thời điểm
- Chưa có flow approve plan trước khi sửa file
- Chưa có UI cấu hình trong Telegram
- `config.json` hiện dùng đường dẫn tuyệt đối

## Demo Project

Thư mục [project/](/home/trtoan/Documents/GIAITRI/CONTENT/botAITodo/project) chỉ là ví dụ tối thiểu để test bot. README riêng của project demo nằm ở [project/README.md](/home/trtoan/Documents/GIAITRI/CONTENT/botAITodo/project/README.md).
