const refreshButton = document.querySelector("#refresh-button");
const updatedAt = document.querySelector("#updated-at");
const projectPath = document.querySelector("#project-path");
const fileCount = document.querySelector("#file-count");
const viewerUrl = document.querySelector("#viewer-url");
const repoState = document.querySelector("#repo-state");
const emptyState = document.querySelector("#empty-state");
const fileList = document.querySelector("#file-list");
const diffTitle = document.querySelector("#diff-title");
const diffStatus = document.querySelector("#diff-status");
const diffOutput = document.querySelector("#diff-output");
const explainAllButton = document.querySelector("#explain-all-button");
const explainFileButton = document.querySelector("#explain-file-button");
const actionStatus = document.querySelector("#action-status");

let currentData = null;
let selectedPath = "";
let explainRequestPending = false;
const closedDirectories = new Set();

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatTimestamp(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function badgeLabel(status) {
  if (status === "??" || status.includes("A")) return "Added";
  if (status.includes("D")) return "Deleted";
  if (status.includes("M")) return "Modified";
  if (status.includes("R")) return "Renamed";
  return status.trim() || "Changed";
}

function statusTone(status) {
  if (status === "??" || status.includes("A")) return "added";
  if (status.includes("D")) return "deleted";
  if (status.includes("M")) return "modified";
  if (status.includes("R")) return "renamed";
  return "changed";
}

function applyDiffStatusTone(status) {
  const tone = statusTone(status);
  diffStatus.className = `badge badge--${tone}`;
}

function isExplainableFile(file) {
  if (!file) return false;
  return (
    file.status === "??" ||
    file.status.includes("A") ||
    file.status.includes("M")
  );
}

function setActionStatus(text, tone = "muted") {
  actionStatus.textContent = text;
  actionStatus.className = `action-status action-status--${tone}`;
}

function syncExplainButtons(file = null) {
  const hasFiles = Boolean(currentData?.files?.length);
  const explainFileVisible = isExplainableFile(file);

  explainAllButton.disabled = explainRequestPending || !hasFiles;
  explainFileButton.hidden = !explainFileVisible;
  explainFileButton.disabled = explainRequestPending || !explainFileVisible;
}

function renderDiff(diff) {
  if (!diff) {
    diffOutput.textContent = "Không có diff để hiển thị cho file này.";
    return;
  }

  const html = diff
    .split("\n")
    .map((line) => {
      let className = "diff-line";
      if (line.startsWith("+") && !line.startsWith("+++"))
        className += " diff-line--add";
      else if (line.startsWith("-") && !line.startsWith("---"))
        className += " diff-line--remove";
      else if (line.startsWith("@@")) className += " diff-line--meta";
      else if (
        line.startsWith("diff --git") ||
        line.startsWith("index ") ||
        line.startsWith("---") ||
        line.startsWith("+++")
      ) {
        className += " diff-line--header";
      }
      return `<span class="${className}">${escapeHtml(line)}</span>`;
    })
    .join("");

  diffOutput.innerHTML = html;
}

function splitPath(filePath) {
  return String(filePath || "")
    .split(/[\\/]+/)
    .filter(Boolean);
}

function sortByLabel(a, b) {
  return a.localeCompare(b, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function buildFileTree(files) {
  const root = {
    directories: new Map(),
    files: [],
  };

  for (const file of files) {
    const segments = splitPath(file.path);
    if (!segments.length) continue;

    let node = root;
    let currentPath = "";

    for (const segment of segments.slice(0, -1)) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;

      if (!node.directories.has(segment)) {
        node.directories.set(segment, {
          name: segment,
          path: currentPath,
          directories: new Map(),
          files: [],
        });
      }

      node = node.directories.get(segment);
    }

    node.files.push({
      ...file,
      name: segments[segments.length - 1],
    });
  }

  return root;
}

function shouldOpenDirectory(directoryPath) {
  return !closedDirectories.has(directoryPath);
}

function createFileNode(file) {
  const item = document.createElement("li");
  item.className = "file-tree__item file-tree__item--file";
  item.dataset.path = file.path;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "file-tree__button";
  button.title = file.path;
  button.addEventListener("click", () => selectFile(file.path));

  const nameRow = document.createElement("span");
  nameRow.className = "file-tree__name-row";

  const dot = document.createElement("span");
  dot.className = `file-tree__dot file-tree__dot--${statusTone(file.status)}`;
  dot.setAttribute("aria-hidden", "true");

  const name = document.createElement("span");
  name.className = "file-tree__name";
  name.textContent = file.name;

  const status = document.createElement("span");
  status.className = `file-tree__status file-tree__status--${statusTone(file.status)}`;
  status.textContent = badgeLabel(file.status);

  nameRow.append(dot, name);
  button.append(nameRow, status);
  item.appendChild(button);
  return item;
}

function createDirectoryNode(directory) {
  const item = document.createElement("li");
  item.className = "file-tree__item file-tree__item--directory";

  const branch = document.createElement("details");
  branch.className = "file-tree__branch";
  branch.open = shouldOpenDirectory(directory.path);
  branch.addEventListener("toggle", () => {
    if (branch.open) {
      closedDirectories.delete(directory.path);
    } else {
      closedDirectories.add(directory.path);
    }
  });

  const summary = document.createElement("summary");
  summary.className = "file-tree__summary";
  const folderName = document.createElement("span");
  folderName.className = "file-tree__folder-name";
  folderName.textContent = directory.name;
  summary.appendChild(folderName);

  branch.appendChild(summary);
  branch.appendChild(renderTreeLevel(directory));
  item.appendChild(branch);

  return item;
}

function renderTreeLevel(node) {
  const list = document.createElement("ul");
  list.className = "file-tree__list";

  const directoryNames = [...node.directories.keys()].sort(sortByLabel);
  for (const name of directoryNames) {
    list.appendChild(createDirectoryNode(node.directories.get(name)));
  }

  const files = [...node.files].sort((a, b) => sortByLabel(a.name, b.name));
  for (const file of files) {
    list.appendChild(createFileNode(file));
  }

  return list;
}

function selectFile(filePath) {
  selectedPath = filePath;
  const file = currentData?.files?.find((entry) => entry.path === filePath);

  document.querySelectorAll(".file-tree__item--file").forEach((item) => {
    item.classList.toggle("is-active", item.dataset.path === filePath);
  });

  if (!file) {
    diffTitle.textContent = "Select a file";
    diffStatus.textContent = "No file selected";
    diffStatus.className = "badge badge--muted";
    diffOutput.textContent = "Chọn một file bên trái để xem diff.";
    syncExplainButtons(null);
    return;
  }

  diffTitle.textContent = file.path;
  diffStatus.textContent = badgeLabel(file.status);
  applyDiffStatusTone(file.status);
  renderDiff(file.diff);
  syncExplainButtons(file);
}

function renderFiles(files) {
  fileList.innerHTML = "";

  if (!files.length) {
    emptyState.classList.remove("hidden");
    emptyState.textContent = currentData?.message || "Không có file thay đổi.";
    selectedPath = "";
    selectFile("");
    return;
  }

  emptyState.classList.add("hidden");
  const nextPath = files.some((file) => file.path === selectedPath)
    ? selectedPath
    : files[0].path;
  selectedPath = nextPath;

  const tree = renderTreeLevel(buildFileTree(files));
  fileList.replaceChildren(...Array.from(tree.children));
  selectFile(nextPath);
}

function render(data) {
  currentData = data;
  projectPath.textContent = data.projectPath || "-";
  fileCount.textContent = String(data.files?.length || 0);
  viewerUrl.textContent = data.viewerUrl || "-";
  updatedAt.textContent = `Updated: ${formatTimestamp(data.generatedAt)}`;
  repoState.textContent = data.repoReady ? "Git Ready" : "No Git Repo";
  repoState.classList.toggle("badge--warning", !data.repoReady);
  if (!data.files?.length) {
    setActionStatus("Không có diff để gửi cho Codex.", "muted");
  }
  renderFiles(data.files || []);
}

async function requestExplain(scope, filePath = "") {
  if (explainRequestPending) return;

  explainRequestPending = true;
  syncExplainButtons(
    currentData?.files?.find((entry) => entry.path === selectedPath),
  );
  setActionStatus("Đang gửi yêu cầu cho Codex...", "muted");

  try {
    const response = await fetch("./api/explain", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Diff-Viewer-Token": currentData?.explainToken || "",
      },
      body: JSON.stringify({
        scope,
        filePath,
      }),
    });
    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(
        data.message || `Request failed with status ${response.status}`,
      );
    }

    setActionStatus(
      data.message || "Đã gửi yêu cầu cho Codex. Kết quả sẽ trả về Telegram.",
      "success",
    );
  } catch (error) {
    setActionStatus(`Không gửi được explain: ${error.message}`, "danger");
  } finally {
    explainRequestPending = false;
    syncExplainButtons(
      currentData?.files?.find((entry) => entry.path === selectedPath),
    );
  }
}

async function loadDiffs() {
  refreshButton.disabled = true;
  refreshButton.textContent = "Refreshing...";

  try {
    const response = await fetch("./api/diff", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }

    const data = await response.json();
    render(data);
  } catch (error) {
    emptyState.classList.remove("hidden");
    emptyState.textContent = `Không tải được diff: ${error.message}`;
  } finally {
    refreshButton.disabled = false;
    refreshButton.textContent = "Refresh";
  }
}

refreshButton?.addEventListener("click", () => {
  void loadDiffs();
});

explainAllButton?.addEventListener("click", () => {
  void requestExplain("all");
});

explainFileButton?.addEventListener("click", () => {
  if (!selectedPath) return;
  void requestExplain("file", selectedPath);
});

void loadDiffs();
setInterval(() => {
  void loadDiffs();
}, 10000);
