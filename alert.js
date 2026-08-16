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
const STAKE_USD = 5;
const RISK_REWARD = 1.5;
const SAFETY_TP_USD = 10.00; // $10 flat profit insurance ceiling on broker side
const BREAKEVEN_ACTIVATE_USD = 2.00; // Move SL to entry once profit hits $2.00
const ATR_PERIOD = 14;
const ATR_MULTIPLIER = 2.0; // Stop loss breathing room
const MARKET_DATA_APP_ID = "1089"; // Dedicated public App ID for unauthenticated candle data
const DERIV_APP_ID = process.env.DERIV_APP_ID || "67418"; // Personal App ID for trading/OTP
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
          const errCode = closeRes.error?.code;
          const errDesc = closeRes.error?.message || JSON.stringify(closeRes.error);
          if (errCode === "ContractNotFound" || errDesc.includes("not found among your open positions")) {
            serverPnl = -5.00;
          } else {
            await sendTelegram(`⚠️ *${REPO_LABEL}* — Manual Close Warning\n\nFailed to close contract \`${trade.contractId}\` on Deriv: ${errDesc}. Retrying next scan.`);
            continue;
          }
        }
        if (typeof closeRes.sell?.profit === 'number') {
          serverPnl = closeRes.sell.profit;
        }
      } catch (e) {
        if (e.message.includes("ContractNotFound") || e.message.includes("not found among your open positions")) {
          serverPnl = -5.00; // Proceed with local close
        } else {
          console.error("Close error:", e.message);
          continue;
        }
      }
    }
    trade.result = result;
    trade.closeTime = new Date().toISOString().replace("T"," ").substring(0,19);
    fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
    const icon = result === "WIN" ? "✅" : "❌";
    const contractType = trade.direction === "BUY" ? "MULTUP" : "MULTDOWN";
    const durationMs = new Date(trade.closeTime) - new Date(trade.openTime);
    const slDollars = parseFloat(STAKE_USD.toFixed(2));
    const tpDollars = parseFloat((STAKE_USD * RISK_REWARD).toFixed(2));
    const pnlStr = serverPnl >= 0 ? `+$${serverPnl.toFixed(2)}` : `-$${Math.abs(serverPnl).toFixed(2)}`;
    const tp1Status = trade.tp1Reached ? "✅ TP1 hit" : "❌ TP1 not reached";
    await sendTelegram(`${icon} *${REPO_LABEL} — Trade ${result}*\n\nDirection: ${trade.direction} (${contractType})\nSymbol: ${SYMBOL_NAME}\n\n📍 Entry: ${trade.entry.toFixed(4)}\n🏁 Exit: ${currentPrice.toFixed(4)}\n🛑 SL: ${trade.sl.toFixed(4)} ($${slDollars} hard)\n🎯 TP1: ${trade.tp1.toFixed(4)} (BGA) ${tp1Status}\n\n💵 P&L: ${pnlStr} (Net of comm.)\nReason: ${reason}\nDuration: ${formatDuration(durationMs)}\n\nOpened: ${trade.openTime}\nClosed: ${trade.closeTime}\n` + (trade.contractId ? `Contract: \`${trade.contractId}\`` : ""));
  }
}

let state = { 
  waitingFor: null, setupEpoch: null, lastProcessedEpoch: null, lastTgUpdateId: 0, h1TrendEpoch: null, 
  phaseATriggeredEpoch: null, activeEntryType: null 
};
try {
  const s = JSON.parse(fs.readFileSync("state.json"));
  state = {
    ...state, ...s,
    waitingFor: s.waitingFor ?? null,
    setupEpoch: s.setupEpoch ?? null,
    h1TrendEpoch: s.h1TrendEpoch ?? null,
    phaseATriggeredEpoch: s.phaseATriggeredEpoch ?? null,
    activeEntryType: s.activeEntryType ?? null
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

// Smart 429 RateLimit Backoff
async function withRetry(fn, retries = 3, delay = 4000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      const isRateLimit = e.message.includes("429") || e.message.includes("RateLimit");
      if (i === retries - 1) throw e;
      const currentDelay = isRateLimit ? delay * (i + 2) : delay;
      dbg(`Retry ${i+1}/${retries} after error: ${e.message}. Waiting ${currentDelay}ms...`);
      await new Promise(r => setTimeout(r, currentDelay));
    }
  }
}

// CONSOLIDATED DATA FETCHER (Opens ONE single WebSocket connection instead of separate ones)
async function fetchAllData() {
  return withRetry(async () => {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${MARKET_DATA_APP_ID}`);
      const results = {};
      ws.on("open", () => {
        ws.send(JSON.stringify({ req_id: 1, ticks_history: SYMBOL, granularity: M5, count: 120, end: "latest", style: "candles" }));
        ws.send(JSON.stringify({ req_id: 2, ticks_history: SYMBOL, granularity: H1, count: 100, end: "latest", style: "candles" }));
        ws.send(JSON.stringify({ req_id: 3, ticks_history: SYMBOL, granularity: M15, count: 100, end: "latest", style: "candles" }));
        ws.send(JSON.stringify({ req_id: 4, ticks_history: SYMBOL, granularity: H4, count: 10, end: "latest", style: "candles" }));
        ws.send(JSON.stringify({ req_id: 5, ticks_history: SYMBOL, granularity: D1, count: 5, end: "latest", style: "candles" }));
      });
      ws.on("message", d => {
        const msg = JSON.parse(d);
        if (msg.req_id === 1) results.m5 = msg.candles;
        if (msg.req_id === 2) results.h1 = msg.candles;
        if (msg.req_id === 3) results.m15 = msg.candles;
        if (msg.req_id === 4) results.h4 = msg.candles;
        if (msg.req_id === 5) results.d1 = msg.candles;
        if (results.m5 && results.h1 && results.m15 && results.h4 && results.d1) {
          ws.close();
          resolve(results);
        }
      });
      ws.on("error", (err) => { ws.close(); reject(err); });
      setTimeout(() => { ws.close(); reject(new Error("fetchAllData timeout")); }, 20000);
    });
  });
}

// CONSOLIDATED OPEN TRADE FETCHER (Price + M5 Candles in ONE connection)
async function fetchOpenTradeData() {
  return withRetry(async () => {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${MARKET_DATA_APP_ID}`);
      const results = {};
      ws.on("open", () => {
        ws.send(JSON.stringify({ req_id: 1, ticks_history: SYMBOL, granularity: M5, count: 50, end: "latest", style: "candles" }));
        ws.send(JSON.stringify({ req_id: 2, ticks_history: SYMBOL, count: 1, end: "latest", style: "ticks" }));
      });
      ws.on("message", d => {
        const msg = JSON.parse(d);
        if (msg.req_id === 1) results.candles = msg.candles;
        if (msg.req_id === 2) results.price = msg.history?.prices?.[msg.history.prices.length - 1];
        if (results.candles && results.price !== undefined) {
          ws.close();
          resolve(results);
        }
      });
      ws.on("error", (err) => { ws.close(); reject(err); });
      setTimeout(() => { ws.close(); reject(new Error("fetchOpenTradeData timeout")); }, 15000);
    });
  });
}

async function getCurrentPrice(sym = SYMBOL) {
  const data = await fetchOpenTradeData();
  return data.price;
}

async function getDerivAccountId() {
  const res = await fetch("https://api.derivws.com/trading/v1/options/accounts", {
    headers: { "Deriv-App-ID": DERIV_APP_ID, "Authorization": `Bearer ${DERIV_TOKEN}` }
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`getAccounts failed: ${JSON.stringify(json.errors || json)}`);
  const accounts = json.data;
  if (!accounts || accounts.length === 0) throw new Error("No Deriv accounts found");
  const account = accounts.find(a => a.account_type === "demo") || accounts[0];
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

// ── Resilient Trade Execution with withRetry ──
async function executeTrade(direction) {
  if (!DERIV_TOKEN) { console.log("⚠️ DERIV_API_TOKEN not set. Skipping."); return null; }
  if (!DERIV_APP_ID) { console.log("⚠️ DERIV_APP_ID not set. Skipping."); return null; }
  if (!PROXY_URL || !PROXY_SECRET) { console.log("⚠️ PROXY_URL or PROXY_SECRET not set. Skipping."); return null; }
  
  return withRetry(async () => {
    console.log(`🔄 Sending ${direction} trade via Cloudflare proxy...`);
    const accountId = await getDerivAccountId();
    const wsUrl = await getDerivOTP(accountId);
    const slDollars = parseFloat(STAKE_USD.toFixed(2));
    const tpValue = typeof SAFETY_TP_USD !== 'undefined' ? SAFETY_TP_USD : 15.00;
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
          stop_loss: slDollars,
          take_profit: tpValue
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
    
    if (data.error || data.errors || String(JSON.stringify(data)).includes("429") || String(JSON.stringify(data)).includes("RateLimit")) {
      throw new Error(`429/RateLimit/Error: ${JSON.stringify(data.error || data.errors || data)}`);
    }
    
    const contractId = data.buy?.contract_id;
    if (contractId) { 
      console.log(`✅ Trade Executed! Contract ID: ${contractId}`); 
      return contractId; 
    }
    throw new Error("No contract ID returned in buy response");
  }, 4, 5000);
}

// ── Resilient Contract Closing with withRetry ──
async function closeContract(contractId) {
  if (!DERIV_TOKEN || !contractId || !PROXY_URL || !PROXY_SECRET || !DERIV_APP_ID) return null;
  return withRetry(async () => {
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
    
    const errCode = data.error?.code || data.errors?.code;
    const errStr = String(JSON.stringify(data));
    
    if (errCode !== "ContractNotFound" && (data.error || data.errors || errStr.includes("429") || errStr.includes("RateLimit"))) {
      throw new Error(`429/RateLimit/Error: ${errStr}`);
    }
    return data;
  }, 4, 5000);
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

function calculateStochastic(candles, kPeriod = 5, dPeriod = 3, slowing = 3) {
  const closes = candles.map(c => parseFloat(c.close));
  const highs = candles.map(c => parseFloat(c.high));
  const lows = candles.map(c => parseFloat(c.low));
  
  const rawK = candles.map((_, i) => {
    if (i < kPeriod - 1) return null;
    const hSlice = highs.slice(i - kPeriod + 1, i + 1);
    const lSlice = lows.slice(i - kPeriod + 1, i + 1);
    const hh = Math.max(...hSlice);
    const ll = Math.min(...lSlice);
    if (hh === ll) return 50;
    return ((closes[i] - ll) / (hh - ll)) * 100;
  });

  const validRawK = rawK.map(x => x !== null ? x : 50);
  const smoothedK = sma(validRawK, slowing);
  const kLine = smoothedK.map((val, idx) => rawK[idx] === null ? null : val);

  const validK = kLine.map(x => x !== null ? x : 50);
  const smoothedD = sma(validK, dPeriod);
  const dLine = smoothedD.map((val, idx) => kLine[idx] === null ? null : val);

  return { k: kLine, d: dLine };
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

function calculateBgaTakeProfits(entry, direction, atr14, d1Candles) {
  let step = 100;
  if (entry > 20000) step = 500;
  else if (entry > 10000) step = 200;
  else if (entry > 5000) step = 100;
  else if (entry > 2000) step = 50;
  else if (entry > 1000) step = 20;
  else step = 10;

  const halfStep = step / 2;
  const baseWhole = Math.round(entry / step) * step;
  const minBuffer = Math.max(step * 0.20, atr14 * 1.2);

  let fibMaxLimit = null;
  if (d1Candles && d1Candles.length >= 2) {
    const prevDay = d1Candles[d1Candles.length - 2];
    const prevHigh = parseFloat(prevDay.high);
    const prevLow = parseFloat(prevDay.low);
    const prevRange = prevHigh - prevLow;
    if (prevRange > 0) {
      if (direction === "BUY") {
        fibMaxLimit = prevHigh + (prevRange * 2.618);
      } else {
        fibMaxLimit = prevLow - (prevRange * 2.618);
      }
    }
  }

  const allLevels = [];
  for (let offset = -10 * step; offset <= 15 * step; offset += halfStep) {
    allLevels.push(baseWhole + offset);
  }

  if (direction === "BUY") {
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

    let futureLevels = allLevels.filter(l => l > tp1).sort((a, b) => a - b);
    if (fibMaxLimit) futureLevels = futureLevels.filter(l => l <= fibMaxLimit);

    let tp2 = futureLevels[0] || tp1 + halfStep;
    let tp3 = futureLevels[1] || tp1 + step;

    if (tp2 <= tp1) tp2 = tp1 + halfStep;
    if (tp3 <= tp2) tp3 = tp2 + halfStep;

    return { tp1, tp2, tp3 };
  } else {
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

    let futureLevels = allLevels.filter(l => l < tp1).sort((a, b) => b - a);
    if (fibMaxLimit) futureLevels = futureLevels.filter(l => l >= fibMaxLimit);

    let tp2 = futureLevels[0] || tp1 - halfStep;
    let tp3 = futureLevels[1] || tp1 - step;

    if (tp2 >= tp1) tp2 = tp1 - halfStep;
    if (tp3 >= tp2) tp3 = tp2 - halfStep;

    return { tp1, tp2, tp3 };
  }
}

async function getD1Context() {
  try {
    const candles = await fetchCandles(D1, 5);
    if (!candles || candles.length < 2) return null;
    const c = candles[candles.length - 2];
    const open = parseFloat(c.open), close = parseFloat(c.close);
    const change = close - open, changePct = (change / open) * 100;
    return { direction: close > open ? "🟢 BULLISH" : "🔴 BEARISH", open, close, change, changePct, candles };
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
    const tradeData = await fetchOpenTradeData();
    const currentPrice = tradeData.price;
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
            const errCode = closeRes.error?.code;
            const errDesc = closeRes.error?.message || JSON.stringify(closeRes.error);
            if (errCode === "ContractNotFound" || errDesc.includes("not found among your open positions")) {
              serverPnl = -5.00;
            } else {
              console.error(`⚠️ Failed to close contract on Deriv: ${errDesc}`);
              await sendTelegram(`⚠️ *${REPO_LABEL}* — Close Warning\n\nFailed to close contract \`${openTrade.contractId}\` on Deriv: ${errDesc}. Retrying next scan.`);
              return;
            }
          } else if (typeof closeRes.sell?.profit === 'number') {
            serverPnl = closeRes.sell.profit;
          }
        } catch (e) {
          if (e.message.includes("ContractNotFound") || e.message.includes("not found among your open positions")) {
            serverPnl = -5.00; // Proceed with local close
          } else {
            console.error("Close exception:", e.message);
            await sendTelegram(`⚠️ *${REPO_LABEL}* — Close Error\n\nException closing contract \`${openTrade.contractId}\`: ${e.message}. Retrying next scan.`);
            return;
          }
        }
      }

      fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
      const icon = result === "WIN" ? "✅" : "❌";
      const contractType = openTrade.direction === "BUY" ? "MULTUP" : "MULTDOWN";
      const durationMs = new Date(openTrade.closeTime) - new Date(openTrade.openTime);
      const slDollars = parseFloat(STAKE_USD.toFixed(2));
      const tpDollars = parseFloat((STAKE_USD * RISK_REWARD).toFixed(2));
      const tp1Status = openTrade.tp1Reached ? "✅ TP1 hit" : "❌ TP1 not reached";
      const pnlStr = serverPnl >= 0 ? `+$${serverPnl.toFixed(2)}` : `-$${Math.abs(serverPnl).toFixed(2)}`;
      
      await sendTelegram(`${icon} *${REPO_LABEL} — Trade ${result}*\n\nDirection: ${openTrade.direction} (${contractType})\nSymbol: ${SYMBOL_NAME}\n\n📍 Entry: ${openTrade.entry.toFixed(4)}\n🏁 Exit: ${currentPrice.toFixed(4)}\n🛑 SL: ${openTrade.sl.toFixed(4)} ($${slDollars} hard)\n🎯 TP1: ${openTrade.tp1.toFixed(4)} (BGA) ${tp1Status}\n\n💵 P&L: ${pnlStr} (Net of comm.)\nReason: ${exitReason}\nDuration: ${formatDuration(durationMs)}\n\nOpened: ${openTrade.openTime}\nClosed: ${openTrade.closeTime}\n` + (openTrade.contractId ? `Contract: \`${openTrade.contractId}\`` : ""));
    };

    // 1. Hard SL Price Check
    const slBreached = openTrade.direction === "BUY" ? currentPrice <= openTrade.sl : currentPrice >= openTrade.sl;
    if (slBreached) {
      await closeWith("LOSS", `Hard SL hit — price ${currentPrice.toFixed(4)} breached SL ${openTrade.sl.toFixed(4)}`);
      return;
    }

    // 2. TP2 Ultimate Target Hit
    const tp2Hit = openTrade.direction === "BUY" ? currentPrice >= openTrade.tp2 : currentPrice <= openTrade.tp2;
    if (tp2Hit) {
      await closeWith("WIN", `TP2 Ultimate Target hit — price ${currentPrice.toFixed(4)} reached BGA level ${openTrade.tp2.toFixed(4)}`);
      return;
    }

    // 3. TP1 Price Level Hit (First BGA Whole Number) -> Arms 20% Peak-Drop Trailing
    if (!openTrade.tp1Reached) {
      const tp1Hit = openTrade.direction === "BUY" ? currentPrice >= openTrade.tp1 : currentPrice <= openTrade.tp1;
      if (tp1Hit) {
        openTrade.tp1Reached = true;
        fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
        await sendTelegram(`🎯 TP1 BGA Whole Number reached (${openTrade.tp1.toFixed(4)}) on ${openTrade.direction} — 20% peak-drop trailing now armed.`);
      }
    }

    // 4. High-Water Mark Trailing (Activated at TP1 BGA Whole Number, exits if profit drops 20% from peak)
    if (openTrade.tp1Reached) {
      if (openTrade.peakProfit === null || pnl > openTrade.peakProfit) {
        openTrade.peakProfit = pnl;
        fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
      }
      const dropThreshold = openTrade.peakProfit * 0.20; 
      if (openTrade.peakProfit > 0 && pnl <= openTrade.peakProfit - dropThreshold) {
        const result = pnl >= 0 ? "WIN" : "LOSS";
        await closeWith(result, `Profit trail exit — locked ~$${pnl.toFixed(2)} (peak $${openTrade.peakProfit.toFixed(2)}, 20% drop from peak)`);
        return;
      }
    }

    console.log("Open trade being managed — skipping scan.");
    return;
  }

  // ── Signal Scan (Consolidated Data Fetching - ONE Single WebSocket Handshake) ──
  const scanData = await fetchAllData();
  const candles = scanData.m5;
  const h1Candles = scanData.h1;
  const d1Candles = scanData.d1;

  if (!candles || candles.length < 60) { console.log("Not enough M5 candles."); return; }

  const i = candles.length - 2; // Closed M5 candle to prevent repainting (-2)
  const currentCandleEpoch = candles[i].epoch;
  const closes = candles.map(c => parseFloat(c.close));

  if (state.lastProcessedEpoch === currentCandleEpoch) {
    console.log("Already processed this candle — skipping.");
    return;
  }

  const isoTime = new Date(currentCandleEpoch * 1000).toISOString();
  const atr14 = calculateATR(candles, ATR_PERIOD);

  // 1. Evaluate H1 Trend Direction (Closed H1 Candle: length - 2) relative to EMA 50
  let h1TrendDir = null;
  if (h1Candles && h1Candles.length >= 52) {
    const h1Closes = h1Candles.map(c => parseFloat(c.close));
    const h1ci = h1Candles.length - 2; // Closed H1 candle
    const sma50_1h = sma(h1Closes, 50);
    if (sma50_1h[h1ci] != null) {
      if (h1Closes[h1ci] > sma50_1h[h1ci]) h1TrendDir = "BUY";
      else if (h1Closes[h1ci] < sma50_1h[h1ci]) h1TrendDir = "SELL";
    }
  }

  // H1 Invalidation / Reset Rule: If H1 changes direction, update waitingFor
  if (h1TrendDir) {
    if (state.waitingFor !== h1TrendDir) {
      dbg(`H1 trend change detected: switching waitingFor to ${h1TrendDir}`);
      state.waitingFor = h1TrendDir;
    }
  } else {
    state.waitingFor = null;
  }

  if (!state.waitingFor) {
    state.lastProcessedEpoch = currentCandleEpoch;
    fs.writeFileSync("state.json", JSON.stringify(state, null, 2));
    return;
  }

  // 2. Indicator Calculations for Phase A & B (Closed M5 candle index: si)
  const si = candles.length - 2;
  const stoch = calculateStochastic(candles, 5, 3, 3);
  const cci = calculateCCI(candles, 34);
  const rsi = calculateRSI(closes, 14);
  const tdi = calculateBollingerBands(rsi, 34, 1.619);

  let signalTriggered = false, direction = "", entry, sl, risk, tp1, tp2, tp3;
  let entryType = null;

  if (si >= 1 && stoch.k[si] != null && stoch.d[si] != null && stoch.k[si-1] != null && stoch.d[si-1] != null &&
      cci[si] != null && cci[si-1] != null && rsi[si] != null && rsi[si-1] != null && tdi.middle[si] != null && tdi.middle[si-1] != null) {

    // --- PHASE A: Stochastic Cross from below 20 (BUY) / above 80 (SELL) ---
    const stochCrossBuyPhaseA = (stoch.k[si-1] <= 20 || stoch.d[si-1] <= 20) && 
                                (stoch.k[si] > 20 && stoch.d[si] > 20) && 
                                (stoch.k[si-1] <= stoch.d[si-1]) && 
                                (stoch.k[si] > stoch.d[si]);

    const stochCrossSellPhaseA = (stoch.k[si-1] >= 80 || stoch.d[si-1] >= 80) && 
                                 (stoch.k[si] < 80 && stoch.d[si] < 80) && 
                                 (stoch.k[si-1] >= stoch.d[si-1]) && 
                                 (stoch.k[si] < stoch.d[si]);

    if (state.waitingFor === "BUY" && stochCrossBuyPhaseA) {
      signalTriggered = true;
      direction = "BUY";
      entry = closes[i];
      entryType = 'PHASE_A';
    } else if (state.waitingFor === "SELL" && stochCrossSellPhaseA) {
      signalTriggered = true;
      direction = "SELL";
      entry = closes[i];
      entryType = 'PHASE_A';
    }

    // --- PHASE B: Simultaneous Confluence Pullback Engine (with Fresh Catalyst) ---
    if (!signalTriggered) {
      const stochAlignedBuy = stoch.k[si] > 50 && stoch.d[si] > 50;
      const stochAlignedSell = stoch.k[si] < 50 && stoch.d[si] < 50;

      const cciAlignedBuy = cci[si] > 0;
      const cciAlignedSell = cci[si] < 0;

      const tdiAlignedBuy = rsi[si] > tdi.middle[si];
      const tdiAlignedSell = rsi[si] < tdi.middle[si];

      const allAlignedBuy = stochAlignedBuy && cciAlignedBuy && tdiAlignedBuy;
      const allAlignedSell = stochAlignedSell && cciAlignedSell && tdiAlignedSell;

      // Fresh catalyst crosses on current candle si
      const stochCrossBuyB = (stoch.k[si-1] <= 50 || stoch.d[si-1] <= 50) && (stoch.k[si] > 50 && stoch.d[si] > 50) && (stoch.k[si-1] <= stoch.d[si-1]) && (stoch.k[si] > stoch.d[si]);
      const stochCrossSellB = (stoch.k[si-1] >= 50 || stoch.d[si-1] >= 50) && (stoch.k[si] < 50 && stoch.d[si] < 50) && (stoch.k[si-1] >= stoch.d[si-1]) && (stoch.k[si] < stoch.d[si]);

      const cciCrossBuyB = cci[si-1] <= 0 && cci[si] > 0;
      const cciCrossSellB = cci[si-1] >= 0 && cci[si] < 0;

      const tdiCrossBuyB = rsi[si-1] <= tdi.middle[si-1] && rsi[si] > tdi.middle[si];
      const tdiCrossSellB = rsi[si-1] >= tdi.middle[si-1] && rsi[si] < tdi.middle[si];

      const freshCatalystBuy = stochCrossBuyB || cciCrossBuyB || tdiCrossBuyB;
      const freshCatalystSell = stochCrossSellB || cciCrossSellB || tdiCrossSellB;

      if (state.waitingFor === "BUY" && allAlignedBuy && freshCatalystBuy) {
        signalTriggered = true;
        direction = "BUY";
        entry = closes[i];
        entryType = 'PHASE_B';
      } else if (state.waitingFor === "SELL" && allAlignedSell && freshCatalystSell) {
        signalTriggered = true;
        direction = "SELL";
        entry = closes[i];
        entryType = 'PHASE_B';
      }
    }
  }

  if (signalTriggered) {
    const slDollars = parseFloat(STAKE_USD.toFixed(2));
    const bgaTps = await calculateBgaTakeProfits(entry, direction, atr14, d1Candles);
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

    const timeFormatted = new Date(currentCandleEpoch * 1000).toISOString().replace("T"," ").substring(0,19);
    const bgaTag = getBGAInfo(entry);

    let message = `🚨 *${SYMBOL_NAME.toUpperCase()} CONFIRMED SIGNAL* 🚨\n\nDirection: ${direction}\nRepo: ${REPO_LABEL}\nTimeframe: M5\n\n📍 Entry: ${entry.toFixed(4)}\n🛑 SL: ${sl.toFixed(4)} ($${slDollars} hard)\n🎯 TP1: ${tp1.toFixed(4)} (BGA Whole)\n🎯 TP2 (Ultimate TP): ${tp2.toFixed(4)} (BGA)\n🎯 TP3: ${tp3.toFixed(4)} (reference)\n\n💰 Stake: $${STAKE_USD} | Hard SL: $${slDollars}\n⚡ Setup: ${entryType} (H1 EMA 50 + Simultaneous Confluence)\n️ Confluence: ${bgaTag}\n━━━━━━━━━━━━━━━━━━━━\n⏰ Time (UTC): ${timeFormatted}\n\n💡 To close manually: send \`/close win\` or \`/close loss\` in this chat`;

    try {
      const contractId = await executeTrade(direction);
      if (!contractId) {
        console.error("⚠️ Trade execution returned no contract ID. Skipping trade record.");
        await sendTelegram(`❌ *${REPO_LABEL}* — Signal triggered for ${direction}, but live broker execution failed. Trade aborted.`);
        return;
      }
      await sendTelegram(message);
      trades.push({
        id: `${SYMBOL}-${isoTime}`, contractId, repo: REPO_LABEL, symbol: SYMBOL,
        direction, entry, sl, tp1, tp2, tp3, h1OpenAtEntry: null, tp1Reached: false,
        peakProfit: null, rr: RISK_REWARD, entryType: entryType, openTime: timeFormatted, closeTime: null, result: null
      });
      fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
    } catch (execErr) {
      console.error("⚠️ Live execution warning:", execErr.message);
      await sendTelegram(`❌ *${REPO_LABEL}* — Live execution warning: ${execErr.message}`);
      return;
    }

    state.waitingFor = null;
  }

  state.lastProcessedEpoch = currentCandleEpoch;
  fs.writeFileSync("state.json", JSON.stringify(state, null, 2));
  console.log(`[${REPO_LABEL}] Scan complete.`);
}

// ==================== EXECUTION MODES ====================
(async () => {
  const REPO_INDEX = { R_10: 0, R_50: 1, R_75: 2, "1HZ75V": 3, R_100: 4, R_25: 5, "1HZ100V": 6 }[SYMBOL] ?? 0;
  const jitterMs = (REPO_INDEX * 4000) + Math.floor(Math.random() * 2000);
  
  dbg(`Staggering execution by ${jitterMs}ms (Repo Index: ${REPO_INDEX})...`);
  await new Promise(r => setTimeout(r, jitterMs));

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
