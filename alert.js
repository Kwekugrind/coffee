import WebSocket from "ws";
import fetch from "node-fetch";
import fs from "fs";

// ==================== REPOSITORY CONFIGURATION ====================
const SYMBOL = "stpRNG";
const SYMBOL_NAME = "Step Index";
const REPO_LABEL = "Coffee Machine";
// ==================================================================

const M5 = 300;
const D1 = 86400;
const CANDLES = 200;
const ATR_PERIOD = 14;
const FRACTAL_LOOKBACK = 8;
const SETUP_EXPIRY_BARS = 15;
const RISK_REWARD = 1.5;

const TG_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT = process.env.TG_CHAT_ID;
const TRIGGER_SOURCE = process.env.TRIGGER_SOURCE;
const MODE = process.env.MODE && process.env.MODE.trim() !== "" ? process.env.MODE.trim() : "scan";

let state = { waitingFor: null, setupEpoch: null, lastProcessedEpoch: null };
try {
  if (fs.existsSync("state.json")) state = JSON.parse(fs.readFileSync("state.json"));
} catch (e) { console.log("State load error, starting fresh."); }

async function sendTelegram(message) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text: message, parse_mode: "Markdown" })
    });
  } catch (err) { console.error("❌ Telegram error:", err.message); }
}

function openWS() {
  return new WebSocket("wss://ws.binaryws.com/websockets/v3?app_id=1089", { headers: { "Origin": "https://deriv.com" } });
}

async function fetchCandles(granularity, count = CANDLES) {
  return new Promise((resolve, reject) => {
    const ws = openWS();
    const timeout = setTimeout(() => { ws.terminate(); reject(new Error("Timeout")); }, 15000);
    ws.on("open", () => ws.send(JSON.stringify({ ticks_history: SYMBOL, adjust_start_time: 1, count, end: "latest", style: "candles", granularity })));
    ws.on("message", (data) => { const r = JSON.parse(data); if (r.error) { clearTimeout(timeout); reject(new Error(r.error.message)); ws.close(); } if (r.candles) { clearTimeout(timeout); resolve(r.candles); ws.close(); } });
    ws.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

async function getCurrentPrice() {
  return new Promise((resolve, reject) => {
    const ws = openWS();
    const timeout = setTimeout(() => { ws.terminate(); reject(new Error("Timeout")); }, 10000);
    ws.on("open", () => ws.send(JSON.stringify({ ticks_history: SYMBOL, count: 1, end: "latest" })));
    ws.on("message", (data) => { const r = JSON.parse(data); if (r.history && r.history.prices) { clearTimeout(timeout); resolve(parseFloat(r.history.prices[0])); ws.close(); } });
    ws.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

function sma(data, period) {
  return data.map((_, i, arr) => { if (i < period - 1) return null; return arr.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period; });
}

function ema(data, period) {
  const k = 2 / (period + 1);
  let emaArr = [data[0]];
  for (let i = 1; i < data.length; i++) emaArr[i] = data[i] * k + emaArr[i - 1] * (1 - k);
  return emaArr;
}

function calculateATR(candles, period) {
  let trs = [];
  for (let i = 1; i < candles.length; i++) { const h = parseFloat(candles[i].high), l = parseFloat(candles[i].low), pc = parseFloat(candles[i-1].close); trs.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc))); }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function getFractals(candles) {
  let hF = [], lF = [];
  for (let i = 2; i < candles.length - 2; i++) {
    const h = parseFloat(candles[i].high);
    if (h > parseFloat(candles[i-1].high) && h > parseFloat(candles[i-2].high) && h > parseFloat(candles[i+1].high) && h > parseFloat(candles[i+2].high)) hF.push(h);
    const l = parseFloat(candles[i].low);
    if (l < parseFloat(candles[i-1].low) && l < parseFloat(candles[i-2].low) && l < parseFloat(candles[i+1].low) && l < parseFloat(candles[i+2].low)) lF.push(l);
  }
  return { significantHigh: hF.length > 0 ? Math.max(...hF.slice(-FRACTAL_LOOKBACK)) : null, significantLow: lF.length > 0 ? Math.min(...lF.slice(-FRACTAL_LOOKBACK)) : null };
}

async function getD1Context() {
  try {
    const d1 = await fetchCandles(D1, 2); if (!d1 || !d1.length) return null;
    const c = d1[d1.length-1]; const open = parseFloat(c.open), close = parseFloat(c.close);
    let direction, change, changePct;
    if (close > open) { direction = "🟢 BULLISH"; change = close-open; changePct = (change/open)*100; }
    else if (close < open) { direction = "🔴 BEARISH"; change = open-close; changePct = (change/open)*100; }
    else { direction = "⚪ NEUTRAL"; change = 0; changePct = 0; }
    return { open, close, direction, change, changePct };
  } catch { return null; }
}

function checkAlignment(signalDir, d1Dir) {
  if (signalDir === "BUY" && d1Dir === "🟢 BULLISH") return "✅ ALIGNED with daily trend";
  if (signalDir === "SELL" && d1Dir === "🔴 BEARISH") return "✅ ALIGNED with daily trend";
  if (d1Dir === "⚪ NEUTRAL") return "⚪ Daily is flat";
  return "⚠️ COUNTER-TREND to daily";
}

async function runSummary(daysBack, title) {
  let trades = fs.existsSync("trades.json") ? JSON.parse(fs.readFileSync("trades.json")) : [];
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - daysBack);
  const pt = trades.filter(t => t.result && t.result !== "CANCELLED" && new Date(t.closeTime) >= cutoff);
  if (pt.length === 0) { await sendTelegram(`📊 *${REPO_LABEL} — ${title}*\n\nNo closed trades in this period.`); return; }
  const wins = pt.filter(t => t.result === "WIN").length, losses = pt.filter(t => t.result === "LOSS").length;
  const netR = pt.reduce((s, t) => s + (t.result === "WIN" ? t.rr : -1), 0);
  await sendTelegram(`📊 *${REPO_LABEL} — ${title}*\n\nTrades:    ${pt.length}\nWins:      ${wins}  |  Losses: ${losses}\nWin Rate:  ${((wins/pt.length)*100).toFixed(1)}%\nNet R:     ${netR.toFixed(1)}R`);
}

(async () => {
  if (MODE === "daily")   { await runSummary(1,  "Daily Report");   process.exit(0); }
  if (MODE === "weekly")  { await runSummary(7,  "Weekly Report");  process.exit(0); }
  if (MODE === "monthly") { await runSummary(30, "Monthly Report"); process.exit(0); }
  if (TRIGGER_SOURCE !== "cronjob") { console.log("⛔ Blocked: Not a cronjob trigger."); process.exit(0); }
  await runScanMode();
})();

async function runScanMode() {
  try {
    let trades = fs.existsSync("trades.json") ? JSON.parse(fs.readFileSync("trades.json")) : [];
    const candles = await fetchCandles(M5, CANDLES);
    if (!candles || candles.length < 50) return;
    const i = candles.length - 2;
    const closes = candles.map(c => parseFloat(c.close));
    const emaFast = ema(closes, 4), emaSlow = ema(closes, 34);
    const macd = emaFast[i] - emaSlow[i];
    let openTrade = trades.find(t => t.result === null);

    if (openTrade) {
      const currentPrice = await getCurrentPrice();
      const macdFlipped = (openTrade.direction === "BUY" && macd < 0) || (openTrade.direction === "SELL" && macd > 0);
      const slHit =
        (openTrade.direction === "BUY"  && currentPrice <= openTrade.sl) ||
        (openTrade.direction === "SELL" && currentPrice >= openTrade.sl);

      let settledResult = null, exitReason = "";

      if (slHit) {
        settledResult = "LOSS";
        exitReason = "Stop Loss Hit";
      } else if (openTrade.tp1Reached) {
        if (macdFlipped) { settledResult = "WIN"; exitReason = "MACD Trail Exit (after TP1)"; }
      } else {
        if (macdFlipped) {
          const closedInProfit =
            (openTrade.direction === "BUY"  && currentPrice >= openTrade.entry) ||
            (openTrade.direction === "SELL" && currentPrice <= openTrade.entry);
          settledResult = closedInProfit ? "WIN" : "LOSS";
          exitReason = closedInProfit
            ? "MACD Early Exit — Closed in Profit (before TP1)"
            : "MACD Early Exit — Partial Loss (before SL hit)";
        } else if (openTrade.direction === "BUY" && currentPrice >= openTrade.tp1) {
          openTrade.tp1Reached = true; fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
          await sendTelegram(`🎯 *TP1 Reached — Now Trailing!*\nSymbol: ${SYMBOL_NAME}\nDirection: BUY\nPrice: ${currentPrice.toFixed(4)} | TP1 was: ${openTrade.tp1.toFixed(4)}\n\nTrade will stay open while M5 MACD > 0.\nWill close when momentum fades.`);
        } else if (openTrade.direction === "SELL" && currentPrice <= openTrade.tp1) {
          openTrade.tp1Reached = true; fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
          await sendTelegram(`🎯 *TP1 Reached — Now Trailing!*\nSymbol: ${SYMBOL_NAME}\nDirection: SELL\nPrice: ${currentPrice.toFixed(4)} | TP1 was: ${openTrade.tp1.toFixed(4)}\n\nTrade will stay open while M5 MACD < 0.\nWill close when momentum fades.`);
        }
      }

      if (settledResult) {
        openTrade.result = settledResult; openTrade.closeTime = new Date().toISOString();
        fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
        const icon = settledResult === "WIN" ? "✅" : "❌";
        const phase = openTrade.tp1Reached ? "Trailed past TP1 ✅" : "Closed before TP1";
        const durationMins = Math.round((new Date(openTrade.closeTime) - new Date(openTrade.openTime)) / 60000);
        await sendTelegram(`${icon} *${REPO_LABEL} — Trade ${settledResult}*\n\nDirection: ${openTrade.direction}\nSymbol:    ${SYMBOL_NAME}\n\n📍 Entry:  ${openTrade.entry.toFixed(4)}\n🏁 Exit:   ${currentPrice.toFixed(4)}\n🛑 SL:     ${openTrade.sl.toFixed(4)}\n🎯 TP1:    ${openTrade.tp1.toFixed(4)}  (${RISK_REWARD}R)\n\nPhase:     ${phase}\nReason:    ${exitReason}\nDuration:  ~${durationMins} min\n\nOpened:  ${openTrade.openTime.substring(0,16).replace("T"," ")} UTC\nClosed:  ${openTrade.closeTime.substring(0,16).replace("T"," ")} UTC`);
      }
      return;
    }

    const currentCandleEpoch = candles[i].epoch;
    const isoTime = new Date(currentCandleEpoch * 1000).toISOString();
    if (state.lastProcessedEpoch === currentCandleEpoch) return;

    const opens = candles.map(c => parseFloat(c.open)), highs = candles.map(c => parseFloat(c.high)), lows = candles.map(c => parseFloat(c.low));
    const smaFast = sma(closes, 4), smaSlow = sma(closes, 34);
    const atr14 = calculateATR(candles, ATR_PERIOD);
    const bodies = candles.map(c => Math.abs(parseFloat(c.close) - parseFloat(c.open)));
    const avgBody = sma(bodies, 20)[i] || 0;
    const crossUp = (smaFast[i-1] <= smaSlow[i-1]) && (smaFast[i] > smaSlow[i]);
    const crossDn = (smaFast[i-1] >= smaSlow[i-1]) && (smaFast[i] < smaSlow[i]);
    if (crossUp) { state.waitingFor = "BUY"; state.setupEpoch = currentCandleEpoch; }
    else if (crossDn) { state.waitingFor = "SELL"; state.setupEpoch = currentCandleEpoch; }
    if (state.waitingFor && state.setupEpoch && (currentCandleEpoch - state.setupEpoch) > (SETUP_EXPIRY_BARS * M5)) { state.waitingFor = null; state.setupEpoch = null; }

    const candleRange = highs[i] - lows[i];
    const closePosBuy = (closes[i] - lows[i]) / candleRange, closePosSell = (highs[i] - closes[i]) / candleRange;
    const smaSeparation = Math.abs(smaFast[i] - smaSlow[i]), sma34Slope = smaSlow[i] - smaSlow[i-3];
    const separationOk = smaSeparation > (atr14 * 0.5), impulseOk = bodies[i] > (avgBody * 1.5);
    const fractals = getFractals(candles);
    const fractalBreakUp = fractals.significantHigh !== null && closes[i] > fractals.significantHigh;
    const fractalBreakDown = fractals.significantLow !== null && closes[i] < fractals.significantLow;
    const buySignal = state.waitingFor === "BUY" && fractalBreakUp && separationOk && sma34Slope > 0 && impulseOk && closePosBuy >= 0.7 && closes[i] > opens[i];
    const sellSignal = state.waitingFor === "SELL" && fractalBreakDown && separationOk && sma34Slope < 0 && impulseOk && closePosSell >= 0.7 && closes[i] < opens[i];

    let signalTriggered = false, direction = "", entry, sl, risk, tp1, tp2, tp3;
    if (buySignal) { signalTriggered = true; direction = "BUY"; entry = closes[i]; sl = fractals.significantLow !== null ? Math.min(fractals.significantLow, entry-atr14*1.5) : entry-atr14*1.5; risk = entry-sl; tp1 = entry+risk*RISK_REWARD; tp2 = entry+risk*2; tp3 = entry+risk*3; }
    else if (sellSignal) { signalTriggered = true; direction = "SELL"; entry = closes[i]; sl = fractals.significantHigh !== null ? Math.max(fractals.significantHigh, entry+atr14*1.5) : entry+atr14*1.5; risk = sl-entry; tp1 = entry-risk*RISK_REWARD; tp2 = entry-risk*2; tp3 = entry-risk*3; }

    if (signalTriggered) {
      const d1 = await getD1Context();
      const alignment = d1 ? checkAlignment(direction, d1.direction) : "⚠️ D1 data unavailable";
      const timeFormatted = new Date(currentCandleEpoch * 1000).toISOString().replace("T"," ").substring(0,19);
      let message = `🚨 ${SYMBOL_NAME.toUpperCase()} CONFIRMED SIGNAL 🚨\n\nDirection: ${direction}\nRepo: ${REPO_LABEL}\nTimeframe: M5\n\n📍 Entry:  ${entry.toFixed(4)}\n🛑 SL:     ${sl.toFixed(4)}\n🎯 TP1:    ${tp1.toFixed(4)}  (${RISK_REWARD}R) → trail with MACD after\n🎯 TP2:    ${tp2.toFixed(4)}  (2R)\n🎯 TP3:    ${tp3.toFixed(4)}  (3R)\n\n📊 Risk:   ${risk.toFixed(2)} points\n🔥 Setup:  Fractal break confirmed with impulse\n━━━━━━━━━━━━━━━━━━━━\n📅 D1 CANDLE STATUS\n━━━━━━━━━━━━━━━━━━━━\n`;
      if (d1) message += `Direction:  ${d1.direction}\nD1 Open:    ${d1.open.toFixed(4)}\nD1 Current: ${d1.close.toFixed(4)}\nMovement:   ${d1.change.toFixed(4)} pts (${d1.changePct.toFixed(2)}%)\nAlignment:  ${alignment}\n\n`;
      else message += `⚠️ D1 data unavailable\n\n`;
      message += `⏰ Time (UTC): ${timeFormatted}`;
      await sendTelegram(message);
      trades.push({ id: `${SYMBOL}-${isoTime}`, repo: REPO_LABEL, symbol: SYMBOL, direction, entry, sl, tp1, tp2, tp3, rr: RISK_REWARD, tp1Reached: false, openTime: timeFormatted, closeTime: null, result: null });
      fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
      state.waitingFor = null; state.setupEpoch = null;
    }

    state.lastProcessedEpoch = currentCandleEpoch;
    fs.writeFileSync("state.json", JSON.stringify(state, null, 2));
  } catch (err) { console.error("❌ BOT ERROR:", err.message); process.exit(1); }
}
