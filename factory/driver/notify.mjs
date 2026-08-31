// Telegram notification transport — the one copy of the send + creds scan
// that factory.mjs, deploy-runtime.mjs, watchdog.mjs, and supervisor.mjs
// each carried privately (7 sites, drifted timeouts; 2026-07-31 trash
// sweep). Failures log and never throw: every caller must behave
// identically with notifications broken.
import * as os from "node:os";
import * as path from "node:path";
import { stateDir, machineEnvFile, readEnvLines } from "./paths.mjs";

// ~/secrets/factory-shared.env first (the machine-level creds the OnFailure
// unit's notify-fail.sh also reads), then any registered factory's .env —
// one bot serves the fleet, first hit wins. The legacy
// ~/.factory/telegram.env home was hard-migrated (owner decision
// 2026-08-18) — no fallback read.
export const telegramCreds = (factories = {}, home = os.homedir()) => {
  const candidates = [
    machineEnvFile(home),
    ...Object.keys(factories).map((p) => path.join(stateDir(p, home), ".env")),
  ];
  for (const p of candidates) {
    const env = readEnvLines(p);
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) return { token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID };
  }
  return null;
};

// Callers own the message prefix ([factory-name]/[runtime]/[fleet]/…) and
// the log wording via `log` — the transport reports "telegram HTTP <n>" /
// "telegram failed (<reason>)" and the caller decorates.
export const sendTelegram = async ({ token, chatId }, text, { timeoutMs = 10_000, log = () => {} } = {}) => {
  try {
    // FACTORY_TELEGRAM_API: test double (helpers.mjs startTelegramStub).
    const res = await fetch(`${process.env.FACTORY_TELEGRAM_API ?? "https://api.telegram.org"}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) { log(`telegram HTTP ${res.status}`); return false; }
    return true;
  } catch (e) {
    log(`telegram failed (${String(e.message ?? e).split("\n")[0]})`);
    return false;
  }
};

// One re-send for the callers with no second channel (supervisor, watchdog,
// deploy-runtime): a single failed POST must not eat an emergency. Bounded
// at exactly two attempts by design — these run at process exit, and an
// unbounded retry would hang it. Same contract as sendTelegram: logs,
// never throws.
export const sendTelegramWithRetry = async (creds, text, opts = {}) => {
  if (await sendTelegram(creds, text, opts)) return true;
  (opts.log ?? (() => {}))("telegram send failed — re-sending once");
  return sendTelegram(creds, text, opts);
};
