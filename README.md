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

## Commands

- `/start` - màn hình welcome và onboarding ngắn
- `/help` - hướng dẫn dùng bot
- `/tasks` - xem danh sách task và nút `Run`
- `/run <id>` - chạy task theo id, ví dụ `/run 2` hoặc `/run 1.3`
- `/status` - xem trạng thái Codex hiện tại
- `/stop` - dừng job đang chạy hoặc xóa session đã lưu
- `/approve_commit` - yêu cầu Codex kiểm tra diff và tạo commit nếu phù hợp

## Current Behavior

- Bot đọc project path từ `bot/config.json`
- Bot đọc `todo.md` của project để lấy task
- `/tasks` hiển thị task dễ đọc hơn và có inline button `Run`
- Bot giữ lại Codex thread id giữa các lần chạy
- Bot stream output chạy task về Telegram
- Bot validate startup config trước khi bắt đầu polling

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
