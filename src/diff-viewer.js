import fs from "fs";
import http from "http";
import path from "path";
import { spawn, spawnSync } from "child_process";

import {
  DIFF_VIEWER_HOST,
  DIFF_VIEWER_PORT,
  DIFF_VIEWER_TUNNEL,
  NGROK_API_URL,
  WEB_ROOT,
} from "./constants.js";
import { getDiffViewerData } from "./git.js";

export function createDiffViewerService({ getProjectPath }) {
  let diffViewerServer = null;
  let tunnelProcess = null;
  let tunnelPublicUrl = "";
  let tunnelProvider = "";

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
