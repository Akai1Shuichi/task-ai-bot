import path from "path";
import { spawnSync } from "child_process";

export function runGitCommand(projectPath, args) {
  return spawnSync("git", args, {
    cwd: projectPath,
    encoding: "utf8",
    shell: false,
  });
}

export function checkProjectGitRepo(projectPath) {
  const check = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: projectPath,
    encoding: "utf8",
    shell: false,
  });

  return check.status === 0 && check.stdout.trim() === "true";
}

export function ensureProjectGitRepo(projectPath) {
  if (checkProjectGitRepo(projectPath)) {
    return { ok: true, initialized: false };
  }

  const init = spawnSync("git", ["init"], {
    cwd: projectPath,
    encoding: "utf8",
    shell: false,
  });

  if (init.status !== 0) {
    const detail = init.stderr?.trim() || init.stdout?.trim() || "git init thất bại.";
    return {
      ok: false,
      initialized: false,
      error: detail,
    };
  }

  return { ok: true, initialized: true };
}

export function approveCommitForTask(
  projectPath,
  task,
  formatTaskForCommitMessage,
) {
  const gitState = ensureProjectGitRepo(projectPath);

  if (!gitState.ok) {
    return {
      ok: false,
      message: `❌ Không thể chuẩn bị git repo cho /approve_commit: ${gitState.error}`,
    };
  }

  if (!task) {
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

  const commitMessage = formatTaskForCommitMessage(task);
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

export function normalizeStatusPath(rawPath) {
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

export function getUntrackedDiff(projectPath, filePath) {
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

export function getFileDiff(projectPath, status, filePath) {
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

export function getDiffViewerData(projectPath) {
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

export function getCombinedDiffText(projectPath) {
  const data = getDiffViewerData(projectPath);
  if (!data.repoReady || !data.files.length) {
    return {
      ok: false,
      message: data.message || "Không có diff để giải thích.",
      files: data.files || [],
    };
  }

  const sections = data.files
    .map((file) => {
      const diff = file.diff?.trim() || "(Không có nội dung diff để hiển thị)";
      return [`File: ${file.path}`, `Status: ${file.status}`, "", diff].join(
        "\n",
      );
    })
    .join("\n\n");

  return {
    ok: true,
    diff: sections,
    files: data.files,
  };
}
