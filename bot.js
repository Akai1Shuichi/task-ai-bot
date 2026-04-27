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
const CONFIG_PATH = path.resolve(process.cwd(), "config.json");
const CODEX_SESSION_PATH = path.resolve(process.cwd(), ".codex-session.json");
let activeCodexRun = null;

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
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("Failed to clear Codex session state:", err.message);
    }
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
      return `${event.type === "item.started" ? "Running" : "Finished"}: ${command}${exit}`;
    }
  }

  if (event.type === "turn.started") return "Codex started.";
  if (event.type === "turn.completed") return "Codex finished.";

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

      try {
        const event = JSON.parse(cleanLine);
        if (onEvent) onEvent(event);
        const text = extractCodexEventText(event);
        if (text) onText(stripAnsi(String(text)));
      } catch {
        onText(cleanLine);
      }
    }
  };
}

async function safeEditMessage(chatId, messageId, text) {
  try {
    await bot.editMessageText(trimForTelegram(text) || "Running...", {
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
  const clean = text || "Done";
  for (let i = 0; i < clean.length; i += TELEGRAM_LIMIT) {
    await bot.sendMessage(chatId, clean.slice(i, i + TELEGRAM_LIMIT));
  }
}

async function runCodexRealtime(chatId, task) {
  const projectPath = getProjectPath();
  const todoPath = getTodoPath();
  const prompt = `Read ${todoPath} and complete task ${task}`;
  const savedSession = readCodexSession(projectPath);
  const liveMessage = await bot.sendMessage(
    chatId,
    `Running ${task}\n\n${
      savedSession ? "Resuming Codex session..." : "Starting Codex session..."
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
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  let lastEdit = 0;
  let finished = false;
  let flushTimer = null;
  let activeThreadId = savedSession?.threadId || "";
  let sessionLineAdded = false;

  const flush = async (force = false) => {
    const now = Date.now();
    if (!force && now - lastEdit < EDIT_INTERVAL_MS) return;
    lastEdit = now;
    await safeEditMessage(
      chatId,
      liveMessage.message_id,
      `Running ${task}\n\n${trimForTelegram(output) || "Waiting for output..."}`,
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

  const onCodexEvent = (event) => {
    const threadId = extractCodexThreadId(event);
    if (!isCodexThreadId(threadId)) return;

    activeThreadId = threadId;
    saveCodexSession(projectPath, threadId);

    if (!sessionLineAdded) {
      sessionLineAdded = true;
      append(
        `${savedSession ? "Resumed" : "Started"} Codex session ${threadId}.`,
      );
    }
  };

  const parseStdout = createCodexOutputParser(append, onCodexEvent);
  const parseStderr = createCodexOutputParser(append, onCodexEvent);

  child.stdout.on("data", (chunk) => parseStdout(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => parseStderr(chunk.toString("utf8")));

  const timeout = setTimeout(() => {
    append(`Codex timed out after ${RUN_TIMEOUT_MS / 60000} minutes.`);
    child.kill("SIGTERM");
  }, RUN_TIMEOUT_MS);

  child.on("error", (err) => {
    append(`Failed to start Codex: ${err.message}`);
  });

  await new Promise((resolve) => {
    child.on("close", async (code, signal) => {
      try {
        finished = true;
        clearTimeout(timeout);
        if (flushTimer) clearTimeout(flushTimer);

        if (
          code !== 0 &&
          savedSession &&
          /not found|no such|failed to load/i.test(output)
        ) {
          clearCodexSession();
          append(
            "Saved Codex session was invalid. Run /run again to start a new session.",
          );
        } else if (code === 0 && activeThreadId) {
          saveCodexSession(projectPath, activeThreadId);
        }

        const status =
          code === 0
            ? "Done"
            : `Stopped${signal ? ` by ${signal}` : ""}${
                code === null ? "" : ` with code ${code}`
              }`;
        const finalText = `${status}: ${task}\n\n${
          trimForTelegram(output) || "No output."
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
  bot.sendMessage(msg.chat.id, "Ready. Use /tasks or /run 1.1");
});

bot.onText(/\/tasks/, (msg) => {
  if (!auth(msg)) return;
  bot.sendMessage(msg.chat.id, readTodo());
});

bot.onText(/\/run (.+)/, (msg, match) => {
  if (!auth(msg)) return;
  if (activeCodexRun) {
    return bot.sendMessage(
      msg.chat.id,
      "Codex is already running. Wait for it to finish before using /run again.",
    );
  }

  const id = match[1].trim();
  const task = findTask(id);
  if (!task) return bot.sendMessage(msg.chat.id, "Task not found");

  activeCodexRun = runCodexRealtime(msg.chat.id, task)
    .catch((err) => {
      bot.sendMessage(msg.chat.id, `Failed to run Codex: ${err.message}`);
    })
    .finally(() => {
      activeCodexRun = null;
    });
});
