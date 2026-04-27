import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";

dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;
const allowed = String(process.env.ALLOWED_CHAT_ID);
const bot = new TelegramBot(token, { polling: true });
const TELEGRAM_LIMIT = 3900;
const EDIT_INTERVAL_MS = 1200;
const RUN_TIMEOUT_MS = 1000 * 60 * 30;
const STOP_FORCE_KILL_MS = 1000 * 8;
const CONFIG_PATH = path.resolve(process.cwd(), "config.json");
const CODEX_SESSION_PATH = path.resolve(process.cwd(), ".codex-session.json");
let activeCodexRun = null;
let activeCodexJob = null;

function auth(msg) {
  return String(msg.chat.id) === allowed;
}

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
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
  const lines = readTodo().split("\n");
  const normalizedId = id.replace(/\.$/, "");

  return lines.find((line) => {
    // 1. Bullet checkbox task: "- [ ] 1 Task", "- [x] 1.2 Task", "* [X] 2.3) Task"
    // 2. Bullet task không checkbox: "- 1 Task", "* 1.2 Task", "- 3) Task"
    // 3. Task bắt đầu trực tiếp bằng số: "1 Task", "1.2 Task", "3) Task", "4. Task"
    const trimmed = line.trim();
    const taskIdMatch =
      trimmed.match(/^[-*]\s+\[\s*[xX]?\s*\]\s+(\d+(?:\.\d+)*)[.)]?\s+/) ||
      trimmed.match(/^[-*]\s+(\d+(?:\.\d+)*)[.)]?\s+/) ||
      trimmed.match(/^(\d+(?:\.\d+)*)[.)]?\s+/);

    return taskIdMatch?.[1] === normalizedId;
  });
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
      "Trạng thái Codex: đang tắt",
      "Không có tác vụ nào đang chạy.",
      `Dự án: ${projectPath}`,
      `Thread: ${savedSession?.threadId || "không có"}`,
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
    `Trạng thái Codex: ${status}`,
    `Tác vụ: ${activeCodexJob.task}`,
    `Thời gian chạy: ${elapsed}`,
    `Dự án: ${projectPath}`,
    `Thread: ${savedSession?.threadId || "không có"}`,
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

async function runCodexRealtime(chatId, task, job, promptOverride = "") {
  const projectPath = getProjectPath();
  const todoPath = getTodoPath();
  const prompt = promptOverride || `Read ${todoPath} and complete task ${task}`;
  const savedSession = readCodexSession(projectPath);
  const liveMessage = await bot.sendMessage(
    chatId,
    `Đang chạy ${task}\n\n${
      savedSession ? "Đang tiếp tục phiên Codex..." : "Đang bắt đầu phiên Codex..."
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
  bot.sendMessage(
    msg.chat.id,
    "Sẵn sàng. Dùng /tasks, /run 1.1, /status, /stop, hoặc /approve_commit",
  );
});

bot.onText(/\/tasks/, (msg) => {
  if (!auth(msg)) return;
  bot.sendMessage(msg.chat.id, readTodo());
});

bot.onText(/^\/status(?:@\w+)?$/, (msg) => {
  if (!auth(msg)) return;
  bot.sendMessage(msg.chat.id, getCodexStatusText());
});

bot.onText(/\/run (.+)/, (msg, match) => {
  if (!auth(msg)) return;
  if (activeCodexRun) {
    return bot.sendMessage(
      msg.chat.id,
      "Codex đang chạy. Hãy đợi hoàn tất hoặc dùng /stop.",
    );
  }

  const id = match[1].trim();
  const task = findTask(id);
  if (!task) return bot.sendMessage(msg.chat.id, "Không tìm thấy tác vụ.");

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

  activeCodexRun = runCodexRealtime(msg.chat.id, task, activeCodexJob)
    .catch((err) => {
      bot.sendMessage(msg.chat.id, `Không thể chạy Codex: ${err.message}`);
    })
    .finally(() => {
      activeCodexRun = null;
      activeCodexJob = null;
    });
});

bot.onText(/^\/approve_commit(?:@\w+)?$/, (msg) => {
  if (!auth(msg)) return;
  if (activeCodexRun) {
    return bot.sendMessage(
      msg.chat.id,
      "Codex đang chạy. Hãy đợi hoàn tất hoặc dùng /stop.",
    );
  }

  const task = "duyệt commit";
  const prompt =
    "The user approved committing the current work. Inspect git status and git diff in this repository. If there are changes, stage the relevant files and create one clear git commit. Only use git commands for status, diff, add, and commit; do not edit files. If there is nothing to commit, report that.";

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

  activeCodexRun = runCodexRealtime(msg.chat.id, task, activeCodexJob, prompt)
    .catch((err) => {
      bot.sendMessage(
        msg.chat.id,
        `Không thể chạy Codex để duyệt commit: ${err.message}`,
      );
    })
    .finally(() => {
      activeCodexRun = null;
      activeCodexJob = null;
    });
});

bot.onText(/^\/stop(?:@\w+)?$/, async (msg) => {
  if (!auth(msg)) return;

  if (!activeCodexJob) {
    const projectPath = getProjectPath();
    const savedSession = readCodexSession(projectPath);
    const cleared = clearCodexSession();
    return bot.sendMessage(
      msg.chat.id,
      savedSession || cleared
        ? "Không có tác vụ Codex nào đang chạy. Đã xóa threadId Codex đã lưu."
        : "Không có tác vụ Codex nào đang chạy. Không có threadId Codex đã lưu để xóa.",
    );
  }

  if (activeCodexJob.stopRequested) {
    return bot.sendMessage(msg.chat.id, "Đã yêu cầu dừng trước đó.");
  }

  activeCodexJob.stopRequested = true;
  activeCodexJob.stopReason = "Đã dừng bởi người dùng";
  activeCodexJob.appendOutput?.(
    "Đã yêu cầu dừng. Đang chờ tiến trình Codex thoát.",
  );
  await activeCodexJob.setLiveStatus?.("Đang dừng");

  if (!activeCodexJob.child) {
    return bot.sendMessage(
      msg.chat.id,
      `Đã yêu cầu dừng: ${activeCodexJob.task}`,
    );
  }

  const signaled = terminateCodexJob(activeCodexJob);
  return bot.sendMessage(
    msg.chat.id,
    signaled
      ? `Đã gửi tín hiệu dừng: ${activeCodexJob.task}\nBot sẽ cập nhật tin nhắn đang chạy khi Codex thoát.`
      : "Tác vụ Codex đang dừng hoặc đã kết thúc.",
  );
});
