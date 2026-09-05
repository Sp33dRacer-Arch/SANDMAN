(() => {
  'use strict';

  const state = {
    token: null,
    user: null,
    view: 'overview',
    cache: {},
    searchTimer: null,
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const loginView = $('#login-view');
  const appShell = $('#app-shell');
  const viewRoot = $('#view-root');
  const pageHeading = $('#page-heading');
  const modalRoot = $('#modal-root');
  const toastRoot = $('#toast-root');

  const THEME_KEY = 'sandman-theme';
  try { const savedTheme = localStorage.getItem(THEME_KEY); document.documentElement.dataset.theme = savedTheme === 'dark' ? 'dark' : 'light'; }
  catch { document.documentElement.dataset.theme = 'light'; }
  function currentTheme() { return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'; }
  function syncThemeUi() {
    const light = currentTheme() === 'light';
    $$('[data-theme-toggle]').forEach(button => {
      const icon = button.querySelector('.theme-icon');
      const label = button.querySelector('.theme-label');
      if (icon) icon.textContent = light ? '☾' : '☼';
      if (label) label.textContent = light ? 'Dark mode' : 'Light mode';
      button.setAttribute('aria-label', light ? 'Switch to dark mode' : 'Switch to light mode');
      button.title = light ? 'Switch to dark mode' : 'Switch to light mode';
    });
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = light ? '#f4f1e8' : '#0b0b0a';
  }
  function setTheme(theme, persist = true) {
    const next = theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    if (persist) { try { localStorage.setItem(THEME_KEY, next); } catch {} }
    syncThemeUi();
  }
  function toggleTheme() { setTheme(currentTheme() === 'light' ? 'dark' : 'light'); }


  function setAdminMenu(open) {
    const sidebar = $('#admin-sidebar');
    const backdrop = $('#sidebar-backdrop');
    const button = $('#mobile-menu-button');
    sidebar?.classList.toggle('open', open);
    backdrop?.classList.toggle('open', open);
    document.body.classList.toggle('admin-menu-open', open);
    button?.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function enhanceResponsiveTables(root = document) {
    $$('.table-wrap table', root).forEach(table => {
      const labels = $$('thead th', table).map(th => th.textContent.trim());
      if (!labels.length) return;
      table.classList.add('responsive-table');
      $$('tbody tr', table).forEach(row => {
        [...row.children].forEach((cell, index) => {
          if (cell.tagName !== 'TD') return;
          if (cell.colSpan > 1) { cell.dataset.label = ''; cell.classList.add('table-empty-cell'); return; }
          cell.dataset.label = labels[index] || (index === row.children.length - 1 ? 'Action' : '');
        });
      });
    });
  }

  function safeJson(value) {
    try { return value ? JSON.parse(value) : null; } catch { return null; }
  }

  function esc(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function money(cents = 0, currency = 'USD') {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format((Number(cents) || 0) / 100);
  }

  function compactMoney(cents = 0, currency = 'USD') {
    const value = (Number(cents) || 0) / 100;
    if (value >= 1_000_000) return `${currency === 'USD' ? '$' : ''}${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 10_000) return `${currency === 'USD' ? '$' : ''}${(value / 1_000).toFixed(1)}K`;
    return money(cents, currency);
  }

  function dateTime(value) {
    if (!value) return '—';
    return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  }

  function shortDate(value) {
    if (!value) return '—';
    return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short' }).format(new Date(value));
  }

  function badge(status) {
    const raw = String(status || 'UNKNOWN');
    const cls = raw.toLowerCase();
    return `<span class="badge badge-${esc(cls)}">${esc(raw.replaceAll('_', ' '))}</span>`;
  }

  function toast(title, message = '', type = 'success') {
    const node = document.createElement('div');
    node.className = `toast ${type === 'error' ? 'error' : ''}`;
    node.innerHTML = `<i class="toast-mark"></i><div><strong>${esc(title)}</strong>${message ? `<span>${esc(message)}</span>` : ''}</div>`;
    toastRoot.appendChild(node);
    setTimeout(() => node.remove(), 3600);
  }

  async function refreshSession() {
    try {
      const response = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' });
      if (!response.ok) return false;
      const data = await response.json();
      if (!['ADMIN', 'STAFF'].includes(data.user?.role)) return false;
      setSession(data.token, data.user);
      return true;
    } catch { return false; }
  }

  async function api(path, options = {}, retry = true) {
    const headers = { ...(options.headers || {}) };
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    if (state.token) headers.Authorization = `Bearer ${state.token}`;

    const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json() : await response.text();

    if (response.status === 401 && retry && !path.includes('/auth/login') && !path.includes('/auth/refresh')) {
      if (await refreshSession()) return api(path, options, false);
      logout(false);
      throw new Error('Your admin session expired. Please sign in again.');
    }
    if (!response.ok) {
      const message = data?.error?.message || data?.error || data?.message || (typeof data === 'string' && data) || `Request failed (${response.status})`;
      throw new Error(message);
    }
    return data;
  }

  async function uploadAdminProductImages(files) {
    const chosen = [...(files || [])];
    if (!chosen.length) return [];
    if (chosen.length > 8) throw new Error('You can upload up to 8 images at a time.');
    const output = [];
    for (const file of chosen) {
      if (!['image/jpeg','image/png','image/webp'].includes(file.type)) throw new Error(`${file.name} must be JPG, PNG or WebP.`);
      if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} is larger than 10 MB.`);
      const signature = await api('/api/uploads/signature', { method:'POST', body:JSON.stringify({ purpose:'catalogue' }) });
      const body = new FormData();
      body.append('file', file);
      body.append('api_key', signature.apiKey);
      body.append('timestamp', String(signature.timestamp));
      body.append('folder', signature.folder);
      body.append('public_id', signature.publicId);
      body.append('signature', signature.signature);
      const response = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(signature.cloudName)}/image/upload`, { method:'POST', body });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.secure_url) throw new Error(data?.error?.message || `Could not upload ${file.name}.`);
      output.push({ url:data.secure_url, alt:file.name.replace(/\.[^.]+$/, '').slice(0, 240), position:output.length });
    }
    return output;
  }

  function renderAdminProductImages(form) {
    const images = form._sandmanImages || [];
    const list = $('[data-admin-image-list]', form);
    const count = $('[data-admin-image-count]', form);
    if (count) count.textContent = `${images.length}/8`;
    if (!list) return;
    list.innerHTML = images.length ? images.map((image,index) => `<figure class="admin-upload-thumb"><img src="${esc(image.url)}" alt="${esc(image.alt || '')}"><button type="button" data-admin-remove-image="${index}" aria-label="Remove image">×</button>${index === 0 ? '<figcaption>Cover</figcaption>' : ''}</figure>`).join('') : '<div class="admin-upload-empty">No product images yet.</div>';
    $$('[data-admin-remove-image]', list).forEach(button => button.onclick = () => { images.splice(Number(button.dataset.adminRemoveImage),1); images.forEach((image,index) => image.position=index); renderAdminProductImages(form); });
  }

  async function checkApi() {
    const loginStatus = $('#login-api-status');
    const apiPill = $('#api-pill');
    try {
      await api('/api/health');
      if (loginStatus) loginStatus.textContent = 'online';
      if (apiPill) apiPill.innerHTML = '<i class="status-dot"></i> LIVE API';
      return true;
    } catch {
      if (loginStatus) loginStatus.textContent = 'offline';
      if (apiPill) apiPill.innerHTML = '<i class="status-dot bad"></i> API OFFLINE';
      return false;
    }
  }

  function setSession(token, user) {
    state.token = token;
    state.user = user;
    // Access tokens are intentionally memory-only. The HttpOnly refresh
    // cookie is what remembers this browser securely.
  }

  function logout(showMessage = true) {
    fetch('/api/auth/logout', { method:'POST', credentials:'same-origin', headers: state.token ? { Authorization:`Bearer ${state.token}` } : {} }).catch(() => {});
    state.token = null;
    state.user = null;

    appShell.hidden = true;
    loginView.hidden = false;
    closeModal();
    if (showMessage) toast('Signed out', 'Your SANDMAN admin session has ended.');
  }

  async function validateSession() {
    if (!state.token && !(await refreshSession())) return false;
    try {
      const user = await api('/api/auth/me');
      if (!['ADMIN', 'STAFF'].includes(user.role)) throw new Error('This account does not have admin access.');
      state.user = user;
      return true;
    } catch {
      logout(false);
      return false;
    }
  }

  function enterApp() {
    loginView.hidden = true;
    appShell.hidden = false;
    const name = [state.user?.firstName, state.user?.lastName].filter(Boolean).join(' ') || 'SANDMAN Admin';
    $('#user-name').textContent = name;
    $('#user-email').textContent = state.user?.email || '';
    $('#user-avatar').textContent = (state.user?.firstName?.[0] || 'S') + (state.user?.lastName?.[0] || 'A');
    navigate('overview');
  }

  function heading(title, description, actions = '') {
    pageHeading.innerHTML = `
      <div><h1>${esc(title)}</h1><p>${esc(description)}</p></div>
      <div class="heading-meta">${actions || `<span class="date-chip">${new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }).format(new Date())}</span>`}</div>
    `;
  }

  function setActiveNav(view) {
    $$('.nav-item').forEach(btn => btn.classList.toggle('active', btn.dataset.view === view));
  }

  async function navigate(view) {
    state.view = view;
    setActiveNav(view);
    setAdminMenu(false);
    viewRoot.innerHTML = `<div class="empty-state"><div><b>Loading ${esc(view)}…</b><span>Syncing with SANDMAN API</span></div></div>`;
    try {
      if (view === 'overview') await renderOverview();
      else if (view === 'products') await renderProducts();
      else if (view === 'orders') await renderOrders();
      else if (view === 'inventory') await renderInventory();
      else if (view === 'suppliers') await renderSuppliers();
      else if (view === 'vehicles') await renderVehicles();
      else if (view === 'sourcing') await renderSourcing();
      else if (view === 'fulfillment') await renderFulfillment();
      else if (view === 'operations') await renderOperations();
      else if (view === 'customers') await renderCustomerIntelligence();
      else if (view === 'commerce') await renderCommerce();
      else if (view === 'analytics') await renderAnalyticsV25();
      else if (view === 'trust') await renderTrust();
      else if (view === 'readiness') await renderReadiness();
      else if (view === 'settings') await renderSettings();
    } catch (error) {
      viewRoot.innerHTML = `<div class="empty-state"><div><b>Could not load this page</b><span>${esc(error.message)}</span></div></div>`;
      toast('Request failed', error.message, 'error');
    }
  }

  async function renderOverview() {
    heading('Command center', 'Store health, sales, stock and fulfillment at a glance.');
    const data = await api('/api/admin/dashboard');
    state.cache.dashboard = data;
    $('#nav-products-count').textContent = data.activeProducts || '';
    $('#nav-orders-count').textContent = data.pendingOrders || '';

    const maxRevenue = Math.max(1, ...data.sales7d.map(row => row.revenueCents));
    const chart = data.sales7d.map(row => {
      const height = Math.max(2, Math.round((row.revenueCents / maxRevenue) * 100));
      return `<div class="chart-col"><span class="chart-value">${esc(compactMoney(row.revenueCents))}</span><div class="chart-bar-wrap"><div class="chart-bar" style="height:${height}%"></div></div><span class="chart-label">${esc(new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(new Date(`${row.date}T12:00:00Z`)))}</span></div>`;
    }).join('');

    const recentOrders = data.recentOrders.length ? data.recentOrders.map(order => `
      <tr data-order-id="${esc(order.id)}" class="clickable-order">
        <td><strong>${esc(order.orderNumber)}</strong></td>
        <td>${esc(order.email)}</td>
        <td>${badge(order.status)}</td>
        <td>${badge(order.paymentStatus)}</td>
        <td class="text-right"><strong>${esc(money(order.totalCents, order.currency))}</strong></td>
        <td class="text-right">${esc(shortDate(order.createdAt))}</td>
      </tr>`).join('') : `<tr><td colspan="6"><div class="empty-state"><div><b>No orders yet</b><span>Orders will appear here when customers check out.</span></div></div></td></tr>`;

    const lowStock = data.lowStock.length ? data.lowStock.map(item => `
      <div class="alert-row"><div><strong>${esc(item.product)}</strong><small>${esc(item.sku)} · ${esc(item.supplier)}</small></div><div class="stock-number">${esc(item.stock ?? '—')}</div></div>`).join('') : `<div class="empty-state"><div><b>Inventory healthy</b><span>No supplier items are below 10 units.</span></div></div>`;

    viewRoot.innerHTML = `
      <section class="metric-grid">
        ${metric('Gross revenue', compactMoney(data.revenueCents), `${data.orders} lifetime orders`, '↗')}
        ${metric('Active products', data.activeProducts, 'Ready for storefront', '◇')}
        ${metric('Open orders', data.pendingOrders, data.failedFulfillments ? `${data.failedFulfillments} fulfillment failures` : 'Fulfillment pipeline clear', '▤')}
        ${metric('Customers', data.customers, `${data.activeSuppliers} active suppliers`, '◉')}
      </section>
      <section class="dashboard-grid">
        <div class="panel">
          <div class="panel-header"><h2>Sales velocity</h2><span class="subtle">LAST 7 DAYS · PROFIT EST. ${esc(compactMoney(data.recentProfitCents))}</span></div>
          <div class="sales-chart">${chart}</div>
        </div>
        <div class="panel">
          <div class="panel-header"><h2>Low stock watch</h2><span class="subtle">≤ 10 UNITS</span></div>
          <div class="alert-list">${lowStock}</div>
        </div>
      </section>
      <section class="data-panel">
        <div class="panel-header"><h2>Recent orders</h2><button class="table-action" data-nav="orders">VIEW ALL →</button></div>
        <div class="table-wrap"><table><thead><tr><th>Order</th><th>Customer</th><th>Status</th><th>Payment</th><th class="text-right">Total</th><th class="text-right">Date</th></tr></thead><tbody>${recentOrders}</tbody></table></div>
      </section>`;
  }

  function metric(label, value, sub, icon) {
    return `<article class="metric-card"><div class="metric-top"><span>${esc(label)}</span><span class="metric-icon">${esc(icon)}</span></div><div><div class="metric-value">${esc(value)}</div><div class="metric-sub">${esc(sub)}</div></div></article>`;
  }

  async function renderProducts(filters = {}) {
    heading('Products', 'Manage parts, pricing, fitment and storefront status.', '<button class="btn btn-primary" data-action="add-product">＋ New product</button>');
    const qs = new URLSearchParams();
    if (filters.q) qs.set('q', filters.q);
    if (filters.status) qs.set('status', filters.status);
    const [data, categories] = await Promise.all([
      api(`/api/admin/products?${qs}`),
      api('/api/admin/categories'),
    ]);
    state.cache.products = data.items;
    state.cache.categories = categories;
    $('#nav-products-count').textContent = data.total || '';

    const rows = data.items.length ? data.items.map(product => {
      const supplier = product.supplierLinks?.[0];
      const landed = supplier ? supplier.costCents + supplier.shippingCents : null;
      const margin = landed !== null && product.priceCents > 0 ? Math.round(((product.priceCents - landed) / product.priceCents) * 100) : null;
      const image = product.images?.[0]?.url
        ? `<img class="product-thumb" src="${esc(product.images[0].url)}" alt="" />`
        : `<span class="product-thumb placeholder">◇</span>`;
      return `<tr>
        <td><div class="cell-title">${image}<div class="cell-title-copy"><strong>${esc(product.name)}</strong><small>${esc(product.sku)}</small></div></div></td>
        <td>${esc(product.category?.name || '—')}</td>
        <td>${esc(product.brand || '—')}</td>
        <td>${badge(product.status)}</td>
        <td><strong>${esc(money(product.priceCents, product.currency))}</strong></td>
        <td>${supplier ? esc(money(landed, supplier.currency)) : '—'}</td>
        <td>${margin === null ? '—' : `${margin}%`}</td>
        <td>${esc(product._count?.fitments ?? 0)}</td>
        <td class="text-right"><button class="table-action" data-action="edit-product" data-id="${esc(product.id)}">EDIT →</button></td>
      </tr>`;
    }).join('') : `<tr><td colspan="9"><div class="empty-state"><div><b>No products found</b><span>Try a different filter or add your first product.</span></div></div></td></tr>`;

    viewRoot.innerHTML = `
      <div class="toolbar">
        <div class="toolbar-left">
          <input id="product-search" type="search" value="${esc(filters.q || '')}" placeholder="Search name, SKU, brand or part number…" />
          <select id="product-status"><option value="">All statuses</option>${['ACTIVE','DRAFT','ARCHIVED'].map(v => `<option ${filters.status === v ? 'selected' : ''}>${v}</option>`).join('')}</select>
        </div>
        <div class="toolbar-right"><span class="date-chip">${data.total} PRODUCTS</span></div>
      </div>
      <section class="data-panel"><div class="table-wrap"><table>
        <thead><tr><th>Part</th><th>Category</th><th>Brand</th><th>Status</th><th>Retail</th><th>Landed cost</th><th>Margin</th><th>Fitments</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div></section>`;
  }

  async function renderOrders(filters = {}) {
    heading('Orders', 'Payments, customer orders and supplier handoff.', '');
    const qs = new URLSearchParams();
    if (filters.q) qs.set('q', filters.q);
    if (filters.status) qs.set('status', filters.status);
    const orders = await api(`/api/admin/orders?${qs}`);
    state.cache.orders = orders;

    const rows = orders.length ? orders.map(order => `
      <tr>
        <td><strong>${esc(order.orderNumber)}</strong><br><span class="subtle">${esc(shortDate(order.createdAt))}</span></td>
        <td>${esc(order.user ? ([order.user.firstName, order.user.lastName].filter(Boolean).join(' ') || order.email) : order.email)}</td>
        <td>${esc(order.items.reduce((sum, item) => sum + item.quantity, 0))}</td>
        <td>${badge(order.status)}</td>
        <td>${badge(order.paymentStatus)}</td>
        <td>${order.fulfillments.length ? badge(order.fulfillments[0].status) : '<span class="subtle">Not submitted</span>'}</td>
        <td class="text-right"><strong>${esc(money(order.totalCents, order.currency))}</strong></td>
        <td class="text-right"><button class="table-action" data-action="view-order" data-id="${esc(order.id)}">OPEN →</button></td>
      </tr>`).join('') : `<tr><td colspan="8"><div class="empty-state"><div><b>No matching orders</b><span>New customer orders will appear here.</span></div></div></td></tr>`;

    const statusOptions = ['PENDING_PAYMENT','PAID','PROCESSING','SUBMITTED_TO_SUPPLIER','PARTIALLY_FULFILLED','FULFILLED','CANCELLED','REFUNDED','FAILED'];
    viewRoot.innerHTML = `
      <div class="toolbar"><div class="toolbar-left">
        <input id="order-search" type="search" value="${esc(filters.q || '')}" placeholder="Search order number or email…" />
        <select id="order-status"><option value="">All statuses</option>${statusOptions.map(v => `<option value="${v}" ${filters.status === v ? 'selected' : ''}>${v.replaceAll('_',' ')}</option>`).join('')}</select>
      </div><div class="toolbar-right"><span class="date-chip">${orders.length} SHOWN</span></div></div>
      <section class="data-panel"><div class="table-wrap"><table><thead><tr><th>Order</th><th>Customer</th><th>Items</th><th>Status</th><th>Payment</th><th>Fulfillment</th><th class="text-right">Total</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }

  async function renderInventory() {
    heading('Inventory', 'Supplier stock, landed cost and margin intelligence.', '<button class="btn btn-primary" data-action="link-supplier-product">＋ Link supplier SKU</button>');
    const items = await api('/api/admin/supplier-products');
    state.cache.inventory = items;
    const rows = items.length ? items.map(item => {
      const landed = item.costCents + item.shippingCents;
      const profit = item.product.priceCents - landed;
      const margin = item.product.priceCents ? Math.round((profit / item.product.priceCents) * 100) : 0;
      return `<tr>
        <td><strong>${esc(item.product.name)}</strong><br><span class="subtle">${esc(item.product.sku)}</span></td>
        <td>${esc(item.supplier.name)}</td>
        <td>${esc(item.supplierSku || item.supplierProductId)}</td>
        <td>${esc(money(item.costCents, item.currency))}</td>
        <td>${esc(money(item.shippingCents, item.currency))}</td>
        <td><strong>${esc(money(landed, item.currency))}</strong></td>
        <td><strong>${esc(money(profit, item.currency))}</strong> <span class="subtle">(${margin}%)</span></td>
        <td>${item.availableStock === null ? '—' : `<span class="${item.availableStock <= 10 ? 'stock-number' : ''}">${esc(item.availableStock)}</span>`}${item.reservedStock ? `<span class="subtle"> · ${esc(item.reservedStock)} reserved</span>` : ''}</td>
        <td>${badge(item.active ? 'ACTIVE' : 'ARCHIVED')}</td>
      </tr>`;
    }).join('') : `<tr><td colspan="9"><div class="empty-state"><div><b>No supplier inventory</b><span>Link a supplier SKU to a SANDMAN product.</span></div></div></td></tr>`;
    viewRoot.innerHTML = `<section class="data-panel"><div class="table-wrap"><table><thead><tr><th>Product</th><th>Supplier</th><th>Supplier SKU</th><th>Cost</th><th>Shipping</th><th>Landed</th><th>Gross profit</th><th>Stock</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }

  async function renderSuppliers() {
    heading('Suppliers', 'Routing priority, connected catalogues and fulfillment sources.', '<button class="btn btn-primary" data-action="add-supplier">＋ Add supplier</button>');
    const suppliers = await api('/api/admin/suppliers');
    state.cache.suppliers = suppliers;
    const cards = suppliers.length ? suppliers.map(supplier => `
      <article class="supplier-card">
        <div class="supplier-card-head"><div class="supplier-symbol">${esc((supplier.code || supplier.name).slice(0,2).toUpperCase())}</div>${badge(supplier.active ? 'ACTIVE' : 'ARCHIVED')}</div>
        <h3>${esc(supplier.name)}</h3><p>${esc(supplier.type)} · priority ${esc(supplier.priority)} · ${esc(supplier.code)}</p>
        <div class="supplier-stats"><span>${esc(supplier._count.products)} linked SKUs</span><span>${esc(supplier._count.fulfillments)} fulfillments</span></div>
      </article>`).join('') : `<div class="empty-state"><div><b>No suppliers</b><span>Add CJ, a wholesaler, or a custom supplier.</span></div></div>`;
    viewRoot.innerHTML = `<section class="supplier-grid">${cards}</section><section class="panel panel-pad"><div class="eyebrow">ROUTING LOGIC</div><p style="font-size:11px;color:var(--muted);line-height:1.7;margin:0">At checkout SANDMAN compares active supplier links for each product. Your backend can route orders by supplier priority, stock and landed cost, then split a cart across multiple fulfillment sources.</p></section>`;
  }

  async function renderVehicles(filters = {}) {
    heading('Vehicle fitment', 'Your compatibility database: make, model, chassis and engine code.', '<button class="btn" data-action="add-model">＋ Make / model</button><button class="btn btn-primary" data-action="add-vehicle">＋ Engine variant</button>');
    const qs = new URLSearchParams();
    if (filters.q) qs.set('q', filters.q);
    const variants = await api(`/api/admin/vehicles?${qs}`);
    state.cache.vehicles = variants;
    const cards = variants.length ? variants.map(v => `
      <article class="fitment-card">
        <span class="make">${esc(v.model.make.name)} · ${esc(v.chassisCode || 'CHASSIS N/A')}</span>
        <h3>${esc(v.model.name)} ${v.trim ? `· ${esc(v.trim)}` : ''}</h3>
        <div class="engine">${esc(v.engineCode)} — ${esc(v.engineName)}</div>
        <div class="fitment-meta"><span>${esc(v.yearStart)}–${esc(v.yearEnd)}</span><span>${esc(v._count.productFitments)} linked parts · ${esc(v._count.garageVehicles)} garages</span></div>
      </article>`).join('') : `<div class="empty-state"><div><b>No vehicle variants found</b><span>Add an engine variant or change your search.</span></div></div>`;
    viewRoot.innerHTML = `
      <div class="toolbar"><div class="toolbar-left"><input id="vehicle-search" type="search" value="${esc(filters.q || '')}" placeholder="Search BMW, B58, EA888, chassis…" /></div><div class="toolbar-right"><span class="date-chip">${variants.length} VARIANTS</span></div></div>
      <section class="fitment-card-grid">${cards}</section>`;
  }

  async function renderSourcing() {
    heading('Sourcing desk', 'Missing vehicles, requested parts and catalogue health in one queue.');
    const [requests, health] = await Promise.all([
      api('/api/v2/admin/requests'),
      api('/api/v2/admin/catalog-health'),
    ]);
    const openCount = Number(health.openVehicleRequests || 0) + Number(health.openPartRequests || 0);
    const sourcingCount = $('#nav-sourcing-count');
    if (sourcingCount) sourcingCount.textContent = openCount || '';

    const vehicleRows = requests.vehicleRequests?.length ? requests.vehicleRequests.map(item => `
      <tr>
        <td><strong>${esc(item.make)} ${esc(item.model)}</strong><br><span class="subtle">${esc([item.year, item.trim, item.engineCode].filter(Boolean).join(' · ') || 'Details not supplied')}</span></td>
        <td>${esc(item.user?.email || item.email || '—')}</td>
        <td>${badge(item.status)}</td>
        <td>${esc(shortDate(item.createdAt))}</td>
        <td class="text-right"><select class="request-status-select" data-kind="vehicle" data-id="${esc(item.id)}">${['OPEN','REVIEWING','SOURCED','CLOSED'].map(v => `<option value="${v}" ${item.status === v ? 'selected' : ''}>${v.replaceAll('_',' ')}</option>`).join('')}</select></td>
      </tr>`).join('') : '<tr><td colspan="5"><div class="empty-state"><div><b>No vehicle requests</b><span>Missing-car requests from shoppers appear here.</span></div></div></td></tr>';

    const partRows = requests.partRequests?.length ? requests.partRequests.map(item => {
      const vehicle = item.vehicleVariant ? `${item.vehicleVariant.model.make.name} ${item.vehicleVariant.model.name} · ${item.vehicleVariant.engineCode}` : 'Vehicle not linked';
      return `<tr>
        <td><strong>${esc(item.partName)}</strong><br><span class="subtle">${esc(item.oemNumber || 'No OEM number')} · ${esc(vehicle)}</span></td>
        <td>${esc(item.user?.email || item.email || '—')}</td>
        <td>${item.budgetCents == null ? '—' : `<strong>${esc(money(item.budgetCents))}</strong>`}</td>
        <td>${badge(item.status)}</td>
        <td class="text-right"><select class="request-status-select" data-kind="part" data-id="${esc(item.id)}">${['OPEN','REVIEWING','SOURCED','CLOSED'].map(v => `<option value="${v}" ${item.status === v ? 'selected' : ''}>${v.replaceAll('_',' ')}</option>`).join('')}</select></td>
      </tr>`;
    }).join('') : '<tr><td colspan="5"><div class="empty-state"><div><b>No part requests</b><span>Customer sourcing requests appear here.</span></div></div></td></tr>';

    viewRoot.innerHTML = `
      <section class="metric-grid">
        ${metric('Unverified fitments', health.unverifiedFitments, 'Needs fitment review', '◇')}
        ${metric('Fitment gaps', health.activeProductsWithoutFitment, 'Active vehicle-specific parts', '⌁')}
        ${metric('Missing images', health.productsWithoutImages, 'Active product pages', '▧')}
        ${metric('Open sourcing', openCount, `${health.openVehicleRequests} vehicles · ${health.openPartRequests} parts`, '⌕')}
      </section>
      <section class="data-panel">
        <div class="panel-header"><h2>Vehicle requests</h2><span class="subtle">CUSTOMER CATALOGUE GAPS</span></div>
        <div class="table-wrap"><table><thead><tr><th>Vehicle</th><th>Customer</th><th>Status</th><th>Requested</th><th class="text-right">Workflow</th></tr></thead><tbody>${vehicleRows}</tbody></table></div>
      </section>
      <section class="data-panel sourcing-gap">
        <div class="panel-header"><h2>Part sourcing requests</h2><span class="subtle">PARTS NOT YET IN CATALOGUE</span></div>
        <div class="table-wrap"><table><thead><tr><th>Part</th><th>Customer</th><th>Budget</th><th>Status</th><th class="text-right">Workflow</th></tr></thead><tbody>${partRows}</tbody></table></div>
      </section>`;
  }

  async function renderFulfillment() {
    heading('Fulfillment', 'Supplier submissions, tracking and delivery state.');
    const items = await api('/api/admin/fulfillments');
    state.cache.fulfillments = items;
    const rows = items.length ? items.map(item => `
      <tr><td><strong>${esc(item.order.orderNumber)}</strong><br><span class="subtle">${esc(item.order.email)}</span></td><td>${esc(item.supplier.name)}</td><td>${badge(item.status)}</td><td>${esc(item.supplierOrderId || '—')}</td><td>${esc(item.carrier || '—')}</td><td>${esc(item.trackingNumber || '—')}</td><td>${esc(dateTime(item.updatedAt))}</td>${item.supplier.type === 'SYNCEE' ? `<td class="text-right"><button class="table-action" data-action="syncee-fulfillment" data-id="${esc(item.id)}">SYNCEE ↗</button></td>` : item.supplierOrderId ? `<td class="text-right"><button class="table-action" data-action="refresh-fulfillment" data-id="${esc(item.id)}">REFRESH ↻</button></td>` : '<td></td>'}</tr>`).join('') : `<tr><td colspan="8"><div class="empty-state"><div><b>No fulfillments yet</b><span>Paid orders submitted to suppliers appear here.</span></div></div></td></tr>`;
    viewRoot.innerHTML = `<section class="data-panel"><div class="table-wrap"><table><thead><tr><th>Order</th><th>Supplier</th><th>Status</th><th>Supplier order</th><th>Carrier</th><th>Tracking</th><th>Updated</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }

  async function renderCustomerIntelligence(filters = {}) {
    heading('Customer Intelligence', 'Customer 360° records, value, purchases, Garage, marketplace activity, support and trust.');
    const qs = new URLSearchParams();
    if (filters.q) qs.set('q', filters.q);
    if (filters.status) qs.set('status', filters.status);
    if (filters.sort) qs.set('sort', filters.sort);
    const [summary, data] = await Promise.all([
      api('/api/admin/customer-intelligence/summary'),
      api(`/api/admin/customer-intelligence/customers?${qs}`),
    ]);
    state.cache.customers = data.items;
    const rows = data.items.length ? data.items.map(customer => `<tr>
      <td><div class="cell-title"><span class="avatar">${esc((customer.firstName?.[0]||customer.email[0]||'C').toUpperCase())}</span><div class="cell-title-copy"><strong>${esc([customer.firstName,customer.lastName].filter(Boolean).join(' ')||customer.username||'Customer')}</strong><small>${esc(customer.email)}${customer.country?` · ${esc(customer.country)}`:''}</small></div></div></td>
      <td><strong>${esc(money(customer.netLifetimeValueCents))}</strong><br><span class="subtle">gross ${esc(money(customer.grossPaidSpendCents))} · refunds ${esc(money(customer.refundCents))}</span></td>
      <td>${esc(customer.paidOrderCount)}<br><span class="subtle">AOV ${esc(money(customer.averageOrderValueCents))}</span></td>
      <td><div class="customer-tag-list">${[...customer.segments,...customer.tags].slice(0,5).map(tag=>`<span>${esc(tag.replaceAll('_',' '))}</span>`).join('')||'<span>STANDARD</span>'}</div></td>
      <td>${customer.emailVerifiedAt?'EMAIL ✓':'EMAIL —'}<br><span class="subtle">${customer.phoneVerifiedAt?'PHONE ✓':'PHONE —'} · ${customer.twoFactorEnabled?'2FA ✓':'2FA —'}</span></td>
      <td>${badge(customer.isActive?'ACTIVE':'INACTIVE')}</td>
      <td>${esc(shortDate(customer.lastActivityAt||customer.createdAt))}</td>
      <td><button class="table-action" data-action="view-customer-360" data-id="${esc(customer.id)}">360° →</button></td>
    </tr>`).join('') : '<tr><td colspan="8"><div class="empty-state"><div><b>No matching customers</b><span>Try another search or segment.</span></div></div></td></tr>';
    viewRoot.innerHTML = `<section class="metric-grid customer-metrics">${metric('Customers',summary.customerCount,`${summary.activeCount} active`,'◉')}${metric('Net customer revenue',money(summary.netRevenueCents),`Gross ${money(summary.grossRevenueCents)} · Refunds ${money(summary.refundsCents)}`,'$')}${metric('Avg customer value',money(summary.avgCustomerValueCents),`${summary.customersWithOrders} buyers`,'◇')}${metric('Repeat purchase',`${Math.round(summary.repeatPurchaseRate*100)}%`,`${summary.repeatCustomers} repeat buyers`,'↻')}</section>
      <div class="toolbar"><div class="toolbar-left"><input id="customer-search" type="search" value="${esc(filters.q||'')}" placeholder="Name, email, username, phone or order…"><select id="customer-status"><option value="ALL">All customers</option>${['ACTIVE','INACTIVE','VERIFIED','DEALER','HIGH_VALUE','VIP','AT_RISK'].map(v=>`<option value="${v}" ${filters.status===v?'selected':''}>${v.replaceAll('_',' ')}</option>`).join('')}</select><select id="customer-sort">${[['newest','Newest'],['activity_desc','Last active'],['spend_desc','Highest net value'],['orders_desc','Most orders'],['oldest','Oldest']].map(([v,l])=>`<option value="${v}" ${filters.sort===v?'selected':''}>${l}</option>`).join('')}</select></div><div class="toolbar-right"><span class="date-chip">${esc(data.total)} RECORDS</span></div></div>
      <section class="data-panel"><div class="table-wrap"><table><thead><tr><th>Customer</th><th>Net lifetime value</th><th>Orders</th><th>Segments / tags</th><th>Verification</th><th>Status</th><th>Last active</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
    enhanceResponsiveTables(viewRoot);
  }
  const renderCustomers = renderCustomerIntelligence;

  async function openCustomer360(id) {
    const data = await api(`/api/admin/customer-intelligence/customers/${encodeURIComponent(id)}`);
    const c=data.customer,m=data.metrics;
    const orders=data.orders.length?data.orders.map(order=>`<tr><td><strong>${esc(order.orderNumber)}</strong><br><span class="subtle">${esc(shortDate(order.createdAt))}</span></td><td>${badge(order.status)}</td><td>${badge(order.paymentStatus)}</td><td>${esc(order.items.length)}</td><td><strong>${esc(money(order.totalCents,order.currency))}</strong></td><td><button class="table-action" data-action="view-order" data-id="${esc(order.id)}">OPEN →</button></td></tr>`).join(''):'<tr><td colspan="6">No orders.</td></tr>';
    const garage=data.garage.length?data.garage.map(g=>`<article class="customer-vehicle"><span>${g.isPrimary?'PRIMARY VEHICLE':'GARAGE'}</span><strong>${esc(`${g.year} ${g.vehicleVariant.model.make.name} ${g.vehicleVariant.model.name}`)}</strong><small>${esc(g.vehicleVariant.engineCode)}${g.vehicleVariant.chassisCode?` · ${esc(g.vehicleVariant.chassisCode)}`:''}${g.maskedVin?` · VIN ${esc(g.maskedVin)}`:''}</small></article>`).join(''):'<p class="subtle">No Garage vehicles.</p>';
    const support=data.supportCases.length?data.supportCases.map(item=>`<div class="timeline-row"><strong>${esc(item.type.replaceAll('_',' '))} · ${esc(item.status.replaceAll('_',' '))}</strong><small>${esc(item.order?.orderNumber||'No order')} · ${esc(shortDate(item.createdAt))}</small></div>`).join(''):'<span class="subtle">No support cases.</span>';
    const wishlist=data.wishlist.length?data.wishlist.map(item=>`<div class="timeline-row"><strong>${esc(item.product.name)}</strong><small>${esc(item.product.sku)} · ${esc(money(item.product.priceCents,item.product.currency))}</small></div>`).join(''):'<span class="subtle">No wishlist items.</span>';
    const reviews=data.reviews.length?data.reviews.map(item=>`<div class="timeline-row"><strong>${esc(item.rating)}★ · ${esc(item.product.name)}</strong><small>${item.verifiedPurchase?'Verified purchase · ':''}${esc(shortDate(item.createdAt))}</small></div>`).join(''):'<span class="subtle">No reviews.</span>';
    const listings=data.listings.length?data.listings.map(item=>`<div class="timeline-row"><strong>${esc(item.name)}</strong><small>${esc(item.status)} · ${esc(money(item.priceCents,item.currency))} · ${esc(item.purchaseCount)} sold</small></div>`).join(''):'<span class="subtle">No marketplace listings.</span>';
    const notes=data.notes.length?data.notes.map(note=>`<div class="customer-note"><p>${esc(note.body)}</p><small>${esc([note.author.firstName,note.author.lastName].filter(Boolean).join(' ')||note.author.email)} · ${esc(dateTime(note.createdAt))}</small>${state.user?.role==='ADMIN'?`<button class="table-action" data-action="delete-customer-note" data-customer-id="${esc(c.id)}" data-note-id="${esc(note.id)}">DELETE</button>`:''}</div>`).join(''):'<p class="subtle">No internal staff notes.</p>';
    const tags=data.tags.map(row=>`<button class="customer-tag" data-action="remove-customer-tag" data-customer-id="${esc(c.id)}" data-tag="${encodeURIComponent(row.tag)}">${esc(row.tag.replaceAll('_',' '))} ×</button>`).join('');
    const security=data.security.restricted?`<p class="subtle">Detailed IP/session history is restricted to ADMIN. 7-day summary: ${esc(data.security.summary.failedLogins7d)} failed logins · ${esc(data.security.summary.newDeviceLogins7d)} new-device events · ${esc(data.security.summary.openReports)} open reports.</p>`:(data.security.sessions.length?data.security.sessions.filter(x=>!x.revokedAt).slice(0,8).map(x=>`<div class="timeline-row"><strong>${esc(x.userAgent||'Unknown device')}</strong><small>${esc(x.ipAddress||'IP unavailable')} · ${esc(dateTime(x.lastUsedAt))}</small></div>`).join(''):'<span class="subtle">No active sessions.</span>');
    const timeline=data.timeline.length?data.timeline.map(item=>`<div class="customer-timeline-row"><span>${esc(item.type)}</span><strong>${esc(item.label)}</strong><small>${esc(dateTime(item.at))}</small></div>`).join(''):'<span class="subtle">No timeline activity.</span>';
    openModal(`<div class="modal-header"><div><span class="subtle">CUSTOMER 360° / ${esc(c.id)}</span><h2>${esc([c.firstName,c.lastName].filter(Boolean).join(' ')||c.username||'Customer')}</h2><p>${esc(c.email)} · Joined ${esc(shortDate(c.createdAt))}</p></div><button type="button" class="icon-btn" data-modal-close>×</button></div><div class="modal-body customer-360">
      <section class="customer-hero-grid"><div class="customer-identity-card"><span class="avatar avatar-xl">${esc((c.firstName?.[0]||c.email[0]||'C').toUpperCase())}</span><div><strong>${esc(c.email)}</strong><small>${esc(c.phone||'No phone')} · ${esc(c.country||'Country unknown')}</small><div class="customer-tag-list">${data.segments.map(x=>`<span>${esc(x.replaceAll('_',' '))}</span>`).join('')}</div></div></div><div class="detail-box"><span>Net LTV</span><strong>${esc(money(m.netLifetimeValueCents))}</strong><small>Gross ${esc(money(m.grossPaidSpendCents))}</small></div><div class="detail-box"><span>Refunds</span><strong>${esc(money(m.refundCents))}</strong><small>${esc(m.paidOrderCount)} paid orders</small></div><div class="detail-box"><span>AOV</span><strong>${esc(money(m.averageOrderValueCents))}</strong><small>${esc(m.daysSinceLastPurchase??'—')} days since purchase</small></div><div class="detail-box"><span>Risk</span><strong>${badge(data.risk.level)}</strong><small>Score ${esc(data.risk.score)}/100</small></div></section>
      <section class="customer-360-section"><div class="panel-header"><h3>Admin tags</h3><button class="btn" data-action="add-customer-tag" data-customer-id="${esc(c.id)}">＋ Tag</button></div><div class="customer-tag-list">${tags||'<span class="subtle">No admin tags.</span>'}</div></section>
      <section class="customer-360-section"><h3>Orders & purchases</h3><div class="table-wrap"><table><thead><tr><th>Order</th><th>Status</th><th>Payment</th><th>Items</th><th>Total</th><th></th></tr></thead><tbody>${orders}</tbody></table></div></section>
      <section class="customer-360-section"><h3>My Garage</h3><div class="customer-vehicle-grid">${garage}</div></section>
      <section class="customer-360-section"><h3>Marketplace / dealer</h3>${data.seller?`<div class="detail-grid"><div class="detail-box"><span>Store</span><strong>${esc(data.seller.storeName||'Seller')}</strong></div><div class="detail-box"><span>Sales</span><strong>${esc(data.seller.totalSales||0)}</strong></div><div class="detail-box"><span>Rating</span><strong>${Number(data.seller.ratingAverage||0).toFixed(1)}</strong></div><div class="detail-box"><span>Dealer</span><strong>${data.seller.dealerVerifiedAt?'VERIFIED':'NO'}</strong></div></div>`:'<p class="subtle">Not currently a seller.</p>'}<div class="customer-subgrid"><div><h4>Listings</h4>${listings}</div><div><h4>Wishlist</h4>${wishlist}</div><div><h4>Reviews</h4>${reviews}</div></div></section>
      <section class="customer-360-section"><h3>Support, returns & buyer protection</h3><div class="timeline">${support}</div></section>
      <section class="customer-360-section"><h3>Security</h3><div class="detail-grid"><div class="detail-box"><span>Email</span><strong>${c.emailVerified?'VERIFIED':'UNVERIFIED'}</strong></div><div class="detail-box"><span>Phone</span><strong>${c.phoneVerified?'VERIFIED':'UNVERIFIED'}</strong></div><div class="detail-box"><span>2FA</span><strong>${c.twoFactorEnabled?'ENABLED':'OFF'}</strong></div><div class="detail-box"><span>Last activity</span><strong>${esc(shortDate(m.lastActivityAt))}</strong></div></div><div class="timeline">${security}</div></section>
      <section class="customer-360-section"><div class="panel-header"><h3>Internal staff notes</h3><button class="btn" data-action="add-customer-note" data-customer-id="${esc(c.id)}">＋ Note</button></div>${notes}</section>
      <section class="customer-360-section"><h3>Customer timeline</h3><div class="customer-timeline">${timeline}</div></section>
      </div><div class="modal-footer">${state.user?.role==='ADMIN'?`<button class="btn ${c.isActive?'btn-danger':''}" data-action="toggle-customer-status" data-id="${esc(c.id)}" data-active="${c.isActive?'true':'false'}">${c.isActive?'Deactivate account':'Reactivate account'}</button>`:''}<button class="btn" data-modal-close>Close</button></div>`,'modal-xl');
    enhanceResponsiveTables(modalRoot);
  }

  async function renderCommerce() {
    heading('Global Commerce', 'Settlement currency, country rules, FX display, tax/VAT and shipping zones.', state.user?.role==='ADMIN'?'<button class="btn" data-action="commerce-add-region">＋ Region</button><button class="btn" data-action="commerce-add-fx">＋ FX</button><button class="btn" data-action="commerce-add-tax">＋ Tax</button><button class="btn btn-primary" data-action="commerce-add-zone">＋ Shipping zone</button>':'');
    const data=await api('/api/admin/commerce/overview');
    const regions=data.regions.length?data.regions.map(r=>`<tr><td><strong>${esc(r.country)}</strong></td><td>${esc(r.locale)}</td><td>${esc(r.currency)}</td><td>${r.shippingAllowed?'YES':'NO'}</td><td>${r.taxRequired?'YES':'NO'}</td><td>${r.dutiesRequired?'YES':'NO'}</td><td>${esc(Array.isArray(r.paymentMethods)?r.paymentMethods.join(', '):'—')}</td></tr>`).join(''):'<tr><td colspan="7">No commerce regions configured.</td></tr>';
    const fx=data.rates.length?data.rates.map(r=>`<tr><td>${esc(r.baseCurrency)} → ${esc(r.quoteCurrency)}</td><td><strong>${esc(r.rate)}</strong></td><td>${esc(r.source)}</td><td>${esc(dateTime(r.fetchedAt))}</td></tr>`).join(''):'<tr><td colspan="4">No FX rates.</td></tr>';
    const taxes=data.taxRules.length?data.taxRules.map(r=>`<tr><td>${esc(r.country)}${r.region?`-${esc(r.region)}`:''}</td><td>${esc(r.label)}</td><td>${esc(r.taxType)}</td><td>${(r.rateBps/100).toFixed(2)}%</td><td>${r.taxInclusive?'Inclusive':'Exclusive'}</td><td>${badge(r.active?'ACTIVE':'ARCHIVED')}</td></tr>`).join(''):'<tr><td colspan="6">No tax rules.</td></tr>';
    const zones=data.zones.length?data.zones.map(z=>`<tr><td><strong>${esc(z.name)}</strong></td><td>${esc(Array.isArray(z.countries)?z.countries.join(', '):'—')}</td><td>${esc(money(z.rateCents,z.currency))}</td><td>${z.freeShippingThresholdCents==null?'—':esc(money(z.freeShippingThresholdCents,z.currency))}</td><td>${esc([z.minDays,z.maxDays].filter(v=>v!=null).join('–')||'—')}</td><td>${badge(z.active?'ACTIVE':'ARCHIVED')}</td></tr>`).join(''):'<tr><td colspan="6">No shipping zones.</td></tr>';
    viewRoot.innerHTML=`<section class="metric-grid">${metric('Regions',data.regions.length,'Country rules','◎')}${metric('FX rates',data.rates.length,'Display-only conversion','$')}${metric('Tax rules',data.taxRules.length,'VAT / sales tax','%')}${metric('Shipping zones',data.zones.length,'Destination coverage','↗')}</section><section class="data-panel"><div class="panel-header"><h2>Commerce regions</h2><span class="subtle">Checkout fails closed without destination configuration.</span></div><div class="table-wrap"><table><thead><tr><th>Country</th><th>Locale</th><th>Currency</th><th>Shipping</th><th>Tax req.</th><th>Duties req.</th><th>Payments</th></tr></thead><tbody>${regions}</tbody></table></div></section><section class="dashboard-grid"><div class="data-panel"><div class="panel-header"><h2>FX rates</h2></div><div class="table-wrap"><table><thead><tr><th>Pair</th><th>Rate</th><th>Source</th><th>Updated</th></tr></thead><tbody>${fx}</tbody></table></div></div><div class="data-panel"><div class="panel-header"><h2>Tax / VAT rules</h2></div><div class="table-wrap"><table><thead><tr><th>Jurisdiction</th><th>Rule</th><th>Type</th><th>Rate</th><th>Mode</th><th>Status</th></tr></thead><tbody>${taxes}</tbody></table></div></div></section><section class="data-panel"><div class="panel-header"><h2>Shipping zones</h2><span class="subtle">Settlement-currency fallback rates or live carrier quotes</span></div><div class="table-wrap"><table><thead><tr><th>Zone</th><th>Countries</th><th>Rate</th><th>Free threshold</th><th>Days</th><th>Status</th></tr></thead><tbody>${zones}</tbody></table></div></section>`;
    enhanceResponsiveTables(viewRoot);
  }

  async function renderReadiness() {
    heading('Launch Readiness','Configuration, live certification and recovery gates for production.');
    const data=await api('/api/admin/readiness');
    const categories=[...new Set(data.checks.map(x=>x.category))];
    viewRoot.innerHTML=`<section class="readiness-hero"><div class="readiness-score"><strong>${esc(data.score)}%</strong><span>LAUNCH READINESS</span></div><div><h2>Production is evidence, not environment variables.</h2><p>Automatic failures cannot be hidden with a manual PASS. External providers remain NEEDS TEST until the real workflow succeeds.</p></div></section>${categories.map(category=>`<section class="data-panel readiness-section"><div class="panel-header"><h2>${esc(category)}</h2></div><div class="readiness-list">${data.checks.filter(x=>x.category===category).map(x=>`<article class="readiness-row"><div><strong>${esc(x.label)}</strong><small>${esc(x.detail)}</small>${x.note?`<small>NOTE · ${esc(x.note)}</small>`:''}</div><div>${badge(x.status)}</div>${state.user?.role==='ADMIN'&&!x.automatic?`<button class="table-action" data-action="readiness-update" data-key="${esc(x.key)}" data-status="${esc(x.status)}">UPDATE →</button>`:'<span></span>'}</article>`).join('')}</div></section>`).join('')}`;
  }

  async function renderAnalyticsV25() {
    heading('Analytics','Consent-aware first-party commerce analytics and funnel health.');
    const data=await api('/api/admin/analytics/summary'),f=data.funnel;
    const rows=data.topPaths.length?data.topPaths.map(x=>`<tr><td>${esc(x.path)}</td><td>${esc(x.views)}</td></tr>`).join(''):'<tr><td colspan="2">No page-view analytics yet.</td></tr>';
    viewRoot.innerHTML=`<section class="metric-grid">${metric('Product views',f.productViews,'Last 30 days','◉')}${metric('Add to cart',f.addToCart,'Consent-aware','＋')}${metric('Checkout starts',f.beginCheckout,'Funnel','→')}${metric('Purchases',f.purchases,'Tracked events','✓')}</section><section class="dashboard-grid"><div class="data-panel"><div class="panel-header"><h2>Top paths</h2></div><div class="table-wrap"><table><thead><tr><th>Path</th><th>Views</th></tr></thead><tbody>${rows}</tbody></table></div></div><div class="data-panel"><div class="panel-header"><h2>Consent</h2></div><div class="detail-grid"><div class="detail-box"><span>Consent records</span><strong>${esc(data.consent.records)}</strong></div><div class="detail-box"><span>Analytics opt-in</span><strong>${Math.round(data.consent.analyticsOptInRate*100)}%</strong></div><div class="detail-box"><span>Marketing opt-in</span><strong>${Math.round(data.consent.marketingOptInRate*100)}%</strong></div></div></div></section>`;
    enhanceResponsiveTables(viewRoot);
  }

  async function renderOperations() {
    heading('Operations', 'Money, growth, supplier sync, pricing, promotions, fraud and buyer protection.');
    const [finance, analytics, flags, promos, rules, suppliers, cases] = await Promise.all([
      api('/api/admin/ops/finance'),
      api('/api/admin/ops/analytics'),
      api('/api/admin/ops/fraud-flags'),
      api('/api/admin/ops/promos'),
      api('/api/admin/ops/pricing-rules'),
      api('/api/admin/ops/suppliers'),
      api('/api/support/admin/cases'),
    ]);

    const topProducts = analytics.topProducts?.length ? analytics.topProducts.slice(0, 8).map(product => `
      <tr><td><strong>${esc(product.name)}</strong><br><span class="subtle">${esc(product.sku)}</span></td><td>${esc(product.viewCount)}</td><td>${esc(product.purchaseCount)}</td><td>${esc(product.wishlistCount)}</td></tr>`).join('') : '<tr><td colspan="4">No product activity yet.</td></tr>';
    const searches = analytics.searches?.length ? analytics.searches.slice(0, 8).map(search => `
      <tr><td><strong>${esc(search.query)}</strong></td><td>${esc(search._count?.query || 0)}</td><td>${esc(search._sum?.resultsCount || 0)}</td></tr>`).join('') : '<tr><td colspan="3">No searches tracked yet.</td></tr>';
    const fraudRows = flags.length ? flags.slice(0, 10).map(flag => `
      <tr><td><strong>${esc(flag.orderNumber)}</strong><br><span class="subtle">${esc(flag.email)}</span></td><td>${esc(money(flag.totalCents))}</td><td>${flag.reasons.map(reason => badge(reason)).join(' ')}</td><td class="text-right"><button class="table-action" data-action="view-order" data-id="${esc(flag.orderId)}">OPEN →</button></td></tr>`).join('') : '<tr><td colspan="4"><div class="empty-state"><div><b>No recent risk flags</b><span>Rule-based checks are clear.</span></div></div></td></tr>';
    const supplierRows = suppliers.length ? suppliers.map(supplier => {
      const last = supplier.syncRuns?.[0];
      return `<tr><td><strong>${esc(supplier.name)}</strong><br><span class="subtle">${esc(supplier.code)} · ${esc(supplier.type)}</span></td><td>${supplier.active ? badge('ACTIVE') : badge('INACTIVE')}</td><td>${esc(supplier._count?.products || 0)}</td><td>${last ? `${badge(last.status)}<br><span class="subtle">${esc(dateTime(last.startedAt))}</span>` : 'Never'}</td></tr>`;
    }).join('') : '<tr><td colspan="4">No suppliers connected.</td></tr>';
    const promoRows = promos.length ? promos.slice(0, 10).map(promo => `<tr><td><strong>${esc(promo.code)}</strong></td><td>${promo.percentOff ? `${esc(promo.percentOff)}%` : esc(money(promo.amountOffCents || 0))}</td><td>${esc(promo.uses || 0)}${promo.maxUses ? ` / ${esc(promo.maxUses)}` : ''}</td><td>${promo.active ? badge('ACTIVE') : badge('INACTIVE')}</td></tr>`).join('') : '<tr><td colspan="4">No promo codes yet.</td></tr>';
    const ruleRows = rules.length ? rules.map(rule => `<tr><td><strong>${esc(rule.name)}</strong></td><td>${esc(rule.supplier?.name || 'Any')}</td><td>${esc(rule.category?.name || 'Any')}</td><td>${rule.markupPercent != null ? `${esc(rule.markupPercent)}%` : '—'}</td><td>${esc(money(rule.minimumProfitCents || 0))}</td></tr>`).join('') : '<tr><td colspan="5">No pricing rules yet.</td></tr>';
    const caseRows = cases.length ? cases.slice(0, 10).map(item => `<tr><td><strong>${esc(item.caseNumber || `CASE-${item.id.slice(-8).toUpperCase()}`)}</strong><br><span class="subtle">${esc(item.type.replaceAll('_',' '))}</span></td><td>${esc(item.order?.orderNumber || '—')}</td><td>${badge(item.status)}</td><td>${esc(item.user?.email || '—')}</td><td class="text-right"><button class="table-action" data-action="review-case" data-id="${esc(item.id)}">REVIEW →</button></td></tr>`).join('') : '<tr><td colspan="5">No buyer-protection cases.</td></tr>';

    viewRoot.innerHTML = `
      <section class="metric-grid">
        ${metric('GMV', compactMoney(finance.gmvCents), `${finance.paidOrders} paid orders`, '↗')}
        ${metric('Net before processor fees', compactMoney(finance.netRevenueBeforeProcessorFeesCents), `AOV ${compactMoney(finance.averageOrderValueCents)}`, '◎')}
        ${metric('Supplier costs', compactMoney(finance.supplierCostCents), `Seller payouts ${compactMoney(finance.sellerPayoutsCents)}`, '⇄')}
        ${metric('Refunds', compactMoney(finance.refundsCents), `${finance.refundCount} refunds · ${analytics.openCases} open cases`, '↩')}
      </section>
      <section class="ops-grid">
        <article class="panel panel-pad">
          <div class="panel-header"><h2>Growth signals</h2><span class="subtle">LIVE STORE DATA</span></div>
          <div class="ops-stats"><span>Wishlists <b>${esc(analytics.wishlists)}</b></span><span>Reviews <b>${esc(analytics.reviews)}</b></span><span>Open cases <b>${esc(analytics.openCases)}</b></span><span>Risk flags <b>${esc(flags.length)}</b></span></div>
        </article>
        <article class="panel panel-pad">
          <div class="panel-header"><h2>Automatic pricing</h2><button class="btn btn-primary" data-action="apply-pricing">Apply rules</button></div>
          <p class="subtle">Re-price dropship products from landed supplier cost while respecting your active rules.</p>
          <form id="pricing-rule-form" class="compact-form">
            <input name="name" placeholder="Rule name" required />
            <input name="markupPercent" type="number" min="0" max="1000" step="0.1" placeholder="Markup %" />
            <input name="minimumProfit" type="number" min="0" step="0.01" placeholder="Min profit $" />
            <button class="btn" type="submit">Add rule</button>
          </form>
        </article>
      </section>
      <section class="ops-grid">
        <article class="data-panel"><div class="panel-header"><h2>Top products</h2></div><div class="table-wrap"><table><thead><tr><th>Product</th><th>Views</th><th>Bought</th><th>Wishlists</th></tr></thead><tbody>${topProducts}</tbody></table></div></article>
        <article class="data-panel"><div class="panel-header"><h2>Top searches</h2></div><div class="table-wrap"><table><thead><tr><th>Search</th><th>Times</th><th>Results seen</th></tr></thead><tbody>${searches}</tbody></table></div></article>
      </section>
      <section class="data-panel"><div class="panel-header"><h2>Risk watch</h2><span class="subtle">LAST 7 DAYS</span></div><div class="table-wrap"><table><thead><tr><th>Order</th><th>Total</th><th>Flags</th><th></th></tr></thead><tbody>${fraudRows}</tbody></table></div></section>
      <section class="data-panel"><div class="panel-header"><h2>Supplier sync</h2><span class="subtle">CATALOGUE + STOCK</span></div><div class="table-wrap"><table><thead><tr><th>Supplier</th><th>Status</th><th>Linked products</th><th>Latest sync</th></tr></thead><tbody>${supplierRows}</tbody></table></div></section>
      <section class="ops-grid">
        <article class="data-panel"><div class="panel-header"><h2>Promo codes</h2></div><div class="ops-form-pad"><form id="promo-form" class="compact-form"><input name="code" placeholder="DREAM10" minlength="3" required /><input name="percentOff" type="number" min="1" max="100" placeholder="% off" required /><input name="maxUses" type="number" min="1" placeholder="Max uses" /><button class="btn" type="submit">Create</button></form></div><div class="table-wrap"><table><thead><tr><th>Code</th><th>Discount</th><th>Uses</th><th>Status</th></tr></thead><tbody>${promoRows}</tbody></table></div></article>
        <article class="data-panel"><div class="panel-header"><h2>Pricing rules</h2></div><div class="table-wrap"><table><thead><tr><th>Rule</th><th>Supplier</th><th>Category</th><th>Markup</th><th>Min profit</th></tr></thead><tbody>${ruleRows}</tbody></table></div></article>
      </section>
      <section class="data-panel"><div class="panel-header"><h2>Buyer protection</h2><span class="subtle">RETURNS · DISPUTES · DAMAGE</span></div><div class="table-wrap"><table><thead><tr><th>Case</th><th>Order</th><th>Status</th><th>Buyer</th><th></th></tr></thead><tbody>${caseRows}</tbody></table></div></section>`;
  }

  async function openSupportCaseModal(id) {
    const cases = await api('/api/support/admin/cases');
    const item = cases.find(row => row.id === id);
    if (!item) throw new Error('Support case not found.');
    const canRefund = state.user?.role === 'ADMIN' && item.order && !['REFUNDED'].includes(item.order.paymentStatus);
    const evidence = Array.isArray(item.evidenceUrls) ? item.evidenceUrls.filter(url => typeof url === 'string' && url.startsWith('https://')).slice(0, 8) : [];
    const caseLabel = item.caseNumber || `CASE-${item.id.slice(-8).toUpperCase()}`;
    openModal(`<div class="modal-header"><div><div class="eyebrow">BUYER PROTECTION</div><h2>${esc(caseLabel)}</h2></div><button class="icon-btn" data-modal-close>×</button></div>
      <div class="modal-body"><div class="detail-grid"><div><span>Type</span><strong>${esc(item.type.replaceAll('_',' '))}</strong></div><div><span>Status</span><strong>${esc(item.status.replaceAll('_',' '))}</strong></div><div><span>Order</span><strong>${esc(item.order?.orderNumber || '—')}</strong></div><div><span>Buyer</span><strong>${esc(item.user?.email || '—')}</strong></div></div><div class="code-block">${esc([item.reason, item.details].filter(Boolean).join('\n\n') || 'No description provided.')}</div>${evidence.length?`<div class="case-evidence-grid">${evidence.map(url=>`<a href="${esc(url)}" target="_blank" rel="noreferrer"><img src="${esc(url)}" alt="Buyer evidence" loading="lazy"></a>`).join('')}</div>`:''}${item.sellerResponse?`<div class="case-response"><span class="eyebrow">SELLER RESPONSE</span><p>${esc(item.sellerResponse)}</p></div>`:''}</div>
      <div class="modal-footer"><select id="support-case-status" style="width:auto">${['OPEN','UNDER_REVIEW','AWAITING_SELLER','APPROVED','RESOLVED','REJECTED','CLOSED'].map(v => `<option value="${v}" ${item.status === v ? 'selected' : ''}>${v.replaceAll('_',' ')}</option>`).join('')}</select><button class="btn" data-action="save-case-status" data-id="${esc(item.id)}">Update case</button>${canRefund ? `<button class="btn btn-danger" data-action="refund-case" data-id="${esc(item.id)}" data-max="${esc(item.order.totalCents)}">Issue refund</button>` : ''}</div>`);
  }

  async function renderTrust() {
    heading('Trust & Safety', 'Dealer verification, user reports, security events and moderator audit history.');
    const [summary, dealers, reports, events, riskUsers] = await Promise.all([
      api('/api/admin/trust/summary'),
      api('/api/admin/trust/dealer-verifications?status=PENDING').catch(() => []),
      api('/api/admin/trust/reports?status=OPEN').catch(() => []),
      api('/api/admin/trust/security-events').catch(() => []),
      api('/api/admin/trust/risk-users').catch(() => []),
    ]);
    $('#nav-trust-count').textContent = summary.openReports + summary.pendingDealers || '';
    const dealerRows = dealers.length ? dealers.map(item => `<tr><td><strong>${esc(item.businessName)}</strong><small>${esc(item.country)} · ${esc(item.businessEmail)}</small></td><td>${esc(item.user.email)}</td><td>${badge(item.status)}</td><td class="text-right"><button class="table-action" data-action="dealer-review" data-id="${esc(item.id)}" data-decision="APPROVED">Approve</button> <button class="table-action danger" data-action="dealer-review" data-id="${esc(item.id)}" data-decision="REJECTED">Reject</button></td></tr>`).join('') : '<tr><td colspan="4">No pending dealer applications.</td></tr>';
    const reportRows = reports.length ? reports.map(item => `<tr><td>${badge(item.reason)}</td><td><strong>${esc(item.targetType)}</strong><small>${esc(item.targetId)}</small></td><td>${esc(item.reporter.email)}</td><td class="text-right"><button class="table-action" data-action="report-review" data-id="${esc(item.id)}">Review</button></td></tr>`).join('') : '<tr><td colspan="4">No open reports.</td></tr>';
    const riskRows = riskUsers.filter(item => item.level !== 'LOW').slice(0,25).map(item => `<tr><td><strong>${esc(item.displayName||item.username||item.email)}</strong><small>${esc(item.email)}</small></td><td>${badge(item.level)}</td><td><strong>${esc(item.score)}</strong><small>/ 100</small></td><td>${esc((item.reasons||[]).slice(0,3).join(' · ')||'No elevated signals')}</td></tr>`).join('') || '<tr><td colspan="4">No medium/high-risk accounts in the current sample.</td></tr>';
    viewRoot.innerHTML = `<section class="metric-grid">${metric('Open reports',summary.openReports,'Awaiting moderation','!')}${metric('Dealer reviews',summary.pendingDealers,'Pending verification','✓')}${metric('Security events',summary.securityEvents24h,'Last 24 hours','⌁')}${metric('Audit actions',summary.auditActions24h,'Last 24 hours','▤')}</section><section class="data-panel"><div class="panel-header"><h2>Pending dealer verification</h2><span class="subtle">EMAIL + PHONE + 2FA REQUIRED</span></div><div class="table-wrap"><table class="responsive-table"><thead><tr><th>Business</th><th>Account</th><th>Status</th><th class="text-right">Decision</th></tr></thead><tbody>${dealerRows}</tbody></table></div></section><section class="data-panel"><div class="panel-header"><h2>Open content reports</h2><span class="subtle">TRUST & SAFETY QUEUE</span></div><div class="table-wrap"><table class="responsive-table"><thead><tr><th>Reason</th><th>Target</th><th>Reporter</th><th class="text-right">Action</th></tr></thead><tbody>${reportRows}</tbody></table></div></section><section class="data-panel"><div class="panel-header"><h2>Elevated account risk</h2><span class="subtle">HEURISTIC — REVIEW, DON'T AUTO-BAN</span></div><div class="table-wrap"><table class="responsive-table"><thead><tr><th>Account</th><th>Level</th><th>Score</th><th>Signals</th></tr></thead><tbody>${riskRows}</tbody></table></div></section><section class="panel panel-pad"><div class="panel-header"><h2>Recent security signals</h2></div><div class="alert-list">${events.slice(0,15).map(e=>`<div class="alert-row"><div><strong>${esc(e.type.replaceAll('_',' '))}</strong><small>${esc(e.user?.email||'Unknown user')} · ${esc(shortDate(e.createdAt))}</small></div><span>${esc(e.ipAddress||'—')}</span></div>`).join('')||'<div class="empty-state"><div><b>No security events</b></div></div>'}</div></section>`;
  }

  async function renderSettings() {
    heading('Settings', 'Production security, payments, marketplace payouts and supplier integrations.');
    const [health, config] = await Promise.all([api('/api/health'), api('/api/admin/settings')]);
    viewRoot.innerHTML = `
      <section class="settings-grid">
        <article class="setting-card"><div class="eyebrow">API</div><h3>SANDMAN backend</h3><p>Live API served from the same Express application as the storefront and admin console.</p><div class="code-block">${esc(JSON.stringify(health, null, 2))}</div></article>
        <article class="setting-card"><div class="eyebrow">ENVIRONMENT</div><h3>${esc(config.environment.toUpperCase())}</h3><p>Public application URL and server environment currently in use.</p><div class="code-block">${esc(config.appUrl)}\n${esc(config.apiUrl)}</div></article>
        <article class="setting-card"><div class="eyebrow">SECURITY</div><h3>Persistent admin login</h3><p>You are signed in as ${esc(state.user?.email || '')}. A secure HttpOnly refresh session remembers the login for up to ${esc(config.sessionDays)} days while short-lived JWT access tokens are rotated.</p><form id="admin-password-form" class="form-grid"><label class="field span-2"><span>Current password</span><input name="currentPassword" type="password" autocomplete="current-password" required></label><label class="field"><span>New password</span><input name="newPassword" type="password" minlength="10" autocomplete="new-password" required></label><label class="field"><span>Confirm password</span><input name="confirmPassword" type="password" minlength="10" autocomplete="new-password" required></label><button class="btn btn-primary span-2" type="submit">Change password + sign out other sessions</button></form><div style="height:12px"></div><button class="btn btn-danger" data-action="logout">Sign out</button></article>
        <article class="setting-card"><div class="eyebrow">PAYMENTS</div><h3>Checkout providers</h3><p>Stripe Payment Element can surface eligible cards, Apple Pay, Google Pay, Link, bank methods, BNPL and regional methods. PayPal and manual EFT are separate options.</p><div class="status-stack"><span>Stripe <b>${config.payments.stripe?'READY':'NOT CONFIGURED'}</b></span><span>PayPal <b>${config.payments.paypal?'READY':'NOT CONFIGURED'}</b></span><span>Bank / EFT <b>${config.payments.bankTransfer?'READY':'NOT CONFIGURED'}</b></span></div></article>
        <article class="setting-card"><div class="eyebrow">PRODUCT MEDIA</div><h3>Image uploads</h3><p>Admins and marketplace sellers can upload JPG, PNG and WebP product photos directly when Cloudinary is configured. Image URLs remain available as a fallback.</p><div class="status-stack"><span>Cloudinary <b>${config.imageUploads?.cloudinary?'READY':'NOT CONFIGURED'}</b></span></div></article>
        <article class="setting-card"><div class="eyebrow">OWNER PAYOUTS</div><h3>Money to your business</h3><p>SANDMAN never stores raw payout card or bank numbers. Add your business bank account or supported debit card securely in your payment processor so settled customer funds pay out to you.</p><div class="button-stack"><a class="btn" href="https://dashboard.stripe.com/settings/payouts" target="_blank" rel="noreferrer">Stripe payout settings ↗</a><a class="btn" href="https://www.paypal.com/businessmanage/money" target="_blank" rel="noreferrer">PayPal business money ↗</a></div></article>
        <article class="setting-card"><div class="eyebrow">MARKETPLACE</div><h3>${esc(config.marketplace.commissionPercent)}% SANDMAN commission</h3><p>Marketplace sellers connect a Stripe Connect payout account. On successful Stripe marketplace sales, SANDMAN keeps the configured fee. The seller's net proceeds become transferable after that seller has supplied shipment tracking for every item in the order.</p><div class="code-block">Seller payouts: ${esc(money(config.marketplace.sellerPayoutCents))}\nSANDMAN fees: ${esc(money(config.marketplace.platformFeeCents))}\nPayout records: ${esc(config.marketplace.payoutCount)}</div></article>
        <article class="setting-card"><div class="eyebrow">SYNCEE</div><h3>Manual fulfillment bridge</h3><p>Syncee's public documentation does not expose a retailer-side custom-platform order API. SANDMAN therefore creates a tracked Syncee handoff: open Syncee, pay/forward the supplier order there, then record tracking in SANDMAN.</p><a class="btn" href="${esc(config.syncee.ordersUrl)}" target="_blank" rel="noreferrer">Open Syncee ↗</a></article>
        <article class="setting-card"><div class="eyebrow">DATABASE</div><h3>PostgreSQL + Prisma</h3><p>Products, sessions, orders, marketplace commissions, seller payouts and fulfillment records are stored in PostgreSQL.</p><button class="btn" data-action="copy-command" data-copy="npx prisma studio">Copy Prisma Studio command</button></article>
      </section>`;
  }

  async function openProductModal(productId = null) {
    const categories = state.cache.categories || await api('/api/admin/categories');
    let product = null;
    if (productId) product = await api(`/api/admin/products/${productId}`);
    const productImages = (product?.images || []).map((image, index) => ({ url:image.url, alt:image.alt || product?.name || '', position:index }));
    const categoryOptions = categories.map(c => `<option value="${esc(c.id)}" ${product?.categoryId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    const supplierSummary = product?.supplierLinks?.length ? product.supplierLinks.map(link => `<div class="order-item"><div><strong>${esc(link.supplier.name)}</strong><small>${esc(link.supplierSku || link.supplierProductId)} · available ${esc(link.availableStock ?? 'n/a')}${link.reservedStock ? ` · ${esc(link.reservedStock)} reserved` : ''}</small></div><strong>${esc(money(link.costCents + link.shippingCents, link.currency))}</strong></div>`).join('') : '<div class="empty-state"><div><b>No supplier linked</b><span>Use Inventory to connect this part to a dropship supplier.</span></div></div>';
    const fitmentSummary = product?.fitments?.length ? product.fitments.slice(0, 12).map(f => `<span class="badge badge-submitted">${esc(f.vehicleVariant.model.make.name)} ${esc(f.vehicleVariant.model.name)} · ${esc(f.vehicleVariant.engineCode)}</span>`).join(' ') : '<span class="subtle">No fitments linked yet.</span>';

    openModal(`
      <form id="product-form" data-id="${esc(productId || '')}">
        <div class="modal-header"><div><h2>${product ? 'Edit product' : 'New engine part'}</h2><p>${product ? esc(product.sku) : 'Create a SANDMAN catalogue item'}</p></div><button type="button" class="icon-btn" data-modal-close>×</button></div>
        <div class="modal-body"><div class="form-grid">
          <label class="field"><span>Product name</span><input name="name" required minlength="2" maxlength="240" value="${esc(product?.name || '')}" placeholder="B58 Upgraded Intercooler" /></label>
          <label class="field"><span>SKU</span><input name="sku" required value="${esc(product?.sku || '')}" placeholder="SM-B58-IC-002" ${product ? 'disabled' : ''} /></label>
          <label class="field"><span>Slug</span><input name="slug" required value="${esc(product?.slug || '')}" placeholder="b58-upgraded-intercooler" ${product ? 'disabled' : ''} /></label>
          <label class="field"><span>Brand</span><input name="brand" maxlength="120" value="${esc(product?.brand || '')}" placeholder="SANDMAN Performance" /></label>
          <label class="field"><span>Manufacturer part no.</span><input name="manufacturerPn" maxlength="120" value="${esc(product?.manufacturerPn || '')}" placeholder="OEM / supplier cross-reference" /></label>
          <label class="field"><span>HS / customs code</span><input name="hsCode" maxlength="32" value="${esc(product?.hsCode || '')}" placeholder="8708.99" /></label>
          <label class="field"><span>Country of origin</span><input name="countryOfOrigin" maxlength="2" value="${esc(product?.countryOfOrigin || '')}" placeholder="CN" /></label>
          <label class="field span-2"><span>Customs description</span><input name="customsDescription" maxlength="500" value="${esc(product?.customsDescription || '')}" placeholder="Automotive engine component" /></label>
          <label class="field span-2"><span>Restricted destination countries (comma-separated)</span><input name="restrictedCountries" value="${esc(Array.isArray(product?.restrictedCountries)?product.restrictedCountries.join(', '):'')}" placeholder="US, CA" /></label>
          <label class="field"><span>Taxable</span><select name="taxable"><option value="true" ${product?.taxable!==false?'selected':''}>Yes</option><option value="false" ${product?.taxable===false?'selected':''}>No</option></select></label>
          <label class="field"><span>Weight (grams)</span><input name="weightGrams" type="number" min="1" value="${esc(product?.weightGrams ?? '')}" /></label>
          <label class="field"><span>Length (mm)</span><input name="lengthMm" type="number" min="1" value="${esc(product?.lengthMm ?? '')}" /></label>
          <label class="field"><span>Width (mm)</span><input name="widthMm" type="number" min="1" value="${esc(product?.widthMm ?? '')}" /></label>
          <label class="field"><span>Height (mm)</span><input name="heightMm" type="number" min="1" value="${esc(product?.heightMm ?? '')}" /></label>
          <label class="field"><span>Category</span><select name="categoryId" required><option value="">Choose category</option>${categoryOptions}</select></label>
          <label class="field"><span>Retail price (USD)</span><input name="price" type="number" step="0.01" min="0" required value="${product ? (product.priceCents / 100).toFixed(2) : ''}" placeholder="399.99" /></label>
          <label class="field"><span>Compare-at price</span><input name="compareAt" type="number" step="0.01" min="0" value="${product?.compareAtCents ? (product.compareAtCents / 100).toFixed(2) : ''}" placeholder="449.99" /></label>
          <label class="field"><span>Status</span><select name="status">${['DRAFT','ACTIVE','ARCHIVED'].map(v => `<option ${product?.status === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
          <div class="field span-2 admin-image-manager"><div class="admin-image-head"><div><span>Product images</span><small>Upload up to 8 JPG, PNG or WebP images. The first image is the cover.</small></div><b data-admin-image-count>${productImages.length}/8</b></div><label class="admin-upload-drop"><input id="admin-product-image-files" type="file" accept="image/jpeg,image/png,image/webp" multiple hidden><strong>＋ Choose images</strong><small>Up to 10 MB each</small></label><div class="admin-image-url-row"><input id="admin-product-image-url" type="url" placeholder="Or paste an image URL"><button class="btn" id="admin-add-image-url" type="button">Add URL</button></div><div class="admin-upload-grid" data-admin-image-list></div></div>
          <label class="field span-2"><span>Short description</span><input name="shortDesc" maxlength="500" value="${esc(product?.shortDesc || '')}" placeholder="Short storefront summary" /></label>
          <label class="field span-2"><span>Description</span><textarea name="description" required minlength="10" placeholder="Specifications, materials and verified supplier information…">${esc(product?.description || '')}</textarea></label>
          <div class="divider-title">Storefront details</div>
          <label class="field"><span>Warranty</span><input name="warrantyText" maxlength="1000" value="${esc(product?.warrantyText || '')}" placeholder="12-month limited warranty" /></label>
          <label class="field"><span>Return window (days)</span><input name="returnDays" type="number" min="0" max="365" value="${esc(product?.returnDays ?? '')}" placeholder="30" /></label>
          <label class="field"><span>Install difficulty</span><input name="installDifficulty" maxlength="80" value="${esc(product?.installDifficulty || '')}" placeholder="Intermediate" /></label>
          <label class="field"><span>Product video URL</span><input name="videoUrl" type="url" value="${esc(product?.videoUrl || '')}" placeholder="https://…" /></label>
          <label class="field"><span>Shipping min days</span><input name="shippingMinDays" type="number" min="0" max="365" value="${esc(product?.shippingMinDays ?? '')}" /></label>
          <label class="field"><span>Shipping max days</span><input name="shippingMaxDays" type="number" min="0" max="365" value="${esc(product?.shippingMaxDays ?? '')}" /></label>
          <label class="field span-2"><span>Specifications (one key=value per line)</span><textarea name="specsText" placeholder="Material=Aluminum\nCore size=600x300x76 mm">${esc(Object.entries(product?.specs || {}).map(([k,v]) => `${k}=${v}`).join('\n'))}</textarea></label>
          <label class="field"><span>SEO title</span><input name="seoTitle" maxlength="160" value="${esc(product?.seoTitle || '')}" placeholder="Product title | SANDMAN" /></label>
          <label class="field"><span>SEO description</span><input name="seoDescription" maxlength="320" value="${esc(product?.seoDescription || '')}" placeholder="Search-friendly summary" /></label>
          <div class="field span-2"><span>Fitment mode</span><div class="fitment-mode-options"><label class="field-check"><input name="fitmentMode" type="radio" value="vehicle" ${!product?.isUniversal ? 'checked' : ''} /><span>Vehicle-specific — requires compatible vehicle records</span></label><label class="field-check"><input name="fitmentMode" type="radio" value="universal" ${product?.isUniversal ? 'checked' : ''} /><span>Universal — no vehicle selection required</span></label></div></div>
          ${product ? `<div class="divider-title">Supplier sourcing</div><div class="span-2">${supplierSummary}</div><div class="divider-title">Current fitments</div><div class="span-2" style="display:flex;gap:6px;flex-wrap:wrap">${fitmentSummary}</div>` : ''}
        </div></div>
        <div class="modal-footer">${product ? '<button type="button" class="btn btn-danger" data-action="archive-product" data-id="' + esc(product.id) + '">Archive</button><button type="button" class="btn" data-action="manage-fitments" data-id="' + esc(product.id) + '">Manage fitments</button>' : ''}<button type="button" class="btn" data-modal-close>Cancel</button><button class="btn btn-primary" type="submit">${product ? 'Save changes' : 'Create product'}</button></div>
      </form>`, 'modal-lg');
    const productForm = $('#product-form');
    productForm._sandmanImages = productImages;
    renderAdminProductImages(productForm);
    $('#admin-product-image-files', productForm).onchange = async event => {
      const files = [...event.target.files];
      if (!files.length) return;
      if (productImages.length + files.length > 8) { toast('Too many images', 'Products support up to 8 images.'); event.target.value = ''; return; }
      const drop = event.target.closest('.admin-upload-drop'); drop.classList.add('uploading');
      try {
        const uploaded = await uploadAdminProductImages(files);
        uploaded.forEach(image => { image.position = productImages.length; productImages.push(image); });
        renderAdminProductImages(productForm); toast('Images uploaded', `${uploaded.length} image${uploaded.length === 1 ? '' : 's'} added.`);
      } catch (error) { toast('Upload failed', error.message); }
      finally { drop.classList.remove('uploading'); event.target.value = ''; }
    };
    $('#admin-add-image-url', productForm).onclick = () => {
      const input = $('#admin-product-image-url', productForm); const url = input.value.trim();
      if (!url) return;
      if (productImages.length >= 8) return toast('Too many images', 'Products support up to 8 images.');
      try { const parsed = new URL(url); if (parsed.protocol !== 'https:') throw new Error('https required'); } catch { return toast('Invalid URL', 'Enter a complete https:// image URL.'); }
      productImages.push({ url, alt:product?.name || 'SANDMAN product', position:productImages.length }); input.value = ''; renderAdminProductImages(productForm);
    };
  }

  async function submitProductForm(form) {
    const fd = new FormData(form);
    const productId = form.dataset.id;
    const specs = {};
    for (const line of String(fd.get('specsText') || '').split('\n')) {
      const at = line.indexOf('=');
      if (at <= 0) continue;
      const key = line.slice(0, at).trim();
      const value = line.slice(at + 1).trim();
      if (key && value) specs[key] = value;
    }
    const payload = {
      name: String(fd.get('name') || ''),
      brand: optionalString(fd.get('brand')),
      manufacturerPn: optionalString(fd.get('manufacturerPn')),
      hsCode: optionalString(fd.get('hsCode')),
      countryOfOrigin: optionalString(fd.get('countryOfOrigin'))?.toUpperCase(),
      customsDescription: optionalString(fd.get('customsDescription')),
      restrictedCountries: String(fd.get('restrictedCountries')||'').split(',').map(v=>v.trim().toUpperCase()).filter(v=>v.length===2),
      taxable: String(fd.get('taxable')) !== 'false',
      weightGrams: fd.get('weightGrams') === '' ? undefined : Number(fd.get('weightGrams')),
      lengthMm: fd.get('lengthMm') === '' ? undefined : Number(fd.get('lengthMm')),
      widthMm: fd.get('widthMm') === '' ? undefined : Number(fd.get('widthMm')),
      heightMm: fd.get('heightMm') === '' ? undefined : Number(fd.get('heightMm')),
      description: String(fd.get('description') || ''),
      shortDesc: optionalString(fd.get('shortDesc')),
      categoryId: String(fd.get('categoryId') || ''),
      priceCents: Math.round(Number(fd.get('price') || 0) * 100),
      compareAtCents: fd.get('compareAt') ? Math.round(Number(fd.get('compareAt')) * 100) : undefined,
      currency: 'USD',
      requiresFitment: fd.get('fitmentMode') !== 'universal',
      isUniversal: fd.get('fitmentMode') === 'universal',
      status: String(fd.get('status') || 'DRAFT'),
      warrantyText: optionalString(fd.get('warrantyText')),
      returnDays: fd.get('returnDays') === '' ? undefined : Number(fd.get('returnDays')),
      installDifficulty: optionalString(fd.get('installDifficulty')),
      videoUrl: optionalString(fd.get('videoUrl')),
      shippingMinDays: fd.get('shippingMinDays') === '' ? undefined : Number(fd.get('shippingMinDays')),
      shippingMaxDays: fd.get('shippingMaxDays') === '' ? undefined : Number(fd.get('shippingMaxDays')),
      specs: Object.keys(specs).length ? specs : undefined,
      seoTitle: optionalString(fd.get('seoTitle')),
      seoDescription: optionalString(fd.get('seoDescription')),
      images: (form._sandmanImages || []).map((image, index) => ({ url:image.url, alt:image.alt || String(fd.get('name') || ''), position:index })),
    };
    if (!productId) {
      payload.sku = String(fd.get('sku') || '');
      payload.slug = String(fd.get('slug') || '');
      await api('/api/admin/products', { method: 'POST', body: JSON.stringify(payload) });
      toast('Product created', `${payload.name} is now in SANDMAN.`);
    } else {
      await api(`/api/admin/products/${productId}`, { method: 'PATCH', body: JSON.stringify(payload) });
      toast('Product updated', payload.name);
    }
    closeModal();
    await renderProducts();
  }

  async function openOrderModal(id) {
    const order = await api(`/api/admin/orders/${id}`);
    const shipping = order.shippingAddress || {};
    const items = order.items.map(item => `<div class="order-item"><div><strong>${esc(item.name)} × ${esc(item.quantity)}</strong><small>${esc(item.sku)}${item.supplierId ? ' · supplier assigned' : ''}</small></div><strong>${esc(money(item.totalPriceCents, order.currency))}</strong></div>`).join('');
    const fulfillments = order.fulfillments.length ? order.fulfillments.map(f => `<div class="order-item"><div><strong>${esc(f.supplier.name)}</strong><small>${esc(f.supplierOrderId || 'Not submitted')} ${f.trackingNumber ? `· ${esc(f.trackingNumber)}` : ''}</small></div>${badge(f.status)}</div>`).join('') : '<span class="subtle">No supplier fulfillment created yet.</span>';
    const events = order.events.length ? order.events.map(event => `<div class="timeline-row"><strong>${esc(event.message)}</strong><small>${esc(dateTime(event.createdAt))} · ${esc(event.type)}</small></div>`).join('') : '<span class="subtle">No order events.</span>';
    const canMarkPaid = order.paymentStatus !== 'PAID' && !['CANCELLED','REFUNDED'].includes(order.status);

    openModal(`
      <div class="modal-header"><div><h2>${esc(order.orderNumber)}</h2><p>${esc(order.email)} · ${esc(dateTime(order.createdAt))}</p></div><button type="button" class="icon-btn" data-modal-close>×</button></div>
      <div class="modal-body">
        <div class="detail-grid"><div class="detail-box"><span>Total</span><strong>${esc(money(order.totalCents, order.currency))}</strong></div><div class="detail-box"><span>Order status</span><strong>${order.status.replaceAll('_',' ')}</strong></div><div class="detail-box"><span>Payment</span><strong>${order.paymentStatus}</strong></div></div>
        <div class="detail-section"><h3>Items</h3>${items}</div>
        <div class="detail-section"><h3>Ship to</h3><div class="code-block">${esc([shipping.firstName, shipping.lastName, shipping.line1, shipping.line2, shipping.city, shipping.state, shipping.postalCode, shipping.country].filter(Boolean).join('\n'))}</div></div>
        <div class="detail-section"><h3>Fulfillment</h3>${fulfillments}</div>
        <div class="detail-section"><h3>Order timeline</h3><div class="timeline">${events}</div></div>
      </div>
      <div class="modal-footer">${canMarkPaid ? `<button class="btn" data-action="mark-order-paid" data-id="${esc(order.id)}">Mark paid + fulfill</button>` : ''}<select id="modal-order-status" style="width:auto">${['PENDING_PAYMENT','PAID','PROCESSING','SUBMITTED_TO_SUPPLIER','PARTIALLY_FULFILLED','FULFILLED','CANCELLED','REFUNDED','FAILED'].map(v => `<option value="${v}" ${order.status === v ? 'selected' : ''}>${v.replaceAll('_',' ')}</option>`).join('')}</select><button class="btn btn-primary" data-action="save-order-status" data-id="${esc(order.id)}">Update status</button></div>`, 'modal-lg');
  }

  async function openSupplierModal() {
    openModal(`<form id="supplier-form"><div class="modal-header"><div><h2>Add supplier</h2><p>Connect a dropship or wholesale source</p></div><button type="button" class="icon-btn" data-modal-close>×</button></div><div class="modal-body"><div class="form-grid"><label class="field"><span>Name</span><input name="name" required placeholder="CJ Dropshipping" /></label><label class="field"><span>Code</span><input name="code" required placeholder="cj" /></label><label class="field"><span>Type</span><select name="type"><option>CJ</option><option>SYNCEE</option><option>CUSTOM</option><option>MOCK</option></select></label><label class="field"><span>Priority</span><input name="priority" type="number" min="1" value="100" /></label><label class="field span-2"><span>Base API URL (optional)</span><input name="baseUrl" type="url" placeholder="https://supplier-api.example.com" /></label></div></div><div class="modal-footer"><button type="button" class="btn" data-modal-close>Cancel</button><button class="btn btn-primary" type="submit">Add supplier</button></div></form>`);
  }

  async function openSupplierProductModal() {
    const [productsData, suppliers] = await Promise.all([api('/api/admin/products?limit=100'), api('/api/admin/suppliers')]);
    openModal(`<form id="supplier-product-form"><div class="modal-header"><div><h2>Link supplier SKU</h2><p>Map a source product to your SANDMAN catalogue</p></div><button type="button" class="icon-btn" data-modal-close>×</button></div><div class="modal-body"><div class="form-grid"><label class="field span-2"><span>SANDMAN product</span><select name="productId" required><option value="">Choose product</option>${productsData.items.map(p => `<option value="${esc(p.id)}">${esc(p.sku)} — ${esc(p.name)}</option>`).join('')}</select></label><label class="field span-2"><span>Supplier</span><select name="supplierId" required><option value="">Choose supplier</option>${suppliers.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></label><label class="field"><span>Supplier product ID</span><input name="supplierProductId" required /></label><label class="field"><span>Supplier SKU</span><input name="supplierSku" /></label><label class="field"><span>Part cost (USD)</span><input name="cost" type="number" step="0.01" min="0" required /></label><label class="field"><span>Shipping cost (USD)</span><input name="shipping" type="number" step="0.01" min="0" value="0" /></label><label class="field"><span>Stock</span><input name="stock" type="number" min="0" /></label><label class="field"><span>Lead time (days)</span><input name="leadTimeDays" type="number" min="0" max="365" placeholder="3" /></label><label class="field"><span>Warehouse country</span><input name="warehouseCountry" maxlength="2" placeholder="US" /></label><label class="field"><span>Reliability score</span><input name="reliabilityScore" type="number" min="0" max="100" step="0.1" placeholder="95" /></label></div></div><div class="modal-footer"><button type="button" class="btn" data-modal-close>Cancel</button><button class="btn btn-primary" type="submit">Link supplier SKU</button></div></form>`);
  }

  async function openVehicleModal() {
    const models = await api('/api/admin/vehicle-models');
    openModal(`<form id="vehicle-form"><div class="modal-header"><div><h2>Add engine variant</h2><p>Extend the SANDMAN fitment database</p></div><button type="button" class="icon-btn" data-modal-close>×</button></div><div class="modal-body"><div class="form-grid"><label class="field span-2"><span>Vehicle model</span><select name="modelId" required><option value="">Choose model</option>${models.map(m => `<option value="${esc(m.id)}">${esc(m.make.name)} — ${esc(m.name)}</option>`).join('')}</select></label><label class="field"><span>Year start</span><input name="yearStart" type="number" min="1900" max="2200" required /></label><label class="field"><span>Year end</span><input name="yearEnd" type="number" min="1900" max="2200" required /></label><label class="field"><span>Trim</span><input name="trim" placeholder="M340i" /></label><label class="field"><span>Chassis code</span><input name="chassisCode" placeholder="G20" /></label><label class="field"><span>Engine code</span><input name="engineCode" required placeholder="B58B30O1" /></label><label class="field"><span>Engine name</span><input name="engineName" required placeholder="B58 3.0L Turbo Inline-6" /></label><label class="field"><span>Displacement (cc)</span><input name="displacementCc" type="number" min="1" placeholder="2998" /></label><label class="field"><span>Aspiration</span><input name="aspiration" placeholder="Turbocharged" /></label><label class="field"><span>Fuel</span><input name="fuelType" placeholder="Petrol" /></label><label class="field"><span>Drivetrain</span><input name="drivetrain" placeholder="RWD/AWD" /></label><label class="field span-2"><span>Transmission</span><input name="transmission" placeholder="8-speed automatic" /></label></div></div><div class="modal-footer"><button type="button" class="btn" data-modal-close>Cancel</button><button class="btn btn-primary" type="submit">Add vehicle variant</button></div></form>`);
  }

  async function openFitmentModal(productId) {
    const [product, variants] = await Promise.all([api(`/api/admin/products/${productId}`), api('/api/admin/vehicles?limit=300')]);
    const existing = Object.fromEntries((product.fitments||[]).map(f => [f.vehicleVariantId,{compatibility:f.compatibility||'FITS',verified:Boolean(f.verified),source:f.source||'MANUAL'}]));
    const options = variants.map(v => {
      const fit=existing[v.id]; const stateValue=fit?.compatibility||'NONE';
      return `<div class="fitment-option"><span><strong>${esc(v.model.make.name)} ${esc(v.model.name)} ${v.trim?`· ${esc(v.trim)}`:''}</strong><small>${esc(v.yearStart)}–${esc(v.yearEnd)} · ${esc(v.chassisCode||'chassis n/a')} · ${esc(v.engineName)}</small></span><select name="compatibility:${esc(v.id)}" class="fitment-state"><option value="NONE" ${stateValue==='NONE'?'selected':''}>NO RECORD</option><option value="FITS" ${stateValue==='FITS'?'selected':''}>FITS</option><option value="DOES_NOT_FIT" ${stateValue==='DOES_NOT_FIT'?'selected':''}>DOES NOT FIT</option></select><label class="verify-toggle" title="Verified evidence"><input type="checkbox" name="verifiedVariant" value="${esc(v.id)}" ${fit?.verified?'checked':''}><span>${fit?.verified?'VERIFIED':'VERIFY'}</span></label><code>${esc(v.engineCode)}</code></div>`;
    }).join('');
    openModal(`<form id="fitment-form" data-product-id="${esc(productId)}" data-existing="${esc(JSON.stringify(existing))}"><div class="modal-header"><div><h2>Manage fitment evidence</h2><p>${esc(product.name)} · ${esc(product.sku)}</p></div><button type="button" class="icon-btn" data-modal-close>×</button></div><div class="modal-body"><div class="toolbar" style="margin-bottom:12px"><div class="toolbar-left" style="width:100%"><input id="fitment-filter" type="search" placeholder="Filter make, model or engine code…" style="width:100%"></div><div class="toolbar-right"><select name="fitmentSource" title="Evidence source"><option>MANUAL</option><option>OEM</option><option>SUPPLIER</option><option>IMPORTED</option><option>COMMUNITY</option></select></div></div><div class="fitment-evidence-note"><strong>FITS</strong> is positive compatibility evidence. <strong>DOES NOT FIT</strong> is explicit negative evidence. <strong>NO RECORD</strong> means UNKNOWN — never automatically incompatible. Use VERIFY only when the exact record has been reviewed.</div><div id="fitment-picker" class="fitment-picker">${options||'<div class="empty-state"><div><b>No vehicle variants</b><span>Add vehicles first.</span></div></div>'}</div></div><div class="modal-footer"><button type="button" class="btn" data-modal-close>Cancel</button><button class="btn btn-primary" type="submit">Save fitment evidence</button></div></form>`,'modal-lg');
  }

  async function submitFitmentForm(form) {
    const productId=form.dataset.productId, fd=new FormData(form), existing=safeJson(form.dataset.existing)||{}, source=String(fd.get('fitmentSource')||'MANUAL');
    const verified=new Set(fd.getAll('verifiedVariant').map(String));
    const rows=$$('.fitment-state',form).map(select=>({id:select.name.slice('compatibility:'.length),compatibility:select.value,verified:verified.has(select.name.slice('compatibility:'.length))}));
    for(const row of rows){
      const was=existing[row.id];
      if(row.compatibility==='NONE'){
        if(was) await api(`/api/admin/products/${productId}/fitments/${row.id}`,{method:'DELETE'});
        continue;
      }
      if(!was){await api(`/api/admin/products/${productId}/fitments`,{method:'POST',body:JSON.stringify({vehicleVariantIds:[row.id],compatibility:row.compatibility,verified:row.verified,source})});continue;}
      if(was.compatibility!==row.compatibility||Boolean(was.verified)!==row.verified||was.source!==source){await api(`/api/admin/products/${productId}/fitments/${row.id}`,{method:'PATCH',body:JSON.stringify({compatibility:row.compatibility,verified:row.verified,source})});}
    }
    const counts=rows.reduce((acc,row)=>{acc[row.compatibility]=(acc[row.compatibility]||0)+1;return acc;},{});
    closeModal();toast('Fitment evidence updated',`${counts.FITS||0} fit · ${counts.DOES_NOT_FIT||0} do not fit · ${counts.NONE||0} unknown/no record`);await renderProducts();
  }

  async function openVehicleModelModal() {
    const makes = await api('/api/vehicles/makes');
    openModal(`<form id="vehicle-model-form"><div class="modal-header"><div><h2>Add make / model</h2><p>Expand the vehicle catalogue before adding engine variants</p></div><button type="button" class="icon-btn" data-modal-close>×</button></div><div class="modal-body"><div class="form-grid"><div class="divider-title">Use an existing make</div><label class="field span-2"><span>Existing make</span><select name="makeId"><option value="">Choose existing make</option>${makes.map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}</select></label><div class="divider-title">Or create a new make</div><label class="field"><span>New make name</span><input name="newMakeName" placeholder="Mercedes-Benz" /></label><label class="field"><span>New make slug</span><input name="newMakeSlug" placeholder="mercedes-benz" /></label><div class="divider-title">Model</div><label class="field"><span>Model name</span><input name="modelName" required placeholder="C43 AMG" /></label><label class="field"><span>Model slug</span><input name="modelSlug" required placeholder="c43-amg" /></label></div></div><div class="modal-footer"><button type="button" class="btn" data-modal-close>Cancel</button><button class="btn btn-primary" type="submit">Create model</button></div></form>`);
  }

  async function submitVehicleModelForm(form) {
    const fd = new FormData(form);
    let makeId = String(fd.get('makeId') || '');
    const newMakeName = optionalString(fd.get('newMakeName'));
    const newMakeSlug = optionalString(fd.get('newMakeSlug'));
    if (!makeId) {
      if (!newMakeName || !newMakeSlug) throw new Error('Choose an existing make or enter both a new make name and slug.');
      const make = await api('/api/admin/vehicle-makes', { method: 'POST', body: JSON.stringify({ name: newMakeName, slug: newMakeSlug }) });
      makeId = make.id;
    }
    const payload = { makeId, name: String(fd.get('modelName') || ''), slug: String(fd.get('modelSlug') || '') };
    await api('/api/admin/vehicle-models', { method: 'POST', body: JSON.stringify(payload) });
    closeModal(); toast('Vehicle model created', payload.name); await renderVehicles();
  }

  function optionalString(value) {
    const text = String(value || '').trim();
    return text || undefined;
  }

  function openModal(content, className = '') {
    modalRoot.innerHTML = `<div class="modal-backdrop"><section class="modal ${esc(className)}">${content}</section></div>`;
  }

  function closeModal() {
    modalRoot.innerHTML = '';
  }

  async function submitSupplierForm(form) {
    const fd = new FormData(form);
    const payload = { name: String(fd.get('name')), code: String(fd.get('code')), type: String(fd.get('type')), priority: Number(fd.get('priority') || 100) };
    const baseUrl = optionalString(fd.get('baseUrl'));
    if (baseUrl) payload.baseUrl = baseUrl;
    await api('/api/admin/suppliers', { method: 'POST', body: JSON.stringify(payload) });
    closeModal(); toast('Supplier added', payload.name); await renderSuppliers();
  }

  async function submitSupplierProductForm(form) {
    const fd = new FormData(form);
    const payload = {
      supplierId: String(fd.get('supplierId')),
      productId: String(fd.get('productId')),
      supplierProductId: String(fd.get('supplierProductId')),
      supplierSku: optionalString(fd.get('supplierSku')),
      costCents: Math.round(Number(fd.get('cost') || 0) * 100),
      shippingCents: Math.round(Number(fd.get('shipping') || 0) * 100),
      currency: 'USD',
      stock: fd.get('stock') === '' ? undefined : Number(fd.get('stock')),
      leadTimeDays: fd.get('leadTimeDays') === '' ? undefined : Number(fd.get('leadTimeDays')),
      warehouseCountry: optionalString(fd.get('warehouseCountry'))?.toUpperCase(),
      reliabilityScore: fd.get('reliabilityScore') === '' ? undefined : Number(fd.get('reliabilityScore')),
    };
    await api('/api/admin/supplier-products', { method: 'POST', body: JSON.stringify(payload) });
    closeModal(); toast('Supplier SKU linked', 'Inventory routing is now available for this product.'); await renderInventory();
  }

  async function submitVehicleForm(form) {
    const fd = new FormData(form);
    const payload = {
      modelId: String(fd.get('modelId')),
      yearStart: Number(fd.get('yearStart')),
      yearEnd: Number(fd.get('yearEnd')),
      trim: optionalString(fd.get('trim')),
      chassisCode: optionalString(fd.get('chassisCode')),
      engineCode: String(fd.get('engineCode')),
      engineName: String(fd.get('engineName')),
      displacementCc: fd.get('displacementCc') ? Number(fd.get('displacementCc')) : undefined,
      aspiration: optionalString(fd.get('aspiration')),
      fuelType: optionalString(fd.get('fuelType')),
      drivetrain: optionalString(fd.get('drivetrain')),
      transmission: optionalString(fd.get('transmission')),
    };
    await api('/api/admin/vehicles/variants', { method: 'POST', body: JSON.stringify(payload) });
    closeModal(); toast('Vehicle variant added', `${payload.engineCode} is ready for product fitment.`); await renderVehicles();
  }

  function debounce(fn, ms = 300) {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(fn, ms);
  }

  document.addEventListener('click', async event => {
    const nav = event.target.closest('[data-view]');
    if (nav) { navigate(nav.dataset.view); return; }
    const directNav = event.target.closest('[data-nav]');
    if (directNav) { navigate(directNav.dataset.nav); return; }
    if (event.target.closest('[data-modal-close]') || (event.target.classList.contains('modal-backdrop'))) { closeModal(); return; }

    const actionEl = event.target.closest('[data-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    try {
      if (action === 'view-customer-360') await openCustomer360(actionEl.dataset.id);
      else if (action === 'add-customer-note') { const body=prompt('Internal staff note:'); if(body?.trim()){await api(`/api/admin/customer-intelligence/customers/${actionEl.dataset.customerId}/notes`,{method:'POST',body:JSON.stringify({body})});toast('Customer note added');await openCustomer360(actionEl.dataset.customerId);} }
      else if (action === 'delete-customer-note') { if(confirm('Delete this note?')){await api(`/api/admin/customer-intelligence/customers/${actionEl.dataset.customerId}/notes/${actionEl.dataset.noteId}`,{method:'DELETE'});await openCustomer360(actionEl.dataset.customerId);} }
      else if (action === 'add-customer-tag') { const tag=prompt('Customer tag (VIP, WHOLESALE, FOLLOW_UP):'); if(tag?.trim()){await api(`/api/admin/customer-intelligence/customers/${actionEl.dataset.customerId}/tags`,{method:'POST',body:JSON.stringify({tag})});await openCustomer360(actionEl.dataset.customerId);} }
      else if (action === 'remove-customer-tag') { await api(`/api/admin/customer-intelligence/customers/${actionEl.dataset.customerId}/tags/${actionEl.dataset.tag}`,{method:'DELETE'});await openCustomer360(actionEl.dataset.customerId); }
      else if (action === 'toggle-customer-status') { const isActive=actionEl.dataset.active!=='true'; if(confirm(`${isActive?'Reactivate':'Deactivate'} this customer account?`)){await api(`/api/admin/customer-intelligence/customers/${actionEl.dataset.id}/status`,{method:'PATCH',body:JSON.stringify({isActive})});await openCustomer360(actionEl.dataset.id);} }
      else if (action === 'readiness-update') { const status=(prompt('Status: PASS, FAIL, NEEDS_TEST, NEEDS_CONFIGURATION, NOT_APPLICABLE',actionEl.dataset.status)||'').trim().toUpperCase(); if(status){const note=prompt('Evidence / note (never paste secrets):')||undefined;await api(`/api/admin/readiness/${encodeURIComponent(actionEl.dataset.key)}`,{method:'PUT',body:JSON.stringify({status,note})});await renderReadiness();} }
      else if (action === 'commerce-add-region') { const country=(prompt('Country code (ZA, US, GB):')||'').trim().toUpperCase();const currency=(prompt('Settlement currency (usually USD):','USD')||'USD').trim().toUpperCase();const locale=(prompt('Locale:','en-ZA')||'en-ZA').trim();const payments=(prompt('Payment providers, comma-separated:','STRIPE,PAYPAL')||'STRIPE').split(',').map(x=>x.trim().toUpperCase()).filter(Boolean);if(country){await api('/api/admin/commerce/regions',{method:'POST',body:JSON.stringify({country,currency,locale,shippingAllowed:true,taxRequired:true,dutiesRequired:false,paymentMethods:payments})});await renderCommerce();} }
      else if (action === 'commerce-add-fx') { const quote=(prompt('Display currency (example ZAR):')||'').trim().toUpperCase();const rate=Number(prompt(`1 USD = how many ${quote}?`,''));if(quote&&rate>0){await api('/api/admin/commerce/fx-rates',{method:'POST',body:JSON.stringify({baseCurrency:'USD',quoteCurrency:quote,rate,source:'MANUAL'})});await renderCommerce();} }
      else if (action === 'commerce-add-tax') { const country=(prompt('Country code:','ZA')||'').trim().toUpperCase();const region=(prompt('State/region code (blank for country-wide):','')||'').trim().toUpperCase()||undefined;const label=prompt('Tax label:','VAT')||'VAT';const percent=Number(prompt('Tax rate percent:','15'));const inclusive=confirm('Are storefront prices tax-inclusive for this jurisdiction?');if(country&&percent>=0){await api('/api/admin/commerce/tax-rules',{method:'POST',body:JSON.stringify({country,region,label,taxType:label.toUpperCase().includes('VAT')?'VAT':'SALES_TAX',rateBps:Math.round(percent*100),taxInclusive:inclusive,priority:region?200:100})});await renderCommerce();} }
      else if (action === 'commerce-add-zone') { const name=prompt('Shipping zone name:','South Africa')||'';const countries=(prompt('Country codes, comma-separated:','ZA')||'').split(',').map(x=>x.trim().toUpperCase()).filter(Boolean);const rate=Math.round(Number(prompt('Flat shipping rate in settlement currency:','18'))*100);const freeRaw=Number(prompt('Free shipping threshold (0 = none):','250'));const free=freeRaw>0?Math.round(freeRaw*100):null;if(name&&countries.length){await api('/api/admin/commerce/shipping-zones',{method:'POST',body:JSON.stringify({name,countries,currency:'USD',rateCents:Math.max(0,rate),freeShippingThresholdCents:free,priority:100,active:true})});await renderCommerce();} }
      else if (action === 'add-product') await openProductModal();
      else if (action === 'edit-product') await openProductModal(actionEl.dataset.id);
      else if (action === 'view-order') await openOrderModal(actionEl.dataset.id);
      else if (action === 'add-supplier') await openSupplierModal();
      else if (action === 'link-supplier-product') await openSupplierProductModal();
      else if (action === 'add-vehicle') await openVehicleModal();
      else if (action === 'add-model') await openVehicleModelModal();
      else if (action === 'manage-fitments') await openFitmentModal(actionEl.dataset.id);
      else if (action === 'dealer-review') {
        const notes = prompt(`Moderator notes for ${actionEl.dataset.decision.toLowerCase()} decision (optional):`) || undefined;
        await api(`/api/admin/trust/dealer-verifications/${actionEl.dataset.id}`, { method:'PATCH', body:JSON.stringify({ status:actionEl.dataset.decision, reviewNotes:notes }) });
        toast('Dealer verification updated', actionEl.dataset.decision); await renderTrust();
      } else if (action === 'report-review') {
        const enforcement = prompt('Enforcement: NONE, SUSPEND_USER, REMOVE_POST, or ARCHIVE_LISTING', 'NONE')?.trim().toUpperCase() || 'NONE';
        const notes = prompt('Moderator notes (optional):') || undefined;
        await api(`/api/admin/trust/reports/${actionEl.dataset.id}`, { method:'PATCH', body:JSON.stringify({ status:'ACTIONED', action:enforcement, moderatorNotes:notes }) });
        toast('Report actioned', enforcement); await renderTrust();
      } else if (action === 'archive-product') {
        if (confirm('Archive this product? It will stop appearing in the active catalogue.')) {
          await api(`/api/admin/products/${actionEl.dataset.id}`, { method: 'DELETE' });
          closeModal(); toast('Product archived'); await renderProducts();
        }
      } else if (action === 'mark-order-paid') {
        if (confirm('Mark this order as paid and submit it to configured suppliers?')) {
          actionEl.disabled = true; actionEl.textContent = 'Submitting…';
          await api(`/api/admin/orders/${actionEl.dataset.id}/mark-paid`, { method: 'POST' });
          toast('Order sent to fulfillment', 'Supplier fulfillments were created/submitted.');
          await openOrderModal(actionEl.dataset.id);
        }
      } else if (action === 'save-order-status') {
        const status = $('#modal-order-status')?.value;
        await api(`/api/admin/orders/${actionEl.dataset.id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
        toast('Order status updated', status.replaceAll('_',' '));
        await openOrderModal(actionEl.dataset.id);
      } else if (action === 'refresh-fulfillment') {
        actionEl.disabled = true;
        await api(`/api/admin/suppliers/fulfillments/${actionEl.dataset.id}/refresh`, { method: 'POST' });
        toast('Tracking refreshed'); await renderFulfillment();
      } else if (action === 'syncee-fulfillment') {
        const trackingNumber = prompt('Syncee tracking number (leave blank if not shipped yet)') || undefined;
        const carrier = trackingNumber ? (prompt('Carrier', 'DHL') || 'Courier') : undefined;
        if (trackingNumber) await api(`/api/admin/suppliers/fulfillments/${actionEl.dataset.id}/manual`, { method:'PATCH', body:JSON.stringify({ status:'SHIPPED', trackingNumber, carrier }) });
        window.open('https://syncee.com', '_blank', 'noopener');
        if (trackingNumber) { toast('Syncee tracking saved'); await renderFulfillment(); }
      } else if (action === 'apply-pricing') {
        if (confirm('Apply active pricing rules to all dropship products?')) {
          actionEl.disabled = true;
          const result = await api('/api/admin/ops/pricing/apply', { method: 'POST' });
          toast('Pricing updated', `${result.updated} products changed.`); await renderOperations();
        }
      } else if (action === 'review-case') {
        await openSupportCaseModal(actionEl.dataset.id);
      } else if (action === 'save-case-status') {
        const status = $('#support-case-status')?.value;
        await api(`/api/support/admin/cases/${actionEl.dataset.id}`, { method:'PATCH', body:JSON.stringify({ status }) });
        closeModal(); toast('Case updated', status.replaceAll('_',' ')); await renderOperations();
      } else if (action === 'refund-case') {
        const maxCents = Number(actionEl.dataset.max || 0);
        const raw = prompt(`Refund amount in USD (maximum ${(maxCents / 100).toFixed(2)})`, (maxCents / 100).toFixed(2));
        if (raw !== null) {
          const amountCents = Math.round(Number(raw) * 100);
          if (!Number.isFinite(amountCents) || amountCents <= 0 || amountCents > maxCents) throw new Error('Enter a valid refund amount.');
          if (!confirm(`Refund ${money(amountCents)}? This sends real money through the payment provider.`)) return;
          await api(`/api/support/admin/cases/${actionEl.dataset.id}/refund`, { method:'POST', body:JSON.stringify({ amountCents }) });
          closeModal(); toast('Refund submitted', money(amountCents)); await renderOperations();
        }
      } else if (action === 'copy-command') {
        await navigator.clipboard.writeText(actionEl.dataset.copy || ''); toast('Copied', actionEl.dataset.copy || '');
      } else if (action === 'logout') logout();
    } catch (error) { toast('Action failed', error.message, 'error'); }
  });

  document.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.target;
    try {
      if (form.id === 'login-form') {
        const button = $('#login-button');
        const errorNode = $('#login-error');
        errorNode.hidden = true; button.disabled = true; button.firstElementChild.textContent = 'Signing in…';
        try {
          let result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: $('#login-email').value, password: $('#login-password').value }) });
          if (result.requiresTwoFactor) {
            const code = prompt('Enter your 6-digit authenticator code');
            if (!code) throw new Error('Two-factor code is required.');
            result = await api('/api/auth/login/2fa', { method: 'POST', body: JSON.stringify({ challengeToken: result.challengeToken, code: code.trim() }) });
          }
          if (!['ADMIN', 'STAFF'].includes(result.user?.role)) throw new Error('This account is not an admin or staff account.');
          setSession(result.token, result.user); enterApp(); toast('Welcome to SANDMAN', `Signed in as ${result.user.email}`);
        } catch (error) {
          errorNode.textContent = error.message; errorNode.hidden = false;
        } finally {
          button.disabled = false; button.firstElementChild.textContent = 'Enter dashboard';
        }
      } else if (form.id === 'admin-password-form') {
        const fd = new FormData(form);
        const currentPassword = String(fd.get('currentPassword') || '');
        const newPassword = String(fd.get('newPassword') || '');
        const confirmPassword = String(fd.get('confirmPassword') || '');
        if (newPassword !== confirmPassword) throw new Error('New passwords do not match.');
        const result = await api('/api/auth/change-password', { method:'POST', body:JSON.stringify({ currentPassword, newPassword }) });
        setSession(result.token, result.user); form.reset(); toast('Password changed', 'Other persistent sessions were signed out.');
      } else if (form.id === 'promo-form') {
        const fd = new FormData(form);
        const percentOff = Number(fd.get('percentOff'));
        const maxUsesRaw = String(fd.get('maxUses') || '').trim();
        await api('/api/admin/ops/promos', { method:'POST', body:JSON.stringify({ code:String(fd.get('code') || '').trim(), percentOff, ...(maxUsesRaw ? { maxUses:Number(maxUsesRaw) } : {}) }) });
        toast('Promo created'); await renderOperations();
      } else if (form.id === 'pricing-rule-form') {
        const fd = new FormData(form);
        const markupRaw = String(fd.get('markupPercent') || '').trim();
        const profitRaw = String(fd.get('minimumProfit') || '').trim();
        await api('/api/admin/ops/pricing-rules', { method:'POST', body:JSON.stringify({ name:String(fd.get('name') || '').trim(), ...(markupRaw ? { markupPercent:Number(markupRaw) } : {}), ...(profitRaw ? { minimumProfitCents:Math.round(Number(profitRaw) * 100) } : {}) }) });
        toast('Pricing rule created'); await renderOperations();
      } else if (form.id === 'product-form') await submitProductForm(form);
      else if (form.id === 'supplier-form') await submitSupplierForm(form);
      else if (form.id === 'supplier-product-form') await submitSupplierProductForm(form);
      else if (form.id === 'vehicle-form') await submitVehicleForm(form);
      else if (form.id === 'vehicle-model-form') await submitVehicleModelForm(form);
      else if (form.id === 'fitment-form') await submitFitmentForm(form);
    } catch (error) { toast('Could not save', error.message, 'error'); }
  });

  document.addEventListener('input', event => {
    if (event.target.id === 'product-search') debounce(() => renderProducts({ q: event.target.value, status: $('#product-status')?.value || '' }));
    else if (event.target.id === 'order-search') debounce(() => renderOrders({ q: event.target.value, status: $('#order-status')?.value || '' }));
    else if (event.target.id === 'vehicle-search') debounce(() => renderVehicles({ q: event.target.value }));
    else if (event.target.id === 'customer-search') debounce(() => renderCustomerIntelligence({ q:event.target.value,status:$('#customer-status')?.value||'ALL',sort:$('#customer-sort')?.value||'newest' }));
    else if (event.target.id === 'fitment-filter') { const q = event.target.value.toLowerCase(); $$('.fitment-option', $('#fitment-picker')).forEach(row => { row.hidden = !row.textContent.toLowerCase().includes(q); }); }
  });

  document.addEventListener('change', async event => {
    if (event.target.classList.contains('request-status-select')) {
      try {
        const kind = event.target.dataset.kind;
        const id = event.target.dataset.id;
        const status = event.target.value;
        await api(`/api/v2/admin/requests/${kind}/${id}`, { method:'PATCH', body:JSON.stringify({ status }) });
        toast('Sourcing request updated', status.replaceAll('_',' '));
        await renderSourcing();
      } catch (error) { toast('Could not update request', error.message, 'error'); }
    } else if (event.target.id === 'product-status') renderProducts({ q: $('#product-search')?.value || '', status: event.target.value });
    else if (event.target.id === 'order-status') renderOrders({ q: $('#order-search')?.value || '', status: event.target.value });
    else if (event.target.id === 'customer-status' || event.target.id === 'customer-sort') renderCustomerIntelligence({ q:$('#customer-search')?.value||'',status:$('#customer-status')?.value||'ALL',sort:$('#customer-sort')?.value||'newest' });
  });

  $('#refresh-button').addEventListener('click', () => navigate(state.view));
  $('#quick-add-button').addEventListener('click', () => openProductModal().catch(error => toast('Could not open product form', error.message, 'error')));
  $('#logout-button').addEventListener('click', () => logout());
  $('#mobile-menu-button').addEventListener('click', () => setAdminMenu(!$('#admin-sidebar')?.classList.contains('open')));
  $('#sidebar-backdrop').addEventListener('click', () => setAdminMenu(false));
  $('#global-search').addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      const q = event.target.value.trim();
      if (q) { navigate('products').then(() => { const input = $('#product-search'); if (input) { input.value = q; input.dispatchEvent(new Event('input', { bubbles: true })); } }); }
    }
  });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#global-search')?.focus(); }
    if (event.key === 'Escape') { if (modalRoot.innerHTML) closeModal(); setAdminMenu(false); }
  });

  $$('.clickable-order').forEach(() => {});
  viewRoot.addEventListener('click', event => {
    const row = event.target.closest('.clickable-order');
    if (row?.dataset.orderId) openOrderModal(row.dataset.orderId).catch(error => toast('Could not load order', error.message, 'error'));
  });

  let responsiveTableFrame = 0;
  const refreshResponsiveTables = () => { enhanceResponsiveTables(viewRoot); enhanceResponsiveTables(modalRoot); };
  const responsiveTableObserver = new MutationObserver(() => {
    cancelAnimationFrame(responsiveTableFrame);
    responsiveTableFrame = requestAnimationFrame(refreshResponsiveTables);
  });
  responsiveTableObserver.observe(viewRoot, { childList: true, subtree: true });
  responsiveTableObserver.observe(modalRoot, { childList: true, subtree: true });
  refreshResponsiveTables();

  (async function boot() {
    syncThemeUi();
    $$('[data-theme-toggle]').forEach(button => button.addEventListener('click', toggleTheme));
    await checkApi();
    const valid = await validateSession();
    if (valid) enterApp();
  })();
})();
