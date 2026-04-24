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

const RELOAD_INTERVAL = 18 * 60 * 1000;
const RESTART_DELAY   = 15000;
const startTime       = Date.now();

function elapsed() {
  const ms = Date.now() - startTime;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${m}m`;
}

const app = express();
app.get('/', (req, res) => res.send(`
  <h2>✅ Free4Talk Keeper Running</h2>
  <p>Room: <a href="${ROOM_URL}">${ROOM_URL}</a></p>
  <p>Uptime: ${elapsed()}</p>
`));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: elapsed() }));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] ✅ Listening on 0.0.0.0:${PORT}`);
  joinRoom();
});

async function joinRoom() {
  console.log(`\n[Keeper] Starting... Uptime: ${elapsed()}`);

  try {
    const browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--disable-blink-features=AutomationControlled',
        '--disable-gpu',
        '--allow-running-insecure-content',
        '--autoplay-policy=no-user-gesture-required',
      ],
    });

    const context = await browser.newContext({
      permissions: ['microphone', 'camera'],
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      window.chrome = { runtime: {} };

      // Fake microphone/audio so WebRTC thinks there's a real audio stream
      const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        try {
          return await origGetUserMedia(constraints);
        } catch (e) {
          // Create a silent audio track as fallback
          const ctx = new AudioContext();
          const dst = ctx.createMediaStreamDestination();
          const oscillator = ctx.createOscillator();
          oscillator.frequency.value = 0; // silent
          oscillator.connect(dst);
          oscillator.start();
          return dst.stream;
        }
      };
    });

    // Inject identity.free4talk.com
    const identityPage = await context.newPage();
    await identityPage.goto('https://identity.free4talk.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await identityPage.evaluate(({ user, keypair }) => {
      if (user)    localStorage.setItem('user', user);
      if (keypair) localStorage.setItem('key-pair', keypair);
    }, { user: LS_USER, keypair: LS_KEYPAIR });
    console.log('[Keeper] ✅ identity injected');
    await identityPage.close();

    // Inject www.free4talk.com
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

    // Open room
    const page = await context.newPage();
    page.on('pageerror', () => {});

    // Log websocket and important network activity
    page.on('request', req => {
      const url = req.url();
      if (url.includes('ws') || url.includes('socket') || url.includes('webrtc') || url.includes('peer') || url.includes('join')) {
        console.log(`[NET] ${req.method()} ${url.substring(0, 120)}`);
      }
    });
    page.on('response', async res => {
      const url = res.url();
      if (url.includes('join') || url.includes('room') || url.includes('peer')) {
        console.log(`[NET] ${res.status()} ${url.substring(0, 120)}`);
        try {
          const text = await res.text();
          if (text && text.length < 500) console.log(`[NET] Body: ${text}`);
        } catch {}
      }
    });

    // Log page console messages
    page.on('console', msg => {
      const text = msg.text();
      if (text.includes('join') || text.includes('room') || text.includes('peer') || 
          text.includes('connect') || text.includes('user') || text.includes('error')) {
        console.log(`[PAGE] ${msg.type()}: ${text.substring(0, 200)}`);
      }
    });

    await page.goto(ROOM_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);

    await dismissPopups(page);

    // Click to enter
    try {
      const startText = page.locator('text=Click on anywhere to start').first();
      if (await startText.isVisible({ timeout: 3000 })) {
        await startText.click();
        console.log('[Keeper] ✅ Clicked to start');
      } else {
        await page.mouse.click(400, 300);
      }
    } catch {
      await page.mouse.click(400, 300);
    }

    // Wait longer for WebRTC to establish
    console.log('[Keeper] Waiting 15s for WebRTC to connect...');
    await page.waitForTimeout(15000);

    // Dump page state
    const pageText = await page.evaluate(() => document.body?.innerText?.substring(0, 1000) || '');
    console.log('[Keeper] Page text after join:\n' + pageText);

    // Check participant count
    const participants = await page.evaluate(() => {
      // Look for participant elements
      const cards = document.querySelectorAll('[class*="participant"], [class*="user"], [class*="member"], [class*="avatar"]');
      return Array.from(cards).map(el => ({ class: el.className?.substring(0, 60), text: el.textContent?.trim()?.substring(0, 40) }));
    });
    console.log('[Keeper] Participant elements found:', JSON.stringify(participants.slice(0, 10)));

    console.log(`[Keeper] ✅ In room: ${page.url()} | Uptime: ${elapsed()}`);

    // Reload every 18 minutes
    setInterval(async () => {
      try {
        console.log(`[Keeper] 🔄 Reloading... Uptime: ${elapsed()}`);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(5000);
        await dismissPopups(page);
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

  } catch (err) {
    console.error(`[Keeper] ❌ Error: ${err.message}`);
    setTimeout(joinRoom, RESTART_DELAY);
  }
}

async function dismissPopups(page) {
  try {
    const c1 = page.locator('.ant-notification-notice-close').first();
    if (await c1.isVisible({ timeout: 2000 })) { await c1.click(); await page.waitForTimeout(500); }
  } catch {}
  try {
    const c2 = page.locator('.ant-modal-close').first();
    if (await c2.isVisible({ timeout: 2000 })) { await c2.click(); await page.waitForTimeout(500); }
  } catch {}
}

process.on('uncaughtException', (err) => {
  console.error(`[Keeper] 💥 Crash: ${err.message}`);
  setTimeout(joinRoom, RESTART_DELAY);
});

process.on('unhandledRejection', (reason) => {
  console.error(`[Keeper] 💥 Rejection: ${reason}`);
  setTimeout(joinRoom, RESTART_DELAY);
});
