/**
 * Visual check of the two channel-level features at 1280px:
 *   • the per-channel "addressed to" filter bar
 *   • the "invite an existing agent" popover
 *
 * Run: node scripts/shot-channel.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://localhost:4173/teamz/';
const OUT = 'screenshots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(BASE, { waitUntil: 'networkidle' });

// The seed workspace opens on the Build Room channel, so the filter bar is
// already on screen.
await page.waitForSelector('.filter-bar', { timeout: 10_000 });
await page.waitForTimeout(300);

const filter = await page.evaluate(() => {
  const bar = document.querySelector('.filter-bar');
  const chips = [...document.querySelectorAll('.filter-chip')];
  return {
    chipLabels: chips.map((c) => c.textContent.trim()),
    overflow: bar ? { scrollWidth: bar.scrollWidth, clientWidth: bar.clientWidth } : null,
    pastViewport: chips
      .filter((c) => c.getBoundingClientRect().right > window.innerWidth + 1)
      .map((c) => c.textContent.trim()),
  };
});

await page.screenshot({ path: `${OUT}/channel-filter-1280.png` });

// Narrow to "Directed only" and confirm the count appears.
await page.getByRole('button', { name: 'Directed only' }).click();
await page.waitForTimeout(250);
const directedCount = await page.locator('.filter-count').textContent().catch(() => null);
await page.screenshot({ path: `${OUT}/channel-filter-directed-1280.png` });

// Back to everything, then open the invite popover.
await page.getByRole('button', { name: 'Everything' }).click();
await page.getByRole('button', { name: 'Invite an existing agent' }).click();
await page.waitForSelector('.invite-pop', { timeout: 5_000 });
await page.waitForTimeout(300);

const invite = await page.evaluate(() => {
  const pop = document.querySelector('.invite-pop');
  return {
    heading: pop?.querySelector('strong')?.textContent?.trim() ?? null,
    note: pop?.querySelector('.invite-note')?.textContent?.trim() ?? null,
    rows: [...(pop?.querySelectorAll('ul li') ?? [])].map((li) =>
      li.textContent.trim().replace(/\s+/g, ' '),
    ),
    overflow: pop ? { scrollWidth: pop.scrollWidth, clientWidth: pop.clientWidth } : null,
  };
});

await page.screenshot({ path: `${OUT}/channel-invite-1280.png` });

console.log(JSON.stringify({ filter, directedCount, invite, consoleErrors: errors }, null, 2));

await browser.close();
