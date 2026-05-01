import { spawn } from "child_process";
import { getCodexProcessSpec } from "./codex-cli.js";

import {
  EDIT_INTERVAL_MS,
  RUN_TIMEOUT_MS,
  STOP_FORCE_KILL_MS,
  TELEGRAM_LIMIT,
} from "./constants.js";
import { isCodexThreadId } from "./session.js";

export function createCodexService({
  bot,
  getCodexModel,
  getCodexReasoningEffort,
  getProjectPath,
  getTodoPath,
  readCodexSession,
  saveCodexSession,
  clearCodexSession,
  sendBotMessage,
  safeEditMessage,
  sendLongMessage,
  sendApproveCommitPrompt,
}) {
  let activeCodexRun = null;
  let activeCodexJob = null;
  let lastCompletedTask = "";

  function isRunning() {
    return Boolean(activeCodexRun);
  }

  function getLastCompletedTask() {
    return lastCompletedTask;
  }

  function getStatusText() {
    const projectPath = getProjectPath();
    const savedSession = readCodexSession(projectPath);
    const codexModel = getCodexModel?.() || "";
    const codexReasoningEffort = getCodexReasoningEffort?.() || "";

    if (!activeCodexJob) {
      return [
        "📊 Trạng thái Codex: đang tắt",
        "🫥 Không có tác vụ nào đang chạy.",
        `📁 Dự án: ${projectPath}`,
        `🧠 Model: ${codexModel || "mặc định của Codex CLI"}`,
        `🧩 Reasoning: ${codexReasoningEffort || "mặc định của Codex CLI"}`,
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
      `🧠 Model: ${codexModel || "mặc định của Codex CLI"}`,
      `🧩 Reasoning: ${codexReasoningEffort || "mặc định của Codex CLI"}`,
      `🧵 Thread: ${savedSession?.threadId || "không có"}`,
    ].join("\n");
  }

  function startTask(chatId, task, prompt = "", options = {}) {
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

    activeCodexRun = runCodexRealtime(
      chatId,
      task,
      activeCodexJob,
      prompt,
      options,
    )
      .catch((err) => {
        sendBotMessage(chatId, `Không thể chạy Codex: ${err.message}`);
      })
      .finally(() => {
        activeCodexRun = null;
        activeCodexJob = null;
      });

    return activeCodexRun;
  }

  function startFollowup(chatId, feedback) {
    if (activeCodexRun) {
      return sendBotMessage(
        chatId,
        "⏳ Codex đang chạy. Hãy đợi hoàn tất hoặc dùng /stop.",
      );
    }

    if (!feedback) {
      return sendBotMessage(
        chatId,
        "Thiếu nội dung prompt. Ví dụ: /reply Sửa lại header cho gọn hơn.",
      );
    }

    const savedSession = readCodexSession(getProjectPath());
    if (!savedSession) {
      return sendBotMessage(
        chatId,
        "Chưa có thread Codex để sửa tiếp. Hãy chạy /run trước.",
      );
    }

    return startTask(
      chatId,
      `Phản hồi: ${summarizeFollowupMessage(feedback)}`,
      buildFollowupPrompt(feedback),
    );
  }

  function queueExternalTask(chatId, task, prompt, options = {}) {
    if (activeCodexRun) {
      return {
        ok: false,
        message: "⏳ Codex đang chạy. Hãy đợi hoàn tất hoặc dùng /stop.",
      };
    }

    startTask(chatId, task, prompt, options);
    return {
      ok: true,
      message: `Đã gửi yêu cầu "${task}" cho Codex. Kết quả sẽ trả về Telegram.`,
    };
  }

  function queueDiffExplanation(chatId, task, prompt) {
    return queueExternalTask(chatId, task, prompt, {
      notifyApproveCommit: false,
      recordAsLastCompletedTask: false,
      sessionMode: "isolated",
    });
  }

  async function stopActiveJob(chatId) {
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

  async function runCodexRealtime(
    chatId,
    task,
    job,
    promptOverride = "",
    options = {},
  ) {
    const projectPath = getProjectPath();
    const todoPath = getTodoPath();
    const codexModel = getCodexModel?.() || "";
    const codexReasoningEffort = getCodexReasoningEffort?.() || "";
    const prompt = promptOverride || `Read ${todoPath} and complete task ${task}`;
    const sessionMode = options.sessionMode || "reuse";
    const shouldReuseSession = sessionMode !== "isolated";
    const savedSession = shouldReuseSession ? readCodexSession(projectPath) : null;
    const liveMessage = await bot.sendMessage(
      chatId,
      `Đang chạy ${task}\n\n${
        savedSession
          ? "Đang tiếp tục phiên Codex..."
          : "Đang bắt đầu phiên Codex..."
      }${codexModel ? `\nModel: ${codexModel}` : ""}${
        codexReasoningEffort ? `\nReasoning: ${codexReasoningEffort}` : ""
      }`,
    );
    const args = savedSession ? ["exec", "resume"] : ["exec"];

    if (codexModel) {
      args.push("--model", codexModel);
    }

    if (codexReasoningEffort) {
      args.push("-c", `model_reasoning_effort="${codexReasoningEffort}"`);
    }

    args.push("--skip-git-repo-check");

    if (!savedSession) {
      args.push("--sandbox", "workspace-write");
    }

    args.push("--json");

    if (savedSession) {
      args.push(savedSession.threadId);
    }

    args.push(prompt);
    const codexProcess = getCodexProcessSpec();
    const child = spawn(codexProcess.command, args, {
      cwd: projectPath,
      env: process.env,
      shell: codexProcess.shell,
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
      if (shouldReuseSession) {
        saveCodexSession(projectPath, threadId);
      }

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
            shouldReuseSession &&
            /not found|no such|failed to load/i.test(output)
          ) {
            clearCodexSession();
            append(
              "Phiên Codex đã lưu không hợp lệ. Chạy lại /run để bắt đầu phiên mới.",
            );
          } else if (code === 0 && activeThreadId && shouldReuseSession) {
            saveCodexSession(projectPath, activeThreadId);
          }

          const completedSuccessfully = code === 0 && !job?.stopRequested;

          if (
            completedSuccessfully &&
            options.recordAsLastCompletedTask !== false &&
            task !== "duyệt commit"
          ) {
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

          if (completedSuccessfully && options.notifyApproveCommit !== false) {
            await sendApproveCommitPrompt(chatId, task);
          }
        } catch (err) {
          console.error("Failed to finalize Codex run:", err.message);
        } finally {
          resolve();
        }
      });
    });
  }

  return {
    getLastCompletedTask,
    getStatusText,
    isRunning,
    queueDiffExplanation,
    queueExternalTask,
    startFollowup,
    startTask,
    stopActiveJob,
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
