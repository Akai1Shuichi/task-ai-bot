import {
  ALLOWED_CHAT_ID,
  CODEX_MODEL_SUGGESTIONS,
  CODEX_REASONING_SUGGESTIONS,
  DEFAULT_CODEX_MODEL,
  KEYBOARD_LABELS,
  TELEGRAM_BOT_TOKEN,
} from "./constants.js";
import {
  getCodexModel,
  getCodexReasoningEffort,
  getProjectPath,
  setCodexModel,
  setCodexReasoningEffort,
  getTodoPath,
  readTodo,
  validateStartupConfig,
} from "./config.js";
import { createCodexService } from "./codex.js";
import { createDiffViewerService } from "./diff-viewer.js";
import {
  approveCommitForTask,
  ensureProjectGitRepo,
  hasGitChanges,
} from "./git.js";
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

  function resolveCommitTaskCandidate(taskOverride = "") {
    const task = taskOverride || codex.getLastCompletedTask();
    if (task) return task;

    return todo.getLastCompletedTaskBeforeNextOpen()?.raw || "";
  }

  function truncateButtonLabel(text, limit = 32) {
    if (!text || text.length <= limit) return text;
    return `${text.slice(0, limit - 3).trimEnd()}...`;
  }

  function buildCommitApprovalPayload(taskOverride = "") {
    const gitChanges = hasGitChanges(getProjectPath());
    if (!gitChanges.ok) {
      return {
        ok: false,
        message: gitChanges.message,
      };
    }

    if (!gitChanges.hasChanges) {
      return {
        ok: true,
        prompt: false,
        message: "🫥 Không có thay đổi nào để commit.",
      };
    }

    const task = resolveCommitTaskCandidate(taskOverride);
    if (!task) {
      return {
        ok: false,
        message:
          "⚠️ Có thay đổi Git nhưng chưa xác định được task hoàn tất để dùng làm commit message.",
      };
    }

    const commitMessage = formatTaskForCommitMessage(task);
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
        text: `✅ Commit: ${truncateButtonLabel(commitMessage)}`,
        callback_data: `commit_task:${commitMessage}`,
      },
    ]);

    return {
      ok: true,
      prompt: true,
      message: [
        "✅ Đã tìm thấy thay đổi Git chưa commit.",
        `🧩 Task dùng làm commit message: ${commitMessage}`,
        "",
        ...diffLines,
        "",
        "Bấm nút bên dưới để tạo commit.",
      ].join("\n"),
      options: {
        reply_markup: {
          inline_keyboard: inlineKeyboard,
        },
      },
    };
  }

  async function sendApproveCommitPrompt(chatId, task) {
    const payload = buildCommitApprovalPayload(task);
    if (!payload.ok || !payload.prompt) {
      if (payload?.message) {
        await telegram.sendBotMessage(chatId, payload.message);
      }
      return;
    }

    await telegram.bot.sendMessage(chatId, payload.message, payload.options);
  }

  const codex = createCodexService({
    bot: telegram.bot,
    getCodexModel,
    getCodexReasoningEffort,
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

  function formatModelLabel() {
    return getCodexModel() || "mặc định của Codex CLI";
  }

  function formatReasoningLabel() {
    return getCodexReasoningEffort() || "mặc định của Codex CLI";
  }

  function getEffectiveModelLabel() {
    return getCodexModel() || `${DEFAULT_CODEX_MODEL} (default)`;
  }

  function getEffectiveReasoningLabel() {
    return getCodexReasoningEffort() || "mặc định của model";
  }

  function buildModelControlPayload() {
    const activeModel = getCodexModel() || DEFAULT_CODEX_MODEL;
    const activeReasoning = getCodexReasoningEffort() || "";
    const lines = [
      `🧠 Model đang dùng: \`${getEffectiveModelLabel()}\``,
      `🧩 Reasoning đang dùng: \`${getEffectiveReasoningLabel()}\``,
      "",
      "Model list:",
      ...CODEX_MODEL_SUGGESTIONS.map((item, index) => {
        const marker = item.id === activeModel ? "›" : " ";
        const tags = [
          item.id === DEFAULT_CODEX_MODEL ? "default" : "",
          item.id === activeModel ? "current" : "",
        ].filter(Boolean);
        const suffix = tags.length ? ` (${tags.join(", ")})` : "";
        return `${marker} ${index + 1}. ${item.id}${suffix}  ${item.label}`;
      }),
      "",
      "Reasoning:",
      ...CODEX_REASONING_SUGGESTIONS.map((item) => {
        const marker = item.id === activeReasoning ? "›" : " ";
        return `${marker} ${item.id}  ${item.label}`;
      }),
    ];

    const inlineKeyboard = [
      ...CODEX_MODEL_SUGGESTIONS.map((item) => [
        {
          text: `${item.id === activeModel ? "✅ " : ""}${item.id}`,
          callback_data: `model_pick:${item.id}`,
        },
      ]),
      [
        {
          text: `${activeReasoning === "minimal" ? "✅ " : ""}minimal`,
          callback_data: "reason_pick:minimal",
        },
        {
          text: `${activeReasoning === "low" ? "✅ " : ""}low`,
          callback_data: "reason_pick:low",
        },
      ],
      [
        {
          text: `${activeReasoning === "medium" ? "✅ " : ""}medium`,
          callback_data: "reason_pick:medium",
        },
        {
          text: `${activeReasoning === "high" ? "✅ " : ""}high`,
          callback_data: "reason_pick:high",
        },
      ],
      [
        {
          text: `${activeReasoning === "xhigh" ? "✅ " : ""}xhigh`,
          callback_data: "reason_pick:xhigh",
        },
      ],
    ];

    return {
      text: lines.join("\n"),
      options: {
        reply_markup: {
          inline_keyboard: inlineKeyboard,
        },
      },
    };
  }

  async function sendModelControl(chatId) {
    const payload = buildModelControlPayload();
    return telegram.bot.sendMessage(chatId, payload.text, payload.options);
  }

  async function refreshModelControl(chatId, messageId) {
    const payload = buildModelControlPayload();
    try {
      return await telegram.bot.editMessageText(payload.text, {
        chat_id: chatId,
        message_id: messageId,
        ...payload.options,
      });
    } catch (err) {
      const description =
        err?.response?.body?.description || err?.message || "";
      if (!description.includes("message is not modified")) {
        throw err;
      }
      return null;
    }
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
      `🧠 Model: ${formatModelLabel()}`,
      `🧩 Reasoning: ${formatReasoningLabel()}`,
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
      "/model - xem và chọn model/reasoning bằng nút",
      "/model <tên> - đổi model thủ công nếu cần",
      "/reason <minimal|low|medium|high|xhigh> - đổi reasoning thủ công nếu cần",
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
      "5. Dùng /model nếu muốn chọn model hoặc reasoning bằng nút",
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
      `- Model: ${formatModelLabel()}`,
      `- Reasoning: ${formatReasoningLabel()}`,
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

    telegram.bot.onText(/^\/models(?:@\w+)?$/, (msg) => {
      if (!telegram.auth(msg)) return;
      return sendModelControl(msg.chat.id);
    });

    telegram.bot.onText(/^\/model(?:@\w+)?(?:\s+(.+))?$/, (msg, match) => {
      if (!telegram.auth(msg)) return;

      const requestedModel = match?.[1]?.trim() || "";
      if (!requestedModel) {
        return sendModelControl(msg.chat.id);
      }

      if (codex.isRunning()) {
        return telegram.sendBotMessage(
          msg.chat.id,
          "⏳ Codex đang chạy. Hãy đợi hoàn tất hoặc dùng /stop trước khi đổi model.",
        );
      }

      const nextModel = /^(default|clear|reset)$/i.test(requestedModel)
        ? ""
        : requestedModel;
      const savedModel = setCodexModel(nextModel);

      return telegram.sendBotMessage(
        msg.chat.id,
        savedModel
          ? `✅ Đã cập nhật model Codex thành \`${savedModel}\`.`
          : "✅ Đã xóa model override. Các lần chạy tiếp theo sẽ dùng model mặc định của Codex CLI.",
      );
    });

    telegram.bot.onText(
      /^\/(?:reason|reasoning)(?:@\w+)?(?:\s+(.+))?$/,
      (msg, match) => {
        if (!telegram.auth(msg)) return;

        const requestedReasoning = match?.[1]?.trim().toLowerCase() || "";
        if (!requestedReasoning) {
          return sendModelControl(msg.chat.id);
        }

        if (codex.isRunning()) {
          return telegram.sendBotMessage(
            msg.chat.id,
            "⏳ Codex đang chạy. Hãy đợi hoàn tất hoặc dùng /stop trước khi đổi reasoning.",
          );
        }

        const nextReasoning = /^(default|clear|reset)$/i.test(requestedReasoning)
          ? ""
          : requestedReasoning;
        const savedReasoning = setCodexReasoningEffort(nextReasoning);

        if (nextReasoning && !savedReasoning) {
          return telegram.sendBotMessage(
            msg.chat.id,
            "⚠️ Reasoning không hợp lệ. Hỗ trợ: `minimal`, `low`, `medium`, `high`, `xhigh`.",
          );
        }

        return telegram.sendBotMessage(
          msg.chat.id,
          savedReasoning
            ? `✅ Đã cập nhật reasoning effort thành \`${savedReasoning}\`.`
            : "✅ Đã xóa reasoning override. Các lần chạy tiếp theo sẽ dùng reasoning mặc định của Codex CLI.",
        );
      },
    );

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

      return sendApproveCommitPrompt(msg.chat.id);
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

      if (
        data.startsWith("model_pick:") ||
        data.startsWith("reason_pick:")
      ) {
        if (codex.isRunning()) {
          if (query.id) {
            await telegram.bot.answerCallbackQuery(query.id, {
              text: "⏳ Codex đang chạy. Hãy đợi xong hoặc /stop trước khi đổi.",
              show_alert: true,
            });
          }
          return;
        }

        if (data.startsWith("model_pick:")) {
          const nextModel = data.slice("model_pick:".length).trim();
          if (getCodexModel() === nextModel) {
            if (query.id) {
              await telegram.bot.answerCallbackQuery(query.id, {
                text: `Model đang là ${nextModel}.`,
              });
            }
            return;
          }
          setCodexModel(nextModel);
        } else if (data.startsWith("reason_pick:")) {
          const nextReasoning = data.slice("reason_pick:".length).trim();
          if (getCodexReasoningEffort() === nextReasoning) {
            if (query.id) {
              await telegram.bot.answerCallbackQuery(query.id, {
                text: `Reasoning đang là ${nextReasoning}.`,
              });
            }
            return;
          }
          const savedReasoning = setCodexReasoningEffort(nextReasoning);
          if (!savedReasoning) {
            if (query.id) {
              await telegram.bot.answerCallbackQuery(query.id, {
                text: "⚠️ Reasoning không hợp lệ.",
                show_alert: true,
              });
            }
            return;
          }
        }

        await refreshModelControl(chatId, message.message_id);

        if (query.id) {
          await telegram.bot.answerCallbackQuery(query.id, {
            text: "✅ Đã cập nhật cấu hình Codex",
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

        const payload = buildCommitApprovalPayload();
        if (query.id) {
          await telegram.bot.answerCallbackQuery(query.id, {
            text: payload.prompt
              ? "📝 Đã tạo nút xác nhận commit"
              : "ℹ️ Không có commit để xác nhận",
          });
        }
        if (payload.prompt) {
          await telegram.bot.sendMessage(chatId, payload.message, payload.options);
        } else if (payload.message) {
          await telegram.sendBotMessage(chatId, payload.message);
        }
        return;
      }

      if (data.startsWith("commit_task:")) {
        if (codex.isRunning()) {
          if (query.id) {
            await telegram.bot.answerCallbackQuery(query.id, {
              text: "⏳ Codex vẫn đang chạy. Chưa thể commit.",
            });
          }
          return;
        }

        const task = data.slice("commit_task:".length).trim();

        if (!task) {
          const payload = buildCommitApprovalPayload();
          if (query.id) {
            await telegram.bot.answerCallbackQuery(query.id, {
              text: payload.prompt
                ? "Bot đang tạo lại nút commit mới."
                : "Nút cũ không còn hiệu lực.",
            });
          }
          if (payload.prompt) {
            await telegram.bot.sendMessage(chatId, payload.message, payload.options);
          } else if (payload.message) {
            await telegram.sendBotMessage(chatId, payload.message);
          }
          return;
        }

        if (query.id) {
          await telegram.bot.answerCallbackQuery(query.id, {
            text: "✅ Đang tạo commit",
          });
        }

        const result = approveCommitForTask(
          getProjectPath(),
          task,
          formatTaskForCommitMessage,
        );
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
