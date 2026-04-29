import "dotenv/config";
import path from "path";

export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
export const ALLOWED_CHAT_ID = String(process.env.ALLOWED_CHAT_ID);

export const TELEGRAM_LIMIT = 3900;
export const EDIT_INTERVAL_MS = 1200;
export const RUN_TIMEOUT_MS = 1000 * 60 * 30;
export const STOP_FORCE_KILL_MS = 1000 * 8;

export const CONFIG_PATH = path.resolve(process.cwd(), "config.json");
export const CODEX_SESSION_PATH = path.resolve(
  process.cwd(),
  ".codex-session.json",
);
export const WEB_ROOT = path.resolve(process.cwd(), "web");

export const DIFF_VIEWER_HOST = process.env.DIFF_VIEWER_HOST || "127.0.0.1";
export const DIFF_VIEWER_PORT = Number(process.env.DIFF_VIEWER_PORT || 3210);
export const DIFF_VIEWER_TUNNEL = process.env.DIFF_VIEWER_TUNNEL || "none";
export const NGROK_API_URL =
  process.env.NGROK_API_URL || "http://127.0.0.1:4040/api/tunnels";

export const TELEGRAM_COMMANDS = [
  { command: "start", description: "Khởi động bot và xem hướng dẫn nhanh" },
  { command: "help", description: "Xem hướng dẫn dùng bot" },
  { command: "diff", description: "Xem link diff viewer hiện tại" },
  { command: "tasks", description: "Xem danh sách task hiện tại" },
  { command: "status", description: "Xem trạng thái phiên Codex" },
  { command: "run", description: "Chạy task theo id, ví dụ /run 1" },
  {
    command: "reply",
    description: "Gửi prompt follow-up cho Codex trong thread hiện tại",
  },
  { command: "stop", description: "Dừng task Codex đang chạy" },
  { command: "approve_commit", description: "Yêu cầu Codex tạo commit" },
];

export const KEYBOARD_LABELS = {
  tasks: "🧾 Tasks",
  status: "📊 Status",
  help: "🆘 Help",
  stop: "🛑 Stop",
};

export const REPLY_KEYBOARD = {
  keyboard: [
    [{ text: KEYBOARD_LABELS.tasks }, { text: KEYBOARD_LABELS.status }],
    [{ text: KEYBOARD_LABELS.help }, { text: KEYBOARD_LABELS.stop }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};
