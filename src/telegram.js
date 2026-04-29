import TelegramBot from "node-telegram-bot-api";

import {
  REPLY_KEYBOARD,
  TELEGRAM_COMMANDS,
  TELEGRAM_LIMIT,
} from "./constants.js";

export function createTelegramService({ token, allowedChatId }) {
  const bot = new TelegramBot(token, { polling: false });

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
      const description = err?.response?.body?.description || err?.message || "";
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
