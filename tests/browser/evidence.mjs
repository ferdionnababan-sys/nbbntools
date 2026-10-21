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
const context = await browser.newContext({ timezoneId: 'Asia/Jakarta' });
const page = await context.newPage();
page.on('pageerror', error => report.pageErrors.push(String(error)));
page.on('console', msg => { if (msg.type() === 'error') report.consoleErrors.push(msg.text()); });

try {
  const response = await page.goto(target, { waitUntil: 'networkidle', timeout: 45000 });
  report.checks.push({ name: 'homepage_http_response', pass: Boolean(response && response.status() < 400), status: response?.status() ?? null });
  await page.locator('body').waitFor();

  const title = await page.title();
  report.checks.push({ name: 'page_has_title', pass: title.trim().length > 0, value: title });

  // PWA foundation checks: manifest response, expected metadata, and service-worker activation.
  const pwa = await page.evaluate(async () => {
    const result = { manifestHttp: false, manifestValid: false, iconPngsValid: false, workerHttp: false, serviceWorkerSupported: 'serviceWorker' in navigator, serviceWorkerActivated: false, errors: [] };
    try {
      const manifestResponse = await fetch('/manifest.json', { cache: 'no-store' });
      result.manifestHttp = manifestResponse.ok;
      if (manifestResponse.ok) {
        const manifest = await manifestResponse.json();
        result.manifestValid = manifest.name === 'NBBNTOOLS — Tools Online' && manifest.start_url === '/' && manifest.scope === '/' && Array.isArray(manifest.icons) && manifest.icons.some(icon => icon.sizes === '192x192' && icon.type === 'image/png') && manifest.icons.some(icon => icon.sizes === '512x512' && icon.type === 'image/png');
        const pngIcons = manifest.icons.filter(icon => icon.type === 'image/png' && ['192x192', '512x512'].includes(icon.sizes));
        const iconResults = await Promise.all(pngIcons.map(async icon => { const response = await fetch(icon.src, { cache: 'no-store' }); const bytes = new Uint8Array(await response.arrayBuffer()); return response.ok && (response.headers.get('content-type') || '').includes('image/png') && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71; }));
        result.iconPngsValid = pngIcons.length >= 2 && iconResults.every(Boolean);
      }
    } catch (error) { result.errors.push('manifest: ' + String(error)); }
    try {
      const workerResponse = await fetch('/service-worker.js', { cache: 'no-store' });
      result.workerHttp = workerResponse.ok;
      if (result.serviceWorkerSupported && workerResponse.ok && location.protocol !== 'file:') {
        const registration = await navigator.serviceWorker.register('/service-worker.js', { scope: '/' });
        await Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => setTimeout(() => reject(new Error('service worker activation timeout')), 10000))]);
        result.serviceWorkerActivated = Boolean(registration.active || registration.waiting || registration.installing);
      }
    } catch (error) { result.errors.push('service worker: ' + String(error)); }
    return result;
  });
  report.checks.push({ name: 'pwa_manifest_http', pass: pwa.manifestHttp });
  report.checks.push({ name: 'pwa_manifest_metadata', pass: pwa.manifestValid });
  report.checks.push({ name: 'pwa_png_icons_valid', pass: pwa.iconPngsValid });
  report.checks.push({ name: 'pwa_service_worker_http', pass: pwa.workerHttp });
  report.checks.push({ name: 'pwa_service_worker_supported', pass: pwa.serviceWorkerSupported });
  report.checks.push({ name: 'pwa_service_worker_activated', pass: pwa.serviceWorkerActivated, errors: pwa.errors });

  // Verify actual offline navigation from the installed service-worker cache.
  if (pwa.serviceWorkerActivated) {
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 10000 });
      await context.setOffline(true);
      const offlineHomeResponse = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const offlineHomeTitle = await page.title();
      report.checks.push({ name: 'pwa_homepage_loads_from_cache_offline', pass: Boolean(offlineHomeResponse && offlineHomeResponse.ok()) && offlineHomeTitle.includes('NBBNTOOLS'), status: offlineHomeResponse?.status() ?? null, title: offlineHomeTitle });
      const offlineCashierResponse = await page.goto(new URL('/kasir/', target).href, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const offlineCashierLoaded = await page.locator('#productGrid').count() === 1;
      report.checks.push({ name: 'pwa_cashier_shell_loads_from_cache_offline', pass: Boolean(offlineCashierResponse && offlineCashierResponse.ok()) && offlineCashierLoaded, status: offlineCashierResponse?.status() ?? null, cashierShellLoaded: offlineCashierLoaded });
      if (offlineCashierLoaded) {
        await page.locator('button[data-panel="products"]').click();
        await page.locator('#addProduct').click();
        await page.locator('#pName').fill('Offline Persistence Test Product');
        await page.locator('#pCategory').fill('Offline Test');
        await page.locator('#pBarcode').fill('OFFLINE-PERSIST-001');
        await page.locator('#pCost').fill('100');
        await page.locator('#pPrice').fill('200');
        await page.locator('#pStock').fill('2');
        await page.locator('#productForm button[type="submit"]').click();
        await page.locator('#productsTable').getByText('Offline Persistence Test Product').waitFor({ timeout: 8000 });
        const offlineProductCreated = await page.locator('#productsTable tr').filter({ hasText: 'Offline Persistence Test Product' }).count() === 1;
        report.checks.push({ name: 'cashier_can_create_product_while_offline', pass: offlineProductCreated });
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.locator('button[data-panel="products"]').click();
        const offlineProductAfterReload = await page.locator('#productsTable tr').filter({ hasText: 'Offline Persistence Test Product' }).count();
        const offlineProductStored = await page.evaluate(() => {
          const db = JSON.parse(localStorage.getItem('nbbntools_kasir_v1') || '{"products":[]}');
          return db.products.some(product => product.barcode === 'OFFLINE-PERSIST-001');
        });
        report.checks.push({ name: 'cashier_offline_product_persists_after_offline_reload', pass: offlineProductAfterReload === 1 && offlineProductStored, visibleAfterReload: offlineProductAfterReload, stored: offlineProductStored });

        // Verify a complete local sale while offline, including stock/history persistence across reload.
        const beforeOfflineSale = await page.evaluate(() => {
          const db = JSON.parse(localStorage.getItem('nbbntools_kasir_v1') || '{}');
          const product = (db.products || []).find(item => item.barcode === 'OFFLINE-PERSIST-001');
          return { transactions: (db.transactions || []).length, stock: product?.stock ?? null };
        });
        await page.locator('button[data-panel="sale"]').click();
        await page.locator('#productGrid').getByText('Offline Persistence Test Product').click();
        await page.locator('#paidAmount').fill('200');
        await page.locator('#checkout').click();
        await page.waitForFunction((before) => {
          const db = JSON.parse(localStorage.getItem('nbbntools_kasir_v1') || '{}');
          return (db.transactions || []).length === before + 1;
        }, beforeOfflineSale.transactions, { timeout: 8000 });
        const offlineSaleState = await page.evaluate(() => {
          const db = JSON.parse(localStorage.getItem('nbbntools_kasir_v1') || '{}');
          const product = (db.products || []).find(item => item.barcode === 'OFFLINE-PERSIST-001');
          return { transactions: (db.transactions || []).length, stock: product?.stock ?? null, sale: (db.transactions || []).find(item => (item.items || []).some(line => line.name === 'Offline Persistence Test Product')) || null };
        });
        const offlineSaleRecorded = offlineSaleState.transactions === beforeOfflineSale.transactions + 1 && offlineSaleState.stock === 1 && Boolean(offlineSaleState.sale) && offlineSaleState.sale.total === 200;
        report.checks.push({ name: 'cashier_can_checkout_sale_while_offline', pass: offlineSaleRecorded, transactionCount: offlineSaleState.transactions, stock: offlineSaleState.stock, total: offlineSaleState.sale?.total ?? null });

        await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.locator('button[data-panel="history"]').click();
        const offlineSaleHistoryVisible = await page.locator('#historyTable tr').count() === 1;
        const offlineSaleAfterReload = await page.evaluate(() => {
          const db = JSON.parse(localStorage.getItem('nbbntools_kasir_v1') || '{}');
          const product = (db.products || []).find(item => item.barcode === 'OFFLINE-PERSIST-001');
          const sale = (db.transactions || []).find(item => (item.items || []).some(line => line.name === 'Offline Persistence Test Product'));
          return { stock: product?.stock ?? null, total: sale?.total ?? null };
        });
        report.checks.push({ name: 'cashier_offline_sale_history_and_stock_persist_after_reload', pass: offlineSaleHistoryVisible && offlineSaleAfterReload.stock === 1 && offlineSaleAfterReload.total === 200, historyVisible: offlineSaleHistoryVisible, stock: offlineSaleAfterReload.stock, total: offlineSaleAfterReload.total });

        // Returning online must not duplicate or erase a sale completed while offline.
        const offlineCommittedState = await page.evaluate(() => {
          const db = JSON.parse(localStorage.getItem('nbbntools_kasir_v1') || '{}');
          const product = (db.products || []).find(item => item.barcode === 'OFFLINE-PERSIST-001');
          const sales = (db.transactions || []).filter(item => (item.items || []).some(line => line.name === 'Offline Persistence Test Product'));
          return { transactionCount: (db.transactions || []).length, stock: product?.stock ?? null, matchingSales: sales.length, total: sales[0]?.total ?? null };
        });
        await context.setOffline(false);
        await page.goto(new URL('/kasir/', target).href, { waitUntil: 'domcontentloaded', timeout: 15000 });
        const reconnectedState = await page.evaluate(() => {
          const db = JSON.parse(localStorage.getItem('nbbntools_kasir_v1') || '{}');
          const product = (db.products || []).find(item => item.barcode === 'OFFLINE-PERSIST-001');
          const sales = (db.transactions || []).filter(item => (item.items || []).some(line => line.name === 'Offline Persistence Test Product'));
          return { transactionCount: (db.transactions || []).length, stock: product?.stock ?? null, matchingSales: sales.length, total: sales[0]?.total ?? null };
        });
        report.checks.push({
          name: 'cashier_reconnect_preserves_offline_sale_without_duplicate',
          pass: reconnectedState.transactionCount === offlineCommittedState.transactionCount &&
            reconnectedState.stock === offlineCommittedState.stock &&
            reconnectedState.matchingSales === 1 &&
            reconnectedState.total === 200,
          beforeReconnect: offlineCommittedState,
          afterReconnect: reconnectedState
        });
      }
    } catch (error) {
      report.checks.push({ name: 'pwa_offline_navigation_checks', pass: false, error: String(error) });
    } finally {
      await context.setOffline(false);
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
    }
  } else {
    report.checks.push({ name: 'pwa_homepage_loads_from_cache_offline', pass: false, reason: 'service worker did not activate' });
    report.checks.push({ name: 'pwa_cashier_shell_loads_from_cache_offline', pass: false, reason: 'service worker did not activate' });
  }

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

  // A failed database write during checkout must preserve persisted stock/history and keep the cart recoverable.
  await page.locator('button[data-panel="sale"]').click();
  await page.locator('#productGrid [data-add]').filter({ hasText: 'Browser Test Product' }).click();
  await page.locator('#paidAmount').fill('1000');
  const checkoutBeforeStorageFailure = await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('nbbntools_kasir_v1') || '{}');
    const product = (db.products || []).find(item => item.barcode === '0012345678905');
    return { stock: product?.stock ?? null, transactions: (db.transactions || []).length };
  });
  await page.evaluate(() => {
    window.__originalStorageSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'nbbntools_kasir_v1') throw new DOMException('quota test', 'QuotaExceededError');
      return window.__originalStorageSetItem.call(this, key, value);
    };
  });
  await page.locator('#checkout').click();
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Penyimpanan penuh'));
  const checkoutAfterStorageFailure = await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('nbbntools_kasir_v1') || '{}');
    const product = (db.products || []).find(item => item.barcode === '0012345678905');
    return { stock: product?.stock ?? null, transactions: (db.transactions || []).length, cartItems: document.querySelectorAll('#cartList .cart-item').length };
  });
  await page.evaluate(() => { Storage.prototype.setItem = window.__originalStorageSetItem; delete window.__originalStorageSetItem; });
  report.checks.push({
    name: 'cashier_checkout_storage_failure_preserves_stock_history_and_cart',
    pass: checkoutAfterStorageFailure.stock === checkoutBeforeStorageFailure.stock &&
      checkoutAfterStorageFailure.transactions === checkoutBeforeStorageFailure.transactions &&
      checkoutAfterStorageFailure.cartItems === 1,
    before: checkoutBeforeStorageFailure,
    after: checkoutAfterStorageFailure
  });
  await page.locator('#clearCart').click();

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

  // Ambiguous duplicate barcodes must never auto-add an arbitrary product to the cart.
  await page.locator('#clearCart').click();
  await page.evaluate(() => {
    const key = 'nbbntools_kasir_v1';
    const db = JSON.parse(localStorage.getItem(key));
    db.products.push({ id: 'duplicate-scan-product', name: 'Duplicate Scan Product', category: 'Testing', barcode: '0012345678905', cost: 100, price: 300, stock: 4, active: true });
    localStorage.setItem(key, JSON.stringify(db));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { window.__mockBarcodeValue = '0012345678905'; });
  await page.locator('button[data-panel="sale"]').click();
  await page.locator('#scanBarcodeBtn').click();
  await page.waitForFunction(() => !document.querySelector('#scannerModal')?.classList.contains('show'), null, { timeout: 8000 });
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Barcode duplikat'));
  const duplicateScanState = await page.evaluate(() => ({ cartItems: document.querySelectorAll('#cartList .cart-item').length, toast: document.querySelector('#toast')?.textContent || '' }));
  report.checks.push({ name: 'cashier_duplicate_scanned_barcode_does_not_auto_add_product', pass: duplicateScanState.cartItems === 0 && duplicateScanState.toast.includes('Barcode duplikat'), actual: duplicateScanState });
  // Restore a known product to the cart so the following checkout regression remains meaningful.
  await page.locator('#productGrid').getByText('Browser Test Product').click();

  // Complete a sale and confirm it appears in transaction history.
  await page.locator('#paidAmount').fill('1000');
  await page.locator('#checkout').click();
  await page.locator('button[data-panel="history"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#historyTable tr').length === 1, null, { timeout: 8000 });
  const historyRows = await page.locator('#historyTable tr').count();
  report.checks.push({ name: 'cashier_checkout_records_transaction', pass: historyRows === 1, actual: historyRows });

  // Legacy transactions without a stored local day must use the browser's local date, not the UTC date prefix.
  await page.evaluate(() => {
    const key = 'nbbntools_kasir_v1';
    const db = JSON.parse(localStorage.getItem(key));
    const now = new Date();
    const localMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 30, 0);
    db.transactions.push({ id: 'legacy-local-day-test', number: 'LEGACY-DAY-TEST', date: localMidnight.toISOString(), items: [{ id: 'legacy-item', name: 'Legacy Day Item', qty: 1, price: 1000, cost: 500, subtotal: 1000 }], subtotal: 1000, discount: 0, tax: 0, total: 1000, cost: 500 });
    localStorage.setItem(key, JSON.stringify(db));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const expectedLocalDay = await page.evaluate(() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); });
  await page.locator('button[data-panel="reports"]').click();
  await page.locator('#reportDate').fill(expectedLocalDay);
  await page.waitForFunction(() => Number(document.querySelector('#metricCount')?.textContent) === 2);
  const localDayReportCount = await page.locator('#metricCount').textContent();
  report.checks.push({ name: 'cashier_legacy_transaction_report_uses_local_calendar_day', pass: localDayReportCount.trim() === '2', actual: localDayReportCount.trim(), expected: '2' });

  // Checkout must reject totals/costs beyond safe integer precision without changing stock or history.
  await page.evaluate(() => {
    const key = 'nbbntools_kasir_v1';
    const db = JSON.parse(localStorage.getItem(key));
    db.products.push({ id: 'overflow-price-product', name: 'Overflow Price Product', category: 'Testing', barcode: 'OVERFLOW-PRICE', cost: 1, price: Number.MAX_SAFE_INTEGER, stock: 2, emoji: '🧪', active: true });
    localStorage.setItem(key, JSON.stringify(db));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#productGrid [data-add="overflow-price-product"]').click();
  await page.locator('#productGrid [data-add="overflow-price-product"]').click();
  await page.locator('#paidAmount').fill('9999999999999999');
  await page.locator('#checkout').click();
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Nilai transaksi melebihi batas angka aman'));
  const overflowCheckoutState = await page.evaluate(() => { const db = JSON.parse(localStorage.getItem('nbbntools_kasir_v1')); return { stock: db.products.find(p => p.id === 'overflow-price-product').stock, txCount: db.transactions.length }; });
  report.checks.push({ name: 'cashier_checkout_rejects_unsafe_total_without_stock_or_history_mutation', pass: overflowCheckoutState.stock === 2 && overflowCheckoutState.txCount === 2, actual: overflowCheckoutState, expected: { stock: 2, txCount: 2 } });

  // Even safe per-line costs must be rejected if their combined transaction cost exceeds safe precision.
  await page.evaluate(() => {
    const key = 'nbbntools_kasir_v1';
    const db = JSON.parse(localStorage.getItem(key));
    db.products.push(
      { id: 'cost-overflow-one', name: 'Cost Overflow One', category: 'Testing', barcode: 'COST-OVERFLOW-1', cost: Number.MAX_SAFE_INTEGER, price: 1, stock: 1, active: true },
      { id: 'cost-overflow-two', name: 'Cost Overflow Two', category: 'Testing', barcode: 'COST-OVERFLOW-2', cost: Number.MAX_SAFE_INTEGER, price: 1, stock: 1, active: true }
    );
    localStorage.setItem(key, JSON.stringify(db));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#productGrid [data-add="cost-overflow-one"]').click();
  await page.locator('#productGrid [data-add="cost-overflow-two"]').click();
  await page.locator('#paidAmount').fill('2');
  await page.locator('#checkout').click();
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Nilai transaksi melebihi batas angka aman'));
  const costOverflowState = await page.evaluate(() => { const db = JSON.parse(localStorage.getItem('nbbntools_kasir_v1')); return { stockOne: db.products.find(p => p.id === 'cost-overflow-one').stock, stockTwo: db.products.find(p => p.id === 'cost-overflow-two').stock, txCount: db.transactions.length }; });
  report.checks.push({ name: 'cashier_checkout_rejects_unsafe_aggregate_cost_without_mutation', pass: costOverflowState.stockOne === 1 && costOverflowState.stockTwo === 1 && costOverflowState.txCount === 2, actual: costOverflowState, expected: { stockOne: 1, stockTwo: 1, txCount: 2 } });

  // CSV exports must neutralize formula-like text fields to avoid spreadsheet formula injection.
  await page.evaluate(() => {
    const key = 'nbbntools_kasir_v1';
    const db = JSON.parse(localStorage.getItem(key));
    db.products.push({ id: 'csv-formula-test', name: '=1+1', category: 'Testing', barcode: '+CMD', cost: 1, price: 2, stock: 1, active: true });
    localStorage.setItem(key, JSON.stringify(db));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('button[data-panel="products"]').click();
  const productDownloadPromise = page.waitForEvent('download');
  await page.locator('#exportProducts').click();
  const productDownload = await productDownloadPromise;
  const productCsv = fs.readFileSync(await productDownload.path(), 'utf8');
  const csvFormulaSafe = productCsv.includes("'=1+1") && productCsv.includes("'+CMD");
  report.checks.push({ name: 'cashier_csv_neutralizes_spreadsheet_formula_text', pass: csvFormulaSafe, actual: { formulaTextNeutralized: productCsv.includes("'=1+1"), barcodeNeutralized: productCsv.includes("'+CMD") } });

  // A product with sales history must be hidden, not permanently removed; it must remain reactivatable.
  await page.locator('button[data-panel="products"]').click();
  const historicalProductRow = page.locator('#productsTable tr').filter({ hasText: 'Browser Test Product' });
  page.once('dialog', dialog => dialog.accept());
  await historicalProductRow.locator('button[data-action="delete"]').click();
  await page.waitForFunction(() => [...document.querySelectorAll('#productsTable tr')].some(row => row.innerText.includes('Browser Test Product') && row.innerText.includes('Disembunyikan')));
  const hiddenProductCount = await page.locator('#productsTable tr').filter({ hasText: 'Browser Test Product' }).filter({ hasText: 'Disembunyikan' }).count();
  const preservedHistoryCount = await page.locator('button[data-panel="history"]').count();
  report.checks.push({ name: 'cashier_product_with_history_is_hidden_not_deleted', pass: hiddenProductCount === 1 && preservedHistoryCount === 1, hiddenProductCount });

  await page.locator('#productsTable tr').filter({ hasText: 'Browser Test Product' }).locator('button[data-action="activate"]').click();
  const reactivated = await page.locator('#productsTable tr').filter({ hasText: 'Browser Test Product' }).filter({ hasNotText: 'Disembunyikan' }).count();
  report.checks.push({ name: 'cashier_hidden_product_can_be_reactivated', pass: reactivated === 1, actual: reactivated });

  // A product without sales history must be permanently deleted and removed from localStorage.
  await page.evaluate(() => {
    const key = 'nbbntools_kasir_v1';
    const db = JSON.parse(localStorage.getItem(key));
    db.products.push({ id: 'delete-no-history-test', name: 'Delete Without History', category: 'Testing', barcode: 'DELETE-NO-HISTORY', cost: 10, price: 20, stock: 3, active: true });
    localStorage.setItem(key, JSON.stringify(db));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('button[data-panel="products"]').click();
  const noHistoryRow = page.locator('#productsTable tr').filter({ hasText: 'Delete Without History' });
  page.once('dialog', dialog => dialog.accept());
  await noHistoryRow.locator('button[data-action="delete"]').click();
  await page.waitForFunction(() => {
    const db = JSON.parse(localStorage.getItem('nbbntools_kasir_v1'));
    return !db.products.some(p => p.id === 'delete-no-history-test');
  });
  const permanentDeleteResult = await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('nbbntools_kasir_v1'));
    return { stored: db.products.some(p => p.id === 'delete-no-history-test'), visible: [...document.querySelectorAll('#productsTable tr')].some(row => row.innerText.includes('Delete Without History')) };
  });
  report.checks.push({
    name: 'cashier_product_without_history_is_permanently_deleted',
    pass: !permanentDeleteResult.stored && !permanentDeleteResult.visible,
    actual: permanentDeleteResult
  });

  // Invalid backup must be rejected when two products reuse the same normalized barcode.
  // Existing cashier data must remain unchanged after rejection.
  const duplicateBarcodeBackup = {
    backupFormat: 'nbbntools-kasir',
    backupVersion: 1,
    backupAt: new Date().toISOString(),
    products: [
      { id: 'backup-product-1', name: 'Backup Product One', barcode: 'DUPLICATE-01', cost: 1, price: 2, stock: 3 },
      { id: 'backup-product-2', name: 'Backup Product Two', barcode: ' duplicate-01 ', cost: 1, price: 2, stock: 3 }
    ],
    transactions: [],
    stockMovements: [],
    settings: { storeName: 'Invalid Backup Test' }
  };
  await page.locator('#restoreFile').setInputFiles({
    name: 'duplicate-barcode-backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(duplicateBarcodeBackup))
  });
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Backup tidak valid atau rusak'));
  const currentProductPreserved = await page.locator('#productsTable tr').filter({ hasText: 'Browser Test Product' }).count();
  const invalidBackupNotApplied = await page.locator('#productsTable tr').filter({ hasText: 'Backup Product One' }).count() === 0;
  report.checks.push({
    name: 'cashier_backup_rejects_duplicate_barcodes_without_replacing_current_data',
    pass: currentProductPreserved === 1 && invalidBackupNotApplied,
    currentProductPreserved,
    invalidBackupNotApplied
  });

  // Backups with negative transaction discounts must be rejected without replacing local data.
  const negativeDiscountBackup = {
    backupFormat: 'nbbntools-kasir', backupVersion: 1, backupAt: new Date().toISOString(),
    products: [],
    transactions: [{ id: 'bad-tx-1', number: 'BAD-001', date: new Date().toISOString(), day: new Date().toISOString().slice(0, 10), items: [{ id: 'historic-product', name: 'Historic Product', qty: 1, price: 100, cost: 50, subtotal: 100 }], subtotal: 100, discount: -10, tax: 0, total: 110, paid: 110, due: 0, change: 0, cost: 50 }],
    stockMovements: [], settings: { storeName: 'Invalid Financial Backup' }
  };
  await page.locator('#restoreFile').setInputFiles({ name: 'negative-discount-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(negativeDiscountBackup)) });
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Backup tidak valid atau rusak'));
  const negativeBackupNotApplied = await page.evaluate(() => JSON.parse(localStorage.getItem('nbbntools_kasir_v1')).transactions.every(t => t.id !== 'bad-tx-1'));
  report.checks.push({ name: 'cashier_backup_rejects_negative_transaction_discount_without_replacing_data', pass: negativeBackupNotApplied, actual: negativeBackupNotApplied });

  // Finite but unsafe product prices/costs must not be restored from a crafted backup.
  const unsafePriceBackup = {
    backupFormat: 'nbbntools-kasir', backupVersion: 1, backupAt: new Date().toISOString(),
    products: [{ id: 'unsafe-price-product', name: 'Unsafe Price Product', barcode: 'UNSAFE-PRICE', cost: 1, price: 1e100, stock: 3 }],
    transactions: [], stockMovements: [], settings: { storeName: 'Invalid Numeric Backup' }
  };
  await page.locator('#restoreFile').setInputFiles({ name: 'unsafe-price-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(unsafePriceBackup)) });
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Backup tidak valid atau rusak'));
  const unsafePriceNotApplied = await page.evaluate(() => JSON.parse(localStorage.getItem('nbbntools_kasir_v1')).products.every(p => p.id !== 'unsafe-price-product'));
  report.checks.push({ name: 'cashier_backup_rejects_unsafe_product_price_without_replacing_data', pass: unsafePriceNotApplied, actual: unsafePriceNotApplied });

  // A valid backup restore must preserve product and transaction records while applying its settings.
  const validRestoreBackup = {
    backupFormat: 'nbbntools-kasir',
    backupVersion: 1,
    backupAt: new Date().toISOString(),
    products: [{ id: 'restore-roundtrip-product', name: 'Restore Roundtrip Product', category: 'Test', barcode: 'RESTORE-ROUNDTRIP-01', cost: 50, price: 100, stock: 4, emoji: '🧪', active: true }],
    transactions: [{ id: 'restore-roundtrip-transaction', number: 'RESTORE-ROUNDTRIP-TX', date: new Date().toISOString(), day: new Date().toISOString().slice(0, 10), customer: 'Test', method: 'Tunai', items: [{ id: 'restore-roundtrip-product', name: 'Restore Roundtrip Product', qty: 1, price: 100, cost: 50, subtotal: 100 }], subtotal: 100, discount: 0, tax: 0, total: 100, paid: 100, due: 0, change: 0, cost: 50 }],
    stockMovements: [],
    settings: { storeName: 'Backup Restore Verification' }
  };
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#restoreFile').setInputFiles({
    name: 'valid-roundtrip-backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(validRestoreBackup))
  });
  await page.waitForFunction(() => {
    const text = document.querySelector('#toast')?.textContent || '';
    return text.includes('Backup berhasil dipulihkan') || text.includes('Backup tidak valid atau rusak');
  });
  const validRestoreResult = await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('nbbntools_kasir_v1') || '{}');
    return { products: db.products.length, transactions: db.transactions.length, storeName: db.settings?.storeName, productId: db.products[0]?.id, transactionId: db.transactions[0]?.id, toast: document.querySelector('#toast')?.textContent || '' };
  });
  report.checks.push({
    name: 'cashier_valid_backup_restore_preserves_records',
    pass: validRestoreResult.products === 1 && validRestoreResult.transactions === 1 && validRestoreResult.storeName === 'Backup Restore Verification' && validRestoreResult.productId === 'restore-roundtrip-product' && validRestoreResult.transactionId === 'restore-roundtrip-transaction' && validRestoreResult.toast.includes('Backup berhasil dipulihkan'),
    expected: { products: 1, transactions: 1, storeName: 'Backup Restore Verification' },
    actual: validRestoreResult
  });

  // Stock-in must reject additions that exceed JavaScript's safe integer range.
  await page.evaluate(() => {
    const key = 'nbbntools_kasir_v1';
    const data = JSON.parse(localStorage.getItem(key));
    let product = data.products.find(p => p.name === 'Browser Test Product');
    if (!product) {
      product = { id: 'overflow-stock-test-product', name: 'Browser Test Product', category: 'Testing', barcode: 'OVERFLOW-STOCK-TEST', cost: 1, price: 2, stock: 0, emoji: '🧪', active: true };
      data.products.push(product);
    }
    product.stock = Number.MAX_SAFE_INTEGER;
    localStorage.setItem(key, JSON.stringify(data));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('button[data-panel="products"]').click();
  let stockPromptCount = 0;
  page.on('dialog', async dialog => {
    if (dialog.type() === 'prompt') await dialog.accept(stockPromptCount++ === 0 ? '1' : 'test overflow');
    else await dialog.accept();
  });
  await page.locator('#productsTable tr').filter({ hasText: 'Browser Test Product' }).locator('button[data-action="stock"]').click();
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Stok melebihi batas angka aman'));
  const overflowStock = await page.evaluate(() => JSON.parse(localStorage.getItem('nbbntools_kasir_v1')).products.find(p => p.name === 'Browser Test Product').stock);
  report.checks.push({ name: 'cashier_stock_in_rejects_safe_integer_overflow', pass: overflowStock === Number.MAX_SAFE_INTEGER, actual: overflowStock });

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
