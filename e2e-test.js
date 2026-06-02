const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

// Probe common Windows Chrome paths
const userProfile = process.env.USERPROFILE || 'C:\\Users\\crs14';
const chromePaths = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(userProfile, 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
  'C:\\Program Files\\Google\\Chrome Beta\\Application\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome SxS\\Application\\chrome.exe' // Canary
];

let executablePath = '';
for (const p of chromePaths) {
  if (fs.existsSync(p)) {
    executablePath = p;
    break;
  }
}

if (!executablePath) {
  console.error('ERROR: Google Chrome could not be found in standard paths. Probed paths:');
  chromePaths.forEach(p => console.error(`  - ${p}`));
  process.exit(1);
}

console.log(`Using Chrome executable at: ${executablePath}`);

(async () => {
  console.log('Launching Chrome browser...');
  const browser = await puppeteer.launch({
    executablePath,
    headless: true, // Run headlessly so the user doesn't see window popups
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page1 = await browser.newPage();
    const page2 = await browser.newPage();

    // Log console messages from the browser pages!
    page1.on('console', msg => {
      console.log(`[PAGE 1] ${msg.type().toUpperCase()}: ${msg.text()}`);
    });
    page2.on('console', msg => {
      console.log(`[PAGE 2] ${msg.type().toUpperCase()}: ${msg.text()}`);
    });

    // Log page errors
    page1.on('pageerror', err => {
      console.error('[PAGE 1 JS ERROR STACK]:', err.stack || err.toString());
    });
    page2.on('pageerror', err => {
      console.error('[PAGE 2 JS ERROR STACK]:', err.stack || err.toString());
    });

    const testRoomUrl = 'http://localhost:3000/e2e-test-room-' + Date.now();
    console.log(`Navigating Page 1 to ${testRoomUrl}...`);
    await page1.goto(testRoomUrl, { waitUntil: 'networkidle2' });

    console.log(`Navigating Page 2 to ${testRoomUrl}...`);
    await page2.goto(testRoomUrl, { waitUntil: 'networkidle2' });

    // Wait for editors to load
    await page1.waitForSelector('.ql-editor');
    await page2.waitForSelector('.ql-editor');
    console.log('Editors loaded successfully on both pages.');

    // Wait for connection to settle
    console.log('Waiting 4s for WebSocket handshake and sync room...');
    await new Promise(r => setTimeout(r, 4000));

    console.log('Page 1 typing text "Hello from Automated test!"...');
    await page1.focus('.ql-editor');
    await page1.keyboard.type('Hello from Automated test!');

    console.log('Waiting 4s for synchronization to replicate...');
    await new Promise(r => setTimeout(r, 4000));

    // Retrieve texts
    const text1 = await page1.evaluate(() => document.querySelector('.ql-editor').textContent);
    const text2 = await page2.evaluate(() => document.querySelector('.ql-editor').textContent);

    console.log(`\n--- Verification RESULTS ---`);
    console.log(`Page 1 Editor content: "${text1.trim()}"`);
    console.log(`Page 2 Editor content: "${text2.trim()}"`);

    const matches = text1.trim() === text2.trim() && text1.trim().length > 0;
    console.log(`\nSync status: ${matches ? 'SUCCESS ✅' : 'FAILED ❌'}`);
  } catch (err) {
    console.error('Test script crashed with error:', err);
  } finally {
    await browser.close();
    console.log('Chrome closed.');
  }
})();
