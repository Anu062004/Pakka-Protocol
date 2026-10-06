import fs from "node:fs";
import { createHash } from "node:crypto";
import { writeJson } from "../scripts/expiry-keeper.ts";

export interface KeeperAlertInput {
  ok: boolean;
  chainId: number;
  alerts: { code: string; seriesId?: number }[];
  unsettledMaturedSeries?: number;
}

export interface AlertResult {
  sent: boolean;
  cooldown?: boolean;
  error?: string;
}

interface AlertFingerprint {
  fingerprint?: string;
  sentAt?: number;
}

export function keeperAlerts(env: NodeJS.ProcessEnv = process.env, { fetcher = fetch, now = Date.now }: {
  fetcher?: typeof fetch;
  now?: () => number;
} = {}): (health: KeeperAlertInput) => Promise<AlertResult> {
  let endpoint: string | undefined, telegram = false;
  if (env.KEEPER_ALERT_WEBHOOK_URL) {
    const url = new URL(env.KEEPER_ALERT_WEBHOOK_URL);
    if (url.protocol !== "https:" || !["discord.com", "discordapp.com"].includes(url.hostname) ||
      !/^\/api\/webhooks\/\d+\/[\w-]+$/.test(url.pathname) || url.search || url.username || url.password) throw new Error("INVALID_ALERT_WEBHOOK");
    endpoint = url.href;
  } else if (env.KEEPER_TELEGRAM_BOT_TOKEN && env.KEEPER_TELEGRAM_CHAT_ID) {
    if (!/^\d+:[\w-]+$/.test(env.KEEPER_TELEGRAM_BOT_TOKEN) || !/^-?\d+$/.test(env.KEEPER_TELEGRAM_CHAT_ID)) throw new Error("INVALID_TELEGRAM_CONFIG");
    endpoint = `https://api.telegram.org/bot${env.KEEPER_TELEGRAM_BOT_TOKEN}/sendMessage`; telegram = true;
  }
  const file = env.KEEPER_ALERT_STATE_FILE || "runtime/keeper-alerts.json";
  let previous: AlertFingerprint = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) as AlertFingerprint : {};
  return async (health: KeeperAlertInput): Promise<AlertResult> => {
    if (!endpoint || health.ok || !health.alerts?.length) return { sent: false };
    const codes = health.alerts.map((a) => ({ code: a.code, seriesId: a.seriesId }));
    const fingerprint = createHash("sha256").update(JSON.stringify(codes)).digest("hex");
    if (previous.fingerprint === fingerprint && now() - (previous.sentAt ?? 0) < 300000) return { sent: false, cooldown: true };
    const text = `Pakka keeper alert | chain ${health.chainId}\n${codes.map((a) => `${a.code}${a.seriesId ? ` (series ${a.seriesId})` : ""}`).join("\n")}\nUnsettled maturities: ${health.unsettledMaturedSeries ?? "unknown"}`;
    try {
      const response = await fetcher(endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(telegram ? { chat_id: env.KEEPER_TELEGRAM_CHAT_ID, text } : { content: text, allowed_mentions: { parse: [] } }),
        signal: AbortSignal.timeout(5000) });
      if (!response.ok) return { sent: false, error: "ALERT_DELIVERY_FAILED" };
      // Do not persist URLs or tokens. A failed delivery is retried on the next tick.
      previous = { fingerprint, sentAt: now() }; writeJson(file, previous);
      return { sent: true };
    } catch { return { sent: false, error: "ALERT_DELIVERY_FAILED" }; }
  };
}
