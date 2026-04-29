import {
  ALLOWED_CHAT_ID,
  KEYBOARD_LABELS,
  TELEGRAM_BOT_TOKEN,
} from "./constants.js";
import {
  getProjectPath,
  getTodoPath,
  readTodo,
  validateStartupConfig,
} from "./config.js";
import { createCodexService } from "./codex.js";
import { createDiffViewerService } from "./diff-viewer.js";
import { approveCommitForTask, ensureProjectGitRepo } from "./git.js";
import {
  clearCodexSession,
  readCodexSession,
  saveCodexSession,
} from "./session.js";
import { createTelegramService } from "./telegram.js";
import { createTodoService, formatTaskForCommitMessage } from "./todo.js";

export async function bootstrapBot() {
  const telegram = createTelegramService({
    token: TELEGRAM_BOT_TOKEN,
    allowedChatId: ALLOWED_CHAT_ID,
  });
  const todo = createTodoService({ readTodo });

  function getGitReadyMessage(result) {
    if (!result?.ok) {
      return `❌ Không thể tự tạo git repo cho project: ${result?.error || "lỗi không xác định"}`;
    }
    if (!result.initialized) return "";
    return [
      "🆕 Project chưa có git repo.",
      `Đã tự chạy \`git init\` tại: ${getProjectPath()}`,
    ].join("\n");
  }

  function ensureGitReady(chatId = "") {
    const result = ensureProjectGitRepo(getProjectPath());
    if (!result.ok && chatId) {
      telegram.sendBotMessage(chatId, getGitReadyMessage(result));
    }
    if (result.ok && result.initialized && chatId) {
      telegram.sendBotMessage(chatId, getGitReadyMessage(result));
    }
    return result;
  }

  async function sendApproveCommitPrompt(chatId, task) {
    if (!task) return;

    const diffLines = [
      `🌐 Diff viewer: ${diffViewer.getDiffViewerUrl()}`,
      diffViewer.getDiffViewerPublicUrl()
        ? `🚀 Public diff: ${diffViewer.getDiffViewerPublicUrl()}`
        : "🚧 Public diff: chưa khả dụng",
    ];
    const inlineKeyboard = [];

    if (diffViewer.getDiffViewerPublicUrl()) {
      inlineKeyboard.push([
        {
          text: "🚀 Mở Diff Viewer",
          url: diffViewer.getDiffViewerPublicUrl(),
        },
      ]);
    }

    inlineKeyboard.push([
      {
        text: "✅ Commit luôn",
        callback_data: "approve_commit",
      },
    ]);

    await telegram.bot.sendMessage(
      chatId,
      [
        "✅ Codex đã hoàn tất task.",
        `🧩 Task gần nhất: ${formatTaskForCommitMessage(task)}`,
        "",
        ...diffLines,
        "",
        "Bạn có muốn commit luôn không?",
      ].join("\n"),
      {
        reply_markup: {
          inline_keyboard: inlineKeyboard,
        },
      },
    );
  }

  const codex = createCodexService({
    bot: telegram.bot,
    getProjectPath,
    getTodoPath,
    readCodexSession,
    saveCodexSession,
    clearCodexSession,
    sendBotMessage: telegram.sendBotMessage,
    safeEditMessage: telegram.safeEditMessage,
    sendLongMessage: telegram.sendLongMessage,
    sendApproveCommitPrompt,
  });

  const diffViewer = createDiffViewerService({
    getProjectPath,
    requestDiffExplanation: ({ task, prompt }) =>
      codex.queueDiffExplanation(ALLOWED_CHAT_ID, task, prompt),
  });

  function approveCommitForLastTask() {
    return approveCommitForTask(
      getProjectPath(),
      codex.getLastCompletedTask(),
      formatTaskForCommitMessage,
    );
  }

  function getWelcomeText() {
    const tasks = todo.parseTodoTasks();
    const openCount = tasks.filter((task) => !task.done).length;
    const savedSession = readCodexSession(getProjectPath());

    return [
      "🤖 Bot Codex Todo đã sẵn sàng.",
      "",
      "Bot này sẽ đọc `todo.md` của project và chạy Codex theo từng task.",
      "",
      "🚀 Bắt đầu nhanh:",
      "1. Dùng /tasks để xem danh sách task",
      "2. Dùng /run <id> hoặc bấm nút Run để chạy task",
      "3. Dùng /status để xem tiến trình hoặc /stop để dừng",
      "",
      `📁 Project: ${getProjectPath()}`,
      `📝 Todo file: ${getTodoPath()}`,
      `🌐 Diff viewer: ${diffViewer.getDiffViewerUrl()}`,
      diffViewer.getDiffViewerPublicUrl()
        ? `🚀 Public link: ${diffViewer.getDiffViewerPublicUrl()}`
        : "🚧 Public link: chưa khả dụng",
      `📌 Task đang mở: ${openCount}/${tasks.length}`,
      `🧵 Thread đã lưu: ${savedSession?.threadId || "không có"}`,
      "",
      `⌨️ Nút nhanh bên dưới: ${KEYBOARD_LABELS.tasks}, ${KEYBOARD_LABELS.status}, ${KEYBOARD_LABELS.help}, ${KEYBOARD_LABELS.stop}`,
      "ℹ️ Nếu cần xem chi tiết hơn, dùng /help",
    ].join("\n");
  }

  function getHelpText() {
    return [
      "🤖 Bot này chạy Codex cho project được cấu hình trong config.",
      "",
      "🧭 Các lệnh hỗ trợ:",
      "/start - kiểm tra bot đang sẵn sàng",
      "/help - xem hướng dẫn và mô tả lệnh",
      "/diff - xem link diff viewer và nút mở link",
      "/tasks - xem danh sách task trong todo.md",
      "/run <id> - chạy task theo id, ví dụ /run 1 hoặc /run 1.2",
      "/reply <nội dung> - gửi prompt follow-up cho Codex trong thread hiện tại",
      "/status - xem Codex có đang chạy hay không",
      "/stop - dừng task Codex đang chạy hoặc xóa thread đã lưu",
      "/approve_commit - yêu cầu Codex kiểm tra diff và tạo commit nếu phù hợp",
      "",
      "🚀 Flow dùng nhanh:",
      "1. Dùng /tasks để xem task",
      "2. Dùng /run <id> để chạy task",
      "3. Dùng /status để kiểm tra tiến trình",
      "4. Dùng /stop nếu cần dừng",
      "",
      "⌨️ Nút nhanh:",
      `- ${KEYBOARD_LABELS.tasks}`,
      `- ${KEYBOARD_LABELS.status}`,
      `- ${KEYBOARD_LABELS.help}`,
      `- ${KEYBOARD_LABELS.stop}`,
      "",
      "📁 Config hiện tại:",
      `- Project path: ${getProjectPath()}`,
      `- Todo file: ${getTodoPath()}`,
      `- Diff viewer: ${diffViewer.getDiffViewerUrl()}`,
      `- Public diff link: ${diffViewer.getDiffViewerPublicUrl() || "chưa khả dụng"}`,
    ].join("\n");
  }

  function registerHandlers() {
    telegram.bot.onText(/\/start/, (msg) => {
      if (!telegram.auth(msg)) return;
      telegram.sendBotMessage(msg.chat.id, getWelcomeText());
    });

    telegram.bot.onText(/^\/help(?:@\w+)?$/, (msg) => {
      if (!telegram.auth(msg)) return;
      telegram.sendBotMessage(msg.chat.id, getHelpText());
    });

    telegram.bot.onText(/^\/diff(?:@\w+)?$/, (msg) => {
      if (!telegram.auth(msg)) return;
      const payload = diffViewer.getLinkMessage();
      telegram.bot.sendMessage(msg.chat.id, payload.text, payload.options);
    });

    telegram.bot.onText(/\/tasks/, (msg) => {
      if (!telegram.auth(msg)) return;
      const payload = todo.getTasksMessagePayload();
      telegram.sendBotMessage(msg.chat.id, payload.text, payload.options);
    });

    telegram.bot.onText(/^\/status(?:@\w+)?$/, (msg) => {
      if (!telegram.auth(msg)) return;
      telegram.sendBotMessage(msg.chat.id, codex.getStatusText());
    });

    telegram.bot.onText(/\/run (.+)/, (msg, match) => {
      if (!telegram.auth(msg)) return;
      const gitReady = ensureGitReady(msg.chat.id);
      if (!gitReady.ok) return;
      const id = match[1].trim();
      const task = todo.findTask(id);
      if (!task) {
        return telegram.sendBotMessage(msg.chat.id, "Không tìm thấy tác vụ.");
      }
      codex.startTask(msg.chat.id, task);
    });

    telegram.bot.onText(/^\/reply(?:@\w+)?\s+([\s\S]+)$/, (msg, match) => {
      if (!telegram.auth(msg)) return;
      return codex.startFollowup(msg.chat.id, match[1].trim());
    });

    telegram.bot.onText(/^\/approve_commit(?:@\w+)?$/, (msg) => {
      if (!telegram.auth(msg)) return;
      if (codex.isRunning()) {
        return telegram.sendBotMessage(
          msg.chat.id,
          "⏳ Codex đang chạy. Hãy đợi hoàn tất hoặc dùng /stop.",
        );
      }

      const result = approveCommitForLastTask();
      return telegram.sendBotMessage(msg.chat.id, result.message);
    });

    telegram.bot.onText(/^\/stop(?:@\w+)?$/, async (msg) => {
      if (!telegram.auth(msg)) return;
      return codex.stopActiveJob(msg.chat.id);
    });

    telegram.bot.onText(/^(?:🧾\s+)?Tasks$/i, (msg) => {
      if (!telegram.auth(msg)) return;
      const payload = todo.getTasksMessagePayload();
      telegram.sendBotMessage(msg.chat.id, payload.text, payload.options);
    });

    telegram.bot.onText(/^(?:📊\s+)?Status$/i, (msg) => {
      if (!telegram.auth(msg)) return;
      telegram.sendBotMessage(msg.chat.id, codex.getStatusText());
    });

    telegram.bot.onText(/^(?:🆘\s+)?Help$/i, (msg) => {
      if (!telegram.auth(msg)) return;
      telegram.sendBotMessage(msg.chat.id, getHelpText());
    });

    telegram.bot.onText(/^(?:🛑\s+)?Stop$/i, async (msg) => {
      if (!telegram.auth(msg)) return;
      return codex.stopActiveJob(msg.chat.id);
    });

    telegram.bot.on("callback_query", async (query) => {
      const message = query.message;
      const data = query.data || "";
      const chatId = message?.chat?.id;

      if (!message || !chatId || !telegram.auth(message)) {
        if (query.id) {
          await telegram.bot.answerCallbackQuery(query.id, {
            text: "Không được phép dùng bot này.",
          });
        }
        return;
      }

      if (data === "approve_commit") {
        if (codex.isRunning()) {
          if (query.id) {
            await telegram.bot.answerCallbackQuery(query.id, {
              text: "⏳ Codex vẫn đang chạy. Chưa thể commit.",
            });
          }
          return;
        }

        if (query.id) {
          await telegram.bot.answerCallbackQuery(query.id, {
            text: "✅ Đang tạo commit",
          });
        }

        const result = approveCommitForLastTask();
        await telegram.sendBotMessage(chatId, result.message);
        return;
      }

      if (!data.startsWith("run:")) {
        if (query.id) {
          await telegram.bot.answerCallbackQuery(query.id);
        }
        return;
      }

      const id = data.slice(4).trim();
      const nextOpenTask = todo.getNextOpenTask();
      if (!nextOpenTask || nextOpenTask.id !== id) {
        if (query.id) {
          await telegram.bot.answerCallbackQuery(query.id, {
            text: nextOpenTask
              ? `Task khả dụng hiện tại là ${nextOpenTask.id}. Hãy dùng nút Run mới nhất.`
              : "Không còn task mở nào để chạy.",
            show_alert: true,
          });
        }
        return;
      }

      const task = todo.findTask(id);

      if (!task) {
        if (query.id) {
          await telegram.bot.answerCallbackQuery(query.id, {
            text: `Không tìm thấy task ${id}.`,
            show_alert: true,
          });
        }
        return;
      }

      const gitReady = ensureGitReady(chatId);
      if (!gitReady.ok) {
        if (query.id) {
          await telegram.bot.answerCallbackQuery(query.id, {
            text: "Không thể chuẩn bị git repo.",
            show_alert: true,
          });
        }
        return;
      }

      if (codex.isRunning()) {
        if (query.id) {
          await telegram.bot.answerCallbackQuery(query.id, {
            text: "⏳ Codex đang chạy. Hãy đợi hoàn tất hoặc dùng /stop.",
          });
        }
        return;
      }

      if (query.id) {
        await telegram.bot.answerCallbackQuery(query.id, {
          text: `▶️ Đang chạy task ${id}`,
        });
      }

      codex.startTask(chatId, task);
    });
  }

  validateStartupConfig();
  registerHandlers();
  await diffViewer.start();
  await telegram.setupTelegramCommands();
  await telegram.bot.startPolling();
}
