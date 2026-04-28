import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import fs from "fs";
import http from "http";
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
const WEB_ROOT = path.resolve(process.cwd(), "web");
const DIFF_VIEWER_HOST = process.env.DIFF_VIEWER_HOST || "127.0.0.1";
const DIFF_VIEWER_PORT = Number(process.env.DIFF_VIEWER_PORT || 3210);
const DIFF_VIEWER_TUNNEL = process.env.DIFF_VIEWER_TUNNEL || "none";
const NGROK_API_URL =
  process.env.NGROK_API_URL || "http://127.0.0.1:4040/api/tunnels";
const TELEGRAM_COMMANDS = [
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
let lastCompletedTask = "";
let diffViewerServer = null;
let tunnelProcess = null;
let tunnelPublicUrl = "";
let tunnelProvider = "";

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
  await startDiffViewerServer();
  await startPublicTunnel();
  await setupTelegramCommands();
  await bot.startPolling();
}

function getDiffViewerUrl() {
  return `http://${DIFF_VIEWER_HOST}:${DIFF_VIEWER_PORT}`;
}

function getDiffViewerPublicUrl() {
  return tunnelPublicUrl;
}

function getDiffViewerLinkText() {
  return [
    `🌐 Local diff viewer: ${getDiffViewerUrl()}`,
    getDiffViewerPublicUrl()
      ? `🚀 Public diff viewer: ${getDiffViewerPublicUrl()}`
      : "🚧 Public diff viewer: chưa khả dụng",
  ].join("\n");
}

function getDiffViewerLinkOptions() {
  const inlineKeyboard = [];

  if (getDiffViewerPublicUrl()) {
    inlineKeyboard.push([
      {
        text: "🚀 Mở Diff Viewer",
        url: getDiffViewerPublicUrl(),
      },
    ]);
  }

  return inlineKeyboard.length
    ? {
        reply_markup: {
          inline_keyboard: inlineKeyboard,
        },
      }
    : {};
}

function sendDiffViewerLinkMessage(chatId) {
  return bot.sendMessage(
    chatId,
    [
      "🔎 Diff viewer hiện tại:",
      `🌐 Local: ${getDiffViewerUrl()}`,
      getDiffViewerPublicUrl()
        ? `🚀 Public: ${getDiffViewerPublicUrl()}`
        : "🚧 Public: chưa khả dụng. Hãy kiểm tra tunnel (`ngrok` hoặc `cloudflared`).",
    ].join("\n"),
    getDiffViewerLinkOptions(),
  );
}

function stopTunnelProcess() {
  if (!tunnelProcess || tunnelProcess.exitCode !== null) return;

  try {
    tunnelProcess.kill("SIGTERM");
  } catch (err) {
    console.error("Failed to stop tunnel process:", err.message);
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchNgrokPublicUrl() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(NGROK_API_URL, { cache: "no-store" });
      if (response.ok) {
        const data = await response.json();
        const httpsTunnel = data.tunnels?.find((tunnel) =>
          String(tunnel.public_url || "").startsWith("https://"),
        );
        if (httpsTunnel?.public_url) {
          return httpsTunnel.public_url;
        }
      }
    } catch {
      // Keep retrying while the local API starts up.
    }

    await wait(500);
  }

  return "";
}

function startCloudflaredTunnel() {
  return spawn(
    "cloudflared",
    ["tunnel", "--url", getDiffViewerUrl(), "--no-autoupdate"],
    {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function startNgrokTunnel() {
  return spawn("ngrok", ["http", getDiffViewerUrl(), "--log", "stdout"], {
    cwd: process.cwd(),
    env: process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function startTunnelWithProvider(provider) {
  let child = null;
  let logs = "";
  let resolved = false;

  const captureLogs = (chunk) => {
    logs += chunk.toString("utf8");
    if (logs.length > 6000) {
      logs = logs.slice(-6000);
    }
  };

  try {
    if (provider === "cloudflared") {
      child = startCloudflaredTunnel();
    } else if (provider === "ngrok") {
      child = startNgrokTunnel();
    } else {
      return "";
    }

    tunnelProcess = child;
    tunnelProvider = provider;
    child.stdout.on("data", captureLogs);
    child.stderr.on("data", captureLogs);

    let publicUrl = "";
    if (provider === "cloudflared") {
      publicUrl = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Timed out waiting for cloudflared public URL."));
        }, 15000);

        const onData = (chunk) => {
          const text = chunk.toString("utf8");
          const match = text.match(/https:\/\/[a-z0-9.-]+trycloudflare\.com/i);
          if (match) {
            clearTimeout(timeout);
            child.stdout.off("data", onData);
            child.stderr.off("data", onData);
            resolve(match[0]);
          }
        };

        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        child.once("exit", () => {
          clearTimeout(timeout);
          reject(new Error("cloudflared exited before exposing a public URL."));
        });
      });
    } else if (provider === "ngrok") {
      publicUrl = await fetchNgrokPublicUrl();
      if (!publicUrl) {
        throw new Error("Timed out waiting for ngrok public URL.");
      }
    }

    resolved = true;
    return publicUrl;
  } catch (err) {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
    }
    tunnelProcess = null;
    tunnelProvider = "";
    console.error(
      `Failed to start ${provider} tunnel:`,
      logs.trim() || err.message,
    );
    return "";
  } finally {
    if (!resolved) {
      tunnelPublicUrl = "";
    }
  }
}

async function startPublicTunnel() {
  if (DIFF_VIEWER_TUNNEL === "none") return;

  const providers =
    DIFF_VIEWER_TUNNEL === "auto"
      ? ["cloudflared", "ngrok"]
      : [DIFF_VIEWER_TUNNEL];

  for (const provider of providers) {
    const binary = provider === "cloudflared" ? "cloudflared" : "ngrok";
    const exists = spawnSync(binary, ["--version"], {
      stdio: "ignore",
      shell: false,
    });

    if (exists.status !== 0) continue;

    const publicUrl = await startTunnelWithProvider(provider);
    if (publicUrl) {
      tunnelPublicUrl = publicUrl;
      console.log(`Public diff viewer via ${provider}: ${publicUrl}`);
      process.once("exit", stopTunnelProcess);
      process.once("SIGINT", () => {
        stopTunnelProcess();
        process.exit(0);
      });
      process.once("SIGTERM", () => {
        stopTunnelProcess();
        process.exit(0);
      });
      return;
    }
  }
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

function checkProjectGitRepo(projectPath) {
  const check = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: projectPath,
    encoding: "utf8",
    shell: false,
  });

  return check.status === 0 && check.stdout.trim() === "true";
}

function ensureProjectGitRepo(projectPath) {
  if (checkProjectGitRepo(projectPath)) {
    return { ok: true, initialized: false };
  }

  const init = spawnSync("git", ["init"], {
    cwd: projectPath,
    encoding: "utf8",
    shell: false,
  });

  if (init.status !== 0) {
    const detail =
      init.stderr?.trim() || init.stdout?.trim() || "git init thất bại.";
    return {
      ok: false,
      initialized: false,
      error: detail,
    };
  }

  return { ok: true, initialized: true };
}

function formatTaskForCommitMessage(task) {
  if (!task) return "";

  const trimmed = task.trim();
  const match =
    trimmed.match(/^[-*]\s+\[\s*[xX]?\s*\]\s+((?:\d+(?:\.\d+)*)[.)]?\s+.+)$/) ||
    trimmed.match(/^[-*]\s+((?:\d+(?:\.\d+)*)[.)]?\s+.+)$/) ||
    trimmed.match(/^((?:\d+(?:\.\d+)*)[.)]?\s+.+)$/);

  return (match?.[1] || trimmed).trim();
}

function runGitCommand(projectPath, args) {
  return spawnSync("git", args, {
    cwd: projectPath,
    encoding: "utf8",
    shell: false,
  });
}

function approveCommitForLastTask() {
  const projectPath = getProjectPath();
  const gitState = ensureProjectGitRepo(projectPath);

  if (!gitState.ok) {
    return {
      ok: false,
      message: `❌ Không thể chuẩn bị git repo cho /approve_commit: ${gitState.error}`,
    };
  }

  if (!lastCompletedTask) {
    return {
      ok: false,
      message:
        "⚠️ Chưa có task hoàn tất gần nhất để dùng làm commit message. Hãy chạy /run trước.",
    };
  }

  const status = runGitCommand(projectPath, ["status", "--porcelain"]);
  if (status.status !== 0) {
    const detail =
      status.stderr?.trim() || status.stdout?.trim() || "git status thất bại.";
    return {
      ok: false,
      message: `❌ Không thể đọc git status: ${detail}`,
    };
  }

  if (!status.stdout.trim()) {
    return {
      ok: true,
      message: "🫥 Không có thay đổi nào để commit.",
    };
  }

  const add = runGitCommand(projectPath, ["add", "-A"]);
  if (add.status !== 0) {
    const detail =
      add.stderr?.trim() || add.stdout?.trim() || "git add thất bại.";
    return {
      ok: false,
      message: `❌ Không thể stage thay đổi: ${detail}`,
    };
  }

  const cachedDiff = runGitCommand(projectPath, [
    "diff",
    "--cached",
    "--quiet",
  ]);
  if (cachedDiff.status === 0) {
    return {
      ok: true,
      message: "🫥 Không có thay đổi staged để commit.",
    };
  }

  if (cachedDiff.status !== 1) {
    const detail =
      cachedDiff.stderr?.trim() ||
      cachedDiff.stdout?.trim() ||
      "git diff --cached thất bại.";
    return {
      ok: false,
      message: `❌ Không thể kiểm tra staged diff: ${detail}`,
    };
  }

  const commitMessage = formatTaskForCommitMessage(lastCompletedTask);
  const commit = runGitCommand(projectPath, ["commit", "-m", commitMessage]);
  if (commit.status !== 0) {
    const detail =
      commit.stderr?.trim() || commit.stdout?.trim() || "git commit thất bại.";
    return {
      ok: false,
      message: `❌ Không thể tạo commit: ${detail}`,
    };
  }

  const response = [];
  if (gitState.initialized) {
    response.push(
      `🆕 Project chưa có git repo. Đã chạy \`git init\` tại:\n${projectPath}`,
    );
  }
  response.push(`✅ Đã tạo commit với message: ${commitMessage}`);
  if (commit.stdout.trim()) {
    response.push("");
    response.push(commit.stdout.trim());
  }

  return {
    ok: true,
    message: response.join("\n"),
  };
}

function normalizeStatusPath(rawPath) {
  const clean = rawPath.trim().replace(/^"+|"+$/g, "");
  if (clean.includes(" -> ")) {
    return (
      clean
        .split(" -> ")
        .at(-1)
        ?.replace(/^"+|"+$/g, "") || clean
    );
  }
  return clean;
}

function getUntrackedDiff(projectPath, filePath) {
  const absolutePath = path.resolve(projectPath, filePath);
  const diff = spawnSync(
    "git",
    ["diff", "--no-index", "--no-color", "--", "/dev/null", absolutePath],
    {
      cwd: projectPath,
      encoding: "utf8",
      shell: false,
    },
  );

  return diff.stdout?.trim() || diff.stderr?.trim() || "";
}

function getFileDiff(projectPath, status, filePath) {
  if (status === "??") {
    return getUntrackedDiff(projectPath, filePath);
  }

  const sections = [];
  const staged = runGitCommand(projectPath, [
    "diff",
    "--cached",
    "--no-color",
    "--",
    filePath,
  ]);
  const unstaged = runGitCommand(projectPath, [
    "diff",
    "--no-color",
    "--",
    filePath,
  ]);

  if (staged.stdout?.trim()) {
    sections.push(staged.stdout.trim());
  }
  if (unstaged.stdout?.trim()) {
    sections.push(unstaged.stdout.trim());
  }

  return sections.join("\n\n").trim();
}

function getDiffViewerData() {
  const projectPath = getProjectPath();
  const repoReady = checkProjectGitRepo(projectPath);

  if (!repoReady) {
    return {
      projectPath,
      repoReady: false,
      files: [],
      generatedAt: new Date().toISOString(),
      message: "Project hiện chưa có git repo.",
    };
  }

  const status = runGitCommand(projectPath, [
    "status",
    "--short",
    "--untracked-files=all",
  ]);

  if (status.status !== 0) {
    return {
      projectPath,
      repoReady: true,
      files: [],
      generatedAt: new Date().toISOString(),
      message:
        status.stderr?.trim() ||
        status.stdout?.trim() ||
        "Không đọc được git status.",
    };
  }

  const files = status.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const statusCode = line.slice(0, 2);
      const rawPath = line.slice(3);
      const filePath = normalizeStatusPath(rawPath);

      return {
        path: filePath,
        status: statusCode,
        diff: getFileDiff(projectPath, statusCode, filePath),
      };
    });

  return {
    projectPath,
    repoReady: true,
    files,
    generatedAt: new Date().toISOString(),
    message: files.length ? "" : "Không có thay đổi nào trong working tree.",
  };
}

function sendJson(res, data, statusCode = 200) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

function sendText(res, text, statusCode = 200) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function sendStaticFile(res, filePath, contentType) {
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    });
    res.end(content);
  } catch (err) {
    sendText(res, `Not found: ${err.message}`, 404);
  }
}

async function startDiffViewerServer() {
  if (diffViewerServer) return;

  diffViewerServer = http.createServer((req, res) => {
    const url = new URL(
      req.url || "/",
      `http://${req.headers.host || "localhost"}`,
    );
    const pathname = url.pathname;

    if (req.method !== "GET") {
      sendText(res, "Method not allowed", 405);
      return;
    }

    if (pathname === "/" || pathname === "/diff") {
      sendStaticFile(
        res,
        path.join(WEB_ROOT, "index.html"),
        "text/html; charset=utf-8",
      );
      return;
    }

    if (pathname === "/styles.css") {
      sendStaticFile(
        res,
        path.join(WEB_ROOT, "styles.css"),
        "text/css; charset=utf-8",
      );
      return;
    }

    if (pathname === "/app.js") {
      sendStaticFile(
        res,
        path.join(WEB_ROOT, "app.js"),
        "application/javascript; charset=utf-8",
      );
      return;
    }

    if (pathname === "/api/diff") {
      sendJson(res, {
        ...getDiffViewerData(),
        viewerUrl: getDiffViewerUrl(),
        publicViewerUrl: getDiffViewerPublicUrl(),
      });
      return;
    }

    sendText(res, "Not found", 404);
  });

  await new Promise((resolve, reject) => {
    diffViewerServer.once("error", reject);
    diffViewerServer.listen(DIFF_VIEWER_PORT, DIFF_VIEWER_HOST, () => {
      diffViewerServer?.off("error", reject);
      console.log(`Diff viewer listening at ${getDiffViewerUrl()}`);
      resolve();
    });
  });
}

function getApproveCommitPromptOptions() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "✅ Commit luôn",
            callback_data: "approve_commit",
          },
        ],
      ],
    },
  };
}

async function sendApproveCommitPrompt(chatId) {
  if (!lastCompletedTask) return;

  await bot.sendMessage(
    chatId,
    [
      "✅ Codex đã hoàn tất task.",
      `🧩 Task gần nhất: ${formatTaskForCommitMessage(lastCompletedTask)}`,
      "",
      "Bạn có muốn commit luôn không?",
    ].join("\n"),
    getApproveCommitPromptOptions(),
  );
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

function summarizeFollowupMessage(text, limit = 120) {
  const compact = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, limit - 3).trimEnd()}...`;
}

function buildFollowupPrompt(message) {
  return message.trim();
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
    `🌐 Diff viewer: ${getDiffViewerUrl()}`,
    getDiffViewerPublicUrl()
      ? `🚀 Public link: ${getDiffViewerPublicUrl()}`
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
    `- Diff viewer: ${getDiffViewerUrl()}`,
    `- Public diff link: ${getDiffViewerPublicUrl() || "chưa khả dụng"}`,
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

        const completedSuccessfully =
          code === 0 && !job?.stopRequested && task !== "duyệt commit";

        if (completedSuccessfully) {
          lastCompletedTask = task;
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

        if (completedSuccessfully) {
          await sendApproveCommitPrompt(chatId);
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

bot.onText(/^\/diff(?:@\w+)?$/, (msg) => {
  if (!auth(msg)) return;
  sendDiffViewerLinkMessage(msg.chat.id);
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

bot.onText(/^\/reply(?:@\w+)?\s+([\s\S]+)$/, (msg, match) => {
  if (!auth(msg)) return;
  if (activeCodexRun) {
    return sendBotMessage(
      msg.chat.id,
      "⏳ Codex đang chạy. Hãy đợi hoàn tất hoặc dùng /stop.",
    );
  }

  const feedback = match[1].trim();
  if (!feedback) {
    return sendBotMessage(
      msg.chat.id,
      "Thiếu nội dung prompt. Ví dụ: /reply Sửa lại header cho gọn hơn.",
    );
  }

  const savedSession = readCodexSession(getProjectPath());
  if (!savedSession) {
    return sendBotMessage(
      msg.chat.id,
      "Chưa có thread Codex để sửa tiếp. Hãy chạy /run trước.",
    );
  }

  return startCodexJob(
    msg.chat.id,
    `Phản hồi: ${summarizeFollowupMessage(feedback)}`,
    buildFollowupPrompt(feedback),
  );
});

bot.onText(/^\/approve_commit(?:@\w+)?$/, (msg) => {
  if (!auth(msg)) return;
  if (activeCodexRun) {
    return sendBotMessage(
      msg.chat.id,
      "⏳ Codex đang chạy. Hãy đợi hoàn tất hoặc dùng /stop.",
    );
  }

  const result = approveCommitForLastTask();
  return sendBotMessage(msg.chat.id, result.message);
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

  if (data === "approve_commit") {
    if (activeCodexRun) {
      if (query.id) {
        await bot.answerCallbackQuery(query.id, {
          text: "⏳ Codex vẫn đang chạy. Chưa thể commit.",
        });
      }
      return;
    }

    if (query.id) {
      await bot.answerCallbackQuery(query.id, {
        text: "✅ Đang tạo commit",
      });
    }

    const result = approveCommitForLastTask();
    await sendBotMessage(chatId, result.message);
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
