import WebSocket from "ws";
import fetch from "node-fetch";
import fs from "fs";

// ==================== REPOSITORY CONFIGURATION ====================
// UNCOMMENT THE CONFIGURATION MATCHING YOUR REPOSITORY:

// --- 1. Test Bot (Live) ---
// const SYMBOL = "R_10"; const SYMBOL_NAME = "Volatility 10 Index"; const REPO_LABEL = "Test Bot (V10 Live)"; const MULTIPLIER = 400; const COMMISSION_USD = 0.16;

// --- 2. OmniSight (Live) ---
// const SYMBOL = "R_50"; const SYMBOL_NAME = "Volatility 50 Index"; const REPO_LABEL = "OmniSight (V50)"; const MULTIPLIER = 80; const COMMISSION_USD = 0.16;

// --- 3. Lery's Alerts (Demo) ---
// const SYMBOL = "R_75"; const SYMBOL_NAME = "Volatility 75 Index"; const REPO_LABEL = "Lery's Alerts (V75 Demo)"; const MULTIPLIER = 50; const COMMISSION_USD = 0.15;

// --- 4. Coffee (Demo) ---
const SYMBOL = "1HZ75V"; const SYMBOL_NAME = "Volatility 75 (1s) Index"; const REPO_LABEL = "Coffee (V75-1s Demo)"; const MULTIPLIER = 50; const COMMISSION_USD = 0.15;

// --- 5. Milk (Demo) ---
// const SYMBOL = "R_100"; const SYMBOL_NAME = "Volatility 100 Index"; const REPO_LABEL = "Milk (V100 Demo)"; const MULTIPLIER = 40; const COMMISSION_USD = 0.15;

// --- 6. Tea (Demo) ---
// const SYMBOL = "R_25"; const SYMBOL_NAME = "Volatility 25 Index"; const REPO_LABEL = "Tea (V25 Demo)"; const MULTIPLIER = 160; const COMMISSION_USD = 0.15;

// --- 7. Ice Cream Machine (Demo) ---
// const SYMBOL = "1HZ100V"; const SYMBOL_NAME = "Volatility 100 (1s) Index"; const REPO_LABEL = "Ice Cream Machine"; const MULTIPLIER = 40; const COMMISSION_USD = 0.15;

const TRADING_SYMBOL = SYMBOL;
const STAKE_USD = 10;
const RISK_REWARD = 1.5;
const BREAKEVEN_ACTIVATE_USD = 3.00; // Move SL to entry once profit hits $3.00
const ATR_PERIOD = 14;
const ATR_MULTIPLIER = 2.0; // Stop loss breathing room
const SETUP_EXPIRY_BARS = 35;
const MARKET_DATA_APP_ID = "1089";
const DERIV_APP_ID = process.env.DERIV_APP_ID || "67418";
const TG_TOKEN = process.env.TG_BOT_TOKEN || process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const DERIV_TOKEN = process.env.DERIV_API_TOKEN;
const PROXY_URL = process.env.PROXY_URL;
const PROXY_SECRET = process.env.PROXY_SECRET;
const MODE = process.env.MODE || "cronjob";
const TRIGGER_SOURCE = process.env.TRIGGER_SOURCE || "manual";

const M5 = 5 * 60;
const M15 = 15 * 60;
const H1 = 60 * 60;
const H4 = 4 * 60 * 60;
const D1 = 24 * 60 * 60;

const DEBUG = process.env.DEBUG === "true";
function dbg(...a) { if (DEBUG) console.log("[DBG]", ...a); }

// ==================== TELEGRAM & UTILS ====================
async function sendTelegram(msg) {
  if (!TG_TOKEN || !TG_CHAT_ID) {
    console.warn("Telegram not configured: TG_TOKEN or TG_CHAT_ID is missing. Skipping sendTelegram.");
    return { ok: false, error: "missing_credentials" };
  }
  const send = async (text, parseMode) => {
    const body = { chat_id: TG_CHAT_ID, text };
    if (parseMode) body.parse_mode = parseMode;
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    let json;
    try { json = await res.json(); } catch (e) { json = { ok: false, error: `invalid_json_response: ${e.message}` }; }
    json.__http_status = res.status;
    return json;
  };
  try {
    const data = await send(msg, "Markdown");
    if (!data.ok) {
      console.error(`Telegram Markdown rejected (${data.error_code || data.error || 'unknown'}): ${data.description || JSON.stringify(data)}`);
      const plain = msg.replace(/[*_`\[\]]/g, "");
      const retry = await send(plain, "");
      if (!retry.ok) {
        console.error(`Telegram plain-text retry also failed: ${retry.description || JSON.stringify(retry)}`);
        return { ok: false, error: "telegram_send_failed", detail: retry };
      }
      return { ok: true, via: "plain_text", detail: retry };
    }
    return { ok: true, via: "markdown", detail: data };
  } catch (e) { console.error("Telegram fetch error:", e.message); return { ok: false, error: e.message }; }
}

function formatDuration(ms) {
  const s = Math.floor(ms/1000), m = Math.floor(s/60), h = Math.floor(m/60);
  if (h > 0) return `${h}h ${m%60}m`;
  if (m > 0) return `${m}m ${s%60}s`;
  return `${s}s`;
}

async function runSummary(label) {
  const trades = fs.existsSync("trades.json") ? JSON.parse(fs.readFileSync("trades.json")) : [];
  const closed = trades.filter(t => t.result);
  const wins = closed.filter(t => t.result === "WIN").length;
  const losses = closed.filter(t => t.result === "LOSS").length;
  const openTrades = trades.filter(t => !t.result);
  let msg = `📊 *${label} Summary — ${REPO_LABEL}*\n\nTotal closed: ${closed.length}\n✅ Wins: ${wins} | ❌ Losses: ${losses}\nWin rate: ${closed.length ? ((wins/closed.length)*100).toFixed(1) : 0}%\nOpen positions: ${openTrades.length}`;
  if (openTrades.length) msg += "\n\n*Open trades:*\n" + openTrades.map(t => `• ${t.direction} @ ${t.entry} (${t.openTime})`).join("\n");
  await sendTelegram(msg);
}

async function checkTelegramCommands() {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  try {
    const url = `https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${state.lastTgUpdateId + 1}&limit=10&timeout=0`;
    const res = await fetch(url); const data = await res.json();
    if (!data.ok) return;
    for (const update of data.result) {
      state.lastTgUpdateId = update.update_id;
      const text = update.message?.text?.trim()?.toLowerCase();
      if (text === "/status") {
        const trades = fs.existsSync("trades.json") ? JSON.parse(fs.readFileSync("trades.json")) : [];
        const open = trades.filter(t => !t.result);
        await sendTelegram(open.length ? `📍 Open trades:\n${open.map(t=>`• ${t.direction} @ ${t.entry}`).join("\n")}` : "No open trades.");
      }
      if (text === "/close win" || text === "/closewin") { await executeManualClose("WIN", "telegram command"); }
      if (text === "/close loss" || text === "/closeloss") { await executeManualClose("LOSS", "telegram command"); }
    }
    fs.writeFileSync("state.json", JSON.stringify(state, null, 2));
  } catch (e) { console.error("TG check error:", e.message); }
}

async function executeManualClose(result, reason) {
  const trades = fs.existsSync("trades.json") ? JSON.parse(fs.readFileSync("trades.json")) : [];
  const open = trades.filter(t => !t.result);
  if (!open.length) { await sendTelegram(`⚠️ *${REPO_LABEL}*\n\nNo open trade found to close.`); return; }
  for (const trade of open) {
    const currentPrice = await getCurrentPrice(trade.symbol);
    
    let serverPnl = calcUnrealizedPnL(trade, currentPrice);
    if (trade.contractId) { 
      try { 
        const closeRes = await closeContract(trade.contractId); 
        if (!closeRes || closeRes.error) {
          const errDesc = closeRes?.error?.message || JSON.stringify(closeRes);
          await sendTelegram(`⚠️ *${REPO_LABEL}* — Manual Close Warning\n\nFailed to close contract \`${trade.contractId}\` on Deriv: ${errDesc}. Retrying next scan.`);
          continue; 
        }
        if (typeof closeRes.sell?.profit === 'number') {
          serverPnl = closeRes.sell.profit;
        }
      } catch (e) { 
        console.error("Close error:", e.message); 
        continue; 
      } 
    }

    trade.result = result;
    trade.closeTime = new Date().toISOString().replace("T"," ").substring(0,19);
    fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
    const icon = result === "WIN" ? "✅" : "❌";
    const contractType = trade.direction === "BUY" ? "MULTUP" : "MULTDOWN";
    const durationMs = new Date(trade.closeTime) - new Date(trade.openTime);
    const slDollars = parseFloat((STAKE_USD * 0.5).toFixed(2));
    const tpDollars = parseFloat((STAKE_USD * RISK_REWARD).toFixed(2));
    const pnlStr = serverPnl >= 0 ? `+$${serverPnl.toFixed(2)}` : `-$${Math.abs(serverPnl).toFixed(2)}`;
    const tp1Status = trade.tp1Reached ? "✅ TP1 hit" : "❌ TP1 not reached";
    await sendTelegram(`${icon} *${REPO_LABEL} — Trade ${result}*\n\nDirection: ${trade.direction} (${contractType})\nSymbol: ${SYMBOL_NAME}\n\n📍 Entry: ${trade.entry.toFixed(4)}\n🏁 Exit: ${currentPrice.toFixed(4)}\n🛑 SL: ${trade.sl.toFixed(4)} ($${slDollars} hard)\n🎯 TP1: ${trade.tp1.toFixed(4)} (BGA) ${tp1Status}\n\n💵 P&L: ${pnlStr} (Net of comm.)\nReason: ${reason}\nDuration: ${formatDuration(durationMs)}\n\nOpened: ${trade.openTime}\nClosed: ${trade.closeTime}\n` + (trade.contractId ? `Contract: \`${trade.contractId}\`` : ""));
  }
}

let state = { waitingFor: null, setupEpoch: null, lastProcessedEpoch: null, lastTgUpdateId: 0, h1TrendEpoch: null, phaseATriggeredEpoch: null, activeEntryType: null, anticipatedTrend: null, pendingPullback: null, pullbackEpoch: null, pullbackTrigger: null, rsiLowerBreakSeen: false, rsiUpperBreakSeen: false };
try {
  const s = JSON.parse(fs.readFileSync("state.json"));
  state = {
    ...state,
    ...s,
    waitingFor: s.waitingFor ?? null,
    setupEpoch: s.setupEpoch ?? null,
    h1TrendEpoch: s.h1TrendEpoch ?? null,
    phaseATriggeredEpoch: s.phaseATriggeredEpoch ?? null,
    activeEntryType: s.activeEntryType ?? null,
    anticipatedTrend: s.anticipatedTrend ?? null,
    pendingPullback: s.pendingPullback ?? null,
    pullbackEpoch: s.pullbackEpoch ?? null,
    pullbackTrigger: s.pullbackTrigger ?? null,
    rsiLowerBreakSeen: s.rsiLowerBreakSeen ?? false,
    rsiUpperBreakSeen: s.rsiUpperBreakSeen ?? false
  };
} catch {}

// ==================== DERIV API & PROXY HELPERS ====================
function openWS() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${MARKET_DATA_APP_ID}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
    setTimeout(() => reject(new Error("WS timeout")), 15000);
  });
}

async function withRetry(fn, retries = 3, delay = 2000) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

async function fetchCandles(granularity, count = 100) {
  return withRetry(async () => {
    const ws = await openWS();
    return new Promise((resolve, reject) => {
      ws.send(JSON.stringify({ ticks_history: SYMBOL, granularity, count, end: "latest", style: "candles" }));
      ws.on("message", d => {
        const msg = JSON.parse(d); ws.close();
        if (msg.candles) resolve(msg.candles);
        else reject(new Error("No candles: " + JSON.stringify(msg)));
      });
      setTimeout(() => { ws.close(); reject(new Error("fetchCandles timeout")); }, 20000);
    });
  });
}

async function getCurrentPrice(sym = SYMBOL) {
  return withRetry(async () => {
    const ws = await openWS();
    return new Promise((resolve, reject) => {
      ws.send(JSON.stringify({ ticks_history: sym, count: 1, end: "latest", style: "ticks" }));
      ws.on("message", d => {
        const msg = JSON.parse(d); ws.close();
        if (msg.history?.prices?.length)
          resolve(parseFloat(msg.history.prices[msg.history.prices.length - 1]));
        else reject(new Error("No price: " + JSON.stringify(msg)));
      });
      setTimeout(() => { ws.close(); reject(new Error("getCurrentPrice timeout")); }, 10000);
    });
  });
}

async function getDerivAccountId() {
  const res = await fetch("https://api.derivws.com/trading/v1/options/accounts", {
    headers: { "Deriv-App-ID": DERIV_APP_ID, "Authorization": `Bearer ${DERIV_TOKEN}` }
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`getAccounts failed: ${JSON.stringify(json.errors || json)}`);
  const accounts = json.data;
  if (!accounts || accounts.length === 0) throw new Error("No Deriv accounts found");
  
  // ==================== ACCOUNT ROUTING (SELECT ONE) ====================
  // For LIVE Repos (Test Bot, OmniSight):
  // const account = accounts.find(a => a.account_type !== "demo") || accounts[0];
  
  // For DEMO Repos (Lery's Alerts, Coffee, Milk, Tea, Ice Cream Machine):
  const account = accounts.find(a => a.account_type === "demo") || accounts[0];
  // ======================================================================

  console.log(` Account ID: ${account.account_id} (${account.account_type})`);
  return account.account_id;
}

async function getDerivOTP(accountId) {
  const res = await fetch(`https://api.derivws.com/trading/v1/options/accounts/${accountId}/otp`, {
    method: "POST", headers: { "Deriv-App-ID": DERIV_APP_ID, "Authorization": `Bearer ${DERIV_TOKEN}` }
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`getOTP failed: ${JSON.stringify(json.errors || json)}`);
  console.log(` OTP WebSocket URL obtained ✅`);
  return json.data.url;
}

async function executeTrade(direction) {
  if (!DERIV_TOKEN) { console.log("⚠️ DERIV_API_TOKEN not set. Skipping."); return null; }
  if (!DERIV_APP_ID) { console.log("⚠️ DERIV_APP_ID not set. Skipping."); return null; }
  if (!PROXY_URL || !PROXY_SECRET) { console.log("⚠️ PROXY_URL or PROXY_SECRET not set. Skipping."); return null; }
  console.log(`🔄 Sending ${direction} trade via Cloudflare proxy...`);
  const accountId = await getDerivAccountId();
  const wsUrl = await getDerivOTP(accountId);
  const slDollars = parseFloat((STAKE_USD * 0.5).toFixed(2));
  const params = {
    buy: "1",
    price: STAKE_USD,
    parameters: {
      contract_type: direction === "BUY" ? "MULTUP" : "MULTDOWN",
      underlying_symbol: TRADING_SYMBOL,
      currency: "USD",
      amount: STAKE_USD,
      basis: "stake",
      multiplier: MULTIPLIER,
      limit_order: {
        stop_loss: slDollars
      }
    }
  };
  const response = await fetch(PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-proxy-secret": PROXY_SECRET },
    body: JSON.stringify({ wsUrl, action: "buy", params })
  });
  const data = await response.json();
  console.log("📨 Proxy response:", JSON.stringify(data));
  if (data.error) throw new Error(data.error);
  const contractId = data.buy?.contract_id;
  if (contractId) { console.log(`✅ Trade Executed! Contract ID: ${contractId}`); return contractId; }
  return null;
}

async function closeContract(contractId) {
  if (!DERIV_TOKEN || !contractId || !PROXY_URL || !PROXY_SECRET || !DERIV_APP_ID) return null;
  console.log(`🔄 Closing contract ${contractId} via proxy...`);
  const accountId = await getDerivAccountId();
  const wsUrl = await getDerivOTP(accountId);
  const response = await fetch(PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-proxy-secret": PROXY_SECRET },
    body: JSON.stringify({ wsUrl, action: "sell", params: { sell: contractId, price: 0 } })
  });
  const data = await response.json();
  console.log("📨 Close response:", JSON.stringify(data));
  return data;
}

// ==================== TECHNICAL ANALYSIS & INDICATORS ====================
function sma(data, period) {
  return data.map((_, i) => {
    if (i < period - 1) return null;
    return data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
  });
}

function ema(data, period) {
  const k = 2 / (period + 1);
  const result = [];
  let prev = null;
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { result.push(null); continue; }
    if (i === period - 1) { prev = data.slice(0, period).reduce((a,b)=>a+b,0)/period; result.push(prev); continue; }
    prev = data[i] * k + prev * (1 - k);
    result.push(prev);
  }
  return result;
}

function calculateATR(candles, period) {
  const trs = candles.map((c, i) => {
    if (i === 0) return parseFloat(c.high) - parseFloat(c.low);
    const ph = parseFloat(candles[i-1].close);
    return Math.max(parseFloat(c.high) - parseFloat(c.low), Math.abs(parseFloat(c.high) - ph), Math.abs(parseFloat(c.low) - ph));
  });
  const atrs = sma(trs, period);
  return atrs[atrs.length - 1] || (trs.reduce((a,b)=>a+b,0)/trs.length);
}

function calcUnrealizedPnL(trade, currentPrice) {
  const rawPnl = trade.direction === "BUY" ? (currentPrice - trade.entry) / trade.entry * STAKE_USD * MULTIPLIER : (trade.entry - currentPrice) / trade.entry * STAKE_USD * MULTIPLIER;
  return rawPnl - COMMISSION_USD;
}

function calculateMACD(data, fastPeriod = 3, slowPeriod = 50, signalPeriod = 1) {
  const fastEMA = ema(data, fastPeriod);
  const slowEMA = ema(data, slowPeriod);
  const macdLine = fastEMA.map((f, i) => (f != null && slowEMA[i] != null) ? f - slowEMA[i] : null);
  const validMacd = macdLine.map(x => x !== null ? x : 0);
  const signalLine = ema(validMacd, signalPeriod);
  const histogram = macdLine.map((m, i) => (m != null && signalLine[i] != null) ? m - signalLine[i] : null);
  return { macdLine, signalLine, histogram };
}

function calculateCCI(candles, period = 34) {
  const tp = candles.map(c => (parseFloat(c.high) + parseFloat(c.low) + parseFloat(c.close)) / 3);
  const smaTp = sma(tp, period);
  return tp.map((_, i) => {
    if (i < period - 1 || smaTp[i] == null) return null;
    const sliceTp = tp.slice(i - period + 1, i + 1);
    const meanTp = smaTp[i];
    const meanDev = sliceTp.reduce((sum, val) => sum + Math.abs(val - meanTp), 0) / period;
    if (meanDev === 0) return 0;
    return (tp[i] - meanTp) / (0.015 * meanDev);
  });
}

function calculateRSI(data, period = 14) {
  const result = new Array(data.length).fill(null);
  if (data.length <= period) return result;
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = data[i] - data[i-1];
    if (diff >= 0) gainSum += diff;
    else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  let rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  result[period] = 100 - (100 / (1 + rs));
  for (let i = period + 1; i < data.length; i++) {
    const diff = data[i] - data[i-1];
    const gain = diff >= 0 ? diff : 0;
    const loss = diff >= 0 ? 0 : -diff;
    avgGain = ((avgGain * (period - 1)) + gain) / period;
    avgLoss = ((avgLoss * (period - 1)) + loss) / period;
    rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result[i] = 100 - (100 / (1 + rs));
  }
  return result;
}

function calculateBollingerBands(data, period = 34, deviation = 1.619) {
  const middle = sma(data, period);
  const upper = [];
  const lower = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1 || middle[i] == null || data[i] == null) {
      upper.push(null);
      lower.push(null);
      continue;
    }
    const slice = data.slice(i - period + 1, i + 1);
    if (slice.some(val => val == null)) {
      upper.push(null);
      lower.push(null);
      continue;
    }
    const mean = middle[i];
    const variance = slice.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / period;
    const stdev = Math.sqrt(variance);
    upper.push(mean + (stdev * deviation));
    lower.push(mean - (stdev * deviation));
  }
  return { upper, middle, lower };
}

function getBGAInfo(price) {
  let step = 100;
  if (price > 10000) step = 500;
  else if (price > 1000) step = 100;
  const whole = Math.round(price / step) * step;
  const half = whole - (step / 2);
  const isWhole = Math.abs(price - whole) <= (step * 0.05);
  const isHalf = Math.abs(price - half) <= (step * 0.05);
  if (isWhole) return `BGA Whole Level (${whole})`;
  if (isHalf) return `BGA Half Level (${half})`;
  return `BGA Zone (Near ${whole})`;
}

function calculateBgaTakeProfits(entry, direction, atr14) {
  let step = 100;
  if (entry > 10000) step = 500;
  else if (entry > 1000) step = 100;

  const halfStep = step / 2;
  const baseWhole = Math.round(entry / step) * step;

  // Minimum distance buffer to prevent micro-targets (at least 20% of step or 1.2 * ATR)
  const minBuffer = Math.max(step * 0.20, atr14 * 1.2);

  // Generate the full fine grid (Whole and Half numbers) for sequencing
  const allLevels = [];
  for (let offset = -10 * step; offset <= 15 * step; offset += halfStep) {
    allLevels.push(baseWhole + offset);
  }

  if (direction === "BUY") {
    // 1. TP1 MUST BE A BGA WHOLE NUMBER strictly above entry satisfying minBuffer
    let w = baseWhole;
    if (w <= entry) w += step;
    let validTp1 = null;
    while (!validTp1 && w <= entry + (step * 5)) {
      if ((w - entry) >= minBuffer) {
        validTp1 = w;
      }
      w += step;
    }
    const tp1 = validTp1 || (baseWhole + step);

    // 2. TP2 and TP3 are the next immediate BGA levels (Half then Whole) after TP1
    const futureLevels = allLevels.filter(l => l > tp1).sort((a, b) => a - b);

    return {
      tp1: tp1,
      tp2: futureLevels[0] || tp1 + halfStep,
      tp3: futureLevels[1] || tp1 + step
    };

  } else {
    // SELL direction: TP1 MUST BE A BGA WHOLE NUMBER strictly below entry satisfying minBuffer
    let w = baseWhole;
    if (w >= entry) w -= step;
    let validTp1 = null;
    while (!validTp1 && w >= entry - (step * 5)) {
      if ((entry - w) >= minBuffer) {
        validTp1 = w;
      }
      w -= step;
    }
    const tp1 = validTp1 || (baseWhole - step);

    const futureLevels = allLevels.filter(l => l < tp1).sort((a, b) => b - a);

    return {
      tp1: tp1,
      tp2: futureLevels[0] || tp1 - halfStep,
      tp3: futureLevels[1] || tp1 - step
    };
  }
}

async function fetchH4Candle() {
  try {
    const candles = await fetchCandles(H4, 10);
    if (!candles || candles.length < 2) return null;
    return candles[candles.length - 2];
  } catch (e) { console.error("fetchH4Candle error:", e.message); return null; }
}

async function getD1Context() {
  try {
    const candles = await fetchCandles(D1, 5);
    if (!candles || candles.length < 2) return null;
    const c = candles[candles.length - 2];
    const open = parseFloat(c.open), close = parseFloat(c.close);
    const change = close - open, changePct = (change / open) * 100;
    return { direction: close > open ? "🟢 BULLISH" : "🔴 BEARISH", open, close, change, changePct };
  } catch (e) { console.error("getD1Context error:", e.message); return null; }
}

function checkAlignment(signalDir, d1Dir) {
  const bull = d1Dir.includes("BULLISH"), bear = d1Dir.includes("BEARISH");
  if (signalDir === "BUY" && bull) return "✅ D1 confirms BUY";
  if (signalDir === "SELL" && bear) return "✅ D1 confirms SELL";
  if (signalDir === "BUY" && bear) return "⚠️ Counter-trend BUY (D1 bearish)";
  if (signalDir === "SELL" && bull) return "⚠️ Counter-trend SELL (D1 bullish)";
  return "❓ Unknown";
}

// ==================== MAIN SCANNER & TRADE LOGIC ====================
async function runScanMode() {
  console.log(`[${REPO_LABEL}] Scan started — ${new Date().toISOString()}`);
  await checkTelegramCommands();
  let trades = [];
  try { trades = JSON.parse(fs.readFileSync("trades.json")); } catch {}

  // ── Open Position Management ──────────────────────────────────────────
  const openTrade = trades.find(t => !t.result);
  if (openTrade) {
    const currentPrice = await getCurrentPrice();
    const pnl = calcUnrealizedPnL(openTrade, currentPrice);
    dbg(`Open trade PnL: ${pnl.toFixed(4)}`);

    const closeWith = async (result, exitReason) => {
      openTrade.result = result;
      openTrade.closeTime = new Date().toISOString().replace("T"," ").substring(0,19);
      
      let serverPnl = pnl;
      if (openTrade.contractId) {
        try {
          const closeRes = await closeContract(openTrade.contractId);
          if (!closeRes || closeRes.error) {
            const errDesc = closeRes?.error?.message || JSON.stringify(closeRes);
            console.error(`⚠️ Failed to close contract on Deriv: ${errDesc}`);
            await sendTelegram(`⚠️ *${REPO_LABEL}* — Close Warning\n\nFailed to close contract \`${openTrade.contractId}\` on Deriv: ${errDesc}. Retrying next scan.`);
            return; // Abort local closure so it retries!
          }
          if (typeof closeRes.sell?.profit === 'number') {
            serverPnl = closeRes.sell.profit;
          }
        } catch (e) {
          console.error("Close exception:", e.message);
          await sendTelegram(`⚠️ *${REPO_LABEL}* — Close Error\n\nException closing contract \`${openTrade.contractId}\`: ${e.message}. Retrying next scan.`);
          return; // Abort local closure so it retries!
        }
      }

      fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
      const icon = result === "WIN" ? "✅" : "❌";
      const contractType = openTrade.direction === "BUY" ? "MULTUP" : "MULTDOWN";
      const durationMs = new Date(openTrade.closeTime) - new Date(openTrade.openTime);
      const slDollars = parseFloat((STAKE_USD * 0.5).toFixed(2));
      const tpDollars = parseFloat((STAKE_USD * RISK_REWARD).toFixed(2));
      const tp1Status = openTrade.tp1Reached ? "✅ TP1 hit" : "❌ TP1 not reached";
      const pnlStr = serverPnl >= 0 ? `+$${serverPnl.toFixed(2)}` : `-$${Math.abs(serverPnl).toFixed(2)}`;
      
      await sendTelegram(`${icon} *${REPO_LABEL} — Trade ${result}*\n\nDirection: ${openTrade.direction} (${contractType})\nSymbol: ${SYMBOL_NAME}\n\n📍 Entry: ${openTrade.entry.toFixed(4)}\n🏁 Exit: ${currentPrice.toFixed(4)}\n🛑 SL: ${openTrade.sl.toFixed(4)} ($${slDollars} hard)\n🎯 TP1: ${openTrade.tp1.toFixed(4)} (BGA) ${tp1Status}\n\n💵 P&L: ${pnlStr} (Net of comm.)\nReason: ${exitReason}\nDuration: ${formatDuration(durationMs)}\n\nOpened: ${openTrade.openTime}\nClosed: ${openTrade.closeTime}\n` + (openTrade.contractId ? `Contract: \`${openTrade.contractId}\`` : ""));
    };

    // BREAKEVEN PROTECTION: Arm once profit hits $3.00
    if (!openTrade.tp1Reached && !openTrade.breakevenSet && pnl >= BREAKEVEN_ACTIVATE_USD) {
      openTrade.breakevenSet = true;
      fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
      await sendTelegram(`⚖️ *${REPO_LABEL} — Breakeven Armed*\nProfit reached $${BREAKEVEN_ACTIVATE_USD.toFixed(2)}. Price floor locked at entry (${openTrade.entry.toFixed(4)}).`);
    }

    // BREAKEVEN PRICE TRIGGER: Close immediately if price reverses to entry
    const breakevenHit = openTrade.breakevenSet && !openTrade.tp1Reached && (
      (openTrade.direction === "BUY" && currentPrice <= openTrade.entry) ||
      (openTrade.direction === "SELL" && currentPrice >= openTrade.entry)
    );
    if (breakevenHit) {
      await closeWith("WIN", `Breakeven exit — price reversed back to entry (${openTrade.entry.toFixed(4)}) after hitting profit target`);
      return;
    }

    // 1. Hard SL Price Check
    const slBreached = openTrade.direction === "BUY" ? currentPrice <= openTrade.sl : currentPrice >= openTrade.sl;
    if (slBreached) {
      await closeWith("LOSS", `Hard SL hit — price ${currentPrice.toFixed(4)} breached SL ${openTrade.sl.toFixed(4)}`);
      return;
    }

    // 2. TP2 Ultimate Target Hit (Replaces Safety TP ceiling)
    const tp2Hit = openTrade.direction === "BUY" ? currentPrice >= openTrade.tp2 : currentPrice <= openTrade.tp2;
    if (tp2Hit) {
      await closeWith("WIN", `TP2 Ultimate Target hit — price ${currentPrice.toFixed(4)} reached BGA level ${openTrade.tp2.toFixed(4)}`);
      return;
    }

    // 3. TP1 Price Level Hit (First BGA Whole Number) -> Arms 60% Peak-Drop Trailing
    if (!openTrade.tp1Reached) {
      const tp1Hit = openTrade.direction === "BUY" ? currentPrice >= openTrade.tp1 : currentPrice <= openTrade.tp1;
      if (tp1Hit) {
        openTrade.tp1Reached = true;
        fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
        await sendTelegram(`🎯 TP1 BGA Whole Number reached (${openTrade.tp1.toFixed(4)}) on ${openTrade.direction} — 60% peak-drop trailing now armed.`);
      }
    }

    // 4. High-Water Mark Trailing (Activated at TP1 BGA Whole Number, exits if profit drops 60% from peak)
    if (openTrade.tp1Reached) {
      if (openTrade.peakProfit === null || pnl > openTrade.peakProfit) {
        openTrade.peakProfit = pnl;
        fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
      }
      const dropThreshold = openTrade.peakProfit * 0.60;
      if (openTrade.peakProfit > 0 && pnl <= openTrade.peakProfit - dropThreshold) {
        const result = pnl >= 0 ? "WIN" : "LOSS";
        await closeWith(result, `Profit trail exit — locked ~$${pnl.toFixed(2)} (peak $${openTrade.peakProfit.toFixed(2)}, 60% drop from peak)`);
        return;
      }
    }

    // 5. Momentum Trailing Exit: M5 CCI crosses zero line against position
    const m5CandlesExit = await fetchCandles(M5, 50);
    if (m5CandlesExit && m5CandlesExit.length >= 36) {
      const cciExit = calculateCCI(m5CandlesExit, 34);
      const ie = cciExit.length - 2;
      if (cciExit[ie] != null && cciExit[ie-1] != null) {
        const cciCrossZeroDown = cciExit[ie-1] >= 0 && cciExit[ie] < 0;
        const cciCrossZeroUp = cciExit[ie-1] <= 0 && cciExit[ie] > 0;
        if (openTrade.direction === "BUY" && cciCrossZeroDown) {
          const result = pnl >= 0 ? "WIN" : "LOSS";
          await closeWith(result, `CCI Zero-line Exit — M5 CCI crossed below zero`);
          return;
        }
        if (openTrade.direction === "SELL" && cciCrossZeroUp) {
          const result = pnl >= 0 ? "WIN" : "LOSS";
          await closeWith(result, `CCI Zero-line Exit — M5 CCI crossed above zero`);
          return;
        }
      }
    }

    console.log("Open trade being managed — skipping scan.");
    return;
  }

  // ── Signal Scan (Strict Phase A Fresh H1 Cross + Stateful Phase B TDI/CCI Engine) ──
  const candles = await fetchCandles(M5, 120);
  if (!candles || candles.length < 60) { console.log("Not enough M5 candles."); return; }
  const i = candles.length - 2;
  const currentCandleEpoch = candles[i].epoch;
  const closes = candles.map(c => parseFloat(c.close));

  if (state.lastProcessedEpoch === currentCandleEpoch) {
    console.log("Already processed this candle — skipping.");
    return;
  }

  const isoTime = new Date(currentCandleEpoch * 1000).toISOString();
  const atr14 = calculateATR(candles, ATR_PERIOD);
  const cci = calculateCCI(candles, 34);
  const rsi = calculateRSI(closes, 14);
  const tdi = calculateBollingerBands(rsi, 34, 1.619);

  // Track if RSI touched/broke outer bands for TDI validity
  if (rsi[i] != null && tdi.lower[i] != null && tdi.upper[i] != null) {
    if (rsi[i] <= tdi.lower[i]) state.rsiLowerBreakSeen = true;
    if (rsi[i] >= tdi.upper[i]) state.rsiUpperBreakSeen = true;
  }

  // Evaluate H1 Trend Direction & Fresh Cross
  const h1Candles = await fetchCandles(H1, 100);
  let h1Dir = null, h1Epoch = null, h1FreshCross = false;
  if (h1Candles && h1Candles.length >= 52) {
    const h1Closes = h1Candles.map(c => parseFloat(c.close)), h1ci = h1Candles.length - 2;
    const smaFast1h = sma(h1Closes, 2), smaSlow1h = sma(h1Closes, 50);
    if (smaFast1h[h1ci] != null && smaSlow1h[h1ci] != null && smaFast1h[h1ci-1] != null && smaSlow1h[h1ci-1] != null) {
      if (smaFast1h[h1ci] > smaSlow1h[h1ci]) h1Dir = "BUY";
      else if (smaFast1h[h1ci] < smaSlow1h[h1ci]) h1Dir = "SELL";
      
      const crossedUp = (smaFast1h[h1ci-1] <= smaSlow1h[h1ci-1]) && (smaFast1h[h1ci] > smaSlow1h[h1ci]);
      const crossedDown = (smaFast1h[h1ci-1] >= smaSlow1h[h1ci-1]) && (smaFast1h[h1ci] < smaSlow1h[h1ci]);
      if (crossedUp || crossedDown) h1FreshCross = true;
    }
    h1Epoch = h1Candles[h1Candles.length - 2].epoch;
  }

  // Evaluate M15 Trend Direction (MACD 3, 50, 1 signal line vs 0)
  const m15Candles = await fetchCandles(M15, 100);
  let m15Dir = null;
  if (m15Candles && m15Candles.length >= 60) {
    const m15Closes = m15Candles.map(c => parseFloat(c.close));
    const m15Macd = calculateMACD(m15Closes, 3, 50, 1);
    const m15si = m15Macd.signalLine.length - 2;
    if (m15Macd.signalLine[m15si] != null) {
      if (m15Macd.signalLine[m15si] > 0) m15Dir = "BUY";
      else if (m15Macd.signalLine[m15si] < 0) m15Dir = "SELL";
    }
  }

  // ── HARD HIGHER-TIMEFRAME TREND GATE ─────────────────────────────────
  const h1m15Aligned = h1Dir && m15Dir && (h1Dir === m15Dir);
  if (!h1m15Aligned) {
    dbg("H1 and M15 trend alignment missing or conflicting. Resetting all setups.");
    state.waitingFor = null;
    state.setupEpoch = null;
    state.activeEntryType = null;
    state.pendingPullback = null;
    state.pullbackEpoch = null;
    state.pullbackTrigger = null;
    state.lastProcessedEpoch = currentCandleEpoch;
    fs.writeFileSync("state.json", JSON.stringify(state, null, 2));
    return;
  }

  // Reset phase tracking if a new H1 epoch emerges
  if (state.h1TrendEpoch !== h1Epoch) {
    state.h1TrendEpoch = h1Epoch;
  }

  let m5Ready = false;
  let entryType = null;

  // ── PHASE A: STRICTLY A LIVE FRESH H1 CROSS (First Trade) ────────────
  if (h1FreshCross && state.phaseATriggeredEpoch !== h1Epoch) {
    const mblVal = tdi.middle[i];
    const m5Aligned = (mblVal != null && rsi[i] != null) && ((h1Dir === "BUY" && rsi[i] > mblVal) || (h1Dir === "SELL" && rsi[i] < mblVal));
    if (m5Aligned) {
      if (h1Dir === "BUY" && cci[i] > -114.4) {
        m5Ready = true;
        entryType = 'PHASE_A';
      } else if (h1Dir === "SELL" && cci[i] < 90) {
        m5Ready = true;
        entryType = 'PHASE_A';
      }
    }
  }

  // ── PHASE B: STATEFUL CROSS-CONFIRMATION ENGINE (Pullbacks / Re-entries) ──
  if (!m5Ready && h1Dir && m15Dir && h1Dir === m15Dir) {
    // 1. Check Setup Expiry (35 bars)
    if (state.pendingPullback && state.pullbackEpoch && (currentCandleEpoch - state.pullbackEpoch) > (SETUP_EXPIRY_BARS * M5)) {
      state.pendingPullback = null;
      state.pullbackEpoch = null;
      state.pullbackTrigger = null;
      state.rsiLowerBreakSeen = false;
      state.rsiUpperBreakSeen = false;
      console.log("Pending pullback setup expired (35 bars reached).");
    }

    const cciCrossBuy = (cci[i-1] <= -114.4) && (cci[i] > -114.4);
    const cciCrossSell = (cci[i-1] >= 90) && (cci[i] < 90);
    
    const mblPrev = tdi.middle[i-1], mblCurr = tdi.middle[i];
    const rsiPrev = rsi[i-1], rsiCurr = rsi[i];
    const rawTdiCrossUp = (rsiPrev <= mblPrev) && (rsiCurr > mblCurr);
    const rawTdiCrossDown = (rsiPrev >= mblPrev) && (rsiCurr < mblCurr);

    const tdiCrossUp = rawTdiCrossUp && state.rsiLowerBreakSeen;
    const tdiCrossDown = rawTdiCrossDown && state.rsiUpperBreakSeen;

    if (tdiCrossUp) state.rsiLowerBreakSeen = false;
    if (tdiCrossDown) state.rsiUpperBreakSeen = false;

    // 2. Invalidation Checks for Active Pending States (Opposite Crosses)
    if (state.pendingPullback === "BUY") {
      const oppositeTdiCross = (rsiPrev >= mblPrev) && (rsiCurr < mblCurr);
      const oppositeCciCross = (cci[i-1] > -114.4) && (cci[i] <= -114.4);
      if (oppositeTdiCross || oppositeCciCross || h1Dir !== "BUY") {
        console.log("Pending BUY pullback invalidated by opposite cross or trend shift.");
        state.pendingPullback = null;
        state.pullbackEpoch = null;
        state.pullbackTrigger = null;
      }
    } else if (state.pendingPullback === "SELL") {
      const oppositeTdiCross = (rsiPrev <= mblPrev) && (rsiCurr > mblCurr);
      const oppositeCciCross = (cci[i-1] < 90) && (cci[i] >= 90);
      if (oppositeTdiCross || oppositeCciCross || h1Dir !== "SELL") {
        console.log("Pending SELL pullback invalidated by opposite cross or trend shift.");
        state.pendingPullback = null;
        state.pullbackEpoch = null;
        state.pullbackTrigger = null;
      }
    }

    // 3. Confirmation & Arming Checks
    if (state.pendingPullback === "BUY") {
      if (state.pullbackTrigger === "CCI" && tdiCrossUp) {
        m5Ready = true;
        entryType = 'PHASE_B';
        state.pendingPullback = null;
        state.pullbackEpoch = null;
        state.pullbackTrigger = null;
      } else if (state.pullbackTrigger === "TDI" && cciCrossBuy) {
        m5Ready = true;
        entryType = 'PHASE_B';
        state.pendingPullback = null;
        state.pullbackEpoch = null;
        state.pullbackTrigger = null;
      }
    } else if (state.pendingPullback === "SELL") {
      if (state.pullbackTrigger === "CCI" && tdiCrossDown) {
        m5Ready = true;
        entryType = 'PHASE_B';
        state.pendingPullback = null;
        state.pullbackEpoch = null;
        state.pullbackTrigger = null;
      } else if (state.pullbackTrigger === "TDI" && cciCrossSell) {
        m5Ready = true;
        entryType = 'PHASE_B';
        state.pendingPullback = null;
        state.pullbackEpoch = null;
        state.pullbackTrigger = null;
      }
    } else {
      // Arm new pending pullback state if either indicator triggers first
      if (h1Dir === "BUY") {
        if (cciCrossBuy) {
          state.pendingPullback = "BUY";
          state.pullbackTrigger = "CCI";
          state.pullbackEpoch = currentCandleEpoch;
          console.log("CCI crossed -114.4 upward first. Waiting for TDI MBL cross.");
        } else if (tdiCrossUp) {
          state.pendingPullback = "BUY";
          state.pullbackTrigger = "TDI";
          state.pullbackEpoch = currentCandleEpoch;
          console.log("TDI MBL crossed upward first. Waiting for CCI cross.");
        }
      } else if (h1Dir === "SELL") {
        if (cciCrossSell) {
          state.pendingPullback = "SELL";
          state.pullbackTrigger = "CCI";
          state.pullbackEpoch = currentCandleEpoch;
          console.log("CCI crossed 90 downward first. Waiting for TDI MBL cross.");
        } else if (tdiCrossDown) {
          state.pendingPullback = "SELL";
          state.pullbackTrigger = "TDI";
          state.pullbackEpoch = currentCandleEpoch;
          console.log("TDI MBL crossed downward first. Waiting for CCI cross.");
        }
      }
    }
  }

  if (m5Ready) {
    if (state.waitingFor !== h1Dir || state.activeEntryType !== entryType) {
      state.waitingFor = h1Dir;
      state.activeEntryType = entryType;
      state.setupEpoch = currentCandleEpoch;
      console.log(`Setup armed for ${h1Dir} via ${entryType}`);
    }
  } else {
    if (!h1Dir && !m15m5Aligned && !state.pendingPullback) {
      state.waitingFor = null;
      state.setupEpoch = null;
      state.activeEntryType = null;
    }
  }

  const h4Candle = await fetchH4Candle();
  if (!h4Candle) { state.lastProcessedEpoch = currentCandleEpoch; fs.writeFileSync("state.json", JSON.stringify(state, null, 2)); return; }
  const h4Bullish = parseFloat(h4Candle.close) > parseFloat(h4Candle.open);
  const h4Bearish = parseFloat(h4Candle.close) < parseFloat(h4Candle.open);
  const d1Ctx = await getD1Context();

  const bypassH4ForPhaseA = (state.activeEntryType === 'PHASE_A');
  const buySignal = state.waitingFor === "BUY" && (bypassH4ForPhaseA || h4Bullish);
  const sellSignal = state.waitingFor === "SELL" && (bypassH4ForPhaseA || h4Bearish);

  let signalTriggered = false, direction = "", entry, sl, risk, tp1, tp2, tp3;
  if (buySignal) {
    signalTriggered = true; direction = "BUY"; entry = closes[i];
  } else if (sellSignal) {
    signalTriggered = true; direction = "SELL"; entry = closes[i];
  }

  if (signalTriggered) {
    const slDollars = parseFloat((STAKE_USD * 0.5).toFixed(2));
    
    // Calculate BGA-based TP1 (Strict Whole Number), TP2 (Ultimate TP / Half Number), and TP3
    const bgaTps = calculateBgaTakeProfits(entry, direction, atr14);
    tp1 = bgaTps.tp1;
    tp2 = bgaTps.tp2;
    tp3 = bgaTps.tp3;

    if (direction === "BUY") {
      sl = entry - (atr14 * ATR_MULTIPLIER);
      risk = entry - sl;
    } else {
      sl = entry + (atr14 * ATR_MULTIPLIER);
      risk = sl - entry;
    }

    const alignment = d1Ctx ? checkAlignment(direction, d1Ctx.direction) : "⚠️ D1 data unavailable";
    const timeFormatted = new Date(currentCandleEpoch * 1000).toISOString().replace("T"," ").substring(0,19);
    const h4Dir = h4Bullish ? "🟢 BULLISH" : "🔴 BEARISH";
    const bgaTag = getBGAInfo(entry);

    let message = `🚨 *${SYMBOL_NAME.toUpperCase()} CONFIRMED SIGNAL* 🚨\n\nDirection: ${direction}\nRepo: ${REPO_LABEL}\nTimeframe: M5\n\n📍 Entry: ${entry.toFixed(4)}\n🛑 SL: ${sl.toFixed(4)} ($${slDollars} hard)\n🎯 TP1: ${tp1.toFixed(4)} (BGA Whole) → trail with CCI zero-cross\n🎯 TP2 (Ultimate TP): ${tp2.toFixed(4)} (BGA)\n🎯 TP3: ${tp3.toFixed(4)} (reference)\n\n💰 Stake: $${STAKE_USD} | Hard SL: $${slDollars} | TP1: ${tp1.toFixed(4)} | TP2: ${tp2.toFixed(4)}\n📊 Risk: ${risk.toFixed(2)} points\n️ H4: ${h4Dir} ✅ Direction confirmed\n⚡ Setup: Strict Fresh H1 Cross + Stateful TDI Engine (${state.activeEntryType})\n🏷️ Confluence: ${bgaTag}\n━━━━━━━━━━━━━━━━━━━━\n🌍 *D1 CANDLE STATUS*\n━━━━━━━━━━━━━━━━━━━━\n`;
    if (d1Ctx) message += `Direction: ${d1Ctx.direction}\nD1 Open: ${d1Ctx.open.toFixed(4)}\nD1 Current: ${d1Ctx.close.toFixed(4)}\nMovement: ${d1Ctx.change.toFixed(4)} pts (${d1Ctx.changePct.toFixed(2)}%)\nAlignment: ${alignment}\n\n`;
    else message += `⚠️ D1 data unavailable\n\n`;
    message += `⏰ Time (UTC): ${timeFormatted}\n\n💡 To close manually: send \`/close win\` or \`/close loss\` in this chat`;

    // CRITICAL FIX: Only record trade and send alert AFTER successful broker execution!
    try {
      const contractId = await executeTrade(direction);
      if (!contractId) {
        console.error("⚠️ Trade execution returned no contract ID. Skipping trade record.");
        await sendTelegram(`❌ *${REPO_LABEL}*\n\nSignal triggered for ${direction}, but live broker execution failed. Trade aborted.`);
        return;
      }

      await sendTelegram(message);

      trades.push({
        id: `${SYMBOL}-${isoTime}`, contractId, repo: REPO_LABEL, symbol: SYMBOL,
        direction, entry, sl, tp1, tp2, tp3, h1OpenAtEntry: null, tp1Reached: false,
        peakProfit: null, rr: RISK_REWARD, openTime: timeFormatted,
        closeTime: null, result: null
      });
      fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));

    } catch (execErr) {
      console.error("⚠️ Live execution warning:", execErr.message);
      await sendTelegram(`❌ *${REPO_LABEL}*\n\nLive execution warning: ${execErr.message}`);
      return;
    }

    if (state.activeEntryType === 'PHASE_A') {
      state.phaseATriggeredEpoch = h1Epoch; // Lock Phase A so it only triggers once per fresh H1 cross
    }
    state.waitingFor = null;
    state.setupEpoch = null;
    state.activeEntryType = null;
    state.pendingPullback = null;
    state.pullbackEpoch = null;
    state.pullbackTrigger = null;
    state.rsiLowerBreakSeen = false;
    state.rsiUpperBreakSeen = false;
  }

  state.lastProcessedEpoch = currentCandleEpoch;
  fs.writeFileSync("state.json", JSON.stringify(state, null, 2));
  console.log(`[${REPO_LABEL}] Scan complete.`);
}

// ==================== EXECUTION MODES ====================
(async () => {
  if (MODE === "daily") { await runSummary("Daily"); return; }
  if (MODE === "weekly") { await runSummary("Weekly"); return; }
  if (MODE === "monthly") { await runSummary("Monthly"); return; }
  if (MODE === "close_win") { await executeManualClose("WIN", "manual command"); return; }
  if (MODE === "close_loss") { await executeManualClose("LOSS", "manual command"); return; }
  if (MODE === "test") {
    await sendTelegram(`🧪 Test mode active — ${REPO_LABEL}\nFiring a direct BUY trade via proxy...\nCheck your Deriv account for a MULTUP contract.`);
    try {
      const cid = await executeTrade("BUY");
      await sendTelegram(`✅ Test trade placed. Contract ID: ${cid}`);
    } catch (e) {
      await sendTelegram(`❌ Test trade failed: ${e.message}`);
    }
    return;
  }
  if (TRIGGER_SOURCE !== "cronjob") { console.log("Not a cronjob trigger — exiting."); return; }
  await runScanMode();
})();
