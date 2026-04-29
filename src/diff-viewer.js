import fs from "fs";
import http from "http";
import path from "path";
import { spawn, spawnSync } from "child_process";
import crypto from "crypto";

import {
  DIFF_VIEWER_HOST,
  DIFF_VIEWER_PORT,
  DIFF_VIEWER_TUNNEL,
  NGROK_API_URL,
  WEB_ROOT,
} from "./constants.js";
import { getCombinedDiffText, getDiffViewerData } from "./git.js";

export function createDiffViewerService({
  getProjectPath,
  requestDiffExplanation,
}) {
  let diffViewerServer = null;
  let tunnelProcess = null;
  let tunnelPublicUrl = "";
  let tunnelProvider = "";
  const explainToken = crypto.randomBytes(24).toString("hex");

  function getDiffViewerUrl() {
    return `http://${DIFF_VIEWER_HOST}:${DIFF_VIEWER_PORT}`;
  }

  function getDiffViewerPublicUrl() {
    return tunnelPublicUrl;
  }

  function getLinkOptions() {
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

  function getLinkMessage() {
    return {
      text: [
        "🔎 Diff viewer hiện tại:",
        `🌐 Local: ${getDiffViewerUrl()}`,
        getDiffViewerPublicUrl()
          ? `🚀 Public: ${getDiffViewerPublicUrl()}`
          : "🚧 Public: chưa khả dụng. Hãy kiểm tra tunnel (`ngrok` hoặc `cloudflared`).",
      ].join("\n"),
      options: getLinkOptions(),
    };
  }

  function stopTunnelProcess() {
    if (!tunnelProcess || tunnelProcess.exitCode !== null) return;

    try {
      tunnelProcess.kill("SIGTERM");
    } catch (err) {
      console.error("Failed to stop tunnel process:", err.message);
    }
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
            reject(
              new Error("cloudflared exited before exposing a public URL."),
            );
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

  async function startDiffViewerServer() {
    if (diffViewerServer) return;

    diffViewerServer = http.createServer((req, res) => {
      const url = new URL(
        req.url || "/",
        `http://${req.headers.host || "localhost"}`,
      );
      const pathname = url.pathname;

      if (pathname === "/api/explain" && req.method === "POST") {
        void handleExplainRequest(req, res, {
          explainToken,
          getProjectPath,
          requestDiffExplanation,
        });
        return;
      }

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
          ...getDiffViewerData(getProjectPath()),
          explainToken,
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

  async function start() {
    await startDiffViewerServer();
    await startPublicTunnel();
  }

  return {
    start,
    getDiffViewerUrl,
    getDiffViewerPublicUrl,
    getLinkMessage,
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function handleExplainRequest(
  req,
  res,
  { explainToken, getProjectPath, requestDiffExplanation },
) {
  if (!requestDiffExplanation) {
    sendJson(
      res,
      {
        ok: false,
        message: "Tính năng explain chưa được cấu hình trên server.",
      },
      503,
    );
    return;
  }

  const token = req.headers["x-diff-viewer-token"];
  if (!token || token !== explainToken) {
    sendJson(
      res,
      {
        ok: false,
        message: "Thiếu hoặc sai token truy cập explain.",
      },
      403,
    );
    return;
  }

  try {
    const payload = await readJsonBody(req);
    const request = buildExplainRequest(getProjectPath(), payload);

    if (!request.ok) {
      sendJson(res, request, request.statusCode || 400);
      return;
    }

    const result = await Promise.resolve(
      requestDiffExplanation({
        prompt: request.prompt,
        task: request.task,
      }),
    );

    sendJson(
      res,
      {
        ok: Boolean(result?.ok),
        message:
          result?.message ||
          "Đã gửi yêu cầu explain cho Codex. Kết quả sẽ trả về Telegram.",
      },
      result?.ok ? 202 : 409,
    );
  } catch (err) {
    sendJson(
      res,
      {
        ok: false,
        message: `Không thể xử lý yêu cầu explain: ${err.message}`,
      },
      400,
    );
  }
}

function buildExplainRequest(projectPath, payload) {
  const scope = String(payload?.scope || "").trim();

  if (scope === "all") {
    const combined = getCombinedDiffText(projectPath);
    if (!combined.ok) {
      return {
        ok: false,
        statusCode: 400,
        message: combined.message || "Không có diff để giải thích.",
      };
    }

    return {
      ok: true,
      task: "giải thích toàn bộ diff",
      prompt: buildAllDiffExplainPrompt(combined.diff),
    };
  }

  if (scope === "file") {
    const filePath = String(payload?.filePath || "").trim();
    if (!filePath) {
      return {
        ok: false,
        statusCode: 400,
        message: "Thiếu đường dẫn file để explain.",
      };
    }

    const data = getDiffViewerData(projectPath);
    const file = data.files.find((entry) => entry.path === filePath);
    if (!file) {
      return {
        ok: false,
        statusCode: 404,
        message: `Không tìm thấy file trong diff hiện tại: ${filePath}`,
      };
    }

    if (!isExplainableFileStatus(file.status)) {
      return {
        ok: false,
        statusCode: 400,
        message: "Chỉ hỗ trợ explain riêng cho file add hoặc edit.",
      };
    }

    if (!file.diff?.trim()) {
      return {
        ok: false,
        statusCode: 400,
        message: "File này hiện không có nội dung diff để giải thích.",
      };
    }

    return {
      ok: true,
      task: `giải thích file ${file.path}`,
      prompt: buildSingleFileExplainPrompt(file),
    };
  }

  return {
    ok: false,
    statusCode: 400,
    message: "Scope explain không hợp lệ.",
  };
}

function isExplainableFileStatus(status) {
  return status === "??" || status.includes("A") || status.includes("M");
}

function buildAllDiffExplainPrompt(diffText) {
  return [
    "Bạn đang nhận một git diff của toàn bộ project.",
    "Chỉ giải thích diff, không sửa file, không đề xuất chạy lệnh nếu không thực sự cần.",
    "Hãy trả lời bằng tiếng Việt, ngắn gọn nhưng đủ ý.",
    "",
    "Yêu cầu:",
    "1. Tóm tắt mục đích thay đổi tổng thể.",
    "2. Giải thích theo từng file: file đó thay đổi gì và để làm gì.",
    "3. Chỉ ra rủi ro, chỗ dễ lỗi, hoặc điểm cần review thêm nếu có.",
    "4. Nếu có file mới, nói rõ vai trò của file đó trong luồng hiện tại.",
    "",
    "Git diff:",
    truncatePromptDiff(diffText),
  ].join("\n");
}

function buildSingleFileExplainPrompt(file) {
  return [
    "Bạn đang nhận git diff của một file trong project.",
    "Chỉ giải thích diff, không sửa file.",
    "Trả lời bằng tiếng Việt, thực dụng, dễ đọc trên Telegram.",
    "",
    `File: ${file.path}`,
    `Status: ${file.status}`,
    "",
    "Yêu cầu:",
    "1. File này đang được thêm mới hay chỉnh sửa gì.",
    "2. Những thay đổi chính trong logic hoặc giao diện là gì.",
    "3. Tác động thực tế của thay đổi này đối với app.",
    "4. Nếu có rủi ro hoặc điểm cần review kỹ thì nêu rõ.",
    "",
    "Git diff:",
    truncatePromptDiff(file.diff),
  ].join("\n");
}

function truncatePromptDiff(diffText, limit = 160000) {
  const clean = String(diffText || "").trim();
  if (clean.length <= limit) return clean;

  return [
    clean.slice(0, limit),
    "",
    "[Diff đã bị cắt bớt vì quá dài. Hãy giải thích dựa trên phần diff còn lại.]",
  ].join("\n");
}

async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) {
      throw new Error("Request body quá lớn.");
    }
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) {
    throw new Error("Request body rỗng.");
  }

  return JSON.parse(text);
}
