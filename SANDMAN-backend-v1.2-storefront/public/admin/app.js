(() => {
  'use strict';

  const TOKEN_KEY = 'sandman_admin_token';
  const USER_KEY = 'sandman_admin_user';
  const state = {
    token: localStorage.getItem(TOKEN_KEY),
    user: safeJson(localStorage.getItem(USER_KEY)),
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

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    if (state.token) headers.Authorization = `Bearer ${state.token}`;

    const response = await fetch(path, { ...options, headers });
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json() : await response.text();

    if (response.status === 401 && !path.includes('/auth/login')) {
      logout(false);
      throw new Error('Your admin session expired. Please sign in again.');
    }
    if (!response.ok) {
      const message = data?.error?.message || data?.message || (typeof data === 'string' && data) || `Request failed (${response.status})`;
      throw new Error(message);
    }
    return data;
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
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  }

  function logout(showMessage = true) {
    state.token = null;
    state.user = null;
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    appShell.hidden = true;
    loginView.hidden = false;
    closeModal();
    if (showMessage) toast('Signed out', 'Your SANDMAN admin session has ended.');
  }

  async function validateSession() {
    if (!state.token) return false;
    try {
      const user = await api('/api/auth/me');
      if (!['ADMIN', 'STAFF'].includes(user.role)) throw new Error('This account does not have admin access.');
      state.user = user;
      localStorage.setItem(USER_KEY, JSON.stringify(user));
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
    $('.sidebar')?.classList.remove('open');
    viewRoot.innerHTML = `<div class="empty-state"><div><b>Loading ${esc(view)}…</b><span>Syncing with SANDMAN API</span></div></div>`;
    try {
      if (view === 'overview') await renderOverview();
      else if (view === 'products') await renderProducts();
      else if (view === 'orders') await renderOrders();
      else if (view === 'inventory') await renderInventory();
      else if (view === 'suppliers') await renderSuppliers();
      else if (view === 'vehicles') await renderVehicles();
      else if (view === 'fulfillment') await renderFulfillment();
      else if (view === 'customers') await renderCustomers();
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
        <td>${item.stock === null ? '—' : `<span class="${item.stock <= 10 ? 'stock-number' : ''}">${esc(item.stock)}</span>`}</td>
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

  async function renderFulfillment() {
    heading('Fulfillment', 'Supplier submissions, tracking and delivery state.');
    const items = await api('/api/admin/fulfillments');
    state.cache.fulfillments = items;
    const rows = items.length ? items.map(item => `
      <tr><td><strong>${esc(item.order.orderNumber)}</strong><br><span class="subtle">${esc(item.order.email)}</span></td><td>${esc(item.supplier.name)}</td><td>${badge(item.status)}</td><td>${esc(item.supplierOrderId || '—')}</td><td>${esc(item.carrier || '—')}</td><td>${esc(item.trackingNumber || '—')}</td><td>${esc(dateTime(item.updatedAt))}</td>${item.supplierOrderId ? `<td class="text-right"><button class="table-action" data-action="refresh-fulfillment" data-id="${esc(item.id)}">REFRESH ↻</button></td>` : '<td></td>'}</tr>`).join('') : `<tr><td colspan="8"><div class="empty-state"><div><b>No fulfillments yet</b><span>Paid orders submitted to suppliers appear here.</span></div></div></td></tr>`;
    viewRoot.innerHTML = `<section class="data-panel"><div class="table-wrap"><table><thead><tr><th>Order</th><th>Supplier</th><th>Status</th><th>Supplier order</th><th>Carrier</th><th>Tracking</th><th>Updated</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }

  async function renderCustomers(filters = {}) {
    heading('Customers', 'Customer accounts, garage usage and lifetime spend.');
    const qs = new URLSearchParams();
    if (filters.q) qs.set('q', filters.q);
    const customers = await api(`/api/admin/customers?${qs}`);
    state.cache.customers = customers;
    const rows = customers.length ? customers.map(customer => `
      <tr><td><div class="cell-title"><span class="avatar">${esc((customer.firstName?.[0] || customer.email[0] || 'C').toUpperCase())}</span><div class="cell-title-copy"><strong>${esc([customer.firstName, customer.lastName].filter(Boolean).join(' ') || 'Customer')}</strong><small>${esc(customer.email)}</small></div></div></td><td>${esc(customer.phone || '—')}</td><td>${esc(customer._count.orders)}</td><td>${esc(customer._count.garage)}</td><td><strong>${esc(money(customer.totalSpentCents))}</strong></td><td>${badge(customer.isActive ? 'ACTIVE' : 'ARCHIVED')}</td><td>${esc(shortDate(customer.createdAt))}</td></tr>`).join('') : `<tr><td colspan="7"><div class="empty-state"><div><b>No customers yet</b><span>Registered shoppers will appear here.</span></div></div></td></tr>`;
    viewRoot.innerHTML = `<div class="toolbar"><div class="toolbar-left"><input id="customer-search" type="search" value="${esc(filters.q || '')}" placeholder="Search customer name or email…" /></div><div class="toolbar-right"><span class="date-chip">${customers.length} CUSTOMERS</span></div></div><section class="data-panel"><div class="table-wrap"><table><thead><tr><th>Customer</th><th>Phone</th><th>Orders</th><th>Garage</th><th>Lifetime spend</th><th>Status</th><th>Joined</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }

  async function renderSettings() {
    heading('Settings', 'Local development configuration and SANDMAN system status.');
    const health = await api('/api/health');
    viewRoot.innerHTML = `
      <section class="settings-grid">
        <article class="setting-card"><div class="eyebrow">API</div><h3>SANDMAN backend</h3><p>The admin console is served by the same Express application as your ecommerce API.</p><div class="code-block">${esc(JSON.stringify(health, null, 2))}</div></article>
        <article class="setting-card"><div class="eyebrow">DATABASE</div><h3>PostgreSQL + Prisma</h3><p>Products, fitments, suppliers, customers and orders are stored in PostgreSQL through Prisma.</p><button class="btn" data-action="copy-command" data-copy="npx prisma studio">Copy Prisma Studio command</button></article>
        <article class="setting-card"><div class="eyebrow">SECURITY</div><h3>Admin session</h3><p>You are signed in as ${esc(state.user?.email || '')}. JWT authorization protects all admin API routes.</p><button class="btn btn-danger" data-action="logout">Sign out</button></article>
        <article class="setting-card"><div class="eyebrow">ENVIRONMENT</div><h3>Development mode</h3><p>Before production, replace demo credentials, configure a production database, HTTPS, payment secrets and real supplier API keys.</p><div class="code-block">SANDMAN Admin V1.1\nhttp://localhost:4000/admin</div></article>
      </section>`;
  }

  async function openProductModal(productId = null) {
    const categories = state.cache.categories || await api('/api/admin/categories');
    let product = null;
    if (productId) product = await api(`/api/admin/products/${productId}`);
    const categoryOptions = categories.map(c => `<option value="${esc(c.id)}" ${product?.categoryId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    const supplierSummary = product?.supplierLinks?.length ? product.supplierLinks.map(link => `<div class="order-item"><div><strong>${esc(link.supplier.name)}</strong><small>${esc(link.supplierSku || link.supplierProductId)} · stock ${esc(link.stock ?? 'n/a')}</small></div><strong>${esc(money(link.costCents + link.shippingCents, link.currency))}</strong></div>`).join('') : '<div class="empty-state"><div><b>No supplier linked</b><span>Use Inventory to connect this part to a dropship supplier.</span></div></div>';
    const fitmentSummary = product?.fitments?.length ? product.fitments.slice(0, 12).map(f => `<span class="badge badge-submitted">${esc(f.vehicleVariant.model.make.name)} ${esc(f.vehicleVariant.model.name)} · ${esc(f.vehicleVariant.engineCode)}</span>`).join(' ') : '<span class="subtle">No fitments linked yet.</span>';

    openModal(`
      <form id="product-form" data-id="${esc(productId || '')}">
        <div class="modal-header"><div><h2>${product ? 'Edit product' : 'New engine part'}</h2><p>${product ? esc(product.sku) : 'Create a SANDMAN catalogue item'}</p></div><button type="button" class="icon-btn" data-modal-close>×</button></div>
        <div class="modal-body"><div class="form-grid">
          <label class="field"><span>Product name</span><input name="name" required minlength="2" value="${esc(product?.name || '')}" placeholder="B58 Upgraded Intercooler" /></label>
          <label class="field"><span>SKU</span><input name="sku" required value="${esc(product?.sku || '')}" placeholder="SM-B58-IC-002" ${product ? 'disabled' : ''} /></label>
          <label class="field"><span>Slug</span><input name="slug" required value="${esc(product?.slug || '')}" placeholder="b58-upgraded-intercooler" ${product ? 'disabled' : ''} /></label>
          <label class="field"><span>Brand</span><input name="brand" value="${esc(product?.brand || '')}" placeholder="SANDMAN Performance" /></label>
          <label class="field"><span>Manufacturer part no.</span><input name="manufacturerPn" value="${esc(product?.manufacturerPn || '')}" placeholder="OEM / supplier cross-reference" /></label>
          <label class="field"><span>Category</span><select name="categoryId" required><option value="">Choose category</option>${categoryOptions}</select></label>
          <label class="field"><span>Retail price (USD)</span><input name="price" type="number" step="0.01" min="0" required value="${product ? (product.priceCents / 100).toFixed(2) : ''}" placeholder="399.99" /></label>
          <label class="field"><span>Compare-at price</span><input name="compareAt" type="number" step="0.01" min="0" value="${product?.compareAtCents ? (product.compareAtCents / 100).toFixed(2) : ''}" placeholder="449.99" /></label>
          <label class="field"><span>Status</span><select name="status">${['DRAFT','ACTIVE','ARCHIVED'].map(v => `<option ${product?.status === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
          <label class="field"><span>Image URL</span><input name="imageUrl" type="url" value="${esc(product?.images?.[0]?.url || '')}" placeholder="https://…" ${product ? 'disabled' : ''} /></label>
          <label class="field span-2"><span>Short description</span><input name="shortDesc" maxlength="500" value="${esc(product?.shortDesc || '')}" placeholder="Short storefront summary" /></label>
          <label class="field span-2"><span>Description</span><textarea name="description" required minlength="10" placeholder="Specifications, materials and verified supplier information…">${esc(product?.description || '')}</textarea></label>
          <label class="field-check"><input name="requiresFitment" type="checkbox" ${product?.requiresFitment !== false ? 'checked' : ''} /><span>Requires vehicle fitment</span></label>
          <label class="field-check"><input name="isUniversal" type="checkbox" ${product?.isUniversal ? 'checked' : ''} /><span>Universal part</span></label>
          ${product ? `<div class="divider-title">Supplier sourcing</div><div class="span-2">${supplierSummary}</div><div class="divider-title">Current fitments</div><div class="span-2" style="display:flex;gap:6px;flex-wrap:wrap">${fitmentSummary}</div>` : ''}
        </div></div>
        <div class="modal-footer">${product ? '<button type="button" class="btn btn-danger" data-action="archive-product" data-id="' + esc(product.id) + '">Archive</button><button type="button" class="btn" data-action="manage-fitments" data-id="' + esc(product.id) + '">Manage fitments</button>' : ''}<button type="button" class="btn" data-modal-close>Cancel</button><button class="btn btn-primary" type="submit">${product ? 'Save changes' : 'Create product'}</button></div>
      </form>`, 'modal-lg');
  }

  async function submitProductForm(form) {
    const fd = new FormData(form);
    const productId = form.dataset.id;
    const payload = {
      name: String(fd.get('name') || ''),
      brand: optionalString(fd.get('brand')),
      manufacturerPn: optionalString(fd.get('manufacturerPn')),
      description: String(fd.get('description') || ''),
      shortDesc: optionalString(fd.get('shortDesc')),
      categoryId: String(fd.get('categoryId') || ''),
      priceCents: Math.round(Number(fd.get('price') || 0) * 100),
      compareAtCents: fd.get('compareAt') ? Math.round(Number(fd.get('compareAt')) * 100) : undefined,
      currency: 'USD',
      requiresFitment: fd.get('requiresFitment') === 'on',
      isUniversal: fd.get('isUniversal') === 'on',
      status: String(fd.get('status') || 'DRAFT'),
    };
    if (!productId) {
      payload.sku = String(fd.get('sku') || '');
      payload.slug = String(fd.get('slug') || '');
      const imageUrl = optionalString(fd.get('imageUrl'));
      payload.images = imageUrl ? [{ url: imageUrl, alt: payload.name, position: 0 }] : [];
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
    openModal(`<form id="supplier-form"><div class="modal-header"><div><h2>Add supplier</h2><p>Connect a dropship or wholesale source</p></div><button type="button" class="icon-btn" data-modal-close>×</button></div><div class="modal-body"><div class="form-grid"><label class="field"><span>Name</span><input name="name" required placeholder="CJ Dropshipping" /></label><label class="field"><span>Code</span><input name="code" required placeholder="cj" /></label><label class="field"><span>Type</span><select name="type"><option>CJ</option><option>CUSTOM</option><option>MOCK</option></select></label><label class="field"><span>Priority</span><input name="priority" type="number" min="1" value="100" /></label><label class="field span-2"><span>Base API URL (optional)</span><input name="baseUrl" type="url" placeholder="https://supplier-api.example.com" /></label></div></div><div class="modal-footer"><button type="button" class="btn" data-modal-close>Cancel</button><button class="btn btn-primary" type="submit">Add supplier</button></div></form>`);
  }

  async function openSupplierProductModal() {
    const [productsData, suppliers] = await Promise.all([api('/api/admin/products?limit=100'), api('/api/admin/suppliers')]);
    openModal(`<form id="supplier-product-form"><div class="modal-header"><div><h2>Link supplier SKU</h2><p>Map a source product to your SANDMAN catalogue</p></div><button type="button" class="icon-btn" data-modal-close>×</button></div><div class="modal-body"><div class="form-grid"><label class="field span-2"><span>SANDMAN product</span><select name="productId" required><option value="">Choose product</option>${productsData.items.map(p => `<option value="${esc(p.id)}">${esc(p.sku)} — ${esc(p.name)}</option>`).join('')}</select></label><label class="field span-2"><span>Supplier</span><select name="supplierId" required><option value="">Choose supplier</option>${suppliers.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></label><label class="field"><span>Supplier product ID</span><input name="supplierProductId" required /></label><label class="field"><span>Supplier SKU</span><input name="supplierSku" /></label><label class="field"><span>Part cost (USD)</span><input name="cost" type="number" step="0.01" min="0" required /></label><label class="field"><span>Shipping cost (USD)</span><input name="shipping" type="number" step="0.01" min="0" value="0" /></label><label class="field"><span>Stock</span><input name="stock" type="number" min="0" /></label></div></div><div class="modal-footer"><button type="button" class="btn" data-modal-close>Cancel</button><button class="btn btn-primary" type="submit">Link supplier SKU</button></div></form>`);
  }

  async function openVehicleModal() {
    const models = await api('/api/admin/vehicle-models');
    openModal(`<form id="vehicle-form"><div class="modal-header"><div><h2>Add engine variant</h2><p>Extend the SANDMAN fitment database</p></div><button type="button" class="icon-btn" data-modal-close>×</button></div><div class="modal-body"><div class="form-grid"><label class="field span-2"><span>Vehicle model</span><select name="modelId" required><option value="">Choose model</option>${models.map(m => `<option value="${esc(m.id)}">${esc(m.make.name)} — ${esc(m.name)}</option>`).join('')}</select></label><label class="field"><span>Year start</span><input name="yearStart" type="number" min="1900" max="2200" required /></label><label class="field"><span>Year end</span><input name="yearEnd" type="number" min="1900" max="2200" required /></label><label class="field"><span>Trim</span><input name="trim" placeholder="M340i" /></label><label class="field"><span>Chassis code</span><input name="chassisCode" placeholder="G20" /></label><label class="field"><span>Engine code</span><input name="engineCode" required placeholder="B58B30O1" /></label><label class="field"><span>Engine name</span><input name="engineName" required placeholder="B58 3.0L Turbo Inline-6" /></label><label class="field"><span>Displacement (cc)</span><input name="displacementCc" type="number" min="1" placeholder="2998" /></label><label class="field"><span>Aspiration</span><input name="aspiration" placeholder="Turbocharged" /></label><label class="field"><span>Fuel</span><input name="fuelType" placeholder="Petrol" /></label><label class="field"><span>Drivetrain</span><input name="drivetrain" placeholder="RWD/AWD" /></label><label class="field span-2"><span>Transmission</span><input name="transmission" placeholder="8-speed automatic" /></label></div></div><div class="modal-footer"><button type="button" class="btn" data-modal-close>Cancel</button><button class="btn btn-primary" type="submit">Add vehicle variant</button></div></form>`);
  }

  async function openFitmentModal(productId) {
    const [product, variants] = await Promise.all([api(`/api/admin/products/${productId}`), api('/api/admin/vehicles?limit=300')]);
    const selected = new Set(product.fitments.map(f => f.vehicleVariantId));
    const options = variants.map(v => `<label class="fitment-option"><input type="checkbox" name="variant" value="${esc(v.id)}" ${selected.has(v.id) ? 'checked' : ''} /><span><strong>${esc(v.model.make.name)} ${esc(v.model.name)} ${v.trim ? `· ${esc(v.trim)}` : ''}</strong><small>${esc(v.yearStart)}–${esc(v.yearEnd)} · ${esc(v.chassisCode || 'chassis n/a')} · ${esc(v.engineName)}</small></span><code>${esc(v.engineCode)}</code></label>`).join('');
    openModal(`<form id="fitment-form" data-product-id="${esc(productId)}" data-existing="${esc(JSON.stringify([...selected]))}"><div class="modal-header"><div><h2>Manage fitment</h2><p>${esc(product.name)} · ${esc(product.sku)}</p></div><button type="button" class="icon-btn" data-modal-close>×</button></div><div class="modal-body"><div class="toolbar" style="margin-bottom:12px"><div class="toolbar-left" style="width:100%"><input id="fitment-filter" type="search" placeholder="Filter make, model or engine code…" style="width:100%" /></div></div><div id="fitment-picker" class="fitment-picker">${options || '<div class="empty-state"><div><b>No vehicle variants</b><span>Add vehicles first.</span></div></div>'}</div></div><div class="modal-footer"><button type="button" class="btn" data-modal-close>Cancel</button><button class="btn btn-primary" type="submit">Save compatibility</button></div></form>`, 'modal-lg');
  }

  async function submitFitmentForm(form) {
    const productId = form.dataset.productId;
    const existing = new Set(safeJson(form.dataset.existing) || []);
    const selected = new Set(new FormData(form).getAll('variant').map(String));
    const toAdd = [...selected].filter(id => !existing.has(id));
    const toRemove = [...existing].filter(id => !selected.has(id));
    if (toAdd.length) await api(`/api/admin/products/${productId}/fitments`, { method: 'POST', body: JSON.stringify({ vehicleVariantIds: toAdd }) });
    await Promise.all(toRemove.map(id => api(`/api/admin/products/${productId}/fitments/${id}`, { method: 'DELETE' })));
    closeModal(); toast('Fitment updated', `${selected.size} compatible vehicle variants linked.`); await renderProducts();
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
      if (action === 'add-product') await openProductModal();
      else if (action === 'edit-product') await openProductModal(actionEl.dataset.id);
      else if (action === 'view-order') await openOrderModal(actionEl.dataset.id);
      else if (action === 'add-supplier') await openSupplierModal();
      else if (action === 'link-supplier-product') await openSupplierProductModal();
      else if (action === 'add-vehicle') await openVehicleModal();
      else if (action === 'add-model') await openVehicleModelModal();
      else if (action === 'manage-fitments') await openFitmentModal(actionEl.dataset.id);
      else if (action === 'archive-product') {
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
          const result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: $('#login-email').value, password: $('#login-password').value }) });
          if (!['ADMIN', 'STAFF'].includes(result.user.role)) throw new Error('This account is not an admin or staff account.');
          setSession(result.token, result.user); enterApp(); toast('Welcome to SANDMAN', `Signed in as ${result.user.email}`);
        } catch (error) {
          errorNode.textContent = error.message; errorNode.hidden = false;
        } finally {
          button.disabled = false; button.firstElementChild.textContent = 'Enter dashboard';
        }
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
    else if (event.target.id === 'customer-search') debounce(() => renderCustomers({ q: event.target.value }));
    else if (event.target.id === 'fitment-filter') { const q = event.target.value.toLowerCase(); $$('.fitment-option', $('#fitment-picker')).forEach(row => { row.hidden = !row.textContent.toLowerCase().includes(q); }); }
  });

  document.addEventListener('change', event => {
    if (event.target.id === 'product-status') renderProducts({ q: $('#product-search')?.value || '', status: event.target.value });
    else if (event.target.id === 'order-status') renderOrders({ q: $('#order-search')?.value || '', status: event.target.value });
  });

  $('#refresh-button').addEventListener('click', () => navigate(state.view));
  $('#quick-add-button').addEventListener('click', () => openProductModal().catch(error => toast('Could not open product form', error.message, 'error')));
  $('#logout-button').addEventListener('click', () => logout());
  $('#mobile-menu-button').addEventListener('click', () => $('.sidebar')?.classList.toggle('open'));
  $('#global-search').addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      const q = event.target.value.trim();
      if (q) { navigate('products').then(() => { const input = $('#product-search'); if (input) { input.value = q; input.dispatchEvent(new Event('input', { bubbles: true })); } }); }
    }
  });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#global-search')?.focus(); }
    if (event.key === 'Escape' && modalRoot.innerHTML) closeModal();
  });

  $$('.clickable-order').forEach(() => {});
  viewRoot.addEventListener('click', event => {
    const row = event.target.closest('.clickable-order');
    if (row?.dataset.orderId) openOrderModal(row.dataset.orderId).catch(error => toast('Could not load order', error.message, 'error'));
  });

  (async function boot() {
    await checkApi();
    const valid = await validateSession();
    if (valid) enterApp();
  })();
})();
