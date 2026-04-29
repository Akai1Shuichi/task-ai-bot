import TelegramBot from "node-telegram-bot-api";

import {
  REPLY_KEYBOARD,
  TELEGRAM_COMMANDS,
  TELEGRAM_LIMIT,
} from "./constants.js";

export function createTelegramService({ token, allowedChatId }) {
  const bot = new TelegramBot(token, { polling: false });
  const originalSendMessage = bot.sendMessage.bind(bot);
  const originalEditMessageText = bot.editMessageText.bind(bot);

  bot.sendMessage = (chatId, text, options = {}) =>
    originalSendMessage(
      chatId,
      formatTelegramHtml(text),
      withHtmlParseMode(options),
    );

  bot.editMessageText = (text, options = {}) =>
    originalEditMessageText(
      formatTelegramHtml(text),
      withHtmlParseMode(options),
    );

  async function setupTelegramCommands() {
    try {
      await bot.setMyCommands(TELEGRAM_COMMANDS);
    } catch (err) {
      console.error("Failed to register Telegram commands:", err.message);
    }
  }

  function auth(msg) {
    return String(msg.chat.id) === allowedChatId;
  }

  function sendBotMessage(chatId, text, options = {}) {
    return bot.sendMessage(chatId, text, {
      reply_markup: REPLY_KEYBOARD,
      ...options,
    });
  }

  async function safeEditMessage(chatId, messageId, text) {
    try {
      await bot.editMessageText(trimForTelegram(text) || "Đang chạy...", {
        chat_id: chatId,
        message_id: messageId,
      });
    } catch (err) {
      const description =
        err?.response?.body?.description || err?.message || "";
      if (!description.includes("message is not modified")) {
        console.error("Failed to edit Telegram message:", description);
      }
    }
  }

  async function sendLongMessage(chatId, text) {
    const clean = text || "Hoàn tất";
    for (let i = 0; i < clean.length; i += TELEGRAM_LIMIT) {
      await bot.sendMessage(chatId, clean.slice(i, i + TELEGRAM_LIMIT));
    }
  }

  return {
    bot,
    auth,
    sendBotMessage,
    safeEditMessage,
    sendLongMessage,
    setupTelegramCommands,
  };
}

function trimForTelegram(text, limit = TELEGRAM_LIMIT) {
  if (!text) return "";
  if (text.length <= limit) return text;
  return `...${text.slice(text.length - limit + 3)}`;
}

function withHtmlParseMode(options = {}) {
  return {
    ...options,
    parse_mode: "HTML",
  };
}

function formatTelegramHtml(text) {
  if (text === null || text === undefined) return "";

  const blocks = [];
  const inlines = [];
  let value = String(text);

  value = value.replace(/```(?:[^\n]*)\n?([\s\S]*?)```/g, (_, code) => {
    const token = `TG_BLOCK_${blocks.length}`;
    blocks.push(`<pre><code>${escapeHtml(code.trim())}</code></pre>`);
    return token;
  });

  value = value.replace(/`([^`\n]+)`/g, (_, code) => {
    const token = `TG_INLINE_${inlines.length}`;
    inlines.push(`<code>${escapeHtml(code)}</code>`);
    return token;
  });

  value = escapeHtml(value);

  value = value.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2">$1</a>',
  );
  value = value.replace(/\*\*([^\n*][\s\S]*?[^\n*])\*\*/g, "<b>$1</b>");

  for (const [index, block] of blocks.entries()) {
    value = value.replace(`TG_BLOCK_${index}`, block);
  }

  for (const [index, inline] of inlines.entries()) {
    value = value.replace(`TG_INLINE_${index}`, inline);
  }

  return value;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
