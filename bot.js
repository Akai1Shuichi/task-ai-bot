import { bootstrapBot } from "./src/app.js";

bootstrapBot().catch((err) => {
  console.error("Failed to start Telegram bot:", err.message);
  process.exit(1);
});
