// Browser evidence runs against the checked-out PR branch to validate homepage changes before merge.
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
  // Cashier regression checks: real Chromium DOM with a mocked camera/BarcodeDetector.
  // This verifies the UI/state flow without requiring physical camera hardware in CI.
  const cashierUrl = new URL('/kasir/', target).href;
  await page.addInitScript(() => {
    window.__mockBarcodeValue = '0000000000000';
    class MockBarcodeDetector {
      constructor() {}
      static async getSupportedFormats() { return ['ean_13']; }
      async detect() { return [{ rawValue: window.__mockBarcodeValue }]; }
    }
    Object.defineProperty(window, 'BarcodeDetector', { configurable: true, value: MockBarcodeDetector });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => new MediaStream() }
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'readyState', {
      configurable: true,
      get() { return 2; }
    });
    HTMLMediaElement.prototype.play = () => Promise.resolve();
    HTMLMediaElement.prototype.pause = () => {};
  });
  await page.goto(cashierUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  report.checks.push({ name: 'cashier_http_page_loaded', pass: await page.locator('#productGrid').count() === 1 });

  // Product creation and duplicate barcode protection.
  await page.locator('button[data-panel="products"]').click();
  await page.locator('#addProduct').click();
  await page.locator('#pName').fill('Browser Test Product');
  await page.locator('#pCategory').fill('Testing');
  await page.locator('#pBarcode').fill('0012345678905');
  await page.locator('#pCost').fill('500');
  await page.locator('#pPrice').fill('1000');
  await page.locator('#pStock').fill('5');
  await page.locator('#productForm button[type="submit"]').click();
  await page.locator('#productsTable').getByText('Browser Test Product').waitFor();
  const createdCount = await page.locator('#productsTable tr').filter({ hasText: 'Browser Test Product' }).count();
  report.checks.push({ name: 'cashier_create_product', pass: createdCount === 1, actual: createdCount });

  await page.locator('#addProduct').click();
  await page.locator('#pName').fill('Duplicate Barcode Product');
  await page.locator('#pBarcode').fill('0012345678905');
  await page.locator('#pCost').fill('100');
  await page.locator('#pPrice').fill('200');
  await page.locator('#pStock').fill('2');
  await page.locator('#productForm button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Barcode/kode tersebut'));
  const duplicateCount = await page.locator('#productsTable tr').filter({ hasText: '0012345678905' }).count();
  report.checks.push({ name: 'cashier_duplicate_barcode_rejected', pass: duplicateCount === 1, actual: duplicateCount });
  await page.locator('#productModal [data-close="productModal"]').first().click();

  // Failed localStorage write must not leave an unsaved product in the UI.
  await page.evaluate(() => {
    window.__originalStorageSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function () { throw new DOMException('quota test', 'QuotaExceededError'); };
  });
  await page.locator('#addProduct').click();
  await page.locator('#pName').fill('Must Roll Back Product');
  await page.locator('#pBarcode').fill('ROLLBACK-001');
  await page.locator('#pCost').fill('10');
  await page.locator('#pPrice').fill('20');
  await page.locator('#pStock').fill('1');
  await page.locator('#productForm button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Penyimpanan penuh'));
  const rollbackCount = await page.locator('#productsTable tr').filter({ hasText: 'Must Roll Back Product' }).count();
  report.checks.push({ name: 'cashier_product_save_failure_rolls_back', pass: rollbackCount === 0, actual: rollbackCount });
  await page.evaluate(() => { Storage.prototype.setItem = window.__originalStorageSetItem; delete window.__originalStorageSetItem; });
  await page.locator('#productModal [data-close="productModal"]').first().click();

  // Unknown barcode must not add a product; a registered barcode must add the right product.
  await page.locator('button[data-panel="sale"]').click();
  await page.evaluate(() => { window.__mockBarcodeValue = 'NOT-REGISTERED'; });
  await page.locator('#scanBarcodeBtn').click();
  await page.waitForFunction(() => !document.querySelector('#scannerModal')?.classList.contains('show'), null, { timeout: 8000 });
  const unknownCartItems = await page.locator('#cartList .cart-item').count();
  report.checks.push({ name: 'cashier_unknown_barcode_does_not_add_product', pass: unknownCartItems === 0, actual: unknownCartItems });

  await page.evaluate(() => { window.__mockBarcodeValue = '0012345678905'; });
  await page.locator('#scanBarcodeBtn').click();
  await page.waitForFunction(() => !document.querySelector('#scannerModal')?.classList.contains('show'), null, { timeout: 8000 });
  const matchedCart = await page.locator('#cartList').getByText('Browser Test Product').count();
  report.checks.push({ name: 'cashier_registered_barcode_adds_matching_product', pass: matchedCart > 0, actual: matchedCart });

  // Complete a sale and confirm it appears in transaction history.
  await page.locator('#paidAmount').fill('1000');
  page.on('dialog', dialog => dialog.dismiss());
  await page.locator('#checkout').click();
  await page.locator('button[data-panel="history"]').click();
  await page.locator('#historyTable').getByText('Browser Test Product').waitFor({ timeout: 8000 });
  const historyRows = await page.locator('#historyTable tr').count();
  report.checks.push({ name: 'cashier_checkout_records_transaction', pass: historyRows === 1, actual: historyRows });

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
