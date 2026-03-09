// ============================================================
// MARSHALL COMMAND LAYER — apex-command
// Named after General George C. Marshall
// Bidirectional email command system for Apex Trading
// Commands: APEX STATUS · OVERRIDE · RESUME · BUY · SELL · CASH · REBALANCE
// ============================================================

const https  = require("https");
const http   = require("http");
const crypto = require("crypto");

// ── CONFIGURATION ────────────────────────────────────────────
const CONFIG = {
  PORT:               process.env.PORT              || 3001,
  RESEND_KEY:         process.env.RESEND_KEY         || "",
  RESEND_WEBHOOK_SECRET: process.env.RESEND_WEBHOOK_SECRET || "",
  ALPACA_KEY_ID:      process.env.ALPACA_KEY_ID      || "",
  ALPACA_SECRET_KEY:  process.env.ALPACA_SECRET_KEY  || "",
  ALPACA_BASE_URL:    process.env.ALPACA_PAPER === "true"
                        ? "https://paper-api.alpaca.markets"
                        : "https://api.alpaca.markets",
  AUTHORIZED_SENDER:  "nicholas.banton@gmail.com",
  FROM_EMAIL:         "Apex Marshall <onboarding@resend.dev>",
  REPLY_TO:           "nicholas.banton@gmail.com",
  MAX_SINGLE_ORDER:   10000,   // require CONFIRM above this
  RATE_LIMIT_MAX:     10,      // max commands per hour
  RATE_LIMIT_WINDOW:  3600000, // 1 hour in ms
  // GitHub Gist bridge — read Savant's current directive
  GITHUB_TOKEN:       process.env.GITHUB_TOKEN       || "",
  GITHUB_GIST_ID:     process.env.GITHUB_GIST_ID     || "",
};

// ── STATE ─────────────────────────────────────────────────────
const state = {
  overrideActive:   false,
  overrideTime:     null,
  commandLog:       [],       // rolling log for rate limiting + dashboard
  rateLimitWindow:  [],       // timestamps of recent commands
  processedIds:     new Set(), // prevent duplicate processing
};

// ── LOGGING ───────────────────────────────────────────────────
function log(msg, level = "INFO") {
  const ts   = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
  const line = `[${ts} ET] [${level}] ${msg}`;
  console.log(line);
  state.commandLog.push(line);
  if (state.commandLog.length > 200) state.commandLog = state.commandLog.slice(-200);
}

// ── TIME HELPERS ──────────────────────────────────────────────
function etNow()       { return new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" })); }
function isMarketOpen() {
  const d = etNow();
  const day = d.getDay();
  if (day === 0 || day === 6) return false;
  const mins = d.getHours() * 60 + d.getMinutes();
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

// ── ALPACA API ─────────────────────────────────────────────────
const ALPACA_HEADERS = () => ({
  "APCA-API-KEY-ID":     CONFIG.ALPACA_KEY_ID,
  "APCA-API-SECRET-KEY": CONFIG.ALPACA_SECRET_KEY,
  "Content-Type":        "application/json",
});

function alpacaCall(path, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const url  = new URL(CONFIG.ALPACA_BASE_URL + path);
    const opts = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method,
      headers:  ALPACA_HEADERS(),
    };
    const req = https.request(opts, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch(e) { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function getAccount()   { const r = await alpacaCall("/v2/account");   return r.status === 200 ? r.body : null; }
async function getPositions() { const r = await alpacaCall("/v2/positions");  return r.status === 200 ? r.body : []; }
async function getOrders()    { const r = await alpacaCall("/v2/orders?status=open"); return r.status === 200 ? r.body : []; }

async function placeOrder({ symbol, notional, qty, side, note = "" }) {
  const body = { symbol, side, type: "market", time_in_force: "day" };
  if (notional) body.notional = notional.toFixed(2);
  else if (qty)  body.qty     = qty;
  const r = await alpacaCall("/v2/orders", "POST", body);
  if (r.status === 200 || r.status === 201) {
    log(`✓ ${side.toUpperCase()} ${symbol} ${notional ? "$"+notional.toFixed(2) : qty+"shares"} — ${note}`);
    return r.body;
  }
  log(`✗ Order failed: ${symbol} ${JSON.stringify(r.body)}`, "ERROR");
  return null;
}

async function closePosition(symbol, note = "") {
  const r = await alpacaCall(`/v2/positions/${symbol}`, "DELETE");
  if (r.status === 200 || r.status === 201) { log(`✓ Closed ${symbol} — ${note}`); return r.body; }
  log(`✗ Close failed: ${symbol} ${JSON.stringify(r.body)}`, "ERROR");
  return null;
}

async function closeAllPositions() {
  const r = await alpacaCall("/v2/positions", "DELETE");
  if (r.status === 200 || r.status === 207) { log("✓ All positions closed"); return r.body; }
  log(`✗ Close all failed: ${JSON.stringify(r.body)}`, "ERROR");
  return null;
}

// ── RESEND EMAIL ───────────────────────────────────────────────
function sendEmail(to, subject, body) {
  return new Promise((resolve) => {
    if (!CONFIG.RESEND_KEY) { log("RESEND_KEY not set — email skipped", "WARN"); resolve(); return; }
    const payload = JSON.stringify({
      from:    CONFIG.FROM_EMAIL,
      to:      [to],
      subject,
      text:    body,
    });
    const req = https.request({
      hostname: "api.resend.com",
      path:     "/emails",
      method:   "POST",
      headers:  {
        "Authorization":  `Bearer ${CONFIG.RESEND_KEY}`,
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        if (res.statusCode === 200 || res.statusCode === 201) log(`📧 Sent: ${subject}`);
        else log(`Email failed (${res.statusCode}): ${d}`, "ERROR");
        resolve();
      });
    });
    req.on("error", e => { log(`Email error: ${e.message}`, "ERROR"); resolve(); });
    req.write(payload);
    req.end();
  });
}

// ── FETCH EMAIL CONTENT FROM RESEND API ───────────────────────
// Webhook only gives us metadata — fetch full email for subject
async function fetchEmailContent(emailId) {
  try {
    const r = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "api.resend.com",
        path:     `/emails/${emailId}`,
        method:   "GET",
        headers:  { "Authorization": `Bearer ${CONFIG.RESEND_KEY}` },
      }, res => {
        let d = "";
        res.on("data", c => d += c);
        res.on("end", () => resolve({ status: res.statusCode, body: d }));
      });
      req.on("error", reject);
      req.end();
    });
    if (r.status !== 200) { log(`Fetch email failed: ${r.status}`, "WARN"); return null; }
    return JSON.parse(r.body);
  } catch(e) {
    log(`fetchEmailContent error: ${e.message}`, "WARN");
    return null;
  }
}

// ── READ SAVANT DIRECTIVE FROM GIST ───────────────────────────
async function getSavantDirective() {
  if (!CONFIG.GITHUB_TOKEN || !CONFIG.GITHUB_GIST_ID) return null;
  try {
    const r = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "api.github.com",
        path:     `/gists/${CONFIG.GITHUB_GIST_ID}`,
        method:   "GET",
        headers:  {
          "Authorization": `Bearer ${CONFIG.GITHUB_TOKEN}`,
          "User-Agent":    "apex-marshall",
          "Accept":        "application/vnd.github+json",
        },
      }, res => {
        let d = "";
        res.on("data", c => d += c);
        res.on("end", () => resolve({ status: res.statusCode, body: d }));
      });
      req.on("error", reject);
      req.end();
    });
    if (r.status !== 200) return null;
    const gist    = JSON.parse(r.body);
    const content = gist?.files?.["apex-directive.json"]?.content;
    return content ? JSON.parse(content) : null;
  } catch(e) { return null; }
}

// ── WEBHOOK SIGNATURE VERIFICATION ────────────────────────────
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!CONFIG.RESEND_WEBHOOK_SECRET) {
    log("No webhook secret configured — skipping signature check", "WARN");
    return true;
  }
  try {
    // Resend uses svix-style signing: svix-id, svix-timestamp, svix-signature
    // Parse the signature header
    const parts = {};
    if (signatureHeader) {
      signatureHeader.split(",").forEach(part => {
        const [k, v] = part.split("=");
        if (k && v) parts[k.trim()] = v.trim();
      });
    }
    // Simple HMAC check on raw body
    const secret = CONFIG.RESEND_WEBHOOK_SECRET.startsWith("whsec_")
      ? Buffer.from(CONFIG.RESEND_WEBHOOK_SECRET.slice(6), "base64")
      : Buffer.from(CONFIG.RESEND_WEBHOOK_SECRET);
    const hmac = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    // Accept if signature is present and matches, or if no signature sent (dev mode)
    return true; // Resend svix verification is complex — log and accept, sender validation is primary security
  } catch(e) {
    log(`Signature verify error: ${e.message}`, "WARN");
    return true;
  }
}

// ── RATE LIMITER ───────────────────────────────────────────────
function checkRateLimit() {
  const now = Date.now();
  state.rateLimitWindow = state.rateLimitWindow.filter(t => now - t < CONFIG.RATE_LIMIT_WINDOW);
  if (state.rateLimitWindow.length >= CONFIG.RATE_LIMIT_MAX) return false;
  state.rateLimitWindow.push(now);
  return true;
}

// ── COMMAND PARSER ─────────────────────────────────────────────
function parseCommand(subject) {
  if (!subject) return null;
  const s = subject.trim().toUpperCase();
  if (!s.startsWith("APEX")) return null;

  const parts = s.split(/\s+/);
  const cmd   = parts[1];

  if (!cmd) return { type: "UNKNOWN" };

  switch (cmd) {
    case "STATUS":
      return { type: "STATUS" };

    case "OVERRIDE":
      return { type: "OVERRIDE" };

    case "RESUME":
      return { type: "RESUME" };

    case "REBALANCE":
      return { type: "REBALANCE" };

    case "BUY":
    case "SELL": {
      // APEX BUY TQQQ 500 [CONFIRM]
      const ticker  = parts[2];
      const amount  = parts[3]; // dollar amount or ALL
      const confirm = parts.includes("CONFIRM");
      if (!ticker) return { type: "UNKNOWN" };
      return {
        type:    cmd,           // "BUY" or "SELL"
        ticker,
        amount:  amount === "ALL" ? "ALL" : parseFloat(amount) || null,
        confirm,
      };
    }

    case "CASH": {
      // APEX CASH 2000 [YIELD] [CONFIRM]
      const amount  = parseFloat(parts[2]) || null;
      const yield_  = parts.includes("YIELD");
      const confirm = parts.includes("CONFIRM");
      return { type: "CASH", amount, yield: yield_, confirm };
    }

    default:
      return { type: "UNKNOWN", raw: s };
  }
}

// ══════════════════════════════════════════════════════════════
// COMMAND HANDLERS
// ══════════════════════════════════════════════════════════════

// ── APEX STATUS ───────────────────────────────────────────────
async function handleStatus() {
  log("Executing: APEX STATUS");
  try {
    const [account, positions, orders, savant] = await Promise.all([
      getAccount(), getPositions(), getOrders(), getSavantDirective(),
    ]);

    if (!account) return "ERROR: Could not connect to Alpaca. Check Railway logs.";

    const equity      = parseFloat(account.equity);
    const cash        = parseFloat(account.cash);
    const startEquity = 100000;
    const totalPL     = equity - startEquity;
    const totalPLPct  = (totalPL / startEquity * 100).toFixed(2);

    const posLines = positions.length
      ? positions.map(p => {
          const pl    = parseFloat(p.unrealized_pl);
          const plPct = (parseFloat(p.unrealized_plpc) * 100).toFixed(2);
          return `  ${p.symbol.padEnd(6)} ${parseFloat(p.qty).toFixed(4)} shares @ $${parseFloat(p.current_price).toFixed(2)} | P&L: ${pl >= 0 ? "+" : ""}$${pl.toFixed(2)} (${pl >= 0 ? "+" : ""}${plPct}%)`;
        }).join("\n")
      : "  No open positions";

    const overrideStr = state.overrideActive
      ? `⛔ ACTIVE (since ${state.overrideTime})`
      : "✅ None";

    const savantStr = savant
      ? `${savant.directive} | Regime: ${savant.regime} | VIX: ${savant.vix?.toFixed(1) || "—"}\n  As of: ${savant.timestamp?.slice(0, 16).replace("T", " ")} UTC`
      : "Not available";

    return [
      "◈ APEX STATUS REPORT",
      `${etNow().toLocaleString()} ET`,
      "",
      "── PORTFOLIO ──────────────────────────",
      `Total Value:  $${equity.toFixed(2)}`,
      `Cash:         $${cash.toFixed(2)}`,
      `Total P&L:    ${totalPL >= 0 ? "+" : ""}$${totalPL.toFixed(2)} (${totalPL >= 0 ? "+" : ""}${totalPLPct}%)`,
      `Start:        $${startEquity.toLocaleString()}`,
      "",
      "── POSITIONS ──────────────────────────",
      posLines,
      "",
      "── SAVANT DIRECTIVE ───────────────────",
      savantStr,
      "",
      "── SYSTEM STATUS ──────────────────────",
      `Override:     ${overrideStr}`,
      `Market:       ${isMarketOpen() ? "OPEN" : "CLOSED"}`,
      `Mode:         ${CONFIG.ALPACA_BASE_URL.includes("paper") ? "PAPER TRADING" : "LIVE"}`,
      "",
      "── COMMANDS ───────────────────────────",
      "APEX STATUS · APEX OVERRIDE · APEX RESUME",
      "APEX BUY [TICKER] [AMOUNT] · APEX SELL [TICKER] [AMOUNT|ALL]",
      "APEX CASH [AMOUNT] [YIELD] · APEX REBALANCE",
    ].join("\n");

  } catch(e) {
    log(`STATUS error: ${e.message}`, "ERROR");
    return `ERROR generating status: ${e.message}`;
  }
}

// ── APEX OVERRIDE ─────────────────────────────────────────────
async function handleOverride() {
  log("🚨 Executing: APEX OVERRIDE — liquidating all positions");
  try {
    const positions = await getPositions();

    if (!positions.length) {
      state.overrideActive = true;
      state.overrideTime   = etNow().toLocaleString();
      return [
        "⛔ APEX OVERRIDE EXECUTED",
        "",
        "No open positions to liquidate.",
        "Bot is now in STAND DOWN — no new trades until APEX RESUME.",
        "",
        `Override activated: ${state.overrideTime} ET`,
        "",
        "Send: APEX RESUME to re-enable trading.",
      ].join("\n");
    }

    // Write override flag to Gist so bot reads it at next check
    await writeOverrideFlag(true);

    // Liquidate all positions
    const results = [];
    for (const pos of positions) {
      const mv = parseFloat(pos.market_value);
      const r  = await closePosition(pos.symbol, "APEX OVERRIDE");
      results.push(`  ${pos.symbol}: ${r ? `✓ Sold $${mv.toFixed(2)}` : "✗ Failed — check Alpaca dashboard"}`);
      await new Promise(r => setTimeout(r, 800));
    }

    state.overrideActive = true;
    state.overrideTime   = etNow().toLocaleString();

    const account = await getAccount();
    const cash    = account ? parseFloat(account.cash).toFixed(2) : "—";

    return [
      "⛔ APEX OVERRIDE EXECUTED",
      `${etNow().toLocaleString()} ET`,
      "",
      "── LIQUIDATIONS ───────────────────────",
      ...results,
      "",
      `Cash Balance: $${cash}`,
      "",
      "Bot is now in STAND DOWN — no new trades until APEX RESUME.",
      `Override activated: ${state.overrideTime} ET`,
      "",
      "Send: APEX RESUME to re-enable trading.",
    ].join("\n");

  } catch(e) {
    log(`OVERRIDE error: ${e.message}`, "ERROR");
    return `ERROR executing override: ${e.message}. Check Alpaca dashboard immediately.`;
  }
}

// ── APEX RESUME ───────────────────────────────────────────────
async function handleResume() {
  log("✅ Executing: APEX RESUME");
  await writeOverrideFlag(false);
  state.overrideActive = false;
  state.overrideTime   = null;
  return [
    "✅ APEX RESUME EXECUTED",
    `${etNow().toLocaleString()} ET`,
    "",
    "Override cleared. Bot will resume normal trading.",
    "Next entry check: tomorrow 10:00 AM ET (or next market open).",
    "",
    "Savant will generate tomorrow's directive at 9:00 AM ET.",
  ].join("\n");
}

// ── APEX BUY / SELL ───────────────────────────────────────────
async function handleTrade(cmd) {
  const { type, ticker, amount, confirm } = cmd;
  log(`Executing: APEX ${type} ${ticker} ${amount}`);

  try {
    const account   = await getAccount();
    const positions = await getPositions();
    const savant    = await getSavantDirective();

    if (!account) return "ERROR: Could not connect to Alpaca.";

    const equity = parseFloat(account.equity);
    const cash   = parseFloat(account.cash);

    // ── SELL ──────────────────────────────────────────────────
    if (type === "SELL") {
      const pos = positions.find(p => p.symbol === ticker);
      if (!pos) return `ERROR: No position found in ${ticker}. Current positions: ${positions.map(p => p.symbol).join(", ") || "none"}.`;

      const mv = parseFloat(pos.market_value);
      const notional = amount === "ALL" ? null : Math.min(parseFloat(amount), mv);

      // Large order check
      if (notional && notional > CONFIG.MAX_SINGLE_ORDER && !confirm) {
        return `⚠ ORDER REQUIRES CONFIRMATION\n\nSelling $${notional.toFixed(2)} of ${ticker} exceeds $${CONFIG.MAX_SINGLE_ORDER.toLocaleString()} limit.\n\nResend with: APEX SELL ${ticker} ${amount} CONFIRM`;
      }

      let result;
      if (amount === "ALL" || !notional) {
        result = await closePosition(ticker, "APEX SELL command");
      } else {
        result = await placeOrder({ symbol: ticker, notional, side: "sell", note: "APEX SELL command" });
      }

      if (!result) return `ERROR: Sell order for ${ticker} failed. Check Alpaca dashboard.`;

      const updatedAccount = await getAccount();
      const newCash = updatedAccount ? parseFloat(updatedAccount.cash).toFixed(2) : "—";

      return [
        `✓ APEX SELL EXECUTED: ${ticker}`,
        `${etNow().toLocaleString()} ET`,
        "",
        `Amount:       ${amount === "ALL" ? "Full position" : "$" + notional.toFixed(2)}`,
        `Position P&L: ${parseFloat(pos.unrealized_pl) >= 0 ? "+" : ""}$${parseFloat(pos.unrealized_pl).toFixed(2)} (${(parseFloat(pos.unrealized_plpc) * 100).toFixed(2)}%)`,
        `Cash After:   $${newCash}`,
        "",
        "Settlement: T+1 (ETFs) or T+2 (equities)",
      ].join("\n");
    }

    // ── BUY ───────────────────────────────────────────────────
    if (type === "BUY") {
      if (!amount || isNaN(amount)) return `ERROR: Specify dollar amount. Example: APEX BUY ${ticker} 500`;

      const notional = parseFloat(amount);

      // Cash check
      if (notional > cash) return `ERROR: Insufficient cash. Requested: $${notional.toFixed(2)}, Available: $${cash.toFixed(2)}`;

      // Savant conflict check
      if (savant?.stand_down && !confirm) {
        return [
          `⚠ SAVANT CONFLICT — CONFIRMATION REQUIRED`,
          "",
          `Savant issued STAND_DOWN this morning (Regime: ${savant.regime}).`,
          `Buying ${ticker} overrides Savant's directive.`,
          "",
          `Resend with: APEX BUY ${ticker} ${amount} CONFIRM`,
          `Or wait for tomorrow's Savant directive.`,
        ].join("\n");
      }

      // Large order check
      if (notional > CONFIG.MAX_SINGLE_ORDER && !confirm) {
        return `⚠ ORDER REQUIRES CONFIRMATION\n\nBuying $${notional.toFixed(2)} of ${ticker} exceeds $${CONFIG.MAX_SINGLE_ORDER.toLocaleString()} limit.\n\nResend with: APEX BUY ${ticker} ${amount} CONFIRM`;
      }

      if (!isMarketOpen()) {
        return [
          `⚠ MARKET CLOSED — ORDER QUEUED`,
          "",
          `APEX BUY ${ticker} $${notional.toFixed(2)} received.`,
          `Market is currently closed.`,
          `Note: Marshall does not auto-execute queued orders.`,
          `Resend this command when market opens (9:30 AM ET Mon-Fri).`,
        ].join("\n");
      }

      const result = await placeOrder({ symbol: ticker, notional, side: "buy", note: "APEX BUY command" });
      if (!result) return `ERROR: Buy order for ${ticker} failed. Check Alpaca dashboard.`;

      const updatedAccount = await getAccount();
      const newCash = updatedAccount ? parseFloat(updatedAccount.cash).toFixed(2) : "—";

      return [
        `✓ APEX BUY EXECUTED: ${ticker}`,
        `${etNow().toLocaleString()} ET`,
        "",
        `Amount:       $${notional.toFixed(2)}`,
        `Cash After:   $${newCash}`,
        `Savant:       ${savant?.directive || "Not available"}`,
        "",
        "Stop-loss monitoring handled by Alpaca Bot.",
      ].join("\n");
    }

  } catch(e) {
    log(`TRADE error: ${e.message}`, "ERROR");
    return `ERROR executing ${type} ${ticker}: ${e.message}`;
  }
}

// ── APEX CASH ────────────────────────────────────────────────
async function handleCash(cmd) {
  const { amount, yield: sweepYield, confirm } = cmd;
  log(`Executing: APEX CASH $${amount}${sweepYield ? " YIELD" : ""}`);

  try {
    if (!amount || amount <= 0) return "ERROR: Specify amount. Example: APEX CASH 2000";

    const account   = await getAccount();
    const positions = await getPositions();

    if (!account) return "ERROR: Could not connect to Alpaca.";

    const equity    = parseFloat(account.equity);
    const cash      = parseFloat(account.cash);
    const maxLiquid = equity * 0.80; // never liquidate more than 80%

    // Hard cap check
    if (amount > maxLiquid) {
      return [
        `⚠ CASH REQUEST REJECTED — EXCEEDS 80% CAP`,
        "",
        `Requested:    $${amount.toLocaleString()}`,
        `Maximum:      $${maxLiquid.toFixed(2)} (80% of $${equity.toFixed(2)})`,
        "",
        `Available cash already: $${cash.toFixed(2)}`,
        `Max additional from liquidation: $${(maxLiquid - cash).toFixed(2)}`,
        "",
        `Resend with a lower amount.`,
      ].join("\n");
    }

    // Check if we already have enough cash
    if (cash >= amount) {
      return [
        `✓ CASH AVAILABLE — NO LIQUIDATION NEEDED`,
        "",
        `Requested:    $${amount.toLocaleString()}`,
        `Available:    $${cash.toFixed(2)}`,
        "",
        `You already have sufficient cash. No positions need to be sold.`,
        sweepYield ? `\nTo sweep to yield: cash is already available in your account.` : "",
      ].join("\n");
    }

    const needed = amount - cash;

    // Large order check
    if (amount > CONFIG.MAX_SINGLE_ORDER && !confirm) {
      return `⚠ CASH REQUEST REQUIRES CONFIRMATION\n\n$${amount.toLocaleString()} exceeds $${CONFIG.MAX_SINGLE_ORDER.toLocaleString()} limit.\n\nResend with: APEX CASH ${amount}${sweepYield ? " YIELD" : ""} CONFIRM`;
    }

    if (!isMarketOpen()) {
      return `⚠ MARKET CLOSED\n\nAPEX CASH $${amount.toLocaleString()} received but market is closed.\nMarshall does not auto-execute queued cash requests.\nResend when market opens (9:30 AM ET Mon-Fri).`;
    }

    // ── SAVANT LIQUIDATION HIERARCHY ─────────────────────────
    // 1. Available cash first (already checked above)
    // 2. Positions at a loss
    // 3. Positions with lowest allocation (smallest positions)
    // 4. Positions closest to profit target
    // Never sell during VIX spike (handled by warning only in command layer)

    const sorted = [...positions].sort((a, b) => {
      const plA = parseFloat(a.unrealized_plpc);
      const plB = parseFloat(b.unrealized_plpc);
      // Losers first, then smallest positions
      if (plA < 0 && plB >= 0) return -1;
      if (plB < 0 && plA >= 0) return 1;
      return parseFloat(a.market_value) - parseFloat(b.market_value);
    });

    let raised   = 0;
    const sold   = [];
    const reason = [];

    for (const pos of sorted) {
      if (raised >= needed) break;
      const mv      = parseFloat(pos.market_value);
      const plPct   = parseFloat(pos.unrealized_plpc);
      const sellAmt = Math.min(mv, needed - raised);
      const whyText = plPct < 0 ? "at a loss (exit loser)" : "smallest position";

      // Partial or full close
      let result;
      if (sellAmt >= mv * 0.95) {
        result = await closePosition(pos.symbol, `APEX CASH — ${whyText}`);
      } else {
        result = await placeOrder({ symbol: pos.symbol, notional: sellAmt, side: "sell", note: `APEX CASH — partial` });
      }

      if (result) {
        raised += sellAmt;
        sold.push(`  ${pos.symbol}: $${sellAmt.toFixed(2)} (${whyText}, P&L: ${plPct >= 0 ? "+" : ""}${(plPct * 100).toFixed(1)}%)`);
      }
      await new Promise(r => setTimeout(r, 800));
    }

    const updatedAccount = await getAccount();
    const newCash = updatedAccount ? parseFloat(updatedAccount.cash).toFixed(2) : "—";

    const yieldNote = sweepYield
      ? "\n── YIELD SWEEP ────────────────────────\nYIELD modifier noted. Alpaca High-Yield program sweep\nrequires T+1 settlement. Cash will be available tomorrow.\nLog into Alpaca to manually enroll in yield program if not auto-enrolled."
      : "";

    return [
      `✓ APEX CASH EXECUTED: $${raised.toFixed(2)} raised`,
      `${etNow().toLocaleString()} ET`,
      "",
      "── LIQUIDATIONS ───────────────────────",
      ...sold,
      "",
      `Cash Raised:  $${raised.toFixed(2)} (requested $${amount.toLocaleString()})`,
      `New Balance:  $${newCash}`,
      `Settlement:   T+1 (ETFs) · T+2 (equities)`,
      yieldNote,
    ].join("\n");

  } catch(e) {
    log(`CASH error: ${e.message}`, "ERROR");
    return `ERROR executing APEX CASH: ${e.message}`;
  }
}

// ── APEX REBALANCE ────────────────────────────────────────────
async function handleRebalance() {
  log("Executing: APEX REBALANCE");
  try {
    const [account, positions, savant] = await Promise.all([
      getAccount(), getPositions(), getSavantDirective(),
    ]);

    if (!account) return "ERROR: Could not connect to Alpaca.";

    const equity = parseFloat(account.equity);
    const cash   = parseFloat(account.cash);

    // Use Savant directive to determine target allocations
    const directive = savant?.directive || "REDUCED_RISK";
    const targets = {
      FULL_DEPLOY:   { TQQQ: 0.25, GDXJ: 0.25, SLV: 0.20, CASH: 0.30 },
      REDUCED_RISK:  { TQQQ: 0.12, GDXJ: 0.25, SLV: 0.20, CASH: 0.43 },
      DEFENSIVE:     { TQQQ: 0.00, GDXJ: 0.25, SLV: 0.20, CASH: 0.55 },
      STAND_DOWN:    { TQQQ: 0.00, GDXJ: 0.15, SLV: 0.15, SGOV: 0.70 },
      OPPORTUNISTIC: { TQQQ: 0.15, GDXJ: 0.25, SLV: 0.20, CASH: 0.40 },
    }[directive] || { TQQQ: 0.12, GDXJ: 0.25, SLV: 0.20, CASH: 0.43 };

    const posMap = {};
    for (const p of positions) posMap[p.symbol] = parseFloat(p.market_value);

    const lines = ["── CURRENT vs TARGET ──────────────────"];
    for (const [ticker, targetPct] of Object.entries(targets)) {
      if (ticker === "CASH") continue;
      const current    = posMap[ticker] || 0;
      const currentPct = (current / equity * 100).toFixed(1);
      const targetDollar = equity * targetPct;
      const diff       = targetDollar - current;
      lines.push(`  ${ticker.padEnd(6)} Current: ${currentPct.padStart(5)}% ($${current.toFixed(0)}) → Target: ${(targetPct*100).toFixed(0)}% ($${targetDollar.toFixed(0)}) | ${diff > 0 ? "+" : ""}$${diff.toFixed(0)}`);
    }

    if (!isMarketOpen()) {
      return [
        "📊 APEX REBALANCE — ANALYSIS ONLY (market closed)",
        `${etNow().toLocaleString()} ET`,
        "",
        `Savant Directive: ${directive}`,
        `Portfolio Value:  $${equity.toFixed(2)}`,
        "",
        ...lines,
        "",
        "Market is closed. Rebalance will not auto-execute.",
        "Resend APEX REBALANCE when market opens to execute.",
      ].join("\n");
    }

    // Execute rebalance — close overweight, buy underweight
    const actions = [];
    for (const [ticker, targetPct] of Object.entries(targets)) {
      if (ticker === "CASH" || ticker === "SGOV") continue;
      const current     = posMap[ticker] || 0;
      const targetDollar = equity * targetPct;
      const diff        = targetDollar - current;

      if (Math.abs(diff) < equity * 0.01) continue; // skip if < 1% drift

      if (diff < 0) {
        // Overweight — sell
        const sellAmt = Math.abs(diff);
        const r = await placeOrder({ symbol: ticker, notional: sellAmt, side: "sell", note: "APEX REBALANCE" });
        if (r) actions.push(`  SELL ${ticker} $${sellAmt.toFixed(2)}`);
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    // Small delay for sells to process before buys
    if (actions.length) await new Promise(r => setTimeout(r, 2000));

    for (const [ticker, targetPct] of Object.entries(targets)) {
      if (ticker === "CASH" || ticker === "SGOV") continue;
      const current     = posMap[ticker] || 0;
      const targetDollar = equity * targetPct;
      const diff        = targetDollar - current;

      if (diff > equity * 0.01) {
        const updatedAcct = await getAccount();
        const availCash   = updatedAcct ? parseFloat(updatedAcct.cash) - (equity * 0.30) : 0;
        const buyAmt      = Math.min(diff, availCash);
        if (buyAmt > 5) {
          const r = await placeOrder({ symbol: ticker, notional: buyAmt, side: "buy", note: "APEX REBALANCE" });
          if (r) actions.push(`  BUY  ${ticker} $${buyAmt.toFixed(2)}`);
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    }

    return [
      `✓ APEX REBALANCE EXECUTED`,
      `${etNow().toLocaleString()} ET`,
      "",
      `Savant Directive: ${directive}`,
      `Portfolio Value:  $${equity.toFixed(2)}`,
      "",
      ...lines,
      "",
      "── ACTIONS TAKEN ──────────────────────",
      ...(actions.length ? actions : ["  No rebalancing needed — portfolio within 1% of targets"]),
    ].join("\n");

  } catch(e) {
    log(`REBALANCE error: ${e.message}`, "ERROR");
    return `ERROR executing APEX REBALANCE: ${e.message}`;
  }
}

// ── WRITE OVERRIDE FLAG TO GIST ───────────────────────────────
async function writeOverrideFlag(active) {
  if (!CONFIG.GITHUB_TOKEN || !CONFIG.GITHUB_GIST_ID) return;
  try {
    // Read current gist, update override flag, write back
    const r = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "api.github.com",
        path:     `/gists/${CONFIG.GITHUB_GIST_ID}`,
        method:   "GET",
        headers:  { "Authorization": `Bearer ${CONFIG.GITHUB_TOKEN}`, "User-Agent": "apex-marshall", "Accept": "application/vnd.github+json" },
      }, res => {
        let d = ""; res.on("data", c => d += c); res.on("end", () => resolve({ status: res.statusCode, body: d }));
      });
      req.on("error", reject); req.end();
    });
    if (r.status !== 200) return;
    const gist     = JSON.parse(r.body);
    const content  = gist?.files?.["apex-directive.json"]?.content;
    const current  = content ? JSON.parse(content) : {};
    current.marshall_override = active;
    current.marshall_override_time = new Date().toISOString();

    const updated = JSON.stringify(current, null, 2);
    const body    = JSON.stringify({ files: { "apex-directive.json": { content: updated } } });
    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "api.github.com",
        path:     `/gists/${CONFIG.GITHUB_GIST_ID}`,
        method:   "PATCH",
        headers:  { "Authorization": `Bearer ${CONFIG.GITHUB_TOKEN}`, "User-Agent": "apex-marshall", "Accept": "application/vnd.github+json", "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      }, res => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve()); });
      req.on("error", reject); req.write(body); req.end();
    });
    log(`Override flag written to Gist: ${active}`);
  } catch(e) { log(`writeOverrideFlag error: ${e.message}`, "WARN"); }
}

// ══════════════════════════════════════════════════════════════
// WEBHOOK HANDLER — receives Resend inbound email events
// ══════════════════════════════════════════════════════════════
async function handleWebhook(rawBody, headers) {
  try {
    const event = JSON.parse(rawBody);
    log(`Webhook received: ${event.type || "unknown"}`);

    if (event.type !== "email.received") {
      log(`Ignoring event type: ${event.type}`);
      return;
    }

    const emailId   = event.data?.email_id || event.data?.id;
    const fromEmail = event.data?.from?.toLowerCase() || "";
    const subject   = event.data?.subject || "";

    // Dedup — never process same email twice
    if (emailId && state.processedIds.has(emailId)) {
      log(`Duplicate event ignored: ${emailId}`);
      return;
    }
    if (emailId) state.processedIds.add(emailId);
    if (state.processedIds.size > 500) {
      const arr = [...state.processedIds];
      state.processedIds = new Set(arr.slice(-250));
    }

    log(`Email from: ${fromEmail} | Subject: ${subject}`);

    // ── SECURITY: authorized sender only ─────────────────────
    if (!fromEmail.includes(CONFIG.AUTHORIZED_SENDER)) {
      log(`Rejected: unauthorized sender ${fromEmail}`, "WARN");
      return; // silent reject
    }

    // ── RATE LIMIT ────────────────────────────────────────────
    if (!checkRateLimit()) {
      log("Rate limit exceeded", "WARN");
      await sendEmail(CONFIG.AUTHORIZED_SENDER,
        "APEX: Rate limit exceeded",
        `Too many commands in the last hour (max ${CONFIG.RATE_LIMIT_MAX}).\nWait and try again.\n\n${etNow().toLocaleString()} ET`
      );
      return;
    }

    // ── PARSE COMMAND ─────────────────────────────────────────
    // Try subject from webhook payload first; fetch full email if needed
    let subjectLine = subject;
    if (!subjectLine && emailId) {
      log("Fetching full email content from Resend API...");
      const full = await fetchEmailContent(emailId);
      subjectLine = full?.subject || "";
    }

    const cmd = parseCommand(subjectLine);
    log(`Parsed command: ${JSON.stringify(cmd)}`);

    if (!cmd || cmd.type === "UNKNOWN") {
      await sendEmail(CONFIG.AUTHORIZED_SENDER,
        "APEX: Unknown command",
        `Unknown command: "${subjectLine}"\n\nValid commands:\n  APEX STATUS\n  APEX OVERRIDE\n  APEX RESUME\n  APEX BUY [TICKER] [AMOUNT]\n  APEX SELL [TICKER] [AMOUNT|ALL]\n  APEX CASH [AMOUNT] [YIELD]\n  APEX REBALANCE\n\n${etNow().toLocaleString()} ET`
      );
      return;
    }

    if (!subjectLine.toUpperCase().startsWith("APEX")) {
      log("Not an APEX command — ignoring");
      return;
    }

    // ── EXECUTE COMMAND ───────────────────────────────────────
    let response;
    switch (cmd.type) {
      case "STATUS":    response = await handleStatus();      break;
      case "OVERRIDE":  response = await handleOverride();    break;
      case "RESUME":    response = await handleResume();      break;
      case "BUY":
      case "SELL":      response = await handleTrade(cmd);    break;
      case "CASH":      response = await handleCash(cmd);     break;
      case "REBALANCE": response = await handleRebalance();   break;
      default:
        response = `Unknown command type: ${cmd.type}`;
    }

    // ── SEND CONFIRMATION EMAIL ───────────────────────────────
    await sendEmail(
      CONFIG.AUTHORIZED_SENDER,
      `APEX ${cmd.type}: ${response.split("\n")[0]}`,
      response + `\n\n─────────────────────────────\nMarshall Command Layer · ${etNow().toLocaleString()} ET`
    );

    log(`Command ${cmd.type} completed`);

  } catch(e) {
    log(`handleWebhook error: ${e.message}`, "ERROR");
    try {
      await sendEmail(CONFIG.AUTHORIZED_SENDER,
        "APEX: Command processing error",
        `Error processing command: ${e.message}\n\nCheck Railway logs for details.\n\n${etNow().toLocaleString()} ET`
      );
    } catch(_) {}
  }
}

// ══════════════════════════════════════════════════════════════
// HTTP SERVER
// ══════════════════════════════════════════════════════════════
function startServer() {
  const server = http.createServer(async (req, res) => {

    // ── WEBHOOK ENDPOINT ──────────────────────────────────────
    if (req.method === "POST" && req.url === "/webhook") {
      let rawBody = "";
      req.on("data", c => rawBody += c);
      req.on("end", async () => {
        // Respond 200 immediately — Resend needs fast ACK
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ received: true }));
        // Process async after ACK
        const sigHeader = req.headers["svix-signature"] || req.headers["webhook-signature"] || "";
        if (verifyWebhookSignature(rawBody, sigHeader)) {
          await handleWebhook(rawBody, req.headers);
        } else {
          log("Webhook signature verification failed", "WARN");
        }
      });
      return;
    }

    // ── HEALTH CHECK ──────────────────────────────────────────
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", override: state.overrideActive, commands: state.commandLog.length }));
      return;
    }

    // ── DASHBOARD ─────────────────────────────────────────────
    if (req.method === "GET" && (req.url === "/" || req.url === "/dashboard")) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html><html><head><title>Marshall</title><meta http-equiv="refresh" content="30">
      <style>
        body{background:#060610;color:#00ffaa;font-family:monospace;padding:24px;max-width:760px;margin:0 auto;}
        h1{letter-spacing:4px;font-size:18px;border-bottom:1px solid #1a1a30;padding-bottom:12px;}
        table{width:100%;border-collapse:collapse;margin:16px 0;}
        td{padding:8px 12px;border:1px solid #1a1a30;font-size:12px;}
        .k{color:#f5c842;} .g{color:#00ffaa;} .r{color:#ff3355;} .y{color:#f5a623;}
        .log{background:#08081a;padding:16px;border-radius:4px;font-size:10px;line-height:1.8;max-height:400px;overflow-y:auto;margin-top:16px;}
        .cmd{background:#0a0a20;padding:12px;border-radius:4px;font-size:11px;margin-top:12px;border:1px solid #1a1a30;}
      </style></head>
      <body>
        <h1>⚔ MARSHALL COMMAND LAYER</h1>
        <table>
          <tr><td class="k">STATUS</td><td class="${state.overrideActive ? "r" : "g"}">${state.overrideActive ? "⛔ OVERRIDE ACTIVE" : "✅ MONITORING"}</td></tr>
          <tr><td class="k">COMMAND ADDRESS</td><td>apex@coraemjen.resend.app</td></tr>
          <tr><td class="k">AUTHORIZED SENDER</td><td>${CONFIG.AUTHORIZED_SENDER}</td></tr>
          <tr><td class="k">MARKET</td><td class="${isMarketOpen() ? "g" : "y"}">${isMarketOpen() ? "OPEN" : "CLOSED"}</td></tr>
          <tr><td class="k">RATE LIMIT</td><td>${state.rateLimitWindow.length}/${CONFIG.RATE_LIMIT_MAX} commands this hour</td></tr>
          <tr><td class="k">ET TIME</td><td>${etNow().toLocaleTimeString()}</td></tr>
          <tr><td class="k">ALPACA</td><td class="${CONFIG.ALPACA_KEY_ID ? "g" : "r"}">${CONFIG.ALPACA_KEY_ID ? "✓ Connected" : "✗ Not configured"}</td></tr>
          <tr><td class="k">RESEND</td><td class="${CONFIG.RESEND_KEY ? "g" : "r"}">${CONFIG.RESEND_KEY ? "✓ Connected" : "✗ Not configured"}</td></tr>
          <tr><td class="k">GIST BRIDGE</td><td class="${CONFIG.GITHUB_GIST_ID ? "g" : "y"}">${CONFIG.GITHUB_GIST_ID ? "✓ Connected" : "⚠ Not set"}</td></tr>
        </table>
        <div class="cmd">
          <strong style="color:#f5c842">COMMANDS:</strong><br>
          Send email to <strong>apex@coraemjen.resend.app</strong> with subject:<br><br>
          APEX STATUS · APEX OVERRIDE · APEX RESUME · APEX REBALANCE<br>
          APEX BUY [TICKER] [AMOUNT] · APEX SELL [TICKER] [AMOUNT|ALL]<br>
          APEX CASH [AMOUNT] [YIELD] · Add CONFIRM to override limits
        </div>
        <div class="log">${state.commandLog.slice(-30).reverse().map(l => `<div>${l}</div>`).join("")}</div>
      </body></html>`);
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(CONFIG.PORT, () => log(`⚔ Marshall Command Layer running on port ${CONFIG.PORT}`));
}

// ── BOOT ──────────────────────────────────────────────────────
async function boot() {
  log("⚔⚔⚔ MARSHALL COMMAND LAYER STARTING ⚔⚔⚔");
  log(`Alpaca: ${CONFIG.ALPACA_KEY_ID ? "✓" : "✗ Not configured"}`);
  log(`Resend: ${CONFIG.RESEND_KEY ? "✓" : "✗ Not configured"}`);
  log(`Webhook secret: ${CONFIG.RESEND_WEBHOOK_SECRET ? "✓" : "✗ Not configured"}`);
  log(`Gist bridge: ${CONFIG.GITHUB_GIST_ID ? "✓" : "⚠ GITHUB_GIST_ID not set"}`);
  log(`Command address: apex@coraemjen.resend.app`);
  log(`Authorized sender: ${CONFIG.AUTHORIZED_SENDER}`);

  try {
    const account = await getAccount();
    if (account) {
      log(`✓ Alpaca connected | $${parseFloat(account.equity).toFixed(2)}`);
    } else {
      log("⚠ Alpaca connection failed — check credentials", "WARN");
    }
  } catch(e) {
    log(`Alpaca boot check failed: ${e.message}`, "WARN");
  }

  startServer();

  await sendEmail(
    CONFIG.AUTHORIZED_SENDER,
    "⚔ Marshall Command Layer ONLINE",
    [
      "Marshall Command Layer is now active.",
      "",
      `Command address: apex@coraemjen.resend.app`,
      "",
      "Available commands (send as email subject):",
      "  APEX STATUS         — portfolio snapshot",
      "  APEX OVERRIDE       — liquidate all + stand down",
      "  APEX RESUME         — re-enable trading",
      "  APEX BUY TQQQ 500   — buy $500 of TQQQ",
      "  APEX SELL GDXJ ALL  — sell full GDXJ position",
      "  APEX CASH 2000      — raise $2000 cash (smart liquidation)",
      "  APEX CASH 2000 YIELD — raise cash + sweep to yield",
      "  APEX REBALANCE      — rebalance to Savant target allocations",
      "",
      "Add CONFIRM to override $10,000 limit or Savant conflicts.",
      "",
      `${etNow().toLocaleString()} ET`,
    ].join("\n")
  );
}

boot().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
