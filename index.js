const { chromium } = require("playwright");
const express = require("express");
require("dotenv").config();

// ── Config ──
const ROOM_URL = process.env.ROOM_URL || null;
const PORT = process.env.PORT || 3000;
const LS_USER_TOKEN = process.env.LS_USER_TOKEN || null;
const LS_USER_NAME = process.env.LS_USER_NAME || null;
const LS_USER_LFP = process.env.LS_USER_LFP || null;
const LS_USER_REDIRECT = process.env.LS_USER_REDIRECT || null;
const LS_KEYPAIR = process.env.LS_KEYPAIR || null;
const LS_USER = process.env.LS_USER || null;

// Tunables
const HEALTH_CHECK_INTERVAL = 3 * 60 * 1000; // check every 3 min
const SAFE_RELOAD_INTERVAL = 18 * 60 * 1000; // full reload every 18 min as safety net
const RESTART_DELAY = 15000; // wait 15s before restart after failure
const MAX_RESTART_ATTEMPTS = 50; // give up after 50 rapid restarts (~12.5 hrs of failures)

// ── State ──
const startTime = Date.now();
let restartCount = 0;
let isShuttingDown = false;
let currentPage = null;
let currentBrowser = null;

// ── Helpers ──
function elapsed() {
  const ms = Date.now() - startTime;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${h}h ${m}m ${s}s`;
}

function checkTokenExpiry() {
  try {
    const tokenObj = JSON.parse(LS_USER_TOKEN);
    const payload = JSON.parse(
      Buffer.from(tokenObj.data.split(".")[1], "base64url").toString(),
    );
    const expiresAt = new Date(payload.exp * 1000);
    const now = new Date();
    const hoursLeft = (expiresAt - now) / 3600000;

    if (hoursLeft < 0) {
      console.error(
        `[Keeper] ❌ TOKEN EXPIRED ${Math.abs(hoursLeft).toFixed(1)}h ago! Update your tokens.`,
      );
      return "expired";
    }
    if (hoursLeft < 2) {
      console.warn(
        `[Keeper] ⚠️ Token expires in ${hoursLeft.toFixed(1)}h — refresh soon!`,
      );
      return "warning";
    }
    console.log(`[Keeper] Token healthy — expires in ${hoursLeft.toFixed(1)}h`);
    return "ok";
  } catch {
    console.log("[Keeper] Could not parse token expiry (not a JWT?)");
    return "unknown";
  }
}

// ── Express Health Endpoint ──
const app = express();
app.get("/", (req, res) => {
  const tokenStatus = checkTokenExpiry();
  res.send(`
    <h2>✅ Free4Talk Keeper Running</h2>
    <table border="1" cellpadding="8">
      <tr><td><b>Room</b></td><td><a href="${ROOM_URL}">${ROOM_URL}</a></td></tr>
      <tr><td><b>Uptime</b></td><td>${elapsed()}</td></tr>
      <tr><td><b>Started</b></td><td>${new Date(startTime).toISOString()}</td></tr>
      <tr><td><b>Restarts</b></td><td>${restartCount}</td></tr>
      <tr><td><b>Token</b></td><td style="color:${tokenStatus === "expired" ? "red" : tokenStatus === "warning" ? "orange" : "green"}">${tokenStatus}</td></tr>
    </table>
  `);
});
app.get("/status", (req, res) => {
  res.json({
    uptime: elapsed(),
    startTime: new Date(startTime).toISOString(),
    restarts: restartCount,
  });
});
app.listen(PORT, () => console.log(`[Server] Port ${PORT}`));

// ── Join Room Logic ──
async function clickJoinButton(page) {
  // Free4Talk uses "Click on anywhere to start", not a button
  try {
    const startText = await page
      .locator("text=Click on anywhere to start")
      .first();
    if (await startText.isVisible({ timeout: 5000 })) {
      await startText.click();
      console.log("[Keeper] ✅ Clicked 'Click on anywhere to start'");
      await page.waitForTimeout(5000);
      return true;
    }
  } catch {}

  // Fallback: click anywhere on page
  try {
    await page.mouse.click(400, 300);
    console.log("[Keeper] ✅ Clicked on page (anywhere)");
    await page.waitForTimeout(5000);
    return true;
  } catch {}

  // Final fallback: try button selectors
  const selectors = [
    'button:has-text("Join")',
    'button:has-text("Enter")',
    'button:has-text("Start")',
    'a:has-text("Join")',
    'input[type="submit"]',
    'button[type="submit"]',
  ];
  for (const sel of selectors) {
    try {
      const btn = await page.waitForSelector(sel, { timeout: 2000 });
      if (btn) {
        await btn.click();
        console.log(`[Keeper] ✅ Clicked: ${sel}`);
        await page.waitForTimeout(5000);
        return true;
      }
    } catch {}
  }
  return false;
}

async function injectAuth(context) {
  // 1. Inject into identity.free4talk.com
  const identityPage = await context.newPage();
  await identityPage.goto("https://identity.free4talk.com", {
    waitUntil: "domcontentloaded",
    timeout: 20000,
  });
  await identityPage.evaluate(
    ({ user, keypair }) => {
      if (user) localStorage.setItem("user", user);
      if (keypair) localStorage.setItem("key-pair", keypair);
    },
    { user: LS_USER, keypair: LS_KEYPAIR },
  );
  console.log("[Keeper] ✅ identity.free4talk.com injected");
  await identityPage.close();

  // 2. Inject into www.free4talk.com
  const wwwPage = await context.newPage();
  await wwwPage.goto("https://www.free4talk.com", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await wwwPage.evaluate(
    ({ token, name, lfp, redirect }) => {
      if (token) localStorage.setItem("user:token", token);
      if (name) localStorage.setItem("user_name", name);
      if (lfp) localStorage.setItem("user:lfp", lfp);
      if (redirect) localStorage.setItem("user:redirect", redirect);
    },
    {
      token: LS_USER_TOKEN,
      name: LS_USER_NAME,
      lfp: LS_USER_LFP,
      redirect: LS_USER_REDIRECT,
    },
  );
  console.log("[Keeper] ✅ www.free4talk.com injected");
  await wwwPage.close();
}

// ── Check if still in room ──
async function isStillInRoom(page) {
  try {
    // Check we're not on login page
    const url = page.url();
    if (url.includes("login") || url.includes("signin")) return false;

    // Check the page is alive (not blank/crashed)
    const title = await page.title();
    const bodyExists = await page.evaluate(
      () => !!document.body && document.body.children.length > 0,
    );
    if (!bodyExists || !title) return false;

    // Check for common "disconnected" or "left room" text
    const pageText = await page.evaluate(
      () => document.body?.innerText?.substring(0, 2000) || "",
    );
    const disconnectedKeywords = [
      "left the room",
      "disconnected",
      "reconnect",
      "connection lost",
      "error",
    ];
    const lowerText = pageText.toLowerCase();
    for (const kw of disconnectedKeywords) {
      if (lowerText.includes(kw)) {
        console.log(`[Keeper] ⚠️ Found disconnect keyword: "${kw}"`);
        return false;
      }
    }

    return true;
  } catch (err) {
    console.error(`[Keeper] Health check error: ${err.message}`);
    return false;
  }
}

// ── Safe cleanup ──
async function safeCleanup() {
  try {
    if (currentBrowser) {
      await currentBrowser.close().catch(() => {});
    }
  } catch {}
  currentBrowser = null;
  currentPage = null;
}

// ── Main ──
async function joinRoom() {
  if (isShuttingDown) return;
  if (restartCount >= MAX_RESTART_ATTEMPTS) {
    console.error(
      `[Keeper] ❌ Max restarts (${MAX_RESTART_ATTEMPTS}) reached. Giving up.`,
    );
    return;
  }

  restartCount++;
  console.log(`\n[Keeper] ═══════════════════════════════════`);
  console.log(`[Keeper] Start #${restartCount} | Uptime: ${elapsed()}`);
  checkTokenExpiry();
  console.log(`[Keeper] ═══════════════════════════════════\n`);

  try {
    console.log("[Keeper] Launching browser...");
    currentBrowser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-software-rasterizer",
        "--disable-features=VizDisplayCompositor",
      ],
    });

    const context = await currentBrowser.newContext({
      permissions: ["microphone"],
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });

    await injectAuth(context);

    // Navigate to room
    console.log("[Keeper] Creating room page...");
    const page = await context.newPage();
    currentPage = page;
    page.on("pageerror", (err) =>
      console.error(`[Keeper] Page error: ${err.message}`),
    );

    // Log ALL page console for debugging
    page.on("console", (msg) => {
      console.log(
        `[Keeper] 📟 [${msg.type()}] ${msg.text().substring(0, 200)}`,
      );
    });

    console.log(`[Keeper] Navigating to room: ${ROOM_URL}`);
    try {
      await page.goto(ROOM_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      console.log(`[Keeper] Page loaded, current URL: ${page.url()}`);
    } catch (navErr) {
      console.error(`[Keeper] Navigation failed: ${navErr.message}`);
      console.log(`[Keeper] Current URL after fail: ${page.url()}`);
    }

    console.log("[Keeper] Waiting 5s for page to settle...");
    await page.waitForTimeout(5000);

    // Dump all buttons BEFORE clicking
    console.log("[Keeper] === Buttons on page (before click) ===");
    const buttonsBefore = await page.evaluate(() => {
      const els = document.querySelectorAll(
        "button, a, [role='button'], input[type='submit']",
      );
      return Array.from(els).map((el) => ({
        tag: el.tagName,
        text: el.textContent?.trim()?.substring(0, 80),
        class: el.className?.toString()?.substring(0, 60),
        id: el.id || "",
        visible: el.offsetParent !== null && el.offsetHeight > 0,
      }));
    });
    console.log(
      JSON.stringify(
        buttonsBefore.filter((b) => b.visible),
        null,
        2,
      ),
    );

    // Dump page text
    const pageText = await page.evaluate(
      () => document.body?.innerText?.substring(0, 1500) || "",
    );
    console.log("[Keeper] === Page text ===");
    console.log(pageText);

    // Screenshot before click
    try {
      await page.screenshot({ path: "/tmp/before-click.png", fullPage: true });
    } catch {}
    console.log("[Keeper] Screenshot: /tmp/before-click.png");

    // Click join - the room uses "click anywhere to start", not a button
    console.log("[Keeper] Looking for join trigger...");

    let joined = false;

    // Method 1: Click the "Click on anywhere to start" text
    try {
      const startText = await page
        .locator("text=Click on anywhere to start")
        .first();
      if (await startText.isVisible({ timeout: 5000 })) {
        await startText.click();
        console.log("[Keeper] ✅ Clicked 'Click on anywhere to start'");
        joined = true;
      }
    } catch {}

    // Method 2: Click anywhere on the page body (if method 1 missed)
    if (!joined) {
      try {
        await page.mouse.click(400, 300);
        console.log("[Keeper] ✅ Clicked on page (anywhere)");
        joined = true;
      } catch {}
    }

    // Method 3: Try button-based join as fallback
    if (!joined) {
      await clickJoinButton(page);
    }

    // Wait for room to fully connect
    console.log("[Keeper] Waiting 10s for room to connect...");
    await page.waitForTimeout(10000);

    // Screenshot after click
    try {
      await page.screenshot({ path: "/tmp/after-click.png", fullPage: true });
    } catch {}
    console.log("[Keeper] Screenshot: /tmp/after-click.png");

    // Dump buttons AFTER clicking
    console.log("[Keeper] === Buttons on page (after click) ===");
    const buttonsAfter = await page.evaluate(() => {
      const els = document.querySelectorAll(
        "button, a, [role='button'], input[type='submit']",
      );
      return Array.from(els).map((el) => ({
        tag: el.tagName,
        text: el.textContent?.trim()?.substring(0, 80),
        class: el.className?.toString()?.substring(0, 60),
        id: el.id || "",
        visible: el.offsetParent !== null && el.offsetHeight > 0,
      }));
    });
    console.log(
      JSON.stringify(
        buttonsAfter.filter((b) => b.visible),
        null,
        2,
      ),
    );

    // Dump page text after
    const pageTextAfter = await page.evaluate(
      () => document.body?.innerText?.substring(0, 1500) || "",
    );
    console.log("[Keeper] === Page text (after click) ===");
    console.log(pageTextAfter);

    // Dump current URL and title
    console.log(`[Keeper] URL now: ${page.url()}`);
    console.log(`[Keeper] Title: ${await page.title()}`);

    const url = page.url();
    if (url.includes("login") || url.includes("signin")) {
      console.error("[Keeper] ❌ Redirected to login — token expired!");
      await safeCleanup();
      return;
    }
    console.log(`[Keeper] ✅ In room: ${url}`);

    // Reset restart count on successful join
    restartCount = 0;

    // ── Health check loop (every 3 min) ──
    const healthInterval = setInterval(async () => {
      if (isShuttingDown) {
        clearInterval(healthInterval);
        return;
      }

      try {
        const healthy = await isStillInRoom(page);
        if (healthy) {
          console.log(`[Keeper] 💚 Health OK | Uptime: ${elapsed()}`);
        } else {
          console.warn(`[Keeper] 💔 Unhealthy — reloading...`);
          clearInterval(healthInterval);
          clearInterval(safeInterval);
          try {
            await page.reload({
              waitUntil: "domcontentloaded",
              timeout: 60000,
            });
            await page.waitForTimeout(5000);
            await clickJoinButton(page);
            console.log(`[Keeper] ✅ Recovered via reload`);
            // Restart health checks after recovery
            startHealthChecks(page);
          } catch (reloadErr) {
            console.error(`[Keeper] ❌ Reload failed: ${reloadErr.message}`);
            await safeCleanup();
            console.log(`[Keeper] Restarting in ${RESTART_DELAY / 1000}s...`);
            setTimeout(() => joinRoom(), RESTART_DELAY);
          }
        }
      } catch (err) {
        console.error(`[Keeper] Health check crashed: ${err.message}`);
        clearInterval(healthInterval);
        clearInterval(safeInterval);
        await safeCleanup();
        setTimeout(() => joinRoom(), RESTART_DELAY);
      }
    }, HEALTH_CHECK_INTERVAL);

    // ── Safety net: full reload every 18 min ──
    const safeInterval = setInterval(async () => {
      if (isShuttingDown) {
        clearInterval(safeInterval);
        return;
      }

      try {
        console.log(
          `[Keeper] 🔄 Safety reload (every 18 min) | Uptime: ${elapsed()}`,
        );
        await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForTimeout(5000);
        await clickJoinButton(page);
        console.log(`[Keeper] ✅ Safety reload done`);
      } catch (err) {
        console.error(`[Keeper] Safety reload failed: ${err.message}`);
        clearInterval(healthInterval);
        clearInterval(safeInterval);
        await safeCleanup();
        setTimeout(() => joinRoom(), RESTART_DELAY);
      }
    }, SAFE_RELOAD_INTERVAL);

    // Store intervals so we can clear them
    page._healthInterval = healthInterval;
    page._safeInterval = safeInterval;
  } catch (err) {
    console.error(`[Keeper] ❌ Fatal error: ${err.message}`);
    await safeCleanup();
    console.log(`[Keeper] Restarting in ${RESTART_DELAY / 1000}s...`);
    setTimeout(() => joinRoom(), RESTART_DELAY);
  }
}

function startHealthChecks(page) {
  const healthInterval = setInterval(async () => {
    if (isShuttingDown) {
      clearInterval(healthInterval);
      return;
    }
    try {
      const healthy = await isStillInRoom(page);
      if (healthy) {
        console.log(`[Keeper] 💚 Health OK | Uptime: ${elapsed()}`);
      } else {
        console.warn(`[Keeper] 💔 Unhealthy — reloading...`);
        clearInterval(healthInterval);
        clearInterval(page._safeInterval);
        await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForTimeout(5000);
        await clickJoinButton(page);
        console.log(`[Keeper] ✅ Recovered`);
        startHealthChecks(page);
      }
    } catch (err) {
      console.error(`[Keeper] Health check crashed: ${err.message}`);
      clearInterval(healthInterval);
      if (page._safeInterval) clearInterval(page._safeInterval);
      await safeCleanup();
      setTimeout(() => joinRoom(), RESTART_DELAY);
    }
  }, HEALTH_CHECK_INTERVAL);

  const safeInterval = setInterval(async () => {
    if (isShuttingDown) {
      clearInterval(safeInterval);
      return;
    }
    try {
      console.log(`[Keeper] 🔄 Safety reload | Uptime: ${elapsed()}`);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(5000);
      await clickJoinButton(page);
      console.log(`[Keeper] ✅ Safety reload done`);
    } catch (err) {
      console.error(`[Keeper] Safety reload failed: ${err.message}`);
      clearInterval(healthInterval);
      clearInterval(safeInterval);
      await safeCleanup();
      setTimeout(() => joinRoom(), RESTART_DELAY);
    }
  }, SAFE_RELOAD_INTERVAL);

  page._healthInterval = healthInterval;
  page._safeInterval = safeInterval;
}

// ── Graceful shutdown ──
process.on("SIGINT", async () => {
  isShuttingDown = true;
  console.log(`\n[Keeper] Shutting down... Total uptime: ${elapsed()}`);
  await safeCleanup();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  isShuttingDown = true;
  console.log(`\n[Keeper] SIGTERM received. Uptime: ${elapsed()}`);
  await safeCleanup();
  process.exit(0);
});

// ── Unhandled crash recovery ──
process.on("uncaughtException", async (err) => {
  console.error(`[Keeper] 💥 Uncaught exception: ${err.message}`);
  await safeCleanup();
  if (!isShuttingDown) {
    setTimeout(() => joinRoom(), RESTART_DELAY);
  }
});

process.on("unhandledRejection", async (reason) => {
  console.error(`[Keeper] 💥 Unhandled rejection: ${reason}`);
  await safeCleanup();
  if (!isShuttingDown) {
    setTimeout(() => joinRoom(), RESTART_DELAY);
  }
});

// ── Start ──
joinRoom();
