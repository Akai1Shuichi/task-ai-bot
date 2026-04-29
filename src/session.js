import fs from "fs";

import { CODEX_SESSION_PATH } from "./constants.js";

export function isCodexThreadId(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

export function readCodexSession(projectPath) {
  try {
    const state = JSON.parse(fs.readFileSync(CODEX_SESSION_PATH, "utf8"));
    if (state.projectPath !== projectPath) return null;
    if (!isCodexThreadId(state.threadId)) return null;
    return state;
  } catch {
    return null;
  }
}

export function saveCodexSession(projectPath, threadId) {
  if (!isCodexThreadId(threadId)) return;

  const state = {
    projectPath,
    threadId,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(CODEX_SESSION_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

export function clearCodexSession() {
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
