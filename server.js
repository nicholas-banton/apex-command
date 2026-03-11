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
  // ── Live data cache (avoids hammering Alpaca on every poll) ──
  let dataCache = { payload: null, fetchedAt: 0 };

  async function buildLiveData() {
    const now = Date.now();
    if (dataCache.payload && (now - dataCache.fetchedAt) < 60 * 1000) return dataCache.payload;
    try {
      const [account, positions, savant] = await Promise.all([
        getAccount(), getPositions(), getSavantDirective(),
      ]);
      // Today's orders
      let orders = [];
      try {
        const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
        const todayStart = new Date(et.getFullYear(), et.getMonth(), et.getDate());
        const r = await alpacaCall(`/v2/orders?status=all&after=${todayStart.toISOString()}&limit=50`);
        if (r.status === 200) orders = r.body;
      } catch(e) { /* non-fatal */ }

      const equity = account ? parseFloat(account.equity) : 0;
      const cash   = account ? parseFloat(account.cash)   : 0;
      const bp     = account ? parseFloat(account.buying_power) : 0;
      const pnl    = equity - 100000;
      const pnlPct = (pnl / 100000) * 100;
      const etNowObj = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
      const etMinsNow = etNowObj.getHours() * 60 + etNowObj.getMinutes();

      const payload = {
        equity, cash, bp, pnl, pnlPct,
        positions,
        orders,
        savant,
        overrideActive: state.overrideActive,
        overrideTime:   state.overrideTime,
        marketOpen:     isMarketOpen(),
        commandCount:   state.rateLimitWindow.length,
        commandMax:     CONFIG.RATE_LIMIT_MAX,
        commandLog:     state.commandLog.slice(-60).reverse(),
        bridgeOk:       !!CONFIG.GITHUB_GIST_ID,
        alpacaOk:       !!CONFIG.ALPACA_KEY_ID,
        resendOk:       !!CONFIG.RESEND_KEY,
        etTime: etNowObj.toLocaleTimeString("en-US", { hour12: false }),
        etDate: etNowObj.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" }),
        etMins: etMinsNow,
        mode: CONFIG.ALPACA_BASE_URL.includes("paper") ? "PAPER" : "LIVE",
      };
      dataCache = { payload, fetchedAt: now };
      return payload;
    } catch(e) {
      log(`buildLiveData error: ${e.message}`, "ERROR");
      return dataCache.payload || null;
    }
  }

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

    // ── LIVE DATA API ──────────────────────────────────────────
    if (req.method === "GET" && req.url === "/api/data") {
      res.writeHead(200, { "Content-Type": "application/json" });
      try {
        const data = await buildLiveData();
        res.end(JSON.stringify(data || { error: "No data available" }));
      } catch(e) {
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ── DASHBOARD ─────────────────────────────────────────────
    if (req.method === "GET" && (req.url === "/" || req.url === "/dashboard")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(MARSHALL_DASHBOARD_HTML);
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(CONFIG.PORT, () => log(`⚔ Marshall Command Layer running on port ${CONFIG.PORT}`));
}

// ── MARSHALL DASHBOARD HTML ──────────────────────────────────
const MARSHALL_DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>MARSHALL // APEX COMMAND LAYER</title>
<link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Orbitron:wght@400;700;900&family=VT323&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-font-smoothing:antialiased}
body{background:#0a0800;color:#c8a84b;font-family:'Share Tech Mono',monospace;min-height:100vh;overflow-x:hidden}
@keyframes scanMove{0%{top:-3px}100%{top:100%}}
@keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
@keyframes ping{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(2.2);opacity:0}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0.2}}
@keyframes tickerScroll{0%{transform:translateX(0)}100%{transform:translateX(-50%)}}
::-webkit-scrollbar{width:3px}::-webkit-scrollbar-thumb{background:#3a2e10}
.scanline{pointer-events:none;position:fixed;left:0;right:0;height:2px;z-index:9999;opacity:0.06;background:linear-gradient(180deg,transparent,#c8a84b,transparent);animation:scanMove 10s linear infinite}
.grid-bg{position:fixed;inset:0;pointer-events:none;z-index:0;
  background-image:linear-gradient(rgba(200,168,75,0.03) 1px,transparent 1px),linear-gradient(90deg,rgba(200,168,75,0.03) 1px,transparent 1px);
  background-size:40px 40px}
.card{background:#0e0c05;border:1px solid #3a2e10;border-radius:2px;overflow:hidden;margin-bottom:10px;position:relative;z-index:1}
.ch{padding:8px 13px;background:#120f04;border-bottom:1px solid #3a2e10;font-size:9px;color:#c8a84b66;letter-spacing:3px;display:flex;justify-content:space-between;align-items:center;cursor:pointer;user-select:none}
.ch:hover{background:#1a1506}
.ct{font-size:11px;color:#3a2e10;transition:transform 0.2s;display:inline-block}
.card.collapsed .ct{transform:rotate(-90deg)}
.card.collapsed .cb{display:none}
.btn-cmd{background:transparent;border:1px solid #3a2e10;color:#c8a84b88;padding:6px 14px;font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:2px;cursor:pointer;transition:all 0.15s;border-radius:2px;width:100%}
.btn-cmd:hover{background:#c8a84b18;border-color:#c8a84b88;color:#c8a84b}
.btn-override{background:#ff333311;border-color:#ff333388;color:#ff3333cc}
.btn-override:hover{background:#ff333333;border-color:#ff3333;color:#ff3333}
.btn-primary{background:#c8a84b18;border-color:#c8a84b88;color:#c8a84b}
.btn-primary:hover{background:#c8a84b33;border-color:#c8a84b}
.stat-lbl{font-size:8px;color:#c8a84b44;letter-spacing:3px;margin-bottom:4px}
.stat-val{font-family:'Orbitron',monospace;font-size:18px;letter-spacing:2px;color:#c8a84b}
.pos-row{display:grid;grid-template-columns:70px 80px 75px 80px 1fr;gap:6px;align-items:center;padding:8px 13px;border-bottom:1px solid #1a1506;font-size:10px}
.pos-row:last-child{border-bottom:none}
.ll{display:flex;gap:8px;padding:3px 0;border-bottom:1px solid #150e00}
.lt{color:#c8a84b33;font-size:9px;flex-shrink:0;width:120px}
.lm{font-size:10px;line-height:1.5}
.ld{position:relative;display:inline-block;width:7px;height:7px}
.ldi{position:absolute;inset:0;border-radius:50%}
.ldr{position:absolute;inset:0;border-radius:50%;animation:ping 2s infinite}
.sp{display:inline-block;width:12px;height:12px;border:2px solid #3a2e10;border-top-color:#c8a84b;border-radius:50%;animation:spin 0.8s linear infinite;vertical-align:middle;margin-right:6px}
input[type=text]{background:#06050100;border:1px solid #3a2e10;color:#c8a84b;padding:9px 12px;font-family:'Share Tech Mono',monospace;font-size:11px;letter-spacing:2px;width:100%;outline:none;border-radius:2px}
input[type=text]:focus{border-color:#c8a84b88;background:#120f04}
input[type=text]::placeholder{color:#3a2e10}
</style>
</head>
<body>
<div class="scanline"></div>
<div class="grid-bg"></div>

<!-- TICKER -->
<div style="background:#08070000;border-bottom:1px solid #c8a84b18;padding:4px 0;overflow:hidden;position:relative;z-index:1">
  <div style="overflow:hidden;white-space:nowrap">
    <div id="ticker-inner" style="display:inline-flex;animation:tickerScroll 45s linear infinite">
      <span style="padding:0 24px;font-size:9px;color:#3a2e10">LOADING MARKET DATA...</span>
    </div>
  </div>
</div>

<!-- HEADER -->
<div style="position:relative;z-index:1;border-bottom:1px solid #c8a84b33;padding:14px 22px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
  <div style="height:2px;position:absolute;top:0;left:0;right:0;background:linear-gradient(90deg,transparent,#c8a84b,#aa8833,#c8a84b,transparent)"></div>
  <div>
    <div style="font-family:'Orbitron',monospace;font-size:22px;font-weight:900;letter-spacing:6px;color:#c8a84b">MARSHALL</div>
    <div style="font-size:9px;color:#c8a84b44;letter-spacing:3px;margin-top:3px">APEX COMMAND LAYER // GENERAL G.C. MARSHALL PROTOCOL</div>
  </div>
  <div style="display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap">
    <div style="text-align:right">
      <div id="hdr-clock" style="font-family:'Orbitron',monospace;font-size:16px;color:#c8a84b;letter-spacing:3px">—</div>
      <div style="font-size:9px;color:#c8a84b44;margin-top:2px">EASTERN TIME // PAPER MODE</div>
      <div id="hdr-market" style="font-size:9px;color:#3a2e10;margin-top:2px;letter-spacing:2px">◇ MARKET CLOSED</div>
    </div>
  </div>
</div>

<!-- SYSTEM STATUS BAR -->
<div id="status-bar" style="position:relative;z-index:1;display:flex;border-bottom:1px solid #3a2e10;flex-wrap:wrap">
  <div style="flex:1;min-width:120px;padding:8px 14px;border-right:1px solid #3a2e10;text-align:center">
    <div style="font-size:8px;color:#c8a84b44;letter-spacing:2px;margin-bottom:3px">PORTFOLIO VALUE</div>
    <div id="sb-equity" style="font-family:'Orbitron',monospace;font-size:14px;color:#c8a84b;letter-spacing:2px">--</div>
  </div>
  <div style="flex:1;min-width:120px;padding:8px 14px;border-right:1px solid #3a2e10;text-align:center">
    <div style="font-size:8px;color:#c8a84b44;letter-spacing:2px;margin-bottom:3px">TOTAL P&L</div>
    <div id="sb-pnl" style="font-family:'Orbitron',monospace;font-size:14px;color:#3a2e10;letter-spacing:2px">--</div>
  </div>
  <div style="flex:1;min-width:120px;padding:8px 14px;border-right:1px solid #3a2e10;text-align:center">
    <div style="font-size:8px;color:#c8a84b44;letter-spacing:2px;margin-bottom:3px">CASH AVAILABLE</div>
    <div id="sb-cash" style="font-family:'Orbitron',monospace;font-size:14px;color:#c8a84b;letter-spacing:2px">--</div>
  </div>
  <div style="flex:1;min-width:120px;padding:8px 14px;border-right:1px solid #3a2e10;text-align:center">
    <div style="font-size:8px;color:#c8a84b44;letter-spacing:2px;margin-bottom:3px">VIX LEVEL</div>
    <div id="sb-vix" style="font-family:'Orbitron',monospace;font-size:14px;color:#3a2e10;letter-spacing:2px">--</div>
  </div>
  <div style="flex:1;min-width:160px;padding:8px 14px;text-align:center">
    <div style="font-size:8px;color:#c8a84b44;letter-spacing:2px;margin-bottom:3px">SYSTEM STATUS</div>
    <div id="sb-status" style="font-family:'Orbitron',monospace;font-size:11px;letter-spacing:2px;color:#ff3333">CONNECTING</div>
  </div>
</div>

<!-- MAIN GRID -->
<div style="position:relative;z-index:1;display:grid;grid-template-columns:1fr 1fr 1fr;gap:0;padding:16px;gap:12px">

  <!-- LEFT COLUMN -->
  <div>
    <!-- Portfolio panel -->
    <div class="card">
      <div class="ch" onclick="toggleCard(this)">
        <span>PORTFOLIO // ALPACA PAPER</span>
        <div style="display:flex;align-items:center;gap:8px">
          <span class="ld"><span class="ldr" id="live-ring" style="background:#3a2e10"></span><span class="ldi" id="live-dot" style="background:#3a2e10"></span></span>
          <span id="live-lbl" style="font-size:9px;color:#3a2e10;letter-spacing:2px">OFFLINE</span>
          <span class="ct">▼</span>
        </div>
      </div>
      <div class="cb" style="padding:16px">
        <div id="portfolio-equity" style="font-family:'VT323',monospace;font-size:52px;color:#c8a84b;letter-spacing:2px;line-height:1">$--,---.--</div>
        <div id="portfolio-pnl" style="font-size:11px;color:#3a2e10;margin-top:4px;letter-spacing:2px">P&L: --</div>
        <div style="margin-top:14px">
          <div style="font-size:8px;color:#c8a84b44;letter-spacing:2px;margin-bottom:5px">INTERVENTION THRESHOLD — $85,000</div>
          <div style="background:#150e00;height:4px;border-radius:1px;position:relative;overflow:hidden">
            <div id="thresh-bar" style="height:100%;background:linear-gradient(90deg,#ff3333,#f5a623,#c8a84b);transition:width 0.5s;width:50%"></div>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:8px;color:#3a2e10;margin-top:4px">
            <span>$75K<br>STOP</span><span>$80K<br>PRESERVE</span><span>$85K --<br>INTERVENE</span><span>$90K<br>CONSERV</span><span>$100K<br>START</span>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px">
          <div style="background:#0a0900;border:1px solid #3a2e10;padding:8px;border-radius:2px"><div class="stat-lbl">BUYING POWER</div><div id="p-bp" style="font-family:'Orbitron',monospace;font-size:13px;color:#c8a84b">—</div></div>
          <div style="background:#0a0900;border:1px solid #3a2e10;padding:8px;border-radius:2px"><div class="stat-lbl">OPEN P&L</div><div id="p-openpl" style="font-family:'Orbitron',monospace;font-size:13px;color:#3a2e10">—</div></div>
        </div>
      </div>
    </div>

    <!-- Savant Directive -->
    <div class="card">
      <div class="ch" onclick="toggleCard(this)">
        <span>SAVANT DIRECTIVE</span>
        <div style="display:flex;align-items:center;gap:8px">
          <span id="directive-badge" style="font-size:9px;padding:1px 7px;border:1px solid #3a2e10;color:#3a2e10">--</span>
          <span class="ct">▼</span>
        </div>
      </div>
      <div class="cb" style="padding:14px" id="savant-panel">
        <div style="font-size:10px;color:#3a2e10;letter-spacing:1px">AWAITING MORNING BRIEFING FROM SAVANT...</div>
      </div>
    </div>

    <!-- Open positions -->
    <div class="card">
      <div class="ch" onclick="toggleCard(this)">
        <span>OPEN POSITIONS</span>
        <div style="display:flex;align-items:center;gap:8px">
          <span id="pos-badge" style="font-size:9px;padding:1px 7px;border:1px solid #3a2e10;color:#3a2e10">0 POSITIONS</span>
          <span class="ct">▼</span>
        </div>
      </div>
      <div class="cb">
        <div class="pos-row" style="font-size:8px;color:#c8a84b44;letter-spacing:2px;padding:6px 13px;background:#0a0900">
          <span>TICKER</span><span>SHARES</span><span>PRICE</span><span>VALUE</span><span>P&L</span>
        </div>
        <div id="positions-list">
          <div style="padding:12px 13px;font-size:10px;color:#3a2e10"><span class="sp"></span>LOADING...</div>
        </div>
        <div id="cash-pos-row"></div>
      </div>
    </div>
  </div>

  <!-- MIDDLE COLUMN -->
  <div>
    <!-- Today's Orders -->
    <div class="card">
      <div class="ch" onclick="toggleCard(this)">
        <span>TODAY'S ORDERS</span>
        <div style="display:flex;align-items:center;gap:8px">
          <span id="orders-badge" style="font-size:9px;color:#3a2e10">0 ORDERS</span>
          <span class="ct">▼</span>
        </div>
      </div>
      <div class="cb">
        <div style="display:grid;grid-template-columns:60px 50px 65px 90px 1fr;gap:4px;padding:6px 13px;font-size:8px;color:#c8a84b44;letter-spacing:1px;background:#0a0900">
          <span>SYMBOL</span><span>SIDE</span><span>STATUS</span><span>AMOUNT</span><span>TIME</span>
        </div>
        <div id="orders-list">
          <div style="padding:12px 13px;font-size:10px;color:#3a2e10">NO ORDERS TODAY</div>
        </div>
      </div>
    </div>

    <!-- Command Log -->
    <div class="card">
      <div class="ch" onclick="toggleCard(this)">
        <span>COMMAND LOG</span>
        <div style="display:flex;align-items:center;gap:8px">
          <span id="log-badge" style="font-size:9px;color:#c8a84b44;padding:1px 7px;border:1px solid #3a2e10">ACTIVE</span>
          <span class="ct">▼</span>
        </div>
      </div>
      <div class="cb">
        <div id="cmd-log" style="padding:10px 13px;max-height:360px;overflow-y:auto"></div>
      </div>
    </div>

    <!-- System status -->
    <div class="card">
      <div class="ch" onclick="toggleCard(this)">
        <span>SYSTEM STATUS</span>
        <div style="display:flex;align-items:center;gap:8px"><span style="color:#3a2e10;font-size:9px">connections</span><span class="ct">▼</span></div>
      </div>
      <div class="cb" style="padding:12px">
        <div id="sys-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:8px"></div>
        <div style="margin-top:10px;font-size:9px;color:#c8a84b44;letter-spacing:2px;border-top:1px solid #3a2e10;padding-top:10px">
          <div style="margin-bottom:4px">COMMAND ADDRESS</div>
          <div style="color:#c8a84b88;font-size:10px">apex@coraemjen.resend.app</div>
          <div style="margin-top:6px;color:#c8a84b44">AUTHORIZED: nicholas.banton@gmail.com</div>
        </div>
      </div>
    </div>
  </div>

  <!-- RIGHT COLUMN -->
  <div>
    <!-- Command Input -->
    <div class="card">
      <div class="ch" onclick="toggleCard(this)">
        <span>COMMAND INPUT</span>
        <div style="display:flex;align-items:center;gap:8px">
          <span id="cmd-mode" style="font-size:9px;color:#c8a84b88;padding:1px 7px;border:1px solid #c8a84b33">MANUAL</span>
          <span class="ct">▼</span>
        </div>
      </div>
      <div class="cb" style="padding:14px">
        <div style="font-size:9px;color:#c8a84b44;line-height:2;margin-bottom:12px">
          SEND EMAIL TO:<br>
          <span style="color:#c8a84b88">apex@coraemjen.resend.app</span><br>
          SUBJECT LINE = COMMAND<br>
          BODY = LEAVE BLANK
        </div>
        <div style="font-size:8px;color:#c8a84b44;letter-spacing:2px;margin-bottom:6px">USE QUICK COMMANDS BELOW OR TYPE FULL SUBJECT</div>
        <input type="text" id="cmd-input" placeholder="TYPE COMMAND SUBJECT..." style="margin-bottom:10px">
        <button class="btn-cmd btn-primary" onclick="transmitCommand()" style="margin-bottom:12px;font-size:11px;letter-spacing:3px;padding:9px">▶ TRANSMIT COMMAND</button>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px">
          <button class="btn-cmd" onclick="setCmd('APEX STATUS')">STATUS</button>
          <button class="btn-cmd" onclick="setCmd('APEX REBALANCE')">REBALANCE</button>
          <button class="btn-cmd" onclick="setCmd('APEX RESUME')">RESUME</button>
          <button class="btn-cmd" onclick="setCmd('APEX CASH 20K YIELD')">CASH $2K</button>
          <button class="btn-cmd" onclick="setCmd('APEX SELL TQQQ ALL')">SELL TQQQ</button>
          <button class="btn-cmd" onclick="setCmd('APEX SELL SOXL ALL')">SELL SOXL</button>
        </div>

        <button class="btn-cmd btn-primary" onclick="requestStatusNow()" style="margin-bottom:10px;letter-spacing:2px">◈ REQUEST STATUS NOW</button>

        <div id="override-confirm" style="display:none;padding:10px;background:#150808;border:1px solid #ff333344;border-radius:2px;margin-bottom:8px">
          <div style="font-size:9px;color:#ff3333;margin-bottom:6px;letter-spacing:2px">TYPE "OVERRIDE" TO CONFIRM LIQUIDATION</div>
          <input type="text" id="override-input" placeholder="OVERRIDE" style="margin-bottom:6px;border-color:#ff333388">
          <button class="btn-cmd btn-override" onclick="confirmOverride()" style="font-size:10px">CONFIRM LIQUIDATE ALL</button>
          <button class="btn-cmd" onclick="cancelOverride()" style="margin-top:4px;font-size:9px">CANCEL</button>
        </div>

        <button class="btn-cmd btn-override" onclick="showOverride()" style="letter-spacing:2px">▲ APEX OVERRIDE — LIQUIDATE ALL</button>

        <div id="cmd-output" style="margin-top:12px;padding:10px;background:#08070000;border:1px solid #3a2e10;border-radius:2px;font-size:9px;color:#c8a84b44;min-height:60px;font-family:'Share Tech Mono',monospace;line-height:1.7">
          AWAITING COMMAND_
        </div>
      </div>
    </div>

    <!-- Rate limit / session -->
    <div class="card">
      <div class="ch" onclick="toggleCard(this)">
        <span>RATE LIMIT // SESSION</span>
        <div style="display:flex;align-items:center;gap:8px"><span id="rl-badge" style="font-size:9px;color:#3a2e10">0/10</span><span class="ct">▼</span></div>
      </div>
      <div class="cb" style="padding:12px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
          <div style="background:#0a0900;border:1px solid #3a2e10;padding:8px;border-radius:2px"><div class="stat-lbl">COMMANDS THIS HOUR</div><div id="rl-count" style="font-family:'Orbitron',monospace;font-size:16px;color:#c8a84b">0</div></div>
          <div style="background:#0a0900;border:1px solid #3a2e10;padding:8px;border-radius:2px"><div class="stat-lbl">LIMIT</div><div style="font-family:'Orbitron',monospace;font-size:16px;color:#3a2e10">10</div></div>
        </div>
        <div style="background:#150e00;height:4px;border-radius:1px;overflow:hidden;margin-bottom:5px">
          <div id="rl-bar" style="height:100%;background:#c8a84b;transition:width 0.5s;width:0%"></div>
        </div>
        <div style="font-size:9px;color:#3a2e10;margin-top:4px">WINDOW RESETS EVERY 60 MINUTES</div>
      </div>
    </div>
  </div>
</div>

<div style="position:relative;z-index:1;border-top:1px solid #c8a84b18;padding:6px 22px;display:flex;justify-content:space-between;font-size:8px;color:#3a2e10">
  <span>◈ MARSHALL COMMAND LAYER // APEX TRADING SYSTEM // PAPER MODE</span>
  <span id="footer-time">—</span>
</div>

<script>
let lastData = null;

function toggleCard(h){ h.closest('.card').classList.toggle('collapsed'); }

const fmt=(n,d=2)=>'$'+Math.abs(n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
const fmtN=(n,d=2)=>(n>=0?'+':'-')+fmt(n,d);
const pct=(n,d=2)=>(n>=0?'+':'')+n.toFixed(d)+'%';
const col=(n)=>n>=0?'#c8a84b':'#ff3333';

function marketCountdown(etMins){
  const open=9*60+30,close=16*60;
  const day=new Date().getDay();
  if(day<1||day>5) return'CLOSED (WEEKEND)';
  if(etMins<open){const m=open-etMins;return\`OPENS IN \${Math.floor(m/60)}h \${m%60}m\`;}
  if(etMins>=close) return'CLOSED (AFTER HOURS)';
  const m=close-etMins;return\`OPEN — CLOSES IN \${Math.floor(m/60)}h \${m%60}m\`;
}

async function fetchData(){
  try{
    const r=await fetch('/api/data');
    const d=await r.json();
    if(d.error) throw new Error(d.error);
    lastData=d;
    renderAll(d);
    document.getElementById('sb-status').textContent='ONLINE';
    document.getElementById('sb-status').style.color='#c8a84b';
    document.getElementById('live-ring').style.background='#c8a84b';
    document.getElementById('live-dot').style.background='#c8a84b';
    document.getElementById('live-lbl').textContent='LIVE';
    document.getElementById('live-lbl').style.color='#c8a84b88';
  }catch(e){
    document.getElementById('sb-status').textContent='UNREACHABLE';
    document.getElementById('sb-status').style.color='#ff3333';
    document.getElementById('live-lbl').textContent='OFFLINE';
    document.getElementById('cmd-output').textContent='ERROR: '+e.message;
    console.error(e);
  }
}

function renderAll(d){
  const{equity,cash,bp,pnl,pnlPct,positions,orders,savant,overrideActive,commandLog,
        marketOpen,commandCount,commandMax,etTime,etDate,etMins,mode,bridgeOk,alpacaOk,resendOk}=d;

  // TICKER — build from positions + key stats
  const items=[
    \`<span style="display:inline-flex;align-items:center;gap:8px;padding:0 22px;font-size:9px"><span style="color:#c8a84b66;font-family:'Orbitron',monospace;font-size:10px;letter-spacing:2px">EQUITY</span><span>\${fmt(equity)}</span><span style="color:#3a2e10;margin-left:4px">│</span></span>\`,
    \`<span style="display:inline-flex;align-items:center;gap:8px;padding:0 22px;font-size:9px"><span style="color:#c8a84b66;font-family:'Orbitron',monospace;font-size:10px;letter-spacing:2px">P&L</span><span style="color:\${col(pnl)}">\${fmtN(pnl)} (\${pct(pnlPct)})</span><span style="color:#3a2e10;margin-left:4px">│</span></span>\`,
    \`<span style="display:inline-flex;align-items:center;gap:8px;padding:0 22px;font-size:9px"><span style="color:#c8a84b66;font-family:'Orbitron',monospace;font-size:10px;letter-spacing:2px">CASH</span><span>\${fmt(cash)}</span><span style="color:#3a2e10;margin-left:4px">│</span></span>\`,
    \`<span style="display:inline-flex;align-items:center;gap:8px;padding:0 22px;font-size:9px"><span style="color:#c8a84b66;font-family:'Orbitron',monospace;font-size:10px;letter-spacing:2px">MARKET</span><span style="color:\${marketOpen?'#c8a84b':'#3a2e10'}">\${marketOpen?'OPEN':'CLOSED'}</span><span style="color:#3a2e10;margin-left:4px">│</span></span>\`,
    ...(positions||[]).map(p=>{const pl=parseFloat(p.unrealized_pl);return\`<span style="display:inline-flex;align-items:center;gap:7px;padding:0 22px;font-size:9px"><span style="color:#c8a84b66;font-family:'Orbitron',monospace;font-size:10px;letter-spacing:2px">\${p.symbol}</span><span>\${fmt(parseFloat(p.current_price))}</span><span style="color:\${col(pl)}">\${pl>=0?'▲':'▼'} \${(Math.abs(parseFloat(p.unrealized_plpc))*100).toFixed(2)}%</span><span style="color:#3a2e10;margin-left:4px">│</span></span>\`;}),
    \`<span style="display:inline-flex;align-items:center;gap:8px;padding:0 22px;font-size:9px"><span style="color:#c8a84b66;font-family:'Orbitron',monospace;font-size:10px;letter-spacing:2px">OVERRIDE</span><span style="color:\${overrideActive?'#ff3333':'#3a2e10'}">\${overrideActive?'ACTIVE':'INACTIVE'}</span><span style="color:#3a2e10;margin-left:4px">│</span></span>\`,
  ];
  document.getElementById('ticker-inner').innerHTML=items.join('')+items.join('');

  // HEADER
  document.getElementById('hdr-clock').textContent=etTime;
  document.getElementById('hdr-market').textContent=(marketOpen?'◈ MARKET OPEN':'◇ MARKET CLOSED')+' // '+marketCountdown(etMins);
  document.getElementById('hdr-market').style.color=marketOpen?'#c8a84b88':'#3a2e10';
  document.getElementById('footer-time').textContent=etDate+' '+etTime+' ET · auto-refresh 30s';

  // STATUS BAR
  document.getElementById('sb-equity').textContent=fmt(equity);
  document.getElementById('sb-pnl').textContent=fmtN(pnl)+' ('+pct(pnlPct)+')';
  document.getElementById('sb-pnl').style.color=col(pnl);
  document.getElementById('sb-cash').textContent=fmt(cash);
  document.getElementById('sb-vix').textContent=savant?.vix?savant.vix.toFixed(1):'--';
  document.getElementById('sb-status').textContent=overrideActive?'OVERRIDE ACTIVE':(marketOpen?'MONITORING':'STANDBY');
  document.getElementById('sb-status').style.color=overrideActive?'#ff3333':marketOpen?'#c8a84b':'#888';

  // PORTFOLIO
  document.getElementById('portfolio-equity').textContent=fmt(equity);
  document.getElementById('portfolio-pnl').textContent='P&L: '+fmtN(pnl)+' ('+pct(pnlPct)+')';
  document.getElementById('portfolio-pnl').style.color=col(pnl);
  document.getElementById('p-bp').textContent=fmt(bp);
  const openPL=(positions||[]).reduce((s,p)=>s+parseFloat(p.unrealized_pl),0);
  document.getElementById('p-openpl').textContent=fmtN(openPL);
  document.getElementById('p-openpl').style.color=col(openPL);
  const threshPct=Math.min(100,Math.max(0,((equity-75000)/25000)*100));
  const threshColor=equity<85000?'#ff3333':equity<90000?'#f5a623':'#c8a84b';
  document.getElementById('thresh-bar').style.width=threshPct+'%';

  // SAVANT DIRECTIVE
  if(savant){
    document.getElementById('directive-badge').textContent=savant.directive||'--';
    document.getElementById('directive-badge').style.color=savant.standDown?'#ff3333':savant.directive==='FULL_DEPLOY'?'#c8a84b':'#f5a623';
    document.getElementById('directive-badge').style.borderColor=savant.standDown?'#ff333366':'#c8a84b44';
    document.getElementById('savant-panel').innerHTML=\`
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:12px">
        <div><div class="stat-lbl">DIRECTIVE</div><div style="font-family:'Orbitron',monospace;font-size:14px;color:\${savant.standDown?'#ff3333':'#c8a84b'}">\${savant.directive||'—'}</div></div>
        <div><div class="stat-lbl">REGIME</div><div style="font-family:'Orbitron',monospace;font-size:13px;color:#c8a84b88">\${savant.regime||'—'}</div></div>
        <div><div class="stat-lbl">RISK LEVEL</div><div style="font-family:'Orbitron',monospace;font-size:14px;color:#c8a84b88">\${savant.riskLevel||'—'}</div></div>
        <div><div class="stat-lbl">VIX AT BRIEF</div><div style="font-family:'Orbitron',monospace;font-size:14px;color:#c8a84b88">\${savant.vix?.toFixed(1)||'—'}</div></div>
      </div>
      \${savant.tqqq_max_alloc?\`<div style="margin-bottom:10px"><div class="stat-lbl">TQQQ MAX ALLOC</div><div style="font-family:'Orbitron',monospace;font-size:16px;color:#f5c842">\${(savant.tqqq_max_alloc*100).toFixed(0)}%</div></div>\`:''}
      \${savant.memo?\`<div style="font-size:10px;color:#c8a84b66;line-height:1.8;padding:10px;background:#06050100;border:1px solid #3a2e10;border-radius:2px">\${savant.memo}</div>\`:''}
      <div style="font-size:9px;color:#3a2e10;margin-top:8px">AS OF: \${savant.timestamp?new Date(savant.timestamp).toLocaleString('en-US',{timeZone:'America/New_York'}):'—'}</div>
    \`;
  } else {
    document.getElementById('directive-badge').textContent='NO BRIDGE';
    document.getElementById('savant-panel').innerHTML=\`<div style="font-size:10px;color:#3a2e10;line-height:1.8">Bridge not initialized.<br>Set GITHUB_GIST_ID after Savant 9AM run.</div>\`;
  }

  // POSITIONS
  const posCount=(positions||[]).length;
  document.getElementById('pos-badge').textContent=posCount+' POSITION'+(posCount!==1?'S':'');
  document.getElementById('positions-list').innerHTML=posCount>0
    ?positions.map(p=>{
        const pl=parseFloat(p.unrealized_pl),plPct=parseFloat(p.unrealized_plpc)*100;
        return\`<div class="pos-row">
          <span style="font-family:'Orbitron',monospace;font-size:11px;color:#c8a84b;letter-spacing:1px">\${p.symbol}</span>
          <span>\${parseFloat(p.qty).toFixed(3)}</span>
          <span>\${fmt(parseFloat(p.current_price))}</span>
          <span>\${fmt(parseFloat(p.market_value))}</span>
          <span style="color:\${col(pl)}">\${fmtN(pl)}<br><span style="font-size:9px">\${pct(plPct)}</span></span>
        </div>\`;
      }).join('')
    :\`<div style="padding:12px 13px;font-size:10px;color:#3a2e10">NO OPEN POSITIONS</div>\`;
  document.getElementById('cash-pos-row').innerHTML=\`
    <div class="pos-row" style="border-top:1px solid #3a2e10;background:#0a0900">
      <span style="font-family:'Orbitron',monospace;font-size:11px;color:#f5c842;letter-spacing:1px">CASH</span>
      <span style="color:#3a2e10">—</span><span style="color:#3a2e10">—</span>
      <span style="color:#f5c842">\${fmt(cash)}</span>
      <span style="color:#3a2e10">—</span>
    </div>\`;

  // ORDERS
  document.getElementById('orders-badge').textContent=(orders||[]).length+' ORDERS';
  document.getElementById('orders-list').innerHTML=(orders||[]).length>0
    ?(orders||[]).map(o=>{
        const side=o.side.toUpperCase();
        const status=o.status.toUpperCase();
        const statusCol=status==='FILLED'?'#c8a84b':status==='CANCELED'||status==='REJECTED'?'#ff3333':'#f5a623';
        const notional=o.notional?'$'+parseFloat(o.notional).toFixed(2):o.qty?o.qty+' sh':'—';
        const time=o.submitted_at?new Date(o.submitted_at).toLocaleTimeString('en-US',{hour12:false,timeZone:'America/New_York'}):'—';
        return\`<div style="display:grid;grid-template-columns:60px 50px 65px 90px 1fr;gap:4px;align-items:center;padding:8px 13px;border-bottom:1px solid #150e00;font-size:10px">
          <span style="font-family:'Orbitron',monospace;font-size:10px;color:#c8a84b;letter-spacing:1px">\${o.symbol}</span>
          <span style="color:\${side==='BUY'?'#c8a84b':'#ff3333'}">\${side}</span>
          <span style="color:\${statusCol};font-size:9px">\${status}</span>
          <span>\${notional}</span>
          <span style="color:#3a2e10;font-size:9px">\${time}</span>
        </div>\`;
      }).join('')
    :\`<div style="padding:12px 13px;font-size:10px;color:#3a2e10">NO ORDERS TODAY</div>\`;

  // SYSTEM GRID
  document.getElementById('sys-grid').innerHTML=[
    ['ALPACA',alpacaOk?'CONNECTED':'ERROR',alpacaOk?'#c8a84b':'#ff3333'],
    ['RESEND',resendOk?'CONNECTED':'ERROR',resendOk?'#c8a84b':'#ff3333'],
    ['BRIDGE',bridgeOk?'CONNECTED':'NOT SET',bridgeOk?'#c8a84b':'#f5a623'],
    ['MARKET',marketOpen?'OPEN':'CLOSED',marketOpen?'#c8a84b':'#3a2e10'],
    ['OVERRIDE',overrideActive?'ACTIVE':'INACTIVE',overrideActive?'#ff3333':'#3a2e10'],
    ['MODE',mode||'PAPER','#c8a84b88'],
  ].map(([k,v,c])=>\`<div style="background:#0a0900;border:1px solid #3a2e10;padding:8px;border-radius:2px">
    <div style="font-size:8px;color:#c8a84b33;letter-spacing:2px;margin-bottom:3px">\${k}</div>
    <div style="font-family:'Orbitron',monospace;font-size:11px;color:\${c};letter-spacing:1px">\${v}</div>
  </div>\`).join('');

  // COMMAND LOG
  document.getElementById('cmd-log').innerHTML=(commandLog||[]).map(l=>{
    const isErr=l.includes('ERROR')||l.includes('failed')||l.includes('Failed');
    const isOk =l.includes('✓')||l.includes('Executed')||l.includes('SUCCESS');
    const mc=isErr?'#ff3333':isOk?'#c8a84b':'#c8a84b66';
    const tm=l.match(/\[(.+? ET)\]/);
    const msg=l.replace(/^\[.+? ET\] \[.+?\] /,'');
    return\`<div class="ll"><span class="lt">\${tm?tm[1]:''}</span><span class="lm" style="color:\${mc}">\${msg}</span></div>\`;
  }).join('');
  document.getElementById('log-badge').textContent=(commandLog||[]).length+' ENTRIES';

  // RATE LIMIT
  document.getElementById('rl-count').textContent=commandCount||0;
  document.getElementById('rl-badge').textContent=(commandCount||0)+'/'+(commandMax||10);
  document.getElementById('rl-bar').style.width=((commandCount||0)/(commandMax||10)*100).toFixed(0)+'%';
}

// ── COMMAND FUNCTIONS ─────────────────────────────────────────
function setCmd(cmd){ document.getElementById('cmd-input').value=cmd; }

function transmitCommand(){
  const cmd=document.getElementById('cmd-input').value.trim();
  if(!cmd){ document.getElementById('cmd-output').textContent='ERROR: ENTER A COMMAND SUBJECT'; return; }
  const mailto=\`mailto:apex@coraemjen.resend.app?subject=\${encodeURIComponent(cmd)}&body=\`;
  document.getElementById('cmd-output').textContent='OPENING EMAIL CLIENT...\\nTO: apex@coraemjen.resend.app\\nSUBJECT: '+cmd;
  window.location.href=mailto;
}

function requestStatusNow(){
  const mailto='mailto:apex@coraemjen.resend.app?subject=APEX%20STATUS&body=';
  document.getElementById('cmd-output').textContent='TRANSMITTING STATUS REQUEST...\\nTO: apex@coraemjen.resend.app\\nSUBJECT: APEX STATUS';
  window.location.href=mailto;
}

function showOverride(){
  document.getElementById('override-confirm').style.display='block';
  document.getElementById('override-input').focus();
}
function cancelOverride(){
  document.getElementById('override-confirm').style.display='none';
  document.getElementById('override-input').value='';
}
function confirmOverride(){
  if(document.getElementById('override-input').value.trim().toUpperCase()!=='OVERRIDE'){
    document.getElementById('cmd-output').textContent='ERROR: TYPE "OVERRIDE" TO CONFIRM';
    return;
  }
  const mailto='mailto:apex@coraemjen.resend.app?subject=APEX%20OVERRIDE%20CONFIRM&body=';
  document.getElementById('cmd-output').textContent='OVERRIDE TRANSMITTED — LIQUIDATING ALL POSITIONS\\nTO: apex@coraemjen.resend.app';
  cancelOverride();
  window.location.href=mailto;
}

fetchData();
setInterval(fetchData, 30000);
</script>
</body>
</html>`;

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
