import WebSocket from "ws";
import fetch from "node-fetch";
import fs from "fs";

const SYMBOL = "STEP";   // ✅ Step Index
const SYMBOL_NAME = "📊 Step Index";

const M15 = 900;
const M30 = 1800;
const CANDLES = 200;

const ATR_PERIOD = 14;
const RISK_REWARD = 1.5;

const DEBUG = true;

const TG_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT = process.env.TG_CHAT_ID;
const TRIGGER_SOURCE = process.env.TRIGGER_SOURCE;

if (TRIGGER_SOURCE !== "cronjob") {
  console.log("⛔ Blocked:", TRIGGER_SOURCE);
  process.exit(0);
}

let state = {
  activeDirection: null,
  lastCrossCandle: null,
  lastConfirmCandle: null
};

// ✅ LOAD STATE
try {
  if (fs.existsSync("state.json")) {
    state = JSON.parse(fs.readFileSync("state.json"));
  }
} catch (e) {
  console.log("State load error.");
}

// ✅ STATE VISIBILITY
console.log("✅ Loaded state at start:", state);

async function sendTelegram(message) {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TG_CHAT,
      text: message
    })
  });
}

async function getCandles(granularity, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const candles = await new Promise((resolve, reject) => {
        const ws = new WebSocket("wss://ws.derivws.com/websockets/v3?app_id=1089");

        const timeout = setTimeout(() => {
          ws.terminate();
          reject(new Error("WebSocket timeout"));
        }, 15000);

        ws.on("open", () => {
          ws.send(JSON.stringify({
            candles: SYMBOL,
            count: CANDLES,
            granularity,
            end: "latest"
        }));
        });

        ws.on("message", (data) => {
          const response = JSON.parse(data);

          if (response.error) {
            clearTimeout(timeout);
            reject(new Error(response.error.message));
            ws.close();
          }

          if (response.candles) {
            clearTimeout(timeout);
            resolve(response.candles);
            ws.close();
          }
        });

        ws.on("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      return candles;

    } catch (err) {
      console.log(`Attempt ${attempt} failed: ${err.message}`);
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

function sma(data, length) {
  return data.map((_, i, arr) => {
    if (i < length - 1) return null;
    return arr.slice(i - length + 1, i + 1)
      .reduce((a, b) => a + b, 0) / length;
  });
}

function calculateATR(candles, period) {
  let trs = [];
  for (let i = 1; i < candles.length; i++) {
    const high = parseFloat(candles[i].high);
    const low = parseFloat(candles[i].low);
    const prevClose = parseFloat(candles[i - 1].close);

    trs.push(Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    ));
  }
  return trs.slice(-period)
    .reduce((a, b) => a + b, 0) / period;
}

function fractals(highs, lows) {
  let up = [], down = [];
  for (let i = 2; i < highs.length - 2; i++) {
    if (
      highs[i] > highs[i-1] &&
      highs[i] > highs[i-2] &&
      highs[i] > highs[i+1] &&
      highs[i] > highs[i+2]
    ) up[i] = highs[i];

    if (
      lows[i] < lows[i-1] &&
      lows[i] < lows[i-2] &&
      lows[i] < lows[i+1] &&
      lows[i] < lows[i+2]
    ) down[i] = lows[i];
  }
  return { up, down };
}

(async () => {
  try {

    await new Promise(resolve => setTimeout(resolve, 20000));

    const m15 = await getCandles(M15);
    const m30 = await getCandles(M30);

    const closes = m15.map(c => parseFloat(c.close));
    const highs30 = m30.map(c => parseFloat(c.high));
    const lows30 = m30.map(c => parseFloat(c.low));

    const sma4 = sma(closes, 4);
    const sma34 = sma(closes, 34);
    const atr = calculateATR(m15, ATR_PERIOD);

    // ✅ Use last fully CLOSED candle (never forming candle)
    const last = closes.length - 2;
    const prev = last - 1;

    const candleTime = m15[last].epoch;
    const isoTime = new Date(candleTime * 1000).toISOString();
    const closePrice = closes[last];

    let crossDirection = null;

    if (sma4[prev] <= sma34[prev] && sma4[last] > sma34[last]) {
      crossDirection = "BUY";
    }

    if (sma4[prev] >= sma34[prev] && sma4[last] < sma34[last]) {
      crossDirection = "SELL";
    }

    if (crossDirection && state.lastCrossCandle !== candleTime) {

      state.activeDirection = crossDirection;
      state.lastCrossCandle = candleTime;

      await sendTelegram(
`══════════════════════
${SYMBOL_NAME}
══════════════════════

🔄 TREND CHANGE → ${crossDirection}

Price: ${closePrice}
Time: ${isoTime}

Waiting for M30 fractal break confirmation...`
      );
    }

    const { up, down } = fractals(highs30, lows30);
    const lastUp = up.filter(Boolean).pop();
    const lastDown = down.filter(Boolean).pop();

    let fractalBreak = null;

    if (state.activeDirection === "BUY" && lastUp && closePrice > lastUp)
      fractalBreak = "BUY";

    if (state.activeDirection === "SELL" && lastDown && closePrice < lastDown)
      fractalBreak = "SELL";

    if (fractalBreak && state.lastConfirmCandle !== candleTime) {

      let entry = closePrice;
      let finalStop, risk, tp;

      if (fractalBreak === "BUY") {

        let recentLow = Math.min(
          m15[last].low,
          m15[last - 1].low,
          m15[last - 2].low
        );

        let structureStop = recentLow - (atr * 0.2);
        let maxStopDistance = atr * 1.0;

        if (entry - structureStop > maxStopDistance) {
          finalStop = entry - maxStopDistance;
        } else {
          finalStop = structureStop;
        }

        risk = entry - finalStop;
        tp = entry + (risk * RISK_REWARD);

      } else {

        let recentHigh = Math.max(
          m15[last].high,
          m15[last - 1].high,
          m15[last - 2].high
        );

        let structureStop = recentHigh + (atr * 0.2);
        let maxStopDistance = atr * 1.0;

        if (structureStop - entry > maxStopDistance) {
          finalStop = entry + maxStopDistance;
        } else {
          finalStop = structureStop;
        }

        risk = finalStop - entry;
        tp = entry - (risk * RISK_REWARD);
      }

      await sendTelegram(
`══════════════════════
${SYMBOL_NAME}
══════════════════════

✅ ${fractalBreak} CONFIRMED — Hybrid Stop

Entry: ${entry}
Stop: ${finalStop.toFixed(3)}
TP: ${tp.toFixed(3)}
RR: 1 : ${RISK_REWARD}

Time: ${isoTime}`
      );

      state.activeDirection = null;
      state.lastConfirmCandle = candleTime;
    }

    if (DEBUG) {
      console.log("════════ DEBUG ════════");
      console.log("Symbol:", SYMBOL_NAME);
      console.log("Time:", isoTime);
      console.log("Close:", closePrice);
      console.log("Cross Direction:", crossDirection);
      console.log("Active Direction:", state.activeDirection);
      console.log("Last M30 Up:", lastUp);
      console.log("Last M30 Down:", lastDown);
      console.log("Fractal Break:", fractalBreak);
      console.log("═══════════════════════");
    }

    fs.writeFileSync("state.json", JSON.stringify(state, null, 2));

  } catch (err) {
    console.error("BOT ERROR:", err.message);
    process.exit(1);
  }
})();
