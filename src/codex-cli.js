import fs from "fs";
import path from "path";

export function getCodexProcessSpec() {
  if (process.platform !== "win32") {
    return {
      command: "codex",
      shell: false,
    };
  }

  const resolvedExe = findWindowsCodexExe();
  if (resolvedExe) {
    return {
      command: resolvedExe,
      shell: false,
    };
  }

  return {
    command: "codex",
    shell: false,
  };
}

function findWindowsCodexExe() {
  const pathShim = findOnPath("codex.cmd");
  if (!pathShim) return "";

  const npmBinDir = path.dirname(pathShim);
  const candidate = path.join(
    npmBinDir,
    "node_modules",
    "@openai",
    "codex",
    "node_modules",
    "@openai",
    `codex-win32-${process.arch}`,
    "vendor",
    getWindowsTargetTriple(),
    "codex",
    "codex.exe",
  );

  return fs.existsSync(candidate) ? candidate : "";
}

function getWindowsTargetTriple() {
  switch (process.arch) {
    case "x64":
      return "x86_64-pc-windows-msvc";
    case "arm64":
      return "aarch64-pc-windows-msvc";
    default:
      return "";
  }
}

function findOnPath(fileName) {
  const pathValue = process.env.Path || process.env.PATH || "";
  if (!pathValue) return "";

  for (const entry of pathValue.split(";")) {
    const dir = entry.trim();
    if (!dir) continue;

    const candidate = path.join(dir, fileName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return "";
}
