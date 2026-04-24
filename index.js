const { chromium } = require('playwright');
const express = require('express');
require('dotenv').config();

const ROOM_URL         = process.env.ROOM_URL;
const PORT             = process.env.PORT || 3000;
const LS_USER_TOKEN    = process.env.LS_USER_TOKEN;
const LS_USER_NAME     = process.env.LS_USER_NAME;
const LS_USER_LFP      = process.env.LS_USER_LFP;
const LS_USER_REDIRECT = process.env.LS_USER_REDIRECT;
const LS_KEYPAIR       = process.env.LS_KEYPAIR;
const LS_USER          = process.env.LS_USER;

const RELOAD_INTERVAL  = 18 * 60 * 1000;
const RESTART_DELAY    = 15000;
const startTime        = Date.now();

function elapsed() {
  const ms = Date.now() - startTime;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${m}m`;
}

// Health check server
const app = express();
app.get('/', (req, res) => res.send(`
  <h2>✅ Free4Talk Keeper</h2>
  <p>Room: <a href="${ROOM_URL}">${ROOM_URL}</a></p>
  <p>Uptime: ${elapsed()}</p>
  <p>Started: ${new Date(startTime).toISOString()}</p>
`));
app.listen(PORT, () => console.log(`[Server] Port ${PORT}`));

async function joinRoom() {
  console.log(`\n[Keeper] Starting... Uptime: ${elapsed()}`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--disable-blink-features=AutomationControlled', // hide automation
    ],
  });

  // Use Chrome user agent + pretend to be Chrome
  const context = await browser.newContext({
    permissions: ['microphone'],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  // Hide webdriver flag (makes site think it's real Chrome)
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {} };
  });

  // 1. Inject identity.free4talk.com
  const identityPage = await context.newPage();
  await identityPage.goto('https://identity.free4talk.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await identityPage.evaluate(({ user, keypair }) => {
    if (user)    localStorage.setItem('user', user);
    if (keypair) localStorage.setItem('key-pair', keypair);
  }, { user: LS_USER, keypair: LS_KEYPAIR });
  console.log('[Keeper] ✅ identity injected');
  await identityPage.close();

  // 2. Inject www.free4talk.com
  const wwwPage = await context.newPage();
  await wwwPage.goto('https://www.free4talk.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await wwwPage.evaluate(({ token, name, lfp, redirect }) => {
    if (token)    localStorage.setItem('user:token', token);
    if (name)     localStorage.setItem('user_name', name);
    if (lfp)      localStorage.setItem('user:lfp', lfp);
    if (redirect) localStorage.setItem('user:redirect', redirect);
  }, { token: LS_USER_TOKEN, name: LS_USER_NAME, lfp: LS_USER_LFP, redirect: LS_USER_REDIRECT });
  console.log('[Keeper] ✅ www injected');
  await wwwPage.close();

  // 3. Open room
  const page = await context.newPage();
  page.on('pageerror', () => {});

  await page.goto(ROOM_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);

  // Close "unsupported browser" warning if present
  try {
    const closeBtn = page.locator('.ant-notification-notice-close').first();
    if (await closeBtn.isVisible({ timeout: 3000 })) {
      await closeBtn.click();
      console.log('[Keeper] ✅ Closed browser warning popup');
      await page.waitForTimeout(1000);
    }
  } catch {}

  // Close "sign in" modal if present by dismissing it
  try {
    const modalClose = page.locator('.ant-modal-close').first();
    if (await modalClose.isVisible({ timeout: 3000 })) {
      await modalClose.click();
      console.log('[Keeper] ✅ Closed sign-in modal');
      await page.waitForTimeout(1000);
    }
  } catch {}

  // Click anywhere to start
  try {
    const startText = page.locator('text=Click on anywhere to start').first();
    if (await startText.isVisible({ timeout: 5000 })) {
      await startText.click();
      console.log('[Keeper] ✅ Clicked to start');
    } else {
      await page.mouse.click(400, 300);
    }
  } catch {
    await page.mouse.click(400, 300);
  }

  await page.waitForTimeout(8000);
  console.log(`[Keeper] ✅ In room: ${page.url()} | Uptime: ${elapsed()}`);

  // Reload every 18 minutes
  setInterval(async () => {
    try {
      console.log(`[Keeper] 🔄 Reloading... Uptime: ${elapsed()}`);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(5000);

      // Close popups again after reload
      try {
        const c1 = page.locator('.ant-notification-notice-close').first();
        if (await c1.isVisible({ timeout: 2000 })) await c1.click();
      } catch {}
      try {
        const c2 = page.locator('.ant-modal-close').first();
        if (await c2.isVisible({ timeout: 2000 })) await c2.click();
      } catch {}

      // Click to rejoin
      try {
        const startText = page.locator('text=Click on anywhere to start').first();
        if (await startText.isVisible({ timeout: 3000 })) {
          await startText.click();
        } else {
          await page.mouse.click(400, 300);
        }
      } catch {
        await page.mouse.click(400, 300);
      }

      console.log(`[Keeper] ✅ Reload OK | Uptime: ${elapsed()}`);
    } catch (err) {
      console.error(`[Keeper] ❌ Reload failed: ${err.message}`);
      await browser.close();
      setTimeout(joinRoom, RESTART_DELAY);
    }
  }, RELOAD_INTERVAL);
}

process.on('uncaughtException', async (err) => {
  console.error(`[Keeper] 💥 Crash: ${err.message}`);
  setTimeout(joinRoom, RESTART_DELAY);
});

joinRoom();
