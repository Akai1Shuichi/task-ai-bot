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

  function getNextOpenTask(tasks = parseTodoTasks()) {
    return tasks.find((task) => !task.done) || null;
  }

  function getLastCompletedTaskBeforeNextOpen(tasks = parseTodoTasks()) {
    const nextOpenIndex = tasks.findIndex((task) => !task.done);
    const searchFrom = nextOpenIndex === -1 ? tasks.length - 1 : nextOpenIndex - 1;

    for (let index = searchFrom; index >= 0; index -= 1) {
      if (tasks[index].done) {
        return tasks[index];
      }
    }

    return null;
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
    const nextOpenTask = getNextOpenTask(tasks);
    if (nextOpenTask) {
      lines.push(
        `▶️ Nút Run hiện chỉ mở cho task gần nhất: ${nextOpenTask.id}.`,
      );
    }
    return lines.join("\n");
  }

  function buildTasksInlineKeyboard(tasks) {
    const nextOpenTask = getNextOpenTask(tasks);
    if (!nextOpenTask) return undefined;

    return {
      inline_keyboard: [
        [
          {
            text: `▶️ Run ${nextOpenTask.id}`,
            callback_data: `run:${nextOpenTask.id}`,
          },
        ],
      ],
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
    getLastCompletedTaskBeforeNextOpen,
    getNextOpenTask,
    getTasksMessagePayload,
  };
}
