export function formatTaskForCommitMessage(task) {
  if (!task) return "";

  const trimmed = task.trim();
  const match =
    trimmed.match(/^[-*]\s+\[\s*[xX]?\s*\]\s+((?:\d+(?:\.\d+)*)[.)]?\s+.+)$/) ||
    trimmed.match(/^[-*]\s+((?:\d+(?:\.\d+)*)[.)]?\s+.+)$/) ||
    trimmed.match(/^((?:\d+(?:\.\d+)*)[.)]?\s+.+)$/);

  return (match?.[1] || trimmed).trim();
}

export function createTodoService({ readTodo }) {
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

      const bulletMatch = trimmed.match(
        /^[-*]\s+(\d+(?:\.\d+)*)[.)]?\s+(.+)$/,
      );
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

  return {
    parseTodoTasks,
    findTask,
    getTasksMessagePayload,
  };
}
