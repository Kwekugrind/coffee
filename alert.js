import WebSocket from "ws";
import fetch from "node-fetch";
import fs from "fs";

const SYMBOL = "R_25_1S"; // ✅ Volatility 25 (1s)
const SYMBOL_TAG = "☕ V25 (1s) — R_25_1S";

const M15 = 900;
const M30 = 1800;
const CANDLES = 200;

const ATR_PERIOD = 14;
const ATR_MULTIPLIER = 1.2;
const RISK_REWARD = 1.5;

const DEBUG = true;

const TG_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT = process.env.TG_CHAT_ID;
const TRIGGER_SOURCE = process.env.TRIGGER_SOURCE;

if (TRIGGER_SOURCE !== "cronjob") {
  console.log("⛔ Blocked:", TRIGGER_SOURCE);
  process.exit(0);
}

async function sendTelegram(message) {
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TG_CHAT,
        text: message
      })
    });
  } catch (err) {
    console.log("Telegram error:", err.message);
  }
}

async function getCandles(granularity) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("wss://ws.binaryws.com/websockets/v3?app_id=1089");

    ws.on("open", () => {
      ws.send(JSON.stringify({
        ticks_history: SYMBOL,
        adjust_start_time: 1,
        count: CANDLES,
        granularity,
        end: "latest",
        style: "candles"
      }));
    });

    ws.on("message", (data) => {
      const response = JSON.parse(data);

      if (response.error) {
        reject(new Error(response.error.message));
        ws.close();
      }

      if (response.candles) {
        resolve(response.candles);
        ws.close();
      }
    });

    ws.on("error", (err) => reject(err));
  });
}

function sma(data, length) {
  return data.map((_, i, arr) => {
    if (i < length - 1) return null;
    const slice = arr.slice(i - length + 1, i + 1);
    return slice.reduce((a, b) => a + b, 0) / length;
  });
}

function calculateATR(candles, period) {
  let trs = [];

  for (let i = 1; i < candles.length; i++) {
    const high = parseFloat(candles[i].high);
    const low = parseFloat(candles[i].low);
    const prevClose = parseFloat(candles[i - 1].close);

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );

    trs.push(tr);
  }

  const recent = trs.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / period;
}

function fractals(highs, lows) {
  let up = [];
  let down = [];

  for (let i = 2; i < highs.length - 2; i++) {
    if (
      highs[i] > highs[i - 1] &&
      highs[i] > highs[i - 2] &&
      highs[i] > highs[i + 1] &&
      highs[i] > highs[i + 2]
    ) up[i] = highs[i];

    if (
      lows[i] < lows[i - 1] &&
      lows[i] < lows[i - 2] &&
      lows[i] < lows[i + 1] &&
      lows[i] < lows[i + 2]
    ) down[i] = lows[i];
  }

  return { up, down };
}

(async () => {
  try {

    const state = JSON.parse(fs.readFileSync("state.json"));

    const m15 = await getCandles(M15);
    const m30 = await getCandles(M30);

    const closes = m15.map(c => parseFloat(c.close));
    const highs30 = m30.map(c => parseFloat(c.high));
    const lows30 = m30.map(c => parseFloat(c.low));

    const sma4 = sma(closes, 4);
    const sma34 = sma(closes, 34);
    const atr = calculateATR(m15, ATR_PERIOD);

    const last = closes.length - 1;
    const candleTime = m15[last].epoch;
    const closePrice = closes[last];

    let newTrend = state.trend;
    let crossHappened = false;

    if (sma4[last - 1] < sma34[last - 1] && sma4[last] > sma34[last]) {
      newTrend = "BUY";
      crossHappened = true;
    }

    if (sma4[last - 1] > sma34[last - 1] && sma4[last] < sma34[last]) {
      newTrend = "SELL";
      crossHappened = true;
    }

    const { up, down } = fractals(highs30, lows30);
    let lastUp = up.filter(Boolean).pop();
    let lastDown = down.filter(Boolean).pop();

    if (DEBUG) {
      console.log("Close:", closePrice);
      console.log("Trend:", newTrend);
      console.log("Fractals:", lastUp, lastDown);
    }

    if (crossHappened && state.lastSignalCandle !== candleTime) {
      await sendTelegram(
`${SYMBOL_TAG}

🔄 TREND CHANGE → ${newTrend}

Price: ${closePrice}
Waiting for M30 fractal break confirmation...`
      );
      state.lastSignalCandle = candleTime;
    }

    let fractalBreak = null;

    if (newTrend === "BUY" && lastUp && closePrice > lastUp) fractalBreak = "BUY";
    if (newTrend === "SELL" && lastDown && closePrice < lastDown) fractalBreak = "SELL";

    function buildMessage(direction) {
      let entry = closePrice;
      let structureStop, atrStop, finalStop, risk, tp;

      if (direction === "BUY") {
        structureStop = lastDown;
        atrStop = entry - (atr * ATR_MULTIPLIER);
        finalStop = Math.max(structureStop, atrStop);
        risk = entry - finalStop;
        tp = entry + (risk * RISK_REWARD);
      } else {
        structureStop = lastUp;
        atrStop = entry + (atr * ATR_MULTIPLIER);
        finalStop = Math.min(structureStop, atrStop);
        risk = finalStop - entry;
        tp = entry - (risk * RISK_REWARD);
      }

      return `${SYMBOL_TAG}

✅ ${direction} CONFIRMED — Hybrid Stop

Entry: ${entry}
Stop: ${finalStop.toFixed(3)}
TP: ${tp.toFixed(3)}
RR: 1 : ${RISK_REWARD}`;
    }

    if (fractalBreak && state.lastFractalBreakCandle !== candleTime) {
      await sendTelegram(buildMessage(fractalBreak));
      state.lastFractalBreakCandle = candleTime;
    }

    state.trend = newTrend;
    fs.writeFileSync("state.json", JSON.stringify(state, null, 2));

  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
})();
