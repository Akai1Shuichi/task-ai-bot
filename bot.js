import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { spawn, spawnSync } from "child_process";

dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;
const allowed = String(process.env.ALLOWED_CHAT_ID);
const bot = new TelegramBot(token, { polling: false });
const TELEGRAM_LIMIT = 3900;
const EDIT_INTERVAL_MS = 1200;
const RUN_TIMEOUT_MS = 1000 * 60 * 30;
const STOP_FORCE_KILL_MS = 1000 * 8;
const CONFIG_PATH = path.resolve(process.cwd(), "config.json");
const CODEX_SESSION_PATH = path.resolve(process.cwd(), ".codex-session.json");
const TELEGRAM_COMMANDS = [
  { command: "start", description: "Khởi động bot và xem hướng dẫn nhanh" },
  { command: "help", description: "Xem hướng dẫn dùng bot" },
  { command: "tasks", description: "Xem danh sách task hiện tại" },
  { command: "status", description: "Xem trạng thái phiên Codex" },
  { command: "run", description: "Chạy task theo id, ví dụ /run 1" },
  { command: "stop", description: "Dừng task Codex đang chạy" },
  { command: "approve_commit", description: "Yêu cầu Codex tạo commit" },
];
const KEYBOARD_LABELS = {
  tasks: "🧾 Tasks",
  status: "📊 Status",
  help: "🆘 Help",
  stop: "🛑 Stop",
};
const REPLY_KEYBOARD = {
  keyboard: [
    [{ text: KEYBOARD_LABELS.tasks }, { text: KEYBOARD_LABELS.status }],
    [{ text: KEYBOARD_LABELS.help }, { text: KEYBOARD_LABELS.stop }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};
let activeCodexRun = null;
let activeCodexJob = null;

async function setupTelegramCommands() {
  try {
    await bot.setMyCommands(TELEGRAM_COMMANDS);
  } catch (err) {
    console.error("Failed to register Telegram commands:", err.message);
  }
}

function auth(msg) {
  return String(msg.chat.id) === allowed;
}

function sendBotMessage(chatId, text, options = {}) {
  return bot.sendMessage(chatId, text, {
    reply_markup: REPLY_KEYBOARD,
    ...options,
  });
}

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function validateStartupConfig() {
  const errors = [];

  if (!token || token === "undefined") {
    errors.push("Thiếu TELEGRAM_BOT_TOKEN trong .env.");
  }

  if (!allowed || allowed === "undefined") {
    errors.push("Thiếu ALLOWED_CHAT_ID trong .env.");
  }

  if (!fs.existsSync(CONFIG_PATH)) {
    errors.push(`Không tìm thấy config file: ${CONFIG_PATH}`);
  }

  let config;
  if (!errors.length || fs.existsSync(CONFIG_PATH)) {
    try {
      config = loadConfig();
    } catch (err) {
      errors.push(`Không đọc được config.json: ${err.message}`);
    }
  }

  if (config) {
    if (!config.path || typeof config.path !== "string") {
      errors.push("config.json thiếu trường path hợp lệ.");
    } else {
      const projectPath = path.resolve(config.path);
      if (!fs.existsSync(projectPath)) {
        errors.push(`Project path không tồn tại: ${projectPath}`);
      } else if (!fs.statSync(projectPath).isDirectory()) {
        errors.push(`Project path không phải thư mục: ${projectPath}`);
      }
    }

    const baseProjectPath =
      config.path && typeof config.path === "string"
        ? path.resolve(config.path)
        : process.cwd();
    const todoFile = config.todoFile || "todo.md";
    const todoPath = path.isAbsolute(todoFile)
      ? todoFile
      : path.resolve(baseProjectPath, todoFile);

    if (!fs.existsSync(todoPath)) {
      errors.push(`Todo file không tồn tại: ${todoPath}`);
    } else if (!fs.statSync(todoPath).isFile()) {
      errors.push(`Todo path không phải file: ${todoPath}`);
    }
  }

  const codexCheck = spawnSync("codex", ["--version"], {
    stdio: "ignore",
    shell: false,
  });
  if (codexCheck.error || codexCheck.status !== 0) {
    const detail = codexCheck.error?.message
      ? ` (${codexCheck.error.message})`
      : "";
    errors.push(`Không chạy được lệnh codex${detail}.`);
  }

  if (errors.length) {
    for (const error of errors) {
      console.error(`Startup validation failed: ${error}`);
    }
    process.exit(1);
  }
}

async function bootstrapBot() {
  validateStartupConfig();
  await setupTelegramCommands();
  await bot.startPolling();
}

function getProjectPath() {
  const config = loadConfig();
  return path.resolve(config.path);
}

function getTodoPath() {
  const config = loadConfig();
  const projectPath = getProjectPath();
  const todoFile = config.todoFile || "todo.md";
  return path.isAbsolute(todoFile)
    ? todoFile
    : path.resolve(projectPath, todoFile);
}

function readTodo() {
  return fs.readFileSync(getTodoPath(), "utf8");
}

function parseTodoTasks() {
  const lines = readTodo().split("\n");
  const tasks = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const checkboxMatch = trimmed.match(
      /^[-*]\s+\[\s*([xX]?)\s*\]\s+(\d+(?:\.\d+)*)[.)]?\s+(.+)$/,
    );
    if (checkboxMatch) {
      tasks.push({
        id: checkboxMatch[2],
        text: checkboxMatch[3].trim(),
        done: checkboxMatch[1].toLowerCase() === "x",
        raw: line,
      });
      continue;
    }

    const bulletMatch = trimmed.match(/^[-*]\s+(\d+(?:\.\d+)*)[.)]?\s+(.+)$/);
    if (bulletMatch) {
      tasks.push({
        id: bulletMatch[1],
        text: bulletMatch[2].trim(),
        done: false,
        raw: line,
      });
      continue;
    }

    const plainMatch = trimmed.match(/^(\d+(?:\.\d+)*)[.)]?\s+(.+)$/);
    if (plainMatch) {
      tasks.push({
        id: plainMatch[1],
        text: plainMatch[2].trim(),
        done: false,
        raw: line,
      });
    }
  }

  return tasks;
}

function isCodexThreadId(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function readCodexSession(projectPath) {
  try {
    const state = JSON.parse(fs.readFileSync(CODEX_SESSION_PATH, "utf8"));
    if (state.projectPath !== projectPath) return null;
    if (!isCodexThreadId(state.threadId)) return null;
    return state;
  } catch {
    return null;
  }
}

function saveCodexSession(projectPath, threadId) {
  if (!isCodexThreadId(threadId)) return;

  const state = {
    projectPath,
    threadId,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(CODEX_SESSION_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function clearCodexSession() {
  try {
    fs.unlinkSync(CODEX_SESSION_PATH);
    return true;
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("Failed to clear Codex session state:", err.message);
    }
    return false;
  }
}

function findTask(id) {
  const normalizedId = id.replace(/\.$/, "");
  return parseTodoTasks().find((task) => task.id === normalizedId)?.raw;
}

function getTaskSummaryText(tasks) {
  const doneCount = tasks.filter((task) => task.done).length;
  const openCount = tasks.length - doneCount;

  if (!tasks.length) {
    return "🧾 Không tìm thấy task nào trong todo.md.";
  }

  const lines = [
    `🧾 Danh sách task: ${tasks.length}`,
    `📌 Đang mở: ${openCount} | ✅ Hoàn tất: ${doneCount}`,
    "",
  ];

  for (const task of tasks) {
    const status = task.done ? "✅" : "🟡";
    lines.push(`${status} ${task.id}. ${task.text}`);
  }

  lines.push("");
  lines.push("▶️ Có thể bấm nút Run bên dưới để chạy task chưa hoàn tất.");
  return lines.join("\n");
}

function buildTasksInlineKeyboard(tasks) {
  const openTasks = tasks.filter((task) => !task.done);
  if (!openTasks.length) return undefined;

  return {
    inline_keyboard: openTasks.map((task) => [
      {
        text: `▶️ Run ${task.id}`,
        callback_data: `run:${task.id}`,
      },
    ]),
  };
}

function getTasksMessagePayload() {
  const tasks = parseTodoTasks();
  const inlineKeyboard = buildTasksInlineKeyboard(tasks);

  return {
    text: getTaskSummaryText(tasks),
    options: inlineKeyboard ? { reply_markup: inlineKeyboard } : {},
  };
}

function trimForTelegram(text, limit = TELEGRAM_LIMIT) {
  if (!text) return "";
  if (text.length <= limit) return text;
  return `...${text.slice(text.length - limit + 3)}`;
}

function stripAnsi(text) {
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function isIgnorableCodexOutput(text) {
  return /codex_core::session: failed to record rollout items: thread/i.test(
    text,
  );
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function isChildRunning(child) {
  return child && child.exitCode === null && child.signalCode === null;
}

function getCodexStatusText() {
  const projectPath = getProjectPath();
  const savedSession = readCodexSession(projectPath);

  if (!activeCodexJob) {
    return [
      "📊 Trạng thái Codex: đang tắt",
      "🫥 Không có tác vụ nào đang chạy.",
      `📁 Dự án: ${projectPath}`,
      `🧵 Thread: ${savedSession?.threadId || "không có"}`,
    ].join("\n");
  }

  const child = activeCodexJob.child;
  const running = isChildRunning(child);
  const status = activeCodexJob.stopRequested
    ? "đang dừng"
    : running
      ? "đang chạy"
      : child
        ? "đang hoàn tất"
        : "đang khởi động";
  const elapsed = activeCodexJob.startedAt
    ? formatDuration(Date.now() - activeCodexJob.startedAt)
    : "không rõ";

  return [
    `📊 Trạng thái Codex: ${status}`,
    `🧩 Tác vụ: ${activeCodexJob.task}`,
    `⏱️ Thời gian chạy: ${elapsed}`,
    `📁 Dự án: ${projectPath}`,
    `🧵 Thread: ${savedSession?.threadId || "không có"}`,
  ].join("\n");
}

function getWelcomeText() {
  const tasks = parseTodoTasks();
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
    "/tasks - xem danh sách task trong todo.md",
    "/run <id> - chạy task theo id, ví dụ /run 1 hoặc /run 1.2",
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
  ].join("\n");
}

function signalCodexChild(child, signal) {
  if (!isChildRunning(child)) return false;

  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
    return true;
  } catch (err) {
    if (err.code !== "ESRCH") {
      console.error(`Failed to send ${signal} to Codex:`, err.message);
    }
    return false;
  }
}

function terminateCodexJob(job, signal = "SIGTERM") {
  if (!job?.child) return false;

  const signaled = signalCodexChild(job.child, signal);
  if (signaled && signal === "SIGTERM" && !job.forceKillTimer) {
    const child = job.child;
    job.forceKillTimer = setTimeout(() => {
      if (isChildRunning(child)) {
        signalCodexChild(child, "SIGKILL");
      }
    }, STOP_FORCE_KILL_MS);
  }

  return signaled;
}

function extractCodexEventText(event) {
  if (!event || typeof event !== "object") return "";

  const direct = event.message || event.text || event.delta || event.output;
  if (typeof direct === "string") return direct;

  const item = event.item || event.data || event.msg;
  if (item && typeof item === "object") {
    const itemText =
      item.text ||
      item.delta ||
      item.message ||
      item.output ||
      item.aggregated_output ||
      "";
    if (typeof itemText === "string") return itemText;

    const command = item.command || item.cmd || item.arguments?.cmd;
    if (typeof command === "string") {
      const exit =
        item.exit_code === undefined && item.exitCode === undefined
          ? ""
          : ` (exit ${item.exit_code ?? item.exitCode})`;
      return `${event.type === "item.started" ? "Đang chạy" : "Đã xong"}: ${command}${exit}`;
    }
  }

  if (event.type === "turn.started") return "Codex đã bắt đầu.";
  if (event.type === "turn.completed") return "Codex đã hoàn tất.";

  return "";
}

function extractCodexThreadId(event) {
  if (!event || typeof event !== "object") return "";
  return event.thread_id || event.session_id || event.payload?.id || "";
}

function createCodexOutputParser(onText, onEvent) {
  let pending = "";

  return (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || "";

    for (const line of lines) {
      const cleanLine = stripAnsi(line).trim();
      if (!cleanLine) continue;
      if (isIgnorableCodexOutput(cleanLine)) continue;

      try {
        const event = JSON.parse(cleanLine);
        if (onEvent) onEvent(event);
        const text = extractCodexEventText(event);
        if (text) {
          const cleanText = stripAnsi(String(text));
          if (!isIgnorableCodexOutput(cleanText)) onText(cleanText);
        }
      } catch {
        onText(cleanLine);
      }
    }
  };
}

async function safeEditMessage(chatId, messageId, text) {
  try {
    await bot.editMessageText(trimForTelegram(text) || "Đang chạy...", {
      chat_id: chatId,
      message_id: messageId,
    });
  } catch (err) {
    const description = err?.response?.body?.description || err?.message || "";
    if (!description.includes("message is not modified")) {
      console.error("Failed to edit Telegram message:", description);
    }
  }
}

async function sendLongMessage(chatId, text) {
  const clean = text || "Hoàn tất";
  for (let i = 0; i < clean.length; i += TELEGRAM_LIMIT) {
    await bot.sendMessage(chatId, clean.slice(i, i + TELEGRAM_LIMIT));
  }
}

function startCodexJob(chatId, task, prompt = "") {
  if (activeCodexRun) {
    return sendBotMessage(
      chatId,
      "⏳ Codex đang chạy. Hãy đợi hoàn tất hoặc dùng /stop.",
    );
  }

  activeCodexJob = {
    task,
    child: null,
    stopRequested: false,
    stopReason: "",
    forceKillTimer: null,
    appendOutput: null,
    setLiveStatus: null,
    startedAt: Date.now(),
  };

  activeCodexRun = runCodexRealtime(chatId, task, activeCodexJob, prompt)
    .catch((err) => {
      sendBotMessage(chatId, `Không thể chạy Codex: ${err.message}`);
    })
    .finally(() => {
      activeCodexRun = null;
      activeCodexJob = null;
    });

  return activeCodexRun;
}

async function stopActiveCodexJob(chatId) {
  if (!activeCodexJob) {
    const projectPath = getProjectPath();
    const savedSession = readCodexSession(projectPath);
    const cleared = clearCodexSession();
    return sendBotMessage(
      chatId,
      savedSession || cleared
        ? "🧹 Không có tác vụ Codex nào đang chạy. Đã xóa threadId Codex đã lưu."
        : "🫥 Không có tác vụ Codex nào đang chạy. Không có threadId Codex đã lưu để xóa.",
    );
  }

  if (activeCodexJob.stopRequested) {
    return sendBotMessage(chatId, "🛑 Đã yêu cầu dừng trước đó.");
  }

  activeCodexJob.stopRequested = true;
  activeCodexJob.stopReason = "Đã dừng bởi người dùng";
  activeCodexJob.appendOutput?.(
    "Đã yêu cầu dừng. Đang chờ tiến trình Codex thoát.",
  );
  await activeCodexJob.setLiveStatus?.("Đang dừng");

  if (!activeCodexJob.child) {
    return sendBotMessage(chatId, `🛑 Đã yêu cầu dừng: ${activeCodexJob.task}`);
  }

  const signaled = terminateCodexJob(activeCodexJob);
  return sendBotMessage(
    chatId,
    signaled
      ? `🛑 Đã gửi tín hiệu dừng: ${activeCodexJob.task}\nBot sẽ cập nhật tin nhắn đang chạy khi Codex thoát.`
      : "🫥 Tác vụ Codex đang dừng hoặc đã kết thúc.",
  );
}

async function runCodexRealtime(chatId, task, job, promptOverride = "") {
  const projectPath = getProjectPath();
  const todoPath = getTodoPath();
  const prompt = promptOverride || `Read ${todoPath} and complete task ${task}`;
  const savedSession = readCodexSession(projectPath);
  const liveMessage = await bot.sendMessage(
    chatId,
    `Đang chạy ${task}\n\n${
      savedSession
        ? "Đang tiếp tục phiên Codex..."
        : "Đang bắt đầu phiên Codex..."
    }`,
  );
  const args = savedSession
    ? [
        "exec",
        "resume",
        "--skip-git-repo-check",
        "--json",
        savedSession.threadId,
        prompt,
      ]
    : [
        "exec",
        "--skip-git-repo-check",
        "--sandbox",
        "workspace-write",
        "--json",
        prompt,
      ];
  const child = spawn("codex", args, {
    cwd: projectPath,
    env: process.env,
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  let lastEdit = 0;
  let finished = false;
  let flushTimer = null;
  let activeThreadId = savedSession?.threadId || "";
  let sessionLineAdded = false;
  let liveStatus = "Đang chạy";

  const flush = async (force = false) => {
    const now = Date.now();
    if (!force && now - lastEdit < EDIT_INTERVAL_MS) return;
    lastEdit = now;
    await safeEditMessage(
      chatId,
      liveMessage.message_id,
      `${liveStatus}: ${task}\n\n${
        trimForTelegram(output) || "Đang chờ kết quả..."
      }`,
    );
  };

  const scheduleFlush = () => {
    if (flushTimer || finished) return;
    flushTimer = setTimeout(async () => {
      flushTimer = null;
      await flush();
    }, EDIT_INTERVAL_MS);
  };

  const append = (text) => {
    output += text.endsWith("\n") ? text : `${text}\n`;
    scheduleFlush();
  };

  if (job) {
    job.child = child;
    job.appendOutput = append;
    job.setLiveStatus = async (status) => {
      liveStatus = status;
      await flush(true);
    };
    if (job.stopRequested) {
      append(`${job.stopReason || "Đã yêu cầu dừng"}.`);
      terminateCodexJob(job);
    }
  }

  const onCodexEvent = (event) => {
    const threadId = extractCodexThreadId(event);
    if (!isCodexThreadId(threadId)) return;

    activeThreadId = threadId;
    saveCodexSession(projectPath, threadId);

    if (!sessionLineAdded) {
      sessionLineAdded = true;
      append(
        `${savedSession ? "Đã tiếp tục" : "Đã bắt đầu"} phiên Codex ${threadId}.`,
      );
    }
  };

  const parseStdout = createCodexOutputParser(append, onCodexEvent);
  const parseStderr = createCodexOutputParser(append, onCodexEvent);

  child.stdout.on("data", (chunk) => parseStdout(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => parseStderr(chunk.toString("utf8")));

  const timeout = setTimeout(() => {
    if (job) {
      job.stopRequested = true;
      job.stopReason = "Đã dừng do timeout";
    }
    append(`Codex quá thời gian sau ${RUN_TIMEOUT_MS / 60000} phút.`);
    terminateCodexJob(job) || signalCodexChild(child, "SIGTERM");
  }, RUN_TIMEOUT_MS);

  child.on("error", (err) => {
    append(`Không thể khởi động Codex: ${err.message}`);
  });

  await new Promise((resolve) => {
    child.on("close", async (code, signal) => {
      try {
        finished = true;
        clearTimeout(timeout);
        if (flushTimer) clearTimeout(flushTimer);
        if (job?.forceKillTimer) clearTimeout(job.forceKillTimer);

        if (
          code !== 0 &&
          savedSession &&
          /not found|no such|failed to load/i.test(output)
        ) {
          clearCodexSession();
          append(
            "Phiên Codex đã lưu không hợp lệ. Chạy lại /run để bắt đầu phiên mới.",
          );
        } else if (code === 0 && activeThreadId) {
          saveCodexSession(projectPath, activeThreadId);
        }

        const status =
          code === 0
            ? "Hoàn tất"
            : job?.stopReason || job?.stopRequested
              ? job.stopReason || "Đã dừng theo yêu cầu"
              : `Đã dừng${signal ? ` bởi ${signal}` : ""}${
                  code === null ? "" : ` với code ${code}`
                }`;
        if (job?.stopRequested) {
          output += `Tiến trình Codex đã thoát${
            signal ? ` bởi ${signal}` : code === null ? "" : ` với code ${code}`
          }.\n`;
        }
        const finalText = `${status}: ${task}\n\n${
          trimForTelegram(output) || "Không có kết quả."
        }`;
        await safeEditMessage(chatId, liveMessage.message_id, finalText);

        if (output.length > TELEGRAM_LIMIT) {
          await sendLongMessage(chatId, output);
        }
      } catch (err) {
        console.error("Failed to finalize Codex run:", err.message);
      } finally {
        resolve();
      }
    });
  });
}

bot.onText(/\/start/, (msg) => {
  if (!auth(msg)) return;
  sendBotMessage(msg.chat.id, getWelcomeText());
});

bot.onText(/^\/help(?:@\w+)?$/, (msg) => {
  if (!auth(msg)) return;
  sendBotMessage(msg.chat.id, getHelpText());
});

bot.onText(/\/tasks/, (msg) => {
  if (!auth(msg)) return;
  const payload = getTasksMessagePayload();
  sendBotMessage(msg.chat.id, payload.text, payload.options);
});

bot.onText(/^\/status(?:@\w+)?$/, (msg) => {
  if (!auth(msg)) return;
  sendBotMessage(msg.chat.id, getCodexStatusText());
});

bot.onText(/\/run (.+)/, (msg, match) => {
  if (!auth(msg)) return;
  const id = match[1].trim();
  const task = findTask(id);
  if (!task) return sendBotMessage(msg.chat.id, "Không tìm thấy tác vụ.");
  startCodexJob(msg.chat.id, task);
});

bot.onText(/^\/approve_commit(?:@\w+)?$/, (msg) => {
  if (!auth(msg)) return;
  const task = "duyệt commit";
  const prompt =
    "The user approved committing the current work. Inspect git status and git diff in this repository. If there are changes, stage the relevant files and create one clear git commit. Only use git commands for status, diff, add, and commit; do not edit files. If there is nothing to commit, report that.";
  startCodexJob(msg.chat.id, task, prompt);
});

bot.onText(/^\/stop(?:@\w+)?$/, async (msg) => {
  if (!auth(msg)) return;
  return stopActiveCodexJob(msg.chat.id);
});

bot.onText(/^(?:🧾\s+)?Tasks$/i, (msg) => {
  if (!auth(msg)) return;
  const payload = getTasksMessagePayload();
  sendBotMessage(msg.chat.id, payload.text, payload.options);
});

bot.onText(/^(?:📊\s+)?Status$/i, (msg) => {
  if (!auth(msg)) return;
  sendBotMessage(msg.chat.id, getCodexStatusText());
});

bot.onText(/^(?:🆘\s+)?Help$/i, (msg) => {
  if (!auth(msg)) return;
  sendBotMessage(msg.chat.id, getHelpText());
});

bot.onText(/^(?:🛑\s+)?Stop$/i, async (msg) => {
  if (!auth(msg)) return;
  return stopActiveCodexJob(msg.chat.id);
});

bot.on("callback_query", async (query) => {
  const message = query.message;
  const data = query.data || "";
  const chatId = message?.chat?.id;

  if (!message || !chatId || !auth(message)) {
    if (query.id) {
      await bot.answerCallbackQuery(query.id, {
        text: "Không được phép dùng bot này.",
      });
    }
    return;
  }

  if (!data.startsWith("run:")) {
    if (query.id) {
      await bot.answerCallbackQuery(query.id);
    }
    return;
  }

  const id = data.slice(4).trim();
  const task = findTask(id);

  if (!task) {
    if (query.id) {
      await bot.answerCallbackQuery(query.id, {
        text: `Không tìm thấy task ${id}.`,
        show_alert: true,
      });
    }
    return;
  }

  if (activeCodexRun) {
    if (query.id) {
      await bot.answerCallbackQuery(query.id, {
        text: "⏳ Codex đang chạy. Hãy đợi hoàn tất hoặc dùng /stop.",
      });
    }
    return;
  }

  if (query.id) {
    await bot.answerCallbackQuery(query.id, {
      text: `▶️ Đang chạy task ${id}`,
    });
  }

  startCodexJob(chatId, task);
});

bootstrapBot().catch((err) => {
  console.error("Failed to start Telegram bot:", err.message);
  process.exit(1);
});
