import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const target = process.env.TARGET_URL || 'https://nbbntools.my.id/';
const out = path.resolve('browser-evidence');
fs.mkdirSync(out, { recursive: true });

const viewports = [
  { width: 320, height: 640 },
  { width: 360, height: 800 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
];

const report = { target, startedAt: new Date().toISOString(), viewports: [], checks: [], pageErrors: [], consoleErrors: [], failed: false };
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on('pageerror', error => report.pageErrors.push(String(error)));
page.on('console', msg => { if (msg.type() === 'error') report.consoleErrors.push(msg.text()); });

try {
  const response = await page.goto(target, { waitUntil: 'networkidle', timeout: 45000 });
  report.checks.push({ name: 'homepage_http_response', pass: Boolean(response && response.status() < 400), status: response?.status() ?? null });
  await page.locator('body').waitFor();

  const title = await page.title();
  report.checks.push({ name: 'page_has_title', pass: title.trim().length > 0, value: title });

  const toolCount = await page.locator('.card').count();
  report.checks.push({ name: 'homepage_has_15_tool_cards', pass: toolCount === 15, actual: toolCount });

  const search = page.locator('#search, input[type="search"], input[placeholder*="Cari"], input[placeholder*="cari"]').first();
  const searchExists = await search.count() > 0;
  report.checks.push({ name: 'search_control_exists', pass: searchExists });
  if (searchExists) {
    await search.fill('diskon');
    await page.waitForTimeout(250);
    const filteredCount = await page.locator('.card:visible').count();
    report.checks.push({ name: 'search_interaction_changes_results', pass: filteredCount > 0 && filteredCount < 15, visibleCards: filteredCount });
    await search.fill('zzzz-no-match-browser-test');
    await page.waitForTimeout(250);
    const emptyState = await page.locator('.empty:visible').count();
    report.checks.push({ name: 'search_empty_state', pass: emptyState > 0, emptyStateElements: emptyState });
    await search.fill('');
    await page.waitForTimeout(200);
  }

  const theme = page.locator('#theme').first();
  const themeExists = await theme.count() > 0;
  report.checks.push({ name: 'theme_toggle_exists', pass: themeExists });
  if (themeExists) {
    const before = await page.locator('html').getAttribute('class');
    await theme.click();
    await page.waitForTimeout(100);
    const after = await page.locator('html').getAttribute('class');
    report.checks.push({ name: 'theme_toggle_interaction', pass: before !== after || (await page.evaluate(() => localStorage.getItem('nbbn-theme'))) !== null, before, after });
  }

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(100);
    const metrics = await page.evaluate(() => ({
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      title: document.title,
      overflowCandidates: [...document.querySelectorAll('body *')]
        .map(el => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return {
            tag: el.tagName.toLowerCase(),
            id: el.id || '',
            className: typeof el.className === 'string' ? el.className.slice(0, 100) : '',
            text: (el.innerText || '').trim().slice(0, 70),
            left: Math.round(r.left),
            right: Math.round(r.right),
            width: Math.round(r.width),
            minWidth: s.minWidth,
            widthCss: s.width,
            position: s.position,
            overflowX: s.overflowX
          };
        })
        .filter(el => el.right > window.innerWidth + 2 || el.left < -2)
        .sort((a, b) => b.right - a.right)
        .slice(0, 12)
    }));
    const pass = metrics.scrollWidth <= metrics.innerWidth + 1;
    report.viewports.push({ ...viewport, ...metrics, noHorizontalOverflow: pass });
    await page.screenshot({ path: path.join(out, `viewport-${viewport.width}x${viewport.height}.png`), fullPage: true });
  }
} catch (error) {
  report.failed = true;
  report.fatalError = String(error?.stack || error);
} finally {
  report.pageErrors = [...new Set(report.pageErrors)];
  report.consoleErrors = [...new Set(report.consoleErrors)];
  report.checks.push({ name: 'no_uncaught_page_errors', pass: report.pageErrors.length === 0, errors: report.pageErrors });
  report.checks.push({ name: 'no_console_errors', pass: report.consoleErrors.length === 0, errors: report.consoleErrors });
  report.checks.push({ name: 'all_viewports_no_horizontal_overflow', pass: report.viewports.length === viewports.length && report.viewports.every(v => v.noHorizontalOverflow), viewportsChecked: report.viewports.length });
  report.finishedAt = new Date().toISOString();
  report.failed = report.failed || report.checks.some(c => !c.pass);
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
console.log(JSON.stringify(report, null, 2));
if (report.failed) process.exit(1);
