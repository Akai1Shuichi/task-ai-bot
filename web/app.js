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

let currentData = null;
let selectedPath = "";

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
  if (status === "??") return "Untracked";
  if (status.includes("M")) return "Modified";
  if (status.includes("A")) return "Added";
  if (status.includes("D")) return "Deleted";
  if (status.includes("R")) return "Renamed";
  return status.trim() || "Changed";
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
      if (line.startsWith("+") && !line.startsWith("+++")) className += " diff-line--add";
      else if (line.startsWith("-") && !line.startsWith("---")) className += " diff-line--remove";
      else if (line.startsWith("@@")) className += " diff-line--meta";
      else if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) {
        className += " diff-line--header";
      }
      return `<span class="${className}">${escapeHtml(line)}</span>`;
    })
    .join("");

  diffOutput.innerHTML = html;
}

function selectFile(filePath) {
  selectedPath = filePath;
  const file = currentData?.files?.find((entry) => entry.path === filePath);

  document.querySelectorAll(".file-list__item").forEach((item) => {
    item.classList.toggle("is-active", item.dataset.path === filePath);
  });

  if (!file) {
    diffTitle.textContent = "Select a file";
    diffStatus.textContent = "No file selected";
    diffOutput.textContent = "Chọn một file bên trái để xem diff.";
    return;
  }

  diffTitle.textContent = file.path;
  diffStatus.textContent = badgeLabel(file.status);
  renderDiff(file.diff);
}

function renderFiles(files) {
  fileList.innerHTML = "";

  if (!files.length) {
    emptyState.classList.remove("hidden");
    emptyState.textContent = currentData?.message || "Không có file thay đổi.";
    selectFile("");
    return;
  }

  emptyState.classList.add("hidden");
  const fragment = document.createDocumentFragment();

  for (const file of files) {
    const item = document.createElement("li");
    item.className = "file-list__item";
    item.dataset.path = file.path;
    item.innerHTML = `
      <button type="button" class="file-list__button">
        <span class="file-list__path">${file.path}</span>
        <span class="file-list__status">${badgeLabel(file.status)}</span>
      </button>
    `;
    item.querySelector("button").addEventListener("click", () => selectFile(file.path));
    fragment.appendChild(item);
  }

  fileList.appendChild(fragment);

  const nextPath = files.some((file) => file.path === selectedPath)
    ? selectedPath
    : files[0].path;
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
  renderFiles(data.files || []);
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

void loadDiffs();
setInterval(() => {
  void loadDiffs();
}, 10000);
