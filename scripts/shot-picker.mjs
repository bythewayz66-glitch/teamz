/**
 * Visual check of the template picker at 1280px.
 *
 * Renders the built app, opens the "Add an agent" dialog (which defaults to the
 * Templates tab), and captures the picker. It also *measures* the category tab
 * row rather than relying on the eye: a tab whose scrollWidth exceeds its
 * clientWidth has a clipped label, and a container whose scrollWidth exceeds
 * its clientWidth has horizontal overflow.
 *
 * Run: node scripts/shot-picker.mjs
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

// Open the dialog. The sidebar's "New Agent" button is the entry point.
await page.getByRole('button', { name: /new agent/i }).first().click();
await page.waitForSelector('.tpl-tabs', { timeout: 10_000 });
await page.waitForSelector('.tpl-tab', { timeout: 10_000 });

// Let the pop-in animation settle before measuring.
await page.waitForTimeout(400);

const report = await page.evaluate(() => {
  const tabs = [...document.querySelectorAll('.tpl-tab')];
  const container = document.querySelector('.tpl-tabs');
  const levels = document.querySelector('.tpl-levels');
  const modal = document.querySelector('.modal');

  const rows = new Set(tabs.map((t) => Math.round(t.getBoundingClientRect().top)));

  return {
    tabCount: tabs.length,
    tabLabels: tabs.map((t) => t.textContent.trim()),
    rows: rows.size,
    containerOverflow: container
      ? { scrollWidth: container.scrollWidth, clientWidth: container.clientWidth }
      : null,
    levelsOverflow: levels
      ? { scrollWidth: levels.scrollWidth, clientWidth: levels.clientWidth }
      : null,
    modalOverflow: modal
      ? { scrollWidth: modal.scrollWidth, clientWidth: modal.clientWidth }
      : null,
    // A tab is clipped when its content is wider than its box.
    clipped: tabs
      .filter((t) => t.scrollWidth > t.clientWidth + 1)
      .map((t) => t.textContent.trim()),
    // Anything sticking out past the viewport is horizontal overflow.
    pastViewport: [...document.querySelectorAll('.tpl-tab, .tpl-level, .tpl-search input')]
      .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
      .map((el) => el.textContent.trim() || el.tagName),
  };
});

await page.screenshot({ path: `${OUT}/picker-1280.png`, fullPage: false });

// A second shot with a level filter active, to show the seniority control.
await page.getByRole('button', { name: 'Senior', exact: true }).click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/picker-1280-senior.png`, fullPage: false });

console.log(JSON.stringify({ ...report, consoleErrors: errors }, null, 2));

await browser.close();
