import { Request, Response } from "express";
import { logger } from "firebase-functions/v2";
import { getFirestore } from "firebase-admin/firestore";
import { runBtcBacktestJob } from "../services/backtest";
import { sendTelegramMessage } from "../services/telegram";

const db = getFirestore();

function fmtUsd(v: number): string {
  const sign = v >= 0 ? "+" : "";
  return `${sign}$${v.toFixed(2)}`;
}

export async function handleGetBacktestStatus(req: Request, res: Response): Promise<void> {
  const user = (req as any).user;
  if (!user?.uid) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const [jobSnap, runsSnap] = await Promise.all([
      db.collection("_jobs").doc("btc_backtest_5m").get(),
      db.collection("backtest_runs").orderBy("createdAt", "desc").limit(5).get(),
    ]);
    const job = jobSnap.data() ?? {};
    const runs = runsSnap.docs.map((d) => {
      const r = d.data();
      return {
        id: d.id,
        trigger: r.trigger,
        symbol: r.symbol,
        candleCount: r.candleCount,
        durationMs: r.durationMs,
        summary: r.summary,
        createdAt: r.createdAt,
      };
    });
    res.json({ job, runs });
  } catch (err) {
    logger.error("[BACKTEST] Status fetch failed", { error: String(err) });
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function handleRunBacktestNow(req: Request, res: Response): Promise<void> {
  const user = (req as any).user;
  if (!user?.uid) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const body = (req.body || {}) as { telegramBotToken?: string; telegramChatId?: string };

  // Fire-and-forget: return 202 immediately, run in background
  res.status(202).json({ status: "started", message: "Backtest running. Results will be sent to Telegram." });

  try {
    const result = await runBtcBacktestJob({ trigger: "manual", failIfLocked: true });

    const text = [
      "Backtest Completed",
      `Symbol: ${result.symbol}`,
      `Candles: ${result.candleCount}`,
      `Trades: ${result.summary.totalTrades}`,
      `Win Rate: ${(result.summary.winRate * 100).toFixed(2)}%`,
      `Net P&L: ${fmtUsd(result.summary.netPnl)}`,
      `Max Drawdown: $${result.summary.maxDrawdown.toFixed(2)}`,
      `Best Hour (UTC): ${result.summary.bestHourUtc}`,
      `Best Grade: ${result.summary.bestGrade}`,
      `Duration: ${(result.durationMs / 1000).toFixed(1)}s`,
    ].join("\n");

    await sendTelegramMessage(text, {
      botToken: body.telegramBotToken,
      chatId: body.telegramChatId,
    }).catch((tgErr) => logger.error("[BACKTEST] Telegram send failed", { error: String(tgErr) }));
  } catch (err) {
    const msg = String(err);
    logger.error("[BACKTEST] Manual trigger failed", { error: msg });
    await sendTelegramMessage(`Backtest FAILED: ${msg}`).catch(() => {});
  }
}
