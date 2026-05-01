import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { getCodexProcessSpec } from "./codex-cli.js";

import {
  ALLOWED_CHAT_ID,
  CONFIG_PATH,
  TELEGRAM_BOT_TOKEN,
} from "./constants.js";

export function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

export function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

export function getProjectPath() {
  const config = loadConfig();
  return path.resolve(config.path);
}

export function getCodexModel() {
  const config = loadConfig();
  return normalizeCodexModel(config.model);
}

export function getCodexReasoningEffort() {
  const config = loadConfig();
  return normalizeCodexReasoningEffort(config.reasoningEffort);
}

export function setCodexModel(model) {
  const config = loadConfig();
  const normalized = normalizeCodexModel(model);

  if (normalized) {
    config.model = normalized;
  } else {
    delete config.model;
  }

  saveConfig(config);
  return normalized;
}

export function setCodexReasoningEffort(reasoningEffort) {
  const config = loadConfig();
  const normalized = normalizeCodexReasoningEffort(reasoningEffort);

  if (normalized === null) {
    return null;
  }

  if (normalized) {
    config.reasoningEffort = normalized;
  } else {
    delete config.reasoningEffort;
  }

  saveConfig(config);
  return normalized;
}

export function getTodoPath() {
  const config = loadConfig();
  const projectPath = getProjectPath();
  const todoFile = config.todoFile || "todo.md";
  return path.isAbsolute(todoFile)
    ? todoFile
    : path.resolve(projectPath, todoFile);
}

export function readTodo() {
  return fs.readFileSync(getTodoPath(), "utf8");
}

export function getStartupValidationErrors() {
  const errors = [];

  if (!TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN === "undefined") {
    errors.push("Thiếu TELEGRAM_BOT_TOKEN trong .env.");
  }

  if (!ALLOWED_CHAT_ID || ALLOWED_CHAT_ID === "undefined") {
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

    if (
      Object.hasOwn(config, "model") &&
      config.model !== undefined &&
      normalizeCodexModel(config.model) === null
    ) {
      errors.push("config.json có trường model không hợp lệ.");
    }

    if (
      Object.hasOwn(config, "reasoningEffort") &&
      config.reasoningEffort !== undefined &&
      normalizeCodexReasoningEffort(config.reasoningEffort) === null
    ) {
      errors.push(
        "config.json có trường reasoningEffort không hợp lệ. Hỗ trợ: minimal, low, medium, high, xhigh.",
      );
    }
  }

  const codexProcess = getCodexProcessSpec();
  const codexCheck = spawnSync(codexProcess.command, ["--version"], {
    stdio: "ignore",
    shell: codexProcess.shell,
  });
  if (codexCheck.error || codexCheck.status !== 0) {
    const detail = codexCheck.error?.message
      ? ` (${codexCheck.error.message})`
      : "";
    errors.push(`Không chạy được lệnh codex${detail}.`);
  }

  return errors;
}

export function validateStartupConfig() {
  const errors = getStartupValidationErrors();
  if (!errors.length) return;

  for (const error of errors) {
    console.error(`Startup validation failed: ${error}`);
  }
  process.exit(1);
}

function normalizeCodexModel(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return null;

  const normalized = value.trim();
  return normalized || "";
}

function normalizeCodexReasoningEffort(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return null;

  const normalized = value.trim().toLowerCase();
  if (!normalized) return "";

  return ["minimal", "low", "medium", "high", "xhigh"].includes(normalized)
    ? normalized
    : null;
}
