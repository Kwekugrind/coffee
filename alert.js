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
const PSAR_STEP = 0.010; // Parabolic SAR acceleration factor step
const PSAR_MAX = 0.070;  // Parabolic SAR maximum acceleration factor
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
const H1 = 60 * 60;
const D1 = 24 * 60 * 60;

const PHASE_A_WINDOW_SECONDS = 2.5 * 60 * 60; // 2h 30m window for Phase A after H1 fresh cross

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
    const finalResult = (typeof serverPnl === 'number') ? (serverPnl >= 0 ? "WIN" : "LOSS") : result;
    trade.result = finalResult;
    trade.closeTime = new Date().toISOString().replace("T"," ").substring(0,19);
    fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
    const icon = finalResult === "WIN" ? "✅" : "❌";
    const contractType = trade.direction === "BUY" ? "MULTUP" : "MULTDOWN";
    const durationMs = new Date(trade.closeTime) - new Date(trade.openTime);
    const slDollars = parseFloat(STAKE_USD.toFixed(2));
    const tpDollars = parseFloat((STAKE_USD * RISK_REWARD).toFixed(2));
    const pnlStr = serverPnl >= 0 ? `+$${serverPnl.toFixed(2)}` : `-$${Math.abs(serverPnl).toFixed(2)}`;
    const tp1Status = trade.tp1Reached ? "✅ TP1 hit" : "❌ TP1 not reached";
    await sendTelegram(`${icon} *${REPO_LABEL} — Trade ${finalResult}*\n\nDirection: ${trade.direction} (${contractType})\nSymbol: ${SYMBOL_NAME}\n\n📍 Entry: ${trade.entry.toFixed(4)}\n🏁 Exit: ${currentPrice.toFixed(4)}\n🛑 SL: ${trade.sl.toFixed(4)} ($${slDollars} hard)\n🎯 TP1: ${trade.tp1.toFixed(4)} (BGA) ${tp1Status}\n\n💵 P&L: ${pnlStr} (Net of comm.)\nReason: ${reason}\nDuration: ${formatDuration(durationMs)}\n\nOpened: ${trade.openTime}\nClosed: ${trade.closeTime}\n` + (trade.contractId ? `Contract: \`${trade.contractId}\`` : ""));
  }
}

let state = { 
  waitingFor: null, setupEpoch: null, lastProcessedEpoch: null, lastTgUpdateId: 0, h1TrendEpoch: null, 
  phaseATriggeredEpoch: null, activeEntryType: null, phaseATaken: false, h1TrendCycleEpoch: null,
  phaseADeadlineEpoch: null, phaseAWindowExpired: false,
  phaseBPending: null, phaseBStochFreshSeen: false, phaseBCciFreshSeen: false, phaseBTdiFreshSeen: false
};
try {
  const s = JSON.parse(fs.readFileSync("state.json"));
  state = {
    ...state, ...s,
    waitingFor: s.waitingFor ?? null,
    setupEpoch: s.setupEpoch ?? null,
    h1TrendEpoch: s.h1TrendEpoch ?? null,
    phaseATriggeredEpoch: s.phaseATriggeredEpoch ?? null,
    activeEntryType: s.activeEntryType ?? null,
    phaseATaken: s.phaseATaken ?? false,
    h1TrendCycleEpoch: s.h1TrendCycleEpoch ?? null,
    phaseADeadlineEpoch: s.phaseADeadlineEpoch ?? null,
    phaseAWindowExpired: s.phaseAWindowExpired ?? false,
    phaseBPending: s.phaseBPending ?? null,
    phaseBStochFreshSeen: s.phaseBStochFreshSeen ?? false,
    phaseBCciFreshSeen: s.phaseBCciFreshSeen ?? false,
    phaseBTdiFreshSeen: s.phaseBTdiFreshSeen ?? false
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

// CONSOLIDATED DATA FETCHER (M5, H1, D1 - 250 H1 candles for fully converged EMA 50)
async function fetchAllData() {
  return withRetry(async () => {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${MARKET_DATA_APP_ID}`);
      const results = {};
      ws.on("open", () => {
        ws.send(JSON.stringify({ req_id: 1, ticks_history: SYMBOL, granularity: M5, count: 120, end: "latest", style: "candles" }));
        ws.send(JSON.stringify({ req_id: 2, ticks_history: SYMBOL, granularity: H1, count: 250, end: "latest", style: "candles" }));
        ws.send(JSON.stringify({ req_id: 5, ticks_history: SYMBOL, granularity: D1, count: 5, end: "latest", style: "candles" }));
      });
      ws.on("message", d => {
        const msg = JSON.parse(d);
        if (msg.req_id === 1) results.m5 = msg.candles;
        if (msg.req_id === 2) results.h1 = msg.candles;
        if (msg.req_id === 5) results.d1 = msg.candles;
        if (results.m5 && results.h1 && results.d1) {
          ws.close();
          resolve(results);
        }
      });
      ws.on("error", (err) => { ws.close(); reject(err); });
      setTimeout(() => { ws.close(); reject(new Error("fetchAllData timeout")); }, 20000);
    });
  });
}

// CONSOLIDATED OPEN TRADE FETCHER (Price + 120 M5 Candles for consistent live PSAR calculation)
async function fetchOpenTradeData() {
  return withRetry(async () => {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${MARKET_DATA_APP_ID}`);
      const results = {};
      ws.on("open", () => {
        ws.send(JSON.stringify({ req_id: 1, ticks_history: SYMBOL, granularity: M5, count: 120, end: "latest", style: "candles" }));
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

// Parabolic SAR (Step: 0.010, Max: 0.070)
function calculatePSAR(candles, step = 0.010, maxStep = 0.070) {
  if (!candles || candles.length < 2) return [];
  const sar = new Array(candles.length).fill(null);
  
  let isUp = parseFloat(candles[1].close) >= parseFloat(candles[0].close);
  let af = step;
  let ep = isUp ? parseFloat(candles[0].high) : parseFloat(candles[0].low);
  let currentSar = isUp ? parseFloat(candles[0].low) : parseFloat(candles[0].high);
  
  sar[0] = currentSar;

  for (let i = 1; i < candles.length; i++) {
    const prevLow1 = parseFloat(candles[i - 1].low);
    const prevLow2 = i >= 2 ? parseFloat(candles[i - 2].low) : prevLow1;
    const prevHigh1 = parseFloat(candles[i - 1].high);
    const prevHigh2 = i >= 2 ? parseFloat(candles[i - 2].high) : prevHigh1;
    const currHigh = parseFloat(candles[i].high);
    const currLow = parseFloat(candles[i].low);

    let nextSar = currentSar + af * (ep - currentSar);

    if (isUp) {
      nextSar = Math.min(nextSar, prevLow1, prevLow2);
      if (currLow < nextSar) {
        isUp = false;
        currentSar = ep;
        ep = currLow;
        af = step;
      } else {
        currentSar = nextSar;
        if (currHigh > ep) {
          ep = currHigh;
          af = Math.min(af + step, maxStep);
        }
      }
    } else {
      nextSar = Math.max(nextSar, prevHigh1, prevHigh2);
      if (currHigh > nextSar) {
        isUp = true;
        currentSar = ep;
        ep = currHigh;
        af = step;
      } else {
        currentSar = nextSar;
        if (currLow < ep) {
          ep = currLow;
          af = Math.min(af + step, maxStep);
        }
      }
    }
    sar[i] = currentSar;
  }
  return sar;
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

function getBGAInfo(price) {
  let step = 100;
  if (price > 20000) step = 500;
  else if (price > 10000) step = 200;
  else if (price > 5000) step = 100;
  else if (price > 2000) step = 50;
  else if (price > 1000) step = 20;
  else step = 10;

  const whole = Math.round(price / step) * step;
  const half = whole - (step / 2);
  const isWhole = Math.abs(price - whole) <= (step * 0.05);
  const isHalf = Math.abs(price - half) <= (step * 0.05);
  if (isWhole) return `BGA Whole Level (${whole})`;
  if (isHalf) return `BGA Half Level (${half})`;
  return `BGA Zone (Near ${whole})`;
}

function calculateBgaTakeProfits(entry, direction, slDistance, d1Candles) {
  let step = 100;
  if (entry > 20000) step = 500;
  else if (entry > 10000) step = 200;
  else if (entry > 5000) step = 100;
  else if (entry > 2000) step = 50;
  else if (entry > 1000) step = 20;
  else step = 10;

  const halfStep = step / 2;
  const baseWhole = Math.round(entry / step) * step;
  
  // ENSURE MINIMUM 1:1 RR: TP1 distance must be at least equal to the Stop Loss distance
  const minBuffer = Math.max(step * 0.50, slDistance);

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
    if (fibMaxLimit && fibMaxLimit > tp1) futureLevels = futureLevels.filter(l => l <= fibMaxLimit);

    let tp2 = futureLevels[0] || (tp1 + halfStep);
    let tp3 = futureLevels[1] || (tp1 + step);

    if (tp2 <= tp1) tp2 = tp1 + halfStep;
    if (tp3 <= tp2) tp3 = tp2 + halfStep;

    // Apply Fib clamp LAST so sanity pass cannot overwrite it
    if (fibMaxLimit && fibMaxLimit > tp1) {
      tp2 = Math.min(tp2, fibMaxLimit);
      tp3 = Math.min(tp3, fibMaxLimit);
    }

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
    if (fibMaxLimit && fibMaxLimit < tp1) futureLevels = futureLevels.filter(l => l >= fibMaxLimit);

    let tp2 = futureLevels[0] || (tp1 - halfStep);
    let tp3 = futureLevels[1] || (tp1 - step);

    if (tp2 >= tp1) tp2 = tp1 - halfStep;
    if (tp3 >= tp2) tp3 = tp2 - halfStep;

    // Apply Fib clamp LAST so sanity pass cannot overwrite it
    if (fibMaxLimit && fibMaxLimit < tp1) {
      tp2 = Math.max(tp2, fibMaxLimit);
      tp3 = Math.max(tp3, fibMaxLimit);
    }

    return { tp1, tp2, tp3 };
  }
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

    // ── Dynamic Live-Trailing Parabolic SAR Stop Loss ──
    if (tradeData.candles && tradeData.candles.length >= 2) {
      const psarValues = calculatePSAR(tradeData.candles, PSAR_STEP, PSAR_MAX);
      const livePsar = psarValues[psarValues.length - 2]; // Closed M5 candle (no repainting)
      const currentClose = parseFloat(tradeData.candles[tradeData.candles.length - 2].close);

      if (livePsar != null) {
        if (!openTrade.psarAligned) {
          const nowAligned = openTrade.direction === "BUY" ? livePsar < currentClose : livePsar > currentClose;
          if (nowAligned) {
            openTrade.psarAligned = true;
            openTrade.sl = openTrade.direction === "BUY"
              ? Math.max(openTrade.sl, livePsar)
              : Math.min(openTrade.sl, livePsar);
            fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
            dbg(`PSAR aligned for open trade. New SL: ${openTrade.sl.toFixed(4)}`);
          }
        } else {
          const oldSl = openTrade.sl;
          openTrade.sl = openTrade.direction === "BUY"
            ? Math.max(openTrade.sl, livePsar)
            : Math.min(openTrade.sl, livePsar);
          if (openTrade.sl !== oldSl) {
            fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
            dbg(`PSAR ratcheted SL from ${oldSl.toFixed(4)} to ${openTrade.sl.toFixed(4)}`);
          }
        }
      }
    }

    const closeWith = async (result, exitReason) => {
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

      // Derive final result strictly from serverPnl to maintain true P&L integrity
      const finalResult = (typeof serverPnl === 'number') ? (serverPnl >= 0 ? "WIN" : "LOSS") : result;
      openTrade.result = finalResult;
      openTrade.closeTime = new Date().toISOString().replace("T"," ").substring(0,19);

      fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
      const icon = finalResult === "WIN" ? "✅" : "❌";
      const contractType = openTrade.direction === "BUY" ? "MULTUP" : "MULTDOWN";
      const durationMs = new Date(openTrade.closeTime) - new Date(openTrade.openTime);
      const slDollars = parseFloat(STAKE_USD.toFixed(2));
      const tpDollars = parseFloat((STAKE_USD * RISK_REWARD).toFixed(2));
      const tp1Status = openTrade.tp1Reached ? "✅ TP1 hit" : "❌ TP1 not reached";
      const pnlStr = serverPnl >= 0 ? `+$${serverPnl.toFixed(2)}` : `-$${Math.abs(serverPnl).toFixed(2)}`;
      
      await sendTelegram(`${icon} *${REPO_LABEL} — Trade ${finalResult}*\n\nDirection: ${openTrade.direction} (${contractType})\nSymbol: ${SYMBOL_NAME}\n\n📍 Entry: ${openTrade.entry.toFixed(4)}\n🏁 Exit: ${currentPrice.toFixed(4)}\n🛑 SL: ${openTrade.sl.toFixed(4)} ($${slDollars} hard)\n🎯 TP1: ${openTrade.tp1.toFixed(4)} (BGA) ${tp1Status}\n\n💵 P&L: ${pnlStr} (Net of comm.)\nReason: ${exitReason}\nDuration: ${formatDuration(durationMs)}\n\nOpened: ${openTrade.openTime}\nClosed: ${openTrade.closeTime}\n` + (openTrade.contractId ? `Contract: \`${openTrade.contractId}\`` : ""));
    };

    // ── 1. Hard SL Price Check (Highest Priority per Spec - Dynamically Driven by PSAR) ──
    const slBreached = openTrade.direction === "BUY" ? currentPrice <= openTrade.sl : currentPrice >= openTrade.sl;
    if (slBreached) {
      await closeWith("LOSS", `Hard SL hit — price ${currentPrice.toFixed(4)} breached SL ${openTrade.sl.toFixed(4)}`);
      return;
    }

    // ── 2. TP2 Ultimate Target Hit ──
    const tp2Hit = openTrade.direction === "BUY" ? currentPrice >= openTrade.tp2 : currentPrice <= openTrade.tp2;
    if (tp2Hit) {
      await closeWith("WIN", `TP2 Ultimate Target hit — price ${currentPrice.toFixed(4)} reached BGA level ${openTrade.tp2.toFixed(4)}`);
      return;
    }

    // ── 3. Breakeven Protection & Commission-Covered Pullback Exit (Lifetime Floor) ──
    if (!openTrade.breakevenSet && pnl >= BREAKEVEN_ACTIVATE_USD) {
      openTrade.breakevenSet = true;
      fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
      await sendTelegram(`⚖️ *${REPO_LABEL} — Breakeven Armed*\nProfit reached $${BREAKEVEN_ACTIVATE_USD.toFixed(2)}. Price floor locked at entry (${openTrade.entry.toFixed(4)}).`);
    }

    const targetNetProfit = 0.50;
    const requiredRawPnl = targetNetProfit + COMMISSION_USD;
    const priceMoveFraction = requiredRawPnl / (STAKE_USD * MULTIPLIER);
    const breakevenPrice = openTrade.direction === "BUY"
      ? openTrade.entry * (1 + priceMoveFraction)
      : openTrade.entry * (1 - priceMoveFraction);

    const breakevenHit = openTrade.breakevenSet && (
      (openTrade.direction === "BUY" && currentPrice <= breakevenPrice) ||
      (openTrade.direction === "SELL" && currentPrice >= breakevenPrice)
    );
    if (breakevenHit) {
      await closeWith("WIN", `Commission-Covered Breakeven exit — locked +$0.50 net profit at price ${breakevenPrice.toFixed(4)}`);
      return;
    }

    // ── 4. TP1 Price Level Hit & High-Water Mark Trailing (50% Trail) ──
    if (!openTrade.tp1Reached) {
      const tp1Hit = openTrade.direction === "BUY" ? currentPrice >= openTrade.tp1 : currentPrice <= openTrade.tp1;
      if (tp1Hit) {
        openTrade.tp1Reached = true;
        fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
        await sendTelegram(`🎯 TP1 BGA Whole Number reached (${openTrade.tp1.toFixed(4)}) on ${openTrade.direction} — 50% peak-drop trailing now armed.`);
      }
    }

    if (openTrade.tp1Reached) {
      if (openTrade.peakProfit === null || pnl > openTrade.peakProfit) {
        openTrade.peakProfit = pnl;
        fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
      }
      const dropThreshold = openTrade.peakProfit * 0.50; 
      if (openTrade.peakProfit > 0 && pnl <= openTrade.peakProfit - dropThreshold) {
        const result = pnl >= 0 ? "WIN" : "LOSS";
        await closeWith(result, `Profit trail exit — locked ~$${pnl.toFixed(2)} (peak $${openTrade.peakProfit.toFixed(2)}, 50% drop from peak)`);
        return;
      }
    }

    console.log("Open trade being managed — skipping scan.");
    return;
  }

  // ── Signal Scan (Consolidated Data Fetching - M5, H1, D1) ──
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
  const psarValues = calculatePSAR(candles, PSAR_STEP, PSAR_MAX);
  const currentPsar = psarValues[i];

  // 1. Evaluate Fresh H1 Crossover using EXPONENTIAL MOVING AVERAGE (EMA 50) over at least 250 H1 candles
  let h1FreshBuy = false;
  let h1FreshSell = false;
  let h1TrendDir = null;
  if (h1Candles && h1Candles.length >= 250) {
    const h1Closes = h1Candles.map(c => parseFloat(c.close));
    const h1ci = h1Candles.length - 2; // Closed H1 candle
    const h1PrevCi = h1ci - 1;         // Previous H1 candle
    const ema50_1h = ema(h1Closes, 50); // <--- Fully converged EMA 50

    if (ema50_1h[h1ci] != null && ema50_1h[h1PrevCi] != null) {
      h1FreshBuy = (h1Closes[h1PrevCi] <= ema50_1h[h1PrevCi]) && (h1Closes[h1ci] > ema50_1h[h1ci]);
      h1FreshSell = (h1Closes[h1PrevCi] >= ema50_1h[h1PrevCi]) && (h1Closes[h1ci] < ema50_1h[h1ci]);

      if (h1Closes[h1ci] > ema50_1h[h1ci]) h1TrendDir = "BUY";
      else if (h1Closes[h1ci] < ema50_1h[h1ci]) h1TrendDir = "SELL";
    }
  }

  // Check if we entered a NEW H1 trend cycle via a fresh crossover event
  let h1NewCycleEpoch = null;
  if (h1Candles && h1Candles.length >= 250) {
    const h1ci = h1Candles.length - 2;
    if (h1FreshBuy || h1FreshSell) {
      h1NewCycleEpoch = h1Candles[h1ci].epoch;
    }
  }

  // ── STEP 1: New H1 cycle detected — reset everything and open a fresh Phase A window ──
  if (h1NewCycleEpoch && state.h1TrendCycleEpoch !== h1NewCycleEpoch) {
    state.h1TrendCycleEpoch = h1NewCycleEpoch;
    state.waitingFor = h1FreshBuy ? "BUY" : "SELL";
    state.phaseATaken = false;
    state.phaseAWindowExpired = false;
    state.phaseADeadlineEpoch = h1NewCycleEpoch + PHASE_A_WINDOW_SECONDS;
    state.phaseBPending = null;
    state.phaseBStochFreshSeen = false;
    state.phaseBCciFreshSeen = false;
    state.phaseBTdiFreshSeen = false;
    dbg(`STEP 1: New H1 trend cycle detected at epoch ${h1NewCycleEpoch} (${state.waitingFor}). Phase A window open until ${new Date(state.phaseADeadlineEpoch * 1000).toISOString()}.`);
  }

  // ── STEP 2: Trend invalidation — if H1 trend flips completely against waitingFor, wipe state ──
  if (h1TrendDir && state.waitingFor && h1TrendDir !== state.waitingFor) {
    dbg("STEP 2: H1 trend flipped against waitingFor. Resetting state.");
    state.waitingFor = null;
    state.phaseATaken = false;
    state.h1TrendCycleEpoch = null;
    state.phaseADeadlineEpoch = null;
    state.phaseAWindowExpired = false;
    state.phaseBPending = null;
    state.phaseBStochFreshSeen = false;
    state.phaseBCciFreshSeen = false;
    state.phaseBTdiFreshSeen = false;
  }

  // ── STEP 3: Cold-boot adoption — ONLY runs if waitingFor is currently null (no cycle tracked at all) ──
  if (!state.waitingFor && h1TrendDir) {
    state.waitingFor = h1TrendDir;
    state.h1TrendCycleEpoch = currentCandleEpoch;
    state.phaseATaken = false;
    state.phaseAWindowExpired = false;
    state.phaseADeadlineEpoch = currentCandleEpoch + PHASE_A_WINDOW_SECONDS;
    dbg(`STEP 3: Cold-boot adoption — no cycle was tracked. Adopting ${h1TrendDir}. Phase A window open until ${new Date(state.phaseADeadlineEpoch * 1000).toISOString()}.`);
  }

  // ── STEP 4: Legacy migration — ONLY runs if waitingFor IS already set, but is missing a deadline ──
  if (state.waitingFor && !state.phaseATaken && !state.phaseAWindowExpired && !state.phaseADeadlineEpoch) {
    const nowEpoch = Math.floor(Date.now() / 1000);
    if (state.h1TrendCycleEpoch) {
      const properDeadline = state.h1TrendCycleEpoch + PHASE_A_WINDOW_SECONDS;
      if (nowEpoch > properDeadline) {
        state.phaseAWindowExpired = true;
        dbg(`STEP 4: Legacy migration — original H1 cross was at ${new Date(state.h1TrendCycleEpoch * 1000).toISOString()}, deadline already passed. Marking Phase A EXPIRED — falling back to Phase B.`);
      } else {
        state.phaseADeadlineEpoch = properDeadline;
        dbg(`STEP 4: Legacy migration — restored Phase A deadline from original cycle epoch, open until ${new Date(properDeadline * 1000).toISOString()}.`);
      }
    } else {
      state.phaseAWindowExpired = true;
      dbg(`STEP 4: Legacy migration — no h1TrendCycleEpoch on record. Marking Phase A EXPIRED — falling back to Phase B.`);
    }
  }

  // ── STEP 5: If still no active trend to track, exit early ──
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

    // --- PHASE A: Must take the very first trade within PHASE_A_WINDOW_SECONDS of the fresh H1 EMA 50 cross ---
    if (!state.phaseATaken && !state.phaseAWindowExpired) {
      const deadlinePassed = state.phaseADeadlineEpoch && currentCandleEpoch > state.phaseADeadlineEpoch;

      if (deadlinePassed) {
        state.phaseAWindowExpired = true;
        dbg(`Phase A window EXPIRED at ${new Date(currentCandleEpoch*1000).toISOString()} — no fill. Falling back to Phase B monitoring.`);
      } else {
        // Strict AND operator for prior candle oversold/overbought per spec
        const stochCrossBuyPhaseA = (stoch.k[si-1] <= 20 && stoch.d[si-1] <= 20) &&
                                    (stoch.k[si] > 20 && stoch.d[si] > 20) &&
                                    (stoch.k[si-1] <= stoch.d[si-1]) &&
                                    (stoch.k[si] > stoch.d[si]);

        const stochCrossSellPhaseA = (stoch.k[si-1] >= 80 && stoch.d[si-1] >= 80) &&
                                     (stoch.k[si] < 80 && stoch.d[si] < 80) &&
                                     (stoch.k[si-1] >= stoch.d[si-1]) &&
                                     (stoch.k[si] < stoch.d[si]);

        if (state.waitingFor === "BUY" && stochCrossBuyPhaseA) {
          signalTriggered = true;
          direction = "BUY";
          entry = closes[i];
          entryType = 'PHASE_A';
          state.phaseATaken = true;
        } else if (state.waitingFor === "SELL" && stochCrossSellPhaseA) {
          signalTriggered = true;
          direction = "SELL";
          entry = closes[i];
          entryType = 'PHASE_A';
          state.phaseATaken = true;
        }
      }
    }

    // --- PHASE B: Stateful Re-entry Engine (fires after a real Phase A fill, OR after Phase A window expires unfilled) ---
    if (!signalTriggered && (state.phaseATaken || state.phaseAWindowExpired)) {
      // 50-level cross on Stochastic main line (%K)
      const stochCrossBuyB = (stoch.k[si-1] <= 50) && (stoch.k[si] > 50);
      const stochCrossSellB = (stoch.k[si-1] >= 50) && (stoch.k[si] < 50);

      const cciCrossBuyB = cci[si-1] <= 0 && cci[si] > 0;
      const cciCrossSellB = cci[si-1] >= 0 && cci[si] < 0;

      const tdiCrossBuyB = rsi[si-1] <= tdi.middle[si-1] && rsi[si] > tdi.middle[si];
      const tdiCrossSellB = rsi[si-1] >= tdi.middle[si-1] && rsi[si] < tdi.middle[si];

      if (state.waitingFor === "BUY") {
        // De-alignment reset checks
        if (stoch.k[si] < 50) state.phaseBStochFreshSeen = false;
        if (cci[si] < 0) state.phaseBCciFreshSeen = false;
        if (rsi[si] < tdi.middle[si]) state.phaseBTdiFreshSeen = false;

        // Arm Phase B upon the first fresh cross
        if (!state.phaseBPending) {
          if (stochCrossBuyB || cciCrossBuyB || tdiCrossBuyB) {
            state.phaseBPending = "BUY";
            if (stochCrossBuyB) state.phaseBStochFreshSeen = true;
            if (cciCrossBuyB) state.phaseBCciFreshSeen = true;
            if (tdiCrossBuyB) state.phaseBTdiFreshSeen = true;
            dbg("Phase B BUY armed by initial fresh cross.");
          }
        } else {
          if (stochCrossBuyB) state.phaseBStochFreshSeen = true;
          if (cciCrossBuyB) state.phaseBCciFreshSeen = true;
          if (tdiCrossBuyB) state.phaseBTdiFreshSeen = true;
        }

        if (state.phaseBPending === "BUY" && !state.phaseBStochFreshSeen && !state.phaseBCciFreshSeen && !state.phaseBTdiFreshSeen) {
          state.phaseBPending = null;
        }

        if (state.phaseBPending === "BUY" && state.phaseBStochFreshSeen && state.phaseBCciFreshSeen && state.phaseBTdiFreshSeen) {
          signalTriggered = true;
          direction = "BUY";
          entry = closes[i];
          entryType = state.phaseATaken ? 'PHASE_B' : 'PHASE_B_NO_PRIOR_A';
          state.phaseBPending = null;
          state.phaseBStochFreshSeen = false;
          state.phaseBCciFreshSeen = false;
          state.phaseBTdiFreshSeen = false;
        }

      } else if (state.waitingFor === "SELL") {
        // De-alignment reset checks
        if (stoch.k[si] > 50) state.phaseBStochFreshSeen = false;
        if (cci[si] > 0) state.phaseBCciFreshSeen = false;
        if (rsi[si] > tdi.middle[si]) state.phaseBTdiFreshSeen = false;

        // Arm Phase B upon the first fresh cross
        if (!state.phaseBPending) {
          if (stochCrossSellB || cciCrossSellB || tdiCrossSellB) {
            state.phaseBPending = "SELL";
            if (stochCrossSellB) state.phaseBStochFreshSeen = true;
            if (cciCrossSellB) state.phaseBCciFreshSeen = true;
            if (tdiCrossSellB) state.phaseBTdiFreshSeen = true;
            dbg("Phase B SELL armed by initial fresh cross.");
          }
        } else {
          if (stochCrossSellB) state.phaseBStochFreshSeen = true;
          if (cciCrossSellB) state.phaseBCciFreshSeen = true;
          if (tdiCrossSellB) state.phaseBTdiFreshSeen = true;
        }

        if (state.phaseBPending === "SELL" && !state.phaseBStochFreshSeen && !state.phaseBCciFreshSeen && !state.phaseBTdiFreshSeen) {
          state.phaseBPending = null;
        }

        if (state.phaseBPending === "SELL" && state.phaseBStochFreshSeen && state.phaseBCciFreshSeen && state.phaseBTdiFreshSeen) {
          signalTriggered = true;
          direction = "SELL";
          entry = closes[i];
          entryType = state.phaseATaken ? 'PHASE_B' : 'PHASE_B_NO_PRIOR_A';
          state.phaseBPending = null;
          state.phaseBStochFreshSeen = false;
          state.phaseBCciFreshSeen = false;
          state.phaseBTdiFreshSeen = false;
        }
      }
    }
  }

  if (signalTriggered) {
    const slDollars = parseFloat(STAKE_USD.toFixed(2));
    let psarAligned = false;

    // Check if PSAR is already aligned with trade direction at entry
    if (direction === "BUY") {
      if (currentPsar != null && currentPsar < entry) {
        sl = currentPsar;
        psarAligned = true;
      } else {
        // Unaligned fallback: exact price level for -$5.00 loss net of commission
        const targetLoss = -5.00;
        const requiredRawPnl = targetLoss + COMMISSION_USD;
        const priceMoveFraction = requiredRawPnl / (STAKE_USD * MULTIPLIER);
        sl = entry * (1 + priceMoveFraction);
        psarAligned = false;
      }
      risk = entry - sl;
    } else {
      if (currentPsar != null && currentPsar > entry) {
        sl = currentPsar;
        psarAligned = true;
      } else {
        // Unaligned fallback: exact price level for -$5.00 loss net of commission
        const targetLoss = -5.00;
        const requiredRawPnl = targetLoss + COMMISSION_USD;
        const priceMoveFraction = requiredRawPnl / (STAKE_USD * MULTIPLIER);
        sl = entry * (1 - priceMoveFraction);
        psarAligned = false;
      }
      risk = sl - entry;
    }

    const slDistance = risk;
    const bgaTps = await calculateBgaTakeProfits(entry, direction, slDistance, d1Candles);
    tp1 = bgaTps.tp1;
    tp2 = bgaTps.tp2;
    tp3 = bgaTps.tp3;

    const timeFormatted = new Date(currentCandleEpoch * 1000).toISOString().replace("T"," ").substring(0,19);
    const bgaTag = getBGAInfo(entry);

    const setupLabel = entryType === 'PHASE_B_NO_PRIOR_A'
      ? 'PHASE B (Phase A window expired unfilled — fallback re-entry)'
      : `${entryType} (H1 EMA 50, ${PHASE_A_WINDOW_SECONDS/3600}h Phase A window)`;

    const psarLabel = psarAligned ? "(Live PSAR)" : "($5 Hard-Stop Floor — PSAR pending alignment)";

    let message = `🚨 *${SYMBOL_NAME.toUpperCase()} CONFIRMED SIGNAL* 🚨\n\nDirection: ${direction}\nRepo: ${REPO_LABEL}\nTimeframe: M5\n\n📍 Entry: ${entry.toFixed(4)}\n🛑 SL: ${sl.toFixed(4)} ($${slDollars} hard, ${psarLabel})\n🎯 TP1: ${tp1.toFixed(4)} (BGA Whole)\n🎯 TP2 (Ultimate TP): ${tp2.toFixed(4)} (BGA)\n🎯 TP3: ${tp3.toFixed(4)} (reference)\n\n💰 Stake: $${STAKE_USD} | Hard SL: $${slDollars}\n⚡ Setup: ${setupLabel}\n️ Confluence: ${bgaTag}\n━━━━━━━━━━━━━━━━━━━━\n⏰ Time (UTC): ${timeFormatted}\n\n💡 To close manually: send \`/close win\` or \`/close loss\` in this chat`;

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
        breakevenSet: false, peakProfit: null, rr: RISK_REWARD, entryType: entryType, 
        psarAligned, openTime: timeFormatted, closeTime: null, result: null
      });
      fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
    } catch (execErr) {
      console.error("⚠️ Live execution warning:", execErr.message);
      await sendTelegram(`❌ *${REPO_LABEL}* — Live execution warning: ${execErr.message}`);
      return;
    }
  }

  state.lastProcessedEpoch = currentCandleEpoch;
  fs.writeFileSync("state.json", JSON.stringify(state, null, 2));
  console.log(`[${REPO_LABEL}] Scan complete.`);
}

// ==================== EXECUTION MODES ====================
(async () => {
  const REPO_INDEX = { R_10: 0, R_50: 1, R_75: 2, "1HZ75V": 3, R_100: 4, R_25: 5, "1HZ100V": 6 }[SYMBOL] ?? 0;
  const jitterMs = (REPO_INDEX * 12000) + Math.floor(Math.random() * 3000);
  
  dbg(`Staggering execution by ${jitterMs}ms (Repo Index: ${REPO_INDEX})...`);
  await new Promise(r => setTimeout(r, jitterMs));

  if (MODE === "daily") {
    await runSummary("Daily");
    return;
  }
  if (MODE === "weekly") {
    await runSummary("Weekly");
    return;
  }
  if (MODE === "monthly") {
    await runSummary("Monthly");
    return;
  }
  if (MODE === "close_win") {
    await executeManualClose("WIN", "manual command");
    return;
  }
  if (MODE === "close_loss") {
    await executeManualClose("LOSS", "manual command");
    return;
  }
  if (MODE === "test") {
    await sendTelegram(`Test mode active — ${REPO_LABEL}\nFiring a direct BUY trade via proxy...\nCheck your Deriv account for a MULTUP contract.`);
    try {
      const cid = await executeTrade("BUY");
      await sendTelegram(`✅ Test trade placed. Contract ID: ${cid}`);
    } catch (e) {
      await sendTelegram(`❌ Test trade failed: ${e.message}`);
    }
    return;
  }
  if (TRIGGER_SOURCE !== "cronjob") {
    console.log("Not a cronjob trigger — exiting.");
    return;
  }
  await runScanMode();
})();
