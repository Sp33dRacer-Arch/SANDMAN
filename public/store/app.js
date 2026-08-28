(() => {
  'use strict';

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const app = $('#app');
  const state = {
    token: '',
    user: null,
    cart: null,
    categories: [],
    paymentConfig: null,
    toastTimer: null,
  };

  const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format((Number(cents) || 0) / 100);
  const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c]));
  const titleCase = value => String(value || '').toLowerCase().replace(/(^|[_\s-])\w/g, s => s.toUpperCase()).replaceAll('_', ' ');
  const sellerName = seller => seller ? `${seller.firstName || ''} ${seller.lastName || ''}`.trim() || 'Independent seller' : 'Independent seller';
  const imageOf = product => product?.images?.[0]?.url || '';
  const queryFromHash = () => {
    const raw = location.hash.replace(/^#\/?/, '');
    const [path = '', query = ''] = raw.split('?');
    return { path: path || '', params: new URLSearchParams(query) };
  };

  async function refreshSession() {
    try {
      const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) return false;
      const data = await res.json();
      setToken(data.token, data.user);
      return true;
    } catch { return false; }
  }

  async function api(path, options = {}, retry = true) {
    const headers = { ...(options.headers || {}) };
    if (!(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    const res = await fetch(`/api${path}`, { ...options, headers, credentials: 'same-origin' });
    let data = null;
    const text = await res.text();
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }
    if (res.status === 401 && retry && !path.startsWith('/auth/login') && !path.startsWith('/auth/register') && !path.startsWith('/auth/refresh')) {
      if (await refreshSession()) return api(path, options, false);
    }
    if (!res.ok) {
      const message = data?.error?.message || data?.error || data?.message || `Request failed (${res.status})`;
      const err = new Error(message);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function loadExternalScript(src, globalName) {
    if (globalName && window[globalName]) return Promise.resolve(window[globalName]);
    return new Promise((resolve, reject) => {
      const existing = [...document.scripts].find(script => script.src === src);
      if (existing) { existing.addEventListener('load', () => resolve(globalName ? window[globalName] : true), { once: true }); return; }
      const script = document.createElement('script');
      script.src = src; script.async = true;
      script.onload = () => resolve(globalName ? window[globalName] : true);
      script.onerror = () => reject(new Error('Could not load secure payment provider'));
      document.head.appendChild(script);
    });
  }

  function toast(message, type = '') {
    const el = $('#toast');
    clearTimeout(state.toastTimer);
    el.textContent = message;
    el.className = `toast show ${type}`;
    state.toastTimer = setTimeout(() => { el.className = 'toast'; }, 3200);
  }

  function setToken(token, user) {
    state.token = token || '';
    state.user = user || null;
    // Access tokens remain memory-only. Persistent login comes from the
    // Secure/HttpOnly refresh cookie, which JavaScript cannot steal.
    updateAccountButton();
  }

  function updateAccountButton() {
    const btn = $('#accountButton');
    if (!btn) return;
    btn.textContent = state.user?.firstName ? state.user.firstName : 'Account';
  }

  async function hydrateUser() {
    if (!state.token) await refreshSession();
    if (!state.token) return;
    try {
      state.user = await api('/auth/me');
      updateAccountButton();
      await loadCart(false);
    } catch {
      setToken('', null);
    }
  }

  async function loadCategories() {
    try { state.categories = await api('/products/categories'); }
    catch { state.categories = []; }
  }

  function openBackdrop() { $('#backdrop').classList.add('open'); }
  function closeBackdropIfUnused() {
    if (!$('#cartDrawer').classList.contains('open') && !$('#authModal').classList.contains('open')) $('#backdrop').classList.remove('open');
  }

  function openAuth(tab = 'login') {
    closeCart();
    const modal = $('#authModal');
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    openBackdrop();
    switchAuthTab(tab);
    setTimeout(() => $(`#${tab}Form input`)?.focus(), 120);
  }
  function closeAuth() {
    const modal = $('#authModal');
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    closeBackdropIfUnused();
  }
  function switchAuthTab(tab) {
    $$('.auth-tabs button').forEach(b => b.classList.toggle('active', b.dataset.authTab === tab));
    $('#loginForm').classList.toggle('hidden', tab !== 'login');
    $('#registerForm').classList.toggle('hidden', tab !== 'register');
  }

  async function loadCart(render = true) {
    if (!state.token) { state.cart = null; updateCartCount(); if (render) renderCart(); return; }
    try { state.cart = await api('/cart'); }
    catch (e) { if (e.status === 401) setToken('', null); state.cart = null; }
    updateCartCount();
    if (render) renderCart();
  }
  function updateCartCount() {
    const count = state.cart?.items?.reduce((n, item) => n + item.quantity, 0) || 0;
    $('#cartCount').textContent = count;
  }
  async function openCart() {
    if (!state.token) return openAuth('login');
    await loadCart(true);
    $('#cartDrawer').classList.add('open');
    $('#cartDrawer').setAttribute('aria-hidden', 'false');
    openBackdrop();
  }
  function closeCart() {
    $('#cartDrawer').classList.remove('open');
    $('#cartDrawer').setAttribute('aria-hidden', 'true');
    closeBackdropIfUnused();
  }
  function renderCart() {
    const wrap = $('#cartItems');
    const foot = $('#cartFooter');
    if (!state.cart?.items?.length) {
      wrap.innerHTML = `<div class="cart-empty"><div><span class="eyebrow">EMPTY BAG</span><p>Find the part your build is waiting for.</p><a class="secondary-btn" href="#/shop" data-close-cart>Shop parts</a></div></div>`;
      foot.innerHTML = '';
      $('[data-close-cart]', wrap)?.addEventListener('click', closeCart);
      return;
    }
    wrap.innerHTML = state.cart.items.map(item => {
      const p = item.product;
      const img = imageOf(p);
      return `<article class="cart-item" data-cart-id="${esc(item.id)}">
        ${img ? `<img src="${esc(img)}" alt="${esc(p.name)}">` : `<div class="skeleton"></div>`}
        <div><h4>${esc(p.name)}</h4><small>${p.sourceType === 'MARKETPLACE' ? 'Seller listing' : 'Supplier stock'} · ${money(p.priceCents)}</small>
          <div class="mini-qty"><button data-qty="-1" aria-label="Decrease">−</button><span>${item.quantity}</span><button data-qty="1" aria-label="Increase">+</button></div>
        </div>
        <button class="cart-remove" data-remove>Remove</button>
      </article>`;
    }).join('');
    const sellerShipping = state.cart.marketplaceShippingCents || 0;
    foot.innerHTML = `<div class="cart-total"><span>Subtotal</span><span>${money(state.cart.subtotalCents)}</span></div>
      ${sellerShipping ? `<p class="cart-note">Seller shipping currently estimated at ${money(sellerShipping)}. Final shipping is shown at checkout.</p>` : `<p class="cart-note">Shipping and taxes are calculated at checkout.</p>`}
      <button class="primary-btn wide" id="checkoutButton">Checkout</button>`;
    $$('.cart-item', wrap).forEach(row => {
      const id = row.dataset.cartId;
      row.querySelectorAll('[data-qty]').forEach(btn => btn.addEventListener('click', async () => {
        const current = state.cart.items.find(i => i.id === id);
        const next = Math.max(1, current.quantity + Number(btn.dataset.qty));
        if (next === current.quantity) return;
        try { await api(`/cart/items/${id}`, { method: 'PATCH', body: JSON.stringify({ quantity: next }) }); await loadCart(true); }
        catch (e) { toast(e.message, 'error'); }
      }));
      row.querySelector('[data-remove]').addEventListener('click', async () => {
        try { await api(`/cart/items/${id}`, { method: 'DELETE' }); await loadCart(true); }
        catch (e) { toast(e.message, 'error'); }
      });
    });
    $('#checkoutButton').addEventListener('click', () => { closeCart(); location.hash = '#/checkout'; });
  }

  async function addToCart(productId, quantity = 1) {
    if (!state.token) { openAuth('login'); toast('Log in to add parts to your bag'); return; }
    try {
      await api('/cart/items', { method: 'POST', body: JSON.stringify({ productId, quantity }) });
      await loadCart(false);
      toast('Added to bag');
      openCart();
    } catch (e) { toast(e.message, 'error'); }
  }

  function productCard(p) {
    const img = imageOf(p);
    const source = p.sourceType === 'MARKETPLACE' ? 'Marketplace' : 'Supplier Stock';
    const condition = titleCase(p.condition || 'NEW');
    const seller = p.sourceType === 'MARKETPLACE' ? sellerName(p.seller) : (p.brand || 'Connected supplier');
    return `<a class="product-card" href="#/product/${encodeURIComponent(p.slug)}">
      <div class="product-media ${img ? '' : 'empty-media'}">
        ${img ? `<img src="${esc(img)}" alt="${esc(p.name)}" loading="lazy">` : `<div class="part-glyph">◉</div>`}
        <div class="product-badges"><span class="badge ${p.sourceType === 'MARKETPLACE' ? 'market' : ''}">${source}</span><span class="badge">${condition}</span></div>
      </div>
      <div class="product-info">
        <div class="product-meta"><span>${esc(p.brand || 'SANDMAN')}</span><span>${esc(p.category?.name || '')}</span></div>
        <h3>${esc(p.name)}</h3>
        <div class="price-row"><span class="price">${money(p.priceCents)}</span>${p.compareAtCents ? `<span class="compare">${money(p.compareAtCents)}</span>` : ''}</div>
        <div class="seller-line">${p.sourceType === 'MARKETPLACE' ? `Sold by ${esc(seller)}` : 'Fulfilled by connected supplier'}</div>
      </div>
    </a>`;
  }

  const cardSkeletons = n => `<div class="product-grid">${Array.from({ length:n }, () => `<div class="product-card"><div class="product-media skeleton"></div><div class="product-info"><div style="height:12px;width:42%;margin-bottom:16px" class="skeleton"></div><div style="height:30px;margin-bottom:15px" class="skeleton"></div><div style="height:18px;width:30%" class="skeleton"></div></div></div>`).join('')}</div>`;

  async function renderHome() {
    app.innerHTML = `<section class="hero">
      <div class="hero-content">
        <div class="hero-logo-wrap"><img class="hero-logo" src="/assets/sandman-logo.png" alt="SANDMAN — Dream While Awake"></div>
        <div class="hero-copy">
          <span class="kicker">ENGINE PARTS MARKETPLACE / 01</span>
          <h1 class="display">Buy. Sell.<br><em>Build.</em></h1>
          <p>SANDMAN brings supplier-stocked engine parts and independent seller listings into one marketplace. Search by engine, part name, brand or part number — then build what you imagined.</p>
          <div class="hero-actions"><a class="primary-btn" href="#/shop">Shop the market</a><a class="secondary-btn" href="#/sell">Sell a part</a></div>
        </div>
      </div>
      <div class="hero-scroll">Explore the market</div><div class="hero-index"><span>Supplier stock</span><span>Independent sellers</span><span>Worldwide sourcing</span></div>
    </section>
    <section class="market-search-band"><div class="market-search"><h3>Find your next part</h3><form id="homeSearch"><input name="q" placeholder="Search B58, 2JZ, turbo, fuel rail, SKU..." autocomplete="off"><button aria-label="Search">↗</button></form><span class="market-stat">Search the whole market.</span></div></section>
    <section class="section"><div class="section-inner"><div class="section-head"><div><span class="eyebrow">BROWSE / CATEGORIES</span><h2>Start with the part.</h2></div><p>No forced vehicle wizard. Search directly, browse categories, compare supplier stock with seller listings, and inspect fitment details when you need them.</p></div><div class="category-grid" id="homeCategories"></div></div></section>
    <section class="section"><div class="section-inner"><div class="section-head"><div><span class="eyebrow">SUPPLIER STOCK / NEW</span><h2>Ready to source.</h2></div><a class="text-link" href="#/shop?source=DROPSHIP">View supplier stock</a></div><div id="supplierProducts">${cardSkeletons(8)}</div></div></section>
    <section class="source-split">
      <a class="source-panel" href="#/shop?source=DROPSHIP"><span class="source-giant">01</span><div class="source-copy"><span class="eyebrow">CONNECTED SUPPLIERS</span><h3>Dropship stock,<br>without the clutter.</h3><p>Products sourced from connected engine-part suppliers. SANDMAN routes paid orders into supplier fulfillment and brings tracking back into one account.</p><span class="secondary-btn">Shop supplier stock</span></div></a>
      <a class="source-panel marketplace" href="#/shop?source=MARKETPLACE"><span class="source-giant">02</span><div class="source-copy"><span class="eyebrow">INDEPENDENT MARKET</span><h3>Rare, used,<br>rebuilt, yours.</h3><p>Independent sellers can list new, used, open-box and remanufactured engine parts alongside the supplier catalog.</p><span class="secondary-btn">Browse seller listings</span></div></a>
    </section>
    <section class="section"><div class="section-inner"><div class="section-head"><div><span class="eyebrow">MARKETPLACE / LATEST</span><h2>From other garages.</h2></div><a class="text-link" href="#/shop?source=MARKETPLACE">View marketplace</a></div><div id="marketProducts">${cardSkeletons(4)}</div></div></section>
    <section class="sell-banner"><div class="sell-banner-inner"><h2>Parts sitting?<br><em>Move them.</em></h2><div><p>Create a SANDMAN account, list your engine part, set the condition, price, location and shipping, then manage your listings from the seller dashboard.</p><a class="primary-btn" href="#/sell">List a part</a></div></div></section>`;

    $('#homeSearch').addEventListener('submit', e => {
      e.preventDefault(); const q = new FormData(e.currentTarget).get('q')?.toString().trim(); location.hash = `#/shop${q ? `?q=${encodeURIComponent(q)}` : ''}`;
    });

    const cats = state.categories.slice(0, 8);
    $('#homeCategories').innerHTML = cats.map((c, i) => `<a class="category-card" href="#/shop?category=${encodeURIComponent(c.slug)}"><span class="num">0${i + 1}</span><h3>${esc(c.name)}</h3><div class="cat-foot"><span>${c._count?.products || 0} listings</span><span>↗</span></div></a>`).join('') || `<div class="empty-state"><p>Categories load from the SANDMAN database.</p></div>`;

    try {
      const [supplier, market] = await Promise.all([
        api('/products?source=DROPSHIP&limit=8&sort=newest'),
        api('/products?source=MARKETPLACE&limit=4&sort=newest'),
      ]);
      $('#supplierProducts').innerHTML = supplier.items?.length ? `<div class="product-grid">${supplier.items.map(productCard).join('')}</div>` : emptyProducts('No supplier products yet.');
      $('#marketProducts').innerHTML = market.items?.length ? `<div class="product-grid">${market.items.map(productCard).join('')}</div>` : emptyProducts('Seller listings will appear here.');
    } catch (e) {
      $('#supplierProducts').innerHTML = emptyProducts(e.message);
      $('#marketProducts').innerHTML = emptyProducts('Marketplace is waiting for its first listings.');
    }
  }

  function emptyProducts(message) { return `<div class="empty-state"><h3>Nothing here yet.</h3><p>${esc(message)}</p></div>`; }

  async function renderShop(params) {
    const source = params.get('source') || '';
    const q = params.get('q') || '';
    const category = params.get('category') || '';
    const condition = params.get('condition') || '';
    const sort = params.get('sort') || 'newest';
    const page = params.get('page') || '1';
    const minPrice = params.get('minPrice') || '';
    const maxPrice = params.get('maxPrice') || '';
    const title = source === 'MARKETPLACE' ? 'Marketplace.' : source === 'DROPSHIP' ? 'Supplier stock.' : q ? `Search: ${q}` : 'The market.';
    const intro = source === 'MARKETPLACE' ? 'New, used, open-box and remanufactured parts listed by independent sellers.' : source === 'DROPSHIP' ? 'Engine parts sourced through SANDMAN-connected suppliers and fulfillment.' : 'Supplier stock and independent seller listings in one catalog.';
    app.innerHTML = `<div class="page-shell"><section class="page-hero"><div class="page-hero-inner"><span class="eyebrow">SANDMAN / MARKET</span><h1>${esc(title)}</h1><p>${esc(intro)}</p></div></section>
      <div class="shop-layout"><aside class="filters">
        <div class="filter-block"><div class="filter-title"><span>Source</span></div><div class="filter-list">
          <button data-filter="source" data-value="" class="${!source ? 'active' : ''}">All market</button><button data-filter="source" data-value="DROPSHIP" class="${source === 'DROPSHIP' ? 'active' : ''}">Supplier stock</button><button data-filter="source" data-value="MARKETPLACE" class="${source === 'MARKETPLACE' ? 'active' : ''}">Seller listings</button>
        </div></div>
        <div class="filter-block"><div class="filter-title"><span>Categories</span></div><div class="filter-list">${state.categories.map(c => `<button data-filter="category" data-value="${esc(c.slug)}" class="${category === c.slug ? 'active' : ''}">${esc(c.name)}</button>`).join('')}</div></div>
        <div class="filter-block"><div class="filter-title"><span>Condition</span></div><div class="filter-list"><button data-filter="condition" data-value="" class="${!condition ? 'active' : ''}">Any condition</button>${['NEW','USED','REMANUFACTURED','OPEN_BOX'].map(v => `<button data-filter="condition" data-value="${v}" class="${condition === v ? 'active' : ''}">${titleCase(v)}</button>`).join('')}</div></div>
        <div class="filter-block price-filter"><div class="filter-title"><span>Price USD</span></div><div class="price-inputs"><input id="minPrice" type="number" min="0" placeholder="Min" value="${esc(minPrice)}"><input id="maxPrice" type="number" min="0" placeholder="Max" value="${esc(maxPrice)}"></div><button class="ghost-btn wide" id="applyPrice" style="margin-top:8px;min-height:38px">Apply</button></div>
      </aside><section class="shop-main"><div class="shop-toolbar"><span class="result-count" id="resultCount">Loading market…</span><select id="sortSelect"><option value="newest" ${sort==='newest'?'selected':''}>Newest</option><option value="price_asc" ${sort==='price_asc'?'selected':''}>Price low → high</option><option value="price_desc" ${sort==='price_desc'?'selected':''}>Price high → low</option><option value="name" ${sort==='name'?'selected':''}>Name</option></select></div><div id="shopProducts">${cardSkeletons(9)}</div><div id="pagination" class="pagination"></div></section></div></div>`;

    const setParam = (key, value) => {
      const next = new URLSearchParams(params.toString());
      if (value) next.set(key, value); else next.delete(key);
      next.delete('page');
      location.hash = `#/shop${next.toString() ? `?${next}` : ''}`;
    };
    $$('[data-filter]').forEach(b => b.addEventListener('click', () => setParam(b.dataset.filter, b.dataset.value)));
    $('#sortSelect').addEventListener('change', e => setParam('sort', e.target.value));
    $('#applyPrice').addEventListener('click', () => {
      const next = new URLSearchParams(params.toString()); const min = $('#minPrice').value; const max = $('#maxPrice').value;
      min ? next.set('minPrice', min) : next.delete('minPrice'); max ? next.set('maxPrice', max) : next.delete('maxPrice'); next.delete('page'); location.hash = `#/shop?${next}`;
    });

    const query = new URLSearchParams({ limit:'24', page, sort });
    if (source) query.set('source', source); if (q) query.set('q', q); if (category) query.set('category', category); if (condition) query.set('condition', condition); if (minPrice) query.set('minPrice', minPrice); if (maxPrice) query.set('maxPrice', maxPrice);
    try {
      const data = await api(`/products?${query}`);
      $('#resultCount').textContent = `${data.total} ${data.total === 1 ? 'part' : 'parts'}`;
      $('#shopProducts').innerHTML = data.items?.length ? `<div class="product-grid">${data.items.map(productCard).join('')}</div>` : emptyProducts('Try another search or filter.');
      const pager = $('#pagination');
      pager.innerHTML = data.pages > 1 ? Array.from({ length: Math.min(data.pages, 8) }, (_, i) => i + 1).map(n => `<button data-page="${n}" class="${Number(page) === n ? 'active' : ''}">${n}</button>`).join('') : '';
      $$('[data-page]', pager).forEach(b => b.addEventListener('click', () => { const next = new URLSearchParams(params.toString()); next.set('page', b.dataset.page); location.hash = `#/shop?${next}`; }));
    } catch (e) { $('#resultCount').textContent = 'Market unavailable'; $('#shopProducts').innerHTML = emptyProducts(e.message); }
  }

  async function renderProduct(slug) {
    app.innerHTML = `<div class="product-page"><div class="product-detail"><div class="product-gallery"><div class="main-product-image skeleton"></div></div><div class="product-panel"><span class="eyebrow">LOADING PART</span><h1>Pulling listing…</h1></div></div></div>`;
    try {
      const p = await api(`/products/${encodeURIComponent(slug)}`);
      const img = imageOf(p);
      const marketplace = p.sourceType === 'MARKETPLACE';
      const stock = marketplace ? p.stockQuantity : p.supplierLinks?.reduce((n, l) => n + (l.stock || 0), 0);
      const fitmentText = p.fitments?.length ? `${p.fitments.length} stored fitment ${p.fitments.length === 1 ? 'record' : 'records'}` : (p.isUniversal ? 'Universal / seller-defined fitment' : 'Verify fitment before ordering');
      app.innerHTML = `<div class="product-page"><div class="product-detail">
        <div class="product-gallery">${img ? `<img class="main-product-image" src="${esc(img)}" alt="${esc(p.name)}">` : `<div class="gallery-placeholder"><span>◉</span></div>`}</div>
        <div class="product-panel">
          <div class="product-source"><span class="badge ${marketplace ? 'market' : ''}">${marketplace ? 'Marketplace Seller' : 'Supplier Stock'}</span><span class="badge">${titleCase(p.condition)}</span></div>
          <div class="brand-line">${esc(p.brand || 'SANDMAN')} ${p.manufacturerPn ? ` / ${esc(p.manufacturerPn)}` : ''}</div>
          <h1>${esc(p.name)}</h1><div class="big-price">${money(p.priceCents)} ${p.compareAtCents ? `<del>${money(p.compareAtCents)}</del>` : ''}</div>
          <p class="short-desc">${esc(p.shortDesc || p.description)}</p>
          ${marketplace ? `<div class="seller-card"><div class="seller-card-top"><div class="seller-avatar">${esc((sellerName(p.seller)[0] || 'S').toUpperCase())}</div><div><strong>${esc(sellerName(p.seller))}</strong><p>${esc(p.sellerLocation || 'Location not provided')} · Independent seller</p></div></div></div>` : ''}
          <div class="buy-row"><div class="qty-select"><button id="qtyMinus">−</button><span id="qtyValue">1</span><button id="qtyPlus">+</button></div><button class="primary-btn" id="addProduct">Add to bag</button></div>
          <div class="product-trust"><div><strong>Source</strong><span>${marketplace ? 'Independent seller' : 'Connected supplier'}</span></div><div><strong>Availability</strong><span>${stock == null ? 'Check at order' : `${stock} available`}</span></div><div><strong>Fitment</strong><span>${esc(fitmentText)}</span></div></div>
          <div class="product-accordion">
            <div class="acc-item open"><button class="acc-btn">Description <span>−</span></button><div class="acc-content">${esc(p.description)}</div></div>
            <div class="acc-item"><button class="acc-btn">Listing details <span>+</span></button><div class="acc-content">SKU: ${esc(p.sku)}<br>Category: ${esc(p.category?.name || '—')}<br>Condition: ${esc(titleCase(p.condition))}${marketplace ? `<br>Seller shipping: ${money(p.sellerShippingCents || 0)}` : '<br>Fulfillment: routed to connected supplier after payment.'}</div></div>
            <div class="acc-item"><button class="acc-btn">Fitment notice <span>+</span></button><div class="acc-content">SANDMAN no longer forces a vehicle selector before shopping. Always verify engine code, dimensions, manufacturer part number and application details before purchasing critical engine components.</div></div>
          </div>
        </div></div></div>`;
      let qty = 1;
      const updateQty = () => $('#qtyValue').textContent = qty;
      $('#qtyMinus').addEventListener('click', () => { qty = Math.max(1, qty - 1); updateQty(); });
      $('#qtyPlus').addEventListener('click', () => { qty = Math.min(20, marketplace && p.stockQuantity ? p.stockQuantity : 20, qty + 1); updateQty(); });
      $('#addProduct').addEventListener('click', () => addToCart(p.id, qty));
      $$('.acc-btn').forEach(btn => btn.addEventListener('click', () => {
        const item = btn.closest('.acc-item'); const open = item.classList.toggle('open'); btn.querySelector('span').textContent = open ? '−' : '+';
      }));
    } catch (e) {
      app.innerHTML = `<div class="page-shell"><section class="page-hero"><div class="page-hero-inner"><span class="eyebrow">404 / PART</span><h1>Part not found.</h1><p>${esc(e.message)}</p><a class="secondary-btn" href="#/shop">Back to market</a></div></section></div>`;
    }
  }

  async function renderSell() {
    if (!state.token) {
      app.innerHTML = `<div class="form-page"><div class="form-layout"><div class="form-intro"><span class="eyebrow">SELL ON SANDMAN</span><h1>Move the parts you don't need.</h1><p>Seller listings sit beside supplier inventory in the same marketplace. Create an account to list a part.</p><button class="primary-btn" id="sellLogin">Log in to sell</button></div><div class="market-form"><div class="empty-state"><h3>Seller account required.</h3><p>Your SANDMAN account owns and manages every listing you create.</p></div></div></div></div>`;
      $('#sellLogin').addEventListener('click', () => openAuth('login'));
      return;
    }

    const sellerConfig = await api('/marketplace/seller-config');
    if (!sellerConfig.stripeConnectConfigured || !sellerConfig.payoutsEnabled) {
      app.innerHTML = `<div class="form-page"><div class="form-layout"><aside class="form-intro"><span class="eyebrow">SELL / PAYOUT SETUP</span><h1>Connect payouts first.</h1><p>SANDMAN uses Stripe Connect so buyers can pay once, SANDMAN keeps ${esc(sellerConfig.commissionPercent)}%, and your net sale proceeds are routed to your verified payout account.</p></aside><div class="market-form"><div class="empty-state"><h3>${sellerConfig.stripeConnectConfigured ? 'Finish seller payout onboarding.' : 'Seller payouts are not configured yet.'}</h3><p>${sellerConfig.stripeConnectConfigured ? 'Open your seller dashboard and connect/verify your payout account before publishing.' : 'The SANDMAN owner needs to configure Stripe + Connect before marketplace sellers can list.'}</p><a class="primary-btn" href="#/seller">Seller payout settings</a></div></div></div></div>`;
      return;
    }

    app.innerHTML = `<div class="form-page"><div class="form-layout"><aside class="form-intro"><span class="eyebrow">SELL / MARKETPLACE</span><h1>List an engine part.</h1><p>Keep the listing accurate. Buyers should understand exactly what the part is, its condition and what arrives in the box.</p><div class="commission-box"><span>SANDMAN FEE</span><strong>${esc(sellerConfig.commissionPercent)}%</strong><p>Commission is calculated on the merchandise sale price. Your listing's shipping charge is passed through to your seller payout.</p></div><div class="sell-steps"><div class="sell-step"><span>01</span><strong>Describe the exact part</strong></div><div class="sell-step"><span>02</span><strong>Set price + condition</strong></div><div class="sell-step"><span>03</span><strong>Add image + location</strong></div><div class="sell-step"><span>04</span><strong>Accept fee + publish</strong></div></div></aside>
      <form class="market-form" id="sellForm">
        <div class="form-section"><h3>Part information</h3><label>Listing title<input name="name" required minlength="3" placeholder="e.g. Garrett GTX3582R turbo"></label><div class="field-row"><label>Brand<input name="brand" placeholder="Garrett"></label><label>Manufacturer part no.<input name="manufacturerPn" placeholder="Optional"></label></div><label>Description<textarea name="description" minlength="20" required placeholder="Condition, mileage, measurements, included hardware, known issues..."></textarea></label><label>Category<select name="categoryId" required><option value="">Choose category</option>${state.categories.map(c=>`<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></label></div>
        <div class="form-section"><h3>Price + stock</h3><div class="field-row three"><label>Price (USD)<input name="price" type="number" step="0.01" min="1" required></label><label>Condition<select name="condition"><option>USED</option><option>NEW</option><option>REMANUFACTURED</option><option value="OPEN_BOX">OPEN BOX</option></select></label><label>Quantity<input name="stockQuantity" type="number" min="1" max="1000" value="1" required></label></div><div class="field-row"><label>Shipping (USD)<input name="shipping" type="number" step="0.01" min="0" value="0"></label><label>Location<input name="sellerLocation" placeholder="Johannesburg, ZA"></label></div></div>
        <div class="form-section"><h3>Images</h3><label>Primary image URL<input name="imageUrl" type="url" placeholder="https://..."></label><div class="upload-note">Hosted image URLs are supported in this release.</div></div>
        <div class="form-section"><h3>Seller agreement</h3><label class="commission-consent"><input name="commissionAccepted" type="checkbox" required><span>I agree that SANDMAN keeps ${esc(sellerConfig.commissionPercent)}% of the merchandise sale price as the marketplace fee. Seller payouts are handled through Stripe Connect.</span></label><label>Extra note<textarea name="sellerNotes" placeholder="Collection details, packaging note, preferred courier, etc." style="min-height:90px"></textarea></label></div>
        <button class="primary-btn wide" type="submit">Publish listing</button>
      </form></div></div>`;
    $('#sellForm').addEventListener('submit', async e => {
      e.preventDefault(); const f = new FormData(e.currentTarget); const imageUrl = f.get('imageUrl')?.toString().trim();
      const conditionRaw = f.get('condition')?.toString() || 'USED';
      const condition = conditionRaw === 'OPEN BOX' ? 'OPEN_BOX' : conditionRaw;
      const body = {
        name: f.get('name')?.toString(), brand: f.get('brand')?.toString() || undefined, manufacturerPn: f.get('manufacturerPn')?.toString() || undefined,
        categoryId: f.get('categoryId')?.toString(), description: f.get('description')?.toString(), shortDesc: f.get('description')?.toString().slice(0, 320),
        priceCents: Math.round(Number(f.get('price')) * 100), condition, stockQuantity: Number(f.get('stockQuantity') || 1), sellerShippingCents: Math.round(Number(f.get('shipping') || 0) * 100),
        sellerLocation: f.get('sellerLocation')?.toString() || undefined, sellerNotes: f.get('sellerNotes')?.toString() || undefined,
        commissionAccepted: f.get('commissionAccepted') === 'on',
        images: imageUrl ? [{ url:imageUrl, alt:f.get('name')?.toString(), position:0 }] : [],
      };
      const submit = e.currentTarget.querySelector('button[type=submit]'); submit.disabled = true; submit.textContent = 'Publishing…';
      try { const listing = await api('/marketplace', { method:'POST', body:JSON.stringify(body) }); toast('Listing published'); location.hash = `#/product/${encodeURIComponent(listing.slug)}`; }
      catch (err) { toast(err.message, 'error'); submit.disabled = false; submit.textContent = 'Publish listing'; }
    });
  }

  async function renderSeller() {
    if (!state.token) return renderAccountRequired('Seller dashboard', 'Log in to manage your marketplace listings, sales and payouts.');
    app.innerHTML = `<div class="dashboard-page"><div class="dashboard-head"><div><span class="eyebrow">SELLER / DASHBOARD</span><h1>Your market.</h1></div><a class="primary-btn" href="#/sell">New listing</a></div><div class="dashboard-grid"><nav class="dashboard-nav"><button class="active" data-tab="listings">Listings</button><button data-tab="sales">Sales</button><button data-tab="payouts">Payouts</button><button data-tab="account">Account</button></nav><div class="dashboard-content" id="sellerContent"><div class="empty-state"><p>Loading seller data…</p></div></div></div></div>`;
    const show = async tab => {
      $$('.dashboard-nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
      const content = $('#sellerContent'); content.innerHTML = `<div class="empty-state"><p>Loading…</p></div>`;
      if (tab === 'account') { content.innerHTML = accountPanel(); $('#logoutButton')?.addEventListener('click', logout); bindAccountSecurity(content); return; }
      try {
        if (tab === 'listings') {
          const items = await api('/marketplace/mine');
          const active = items.filter(i => i.status === 'ACTIVE').length;
          content.innerHTML = `<div class="stat-cards"><div class="stat-card"><span>Listings</span><strong>${items.length}</strong></div><div class="stat-card"><span>Active</span><strong>${active}</strong></div><div class="stat-card"><span>Inventory units</span><strong>${items.reduce((n,i)=>n+(i.stockQuantity||0),0)}</strong></div></div>${items.length ? `<div class="data-list">${items.map(i => `<div class="data-row"><div>${imageOf(i)?`<img src="${esc(imageOf(i))}" alt="">`:'<div class="skeleton" style="width:58px;height:58px"></div>'}</div><div><strong>${esc(i.name)}</strong><small>${money(i.priceCents)} · ${titleCase(i.condition)}</small></div><span>${i.stockQuantity ?? 0} in stock</span><span class="status">${esc(i.status)}</span><button class="row-action" data-archive="${esc(i.id)}">Archive</button></div>`).join('')}</div>` : emptyProducts('Create your first marketplace listing.')}`;
          $$('[data-archive]').forEach(btn => btn.addEventListener('click', async () => { if (!confirm('Archive this listing?')) return; try { await api(`/marketplace/${btn.dataset.archive}`, { method:'DELETE' }); toast('Listing archived'); show('listings'); } catch(e){toast(e.message,'error');} }));
        } else if (tab === 'sales') {
          const sales = await api('/marketplace/sales');
          const gross = sales.reduce((n,i)=>n+i.totalPriceCents+(i.sellerShippingCents||0),0);
          const fees = sales.reduce((n,i)=>n+(i.platformFeeCents||0),0);
          content.innerHTML = `<div class="stat-cards"><div class="stat-card"><span>Paid sale items</span><strong>${sales.length}</strong></div><div class="stat-card"><span>Gross sales</span><strong>${money(gross)}</strong></div><div class="stat-card"><span>SANDMAN fees</span><strong>${money(fees)}</strong></div></div>${sales.length ? `<div class="data-list">${sales.map(i => `<div class="data-row"><div>${imageOf(i.product)?`<img src="${esc(imageOf(i.product))}" alt="">`:'<div class="skeleton" style="width:58px;height:58px"></div>'}</div><div><strong>${esc(i.name)}</strong><small>${esc(i.order.orderNumber)} · Qty ${i.quantity} · payout ${money(i.sellerPayoutCents||0)}</small></div><span>${money(i.totalPriceCents)}</span><span class="status">${i.sellerTrackingNumber ? 'Shipped' : 'Paid'}</span>${i.sellerTrackingNumber ? `<span class="row-action" style="cursor:default">${esc(i.sellerCarrier || '')}</span>` : `<button class="row-action" data-ship="${esc(i.id)}">Add tracking</button>`}</div>`).join('')}</div>` : emptyProducts('Paid marketplace sales appear here.')}`;
          $$('[data-ship]').forEach(btn => btn.addEventListener('click', async () => { const trackingNumber = prompt('Tracking number'); if (!trackingNumber) return; const carrier = prompt('Carrier', 'DHL') || 'Courier'; try { await api(`/marketplace/sales/${btn.dataset.ship}/ship`, {method:'POST',body:JSON.stringify({trackingNumber,carrier})}); toast('Tracking added'); show('sales'); } catch(e){toast(e.message,'error');} }));
        } else if (tab === 'payouts') {
          const [config, payout] = await Promise.all([api('/marketplace/seller-config'), api('/marketplace/payout/status')]);
          content.innerHTML = `<div class="payout-panel"><span class="eyebrow">STRIPE CONNECT / SELLER PAYOUTS</span><h2>${payout.payoutsEnabled ? 'Payouts ready.' : payout.connected ? 'Finish verification.' : 'Connect your payout account.'}</h2><p>SANDMAN keeps <strong>${esc(config.commissionPercent)}%</strong> of marketplace merchandise sales. The remainder plus your listing shipping amount is transferred to your verified Stripe Connect account after a successful Stripe payment.</p><div class="payout-status"><span>Connected</span><strong>${payout.connected?'Yes':'No'}</strong><span>Payouts enabled</span><strong>${payout.payoutsEnabled?'Yes':'No'}</strong></div>${payout.requirementsDue?.length ? `<p class="form-note">Stripe still requires: ${esc(payout.requirementsDue.join(', '))}</p>`:''}${!payout.payoutsEnabled ? `<div class="field-row"><label>Seller country code<input id="sellerCountry" maxlength="2" value="${esc(config.sellerCountry || 'ZA')}" style="text-transform:uppercase"></label><button class="primary-btn" id="connectPayout">Connect / continue Stripe</button></div>` : `<button class="secondary-btn" id="openPayoutDashboard">Open Stripe payout dashboard</button>`}<p class="form-note">SANDMAN never stores your bank account or debit-card number. Stripe securely collects and stores payout details.</p></div>`;
          $('#connectPayout')?.addEventListener('click', async () => { try { const result = await api('/marketplace/payout/onboard',{method:'POST',body:JSON.stringify({country:($('#sellerCountry').value||'ZA').toUpperCase()})}); location.href=result.url; } catch(e){toast(e.message,'error');} });
          $('#openPayoutDashboard')?.addEventListener('click', async () => { try { const result = await api('/marketplace/payout/dashboard',{method:'POST'}); location.href=result.url; } catch(e){toast(e.message,'error');} });
        }
      } catch(e){content.innerHTML = emptyProducts(e.message);}
    };
    $$('.dashboard-nav button').forEach(b => b.addEventListener('click', () => show(b.dataset.tab)));
    show(location.hash.includes('stripe=') ? 'payouts' : 'listings');
  }

  function accountPanel() {
    if (!state.user) return emptyProducts('Account unavailable.');
    return `<div class="stat-cards"><div class="stat-card"><span>Name</span><strong style="font-size:24px">${esc(`${state.user.firstName||''} ${state.user.lastName||''}`.trim() || 'SANDMAN Member')}</strong></div><div class="stat-card"><span>Email</span><strong style="font-size:17px">${esc(state.user.email)}</strong></div><div class="stat-card"><span>Role</span><strong style="font-size:24px">${esc(titleCase(state.user.role))}</strong></div></div><div class="account-security"><span class="eyebrow">SECURITY</span><h3>Change password</h3><form id="accountPasswordForm"><div class="field-row"><label>Current password<input name="currentPassword" type="password" autocomplete="current-password" required></label><label>New password<input name="newPassword" type="password" minlength="10" autocomplete="new-password" required></label></div><label>Confirm new password<input name="confirmPassword" type="password" minlength="10" autocomplete="new-password" required></label><button class="secondary-btn" type="submit">Update password</button></form><p class="form-note">Changing your password signs out your other persistent sessions.</p></div><button class="secondary-btn" id="logoutButton">Log out</button>`;
  }

  function bindAccountSecurity(root=document) {
    const form=$('#accountPasswordForm',root);
    if (!form) return;
    form.addEventListener('submit', async e => {
      e.preventDefault(); const fd=new FormData(form); const currentPassword=String(fd.get('currentPassword')||''); const newPassword=String(fd.get('newPassword')||''); const confirmPassword=String(fd.get('confirmPassword')||'');
      if (newPassword!==confirmPassword) return toast('New passwords do not match','error');
      try { const result=await api('/auth/change-password',{method:'POST',body:JSON.stringify({currentPassword,newPassword})}); setToken(result.token,result.user); form.reset(); toast('Password changed'); }
      catch(err){toast(err.message,'error');}
    });
  }

  async function renderAccount() {
    if (!state.token) return renderAccountRequired('Your account', 'Log in to view orders, cart activity and seller tools.');
    app.innerHTML = `<div class="dashboard-page"><div class="dashboard-head"><div><span class="eyebrow">ACCOUNT / SANDMAN</span><h1>${esc(state.user?.firstName || 'Your account')}.</h1></div><a class="secondary-btn" href="#/seller">Seller dashboard</a></div><div class="dashboard-grid"><nav class="dashboard-nav"><button class="active">Orders</button><a href="#/seller" style="display:block;padding:12px 0;color:var(--muted);font-size:10px;letter-spacing:.14em;text-transform:uppercase">Seller</a></nav><div class="dashboard-content" id="accountContent"><div class="empty-state"><p>Loading orders…</p></div></div></div></div>`;
    try {
      const orders = await api('/orders');
      $('#accountContent').innerHTML = `${accountPanel()}<div style="height:30px"></div><span class="eyebrow">ORDER HISTORY</span>${orders.length ? `<div class="data-list" style="margin-top:14px">${orders.map(o => `<div class="data-row" style="grid-template-columns:1fr 140px 110px auto"><div><strong>${esc(o.orderNumber)}</strong><small>${new Date(o.createdAt).toLocaleDateString()} · ${o.items.length} item(s)</small></div><span>${money(o.totalCents)}</span><span class="status">${titleCase(o.status)}</span><a class="row-action" href="#/order/${encodeURIComponent(o.orderNumber)}">View</a></div>`).join('')}</div>` : emptyProducts('No orders yet.')}`;
      $('#logoutButton')?.addEventListener('click', logout); bindAccountSecurity($('#accountContent'));
    } catch(e){$('#accountContent').innerHTML = emptyProducts(e.message);}
  }

  function renderAccountRequired(title, copy) {
    app.innerHTML = `<div class="page-shell"><section class="page-hero"><div class="page-hero-inner"><span class="eyebrow">SANDMAN / ACCOUNT</span><h1>${esc(title)}.</h1><p>${esc(copy)}</p><button class="primary-btn" id="accountRequiredLogin">Log in</button></div></section></div>`;
    $('#accountRequiredLogin').addEventListener('click', () => openAuth('login'));
  }

  async function renderCheckout() {
    if (!state.token) return renderAccountRequired('Checkout', 'Log in before checking out.');
    await loadCart(false);
    if (!state.cart?.items?.length) { app.innerHTML = `<div class="page-shell"><section class="page-hero"><div class="page-hero-inner"><span class="eyebrow">CHECKOUT</span><h1>Your bag is empty.</h1><a class="primary-btn" href="#/shop">Shop parts</a></div></section></div>`; return; }
    state.paymentConfig = state.paymentConfig || await api('/payments/config');
    const hasMarketplace = state.cart.items.some(i => i.product.sourceType === 'MARKETPLACE');
    const methods = [];
    if (state.paymentConfig.stripe.enabled) methods.push(`<label class="payment-choice"><input type="radio" name="paymentProvider" value="stripe" checked><span><strong>Card + digital wallets</strong><small>Stripe dynamically shows eligible cards, Apple Pay, Google Pay, Link, bank methods, BNPL and local methods.</small></span></label>`);
    if (state.paymentConfig.paypal.enabled && !hasMarketplace) methods.push(`<label class="payment-choice"><input type="radio" name="paymentProvider" value="paypal" ${methods.length?'':'checked'}><span><strong>PayPal</strong><small>Pay securely with your PayPal account or eligible PayPal funding sources.</small></span></label>`);
    if (state.paymentConfig.bankTransfer.enabled && !hasMarketplace) methods.push(`<label class="payment-choice"><input type="radio" name="paymentProvider" value="bank_transfer" ${methods.length?'':'checked'}><span><strong>Bank transfer / EFT</strong><small>Your order stays pending until SANDMAN verifies the transfer.</small></span></label>`);
    app.innerHTML = `<div class="checkout-page"><div class="checkout-layout"><form class="checkout-form" id="checkoutForm"><span class="eyebrow">CHECKOUT / DELIVERY</span><h2>Shipping address</h2><div class="field-row"><label>First name<input name="firstName" required value="${esc(state.user?.firstName||'')}"></label><label>Last name<input name="lastName" required value="${esc(state.user?.lastName||'')}"></label></div><label>Address<input name="line1" required></label><label>Address line 2<input name="line2"></label><div class="field-row"><label>City<input name="city" required></label><label>State / province<input name="state"></label></div><div class="field-row"><label>Postal code<input name="postalCode" required></label><label>Country code<select name="country"><option value="ZA">South Africa (ZA)</option><option value="US">United States (US)</option><option value="GB">United Kingdom (GB)</option><option value="DE">Germany (DE)</option><option value="AU">Australia (AU)</option><option value="CA">Canada (CA)</option></select></label></div><label>Phone<input name="phone"></label><label>Order note<textarea name="customerNote" rows="3"></textarea></label><div class="payment-methods"><span class="eyebrow">PAYMENT METHOD</span>${methods.join('') || '<div class="form-note">No live payment provider is configured yet.</div>'}${hasMarketplace ? '<p class="form-note">Marketplace carts use Stripe so seller payouts and the SANDMAN commission can be split securely.</p>' : ''}</div><button class="primary-btn wide" type="submit" ${methods.length?'':'disabled'}>Continue to secure payment</button></form><aside class="order-summary"><span class="eyebrow">ORDER / SUMMARY</span><div style="height:15px"></div>${state.cart.items.map(i => `<div class="summary-item">${imageOf(i.product)?`<img src="${esc(imageOf(i.product))}" alt="">`:'<div class="skeleton" style="width:55px;height:55px"></div>'}<div><strong>${esc(i.product.name)}</strong><span>Qty ${i.quantity}</span></div><strong>${money(i.product.priceCents*i.quantity)}</strong></div>`).join('')}<div class="summary-totals" id="quoteTotals"><div class="summary-line"><span>Subtotal</span><span>${money(state.cart.subtotalCents)}</span></div><div class="summary-line"><span>Shipping</span><span>Calculated next</span></div><div class="summary-line total"><span>Estimated total</span><span>${money(state.cart.subtotalCents)}</span></div></div></aside></div></div>`;
    $('#checkoutForm').addEventListener('submit', async e => {
      e.preventDefault(); const f = new FormData(e.currentTarget); const address = { firstName:f.get('firstName'), lastName:f.get('lastName'), line1:f.get('line1'), line2:f.get('line2')||undefined, city:f.get('city'), state:f.get('state')||undefined, postalCode:f.get('postalCode'), country:f.get('country'), phone:f.get('phone')||undefined };
      const btn = e.currentTarget.querySelector('button[type=submit]'); btn.disabled=true; btn.textContent='Creating secure payment…';
      try {
        const result = await api('/orders/checkout',{method:'POST',body:JSON.stringify({shippingAddress:address,customerNote:f.get('customerNote')||undefined,paymentProvider:f.get('paymentProvider')})});
        if (result.payment.provider === 'stripe') await renderStripePayment(result);
        else if (result.payment.provider === 'paypal') await renderPayPalPayment(result);
        else if (result.payment.provider === 'bank_transfer') {
          e.currentTarget.innerHTML = `<span class="eyebrow">BANK TRANSFER / EFT</span><h2>Order ${esc(result.order.orderNumber)}</h2><div class="bank-instructions">${esc(result.payment.instructions).replaceAll('\n','<br>')}</div><p class="form-note">Use the order number as your payment reference. The order remains pending until payment is verified.</p><a class="primary-btn wide" href="#/order/${encodeURIComponent(result.order.orderNumber)}">View order</a>`;
        }
      } catch(err){toast(err.message,'error');btn.disabled=false;btn.textContent='Continue to secure payment';}
    });
    try { const f=$('#checkoutForm'); const fd=new FormData(f); const a={firstName:state.user?.firstName||'Quote',lastName:state.user?.lastName||'Customer',line1:'Quote only',city:'Quote',postalCode:'0000',country:'ZA'}; const q=await api('/orders/quote',{method:'POST',body:JSON.stringify({shippingAddress:a})}); $('#quoteTotals').innerHTML=`<div class="summary-line"><span>Subtotal</span><span>${money(q.subtotalCents)}</span></div><div class="summary-line"><span>Shipping</span><span>${money(q.shippingCents)}</span></div><div class="summary-line"><span>Tax</span><span>${money(q.taxCents)}</span></div><div class="summary-line total"><span>Total</span><span>${money(q.totalCents)}</span></div>`; } catch {}
  }

  async function renderStripePayment(result) {
    await loadExternalScript('https://js.stripe.com/v3/', 'Stripe');
    const stripe = window.Stripe(result.payment.publishableKey || state.paymentConfig.stripe.publishableKey);
    const elements = stripe.elements({ clientSecret: result.payment.clientSecret, appearance: { theme:'night', variables:{ colorPrimary:'#dfc78d', colorBackground:'#0b0b0a', colorText:'#eee6da', borderRadius:'0px' } } });
    const form = $('#checkoutForm');
    form.innerHTML = `<span class="eyebrow">SECURE PAYMENT / STRIPE</span><h2>Pay ${money(result.order.totalCents)}</h2><p class="form-note">Stripe automatically shows the payment methods eligible for this customer, currency and device.</p><div id="stripePaymentElement" class="provider-element"></div><button class="primary-btn wide" id="stripePayButton" type="button">Pay now</button><p class="form-note" id="paymentMessage"></p>`;
    elements.create('payment',{layout:'accordion'}).mount('#stripePaymentElement');
    $('#stripePayButton').addEventListener('click', async () => {
      const button=$('#stripePayButton'); button.disabled=true; button.textContent='Processing…';
      const {error} = await stripe.confirmPayment({ elements, confirmParams:{ return_url:`${location.origin}/#/order/${encodeURIComponent(result.order.orderNumber)}` }, redirect:'if_required' });
      if (error) { $('#paymentMessage').textContent=error.message||'Payment failed'; button.disabled=false; button.textContent='Pay now'; return; }
      toast('Payment submitted'); location.hash=`#/order/${encodeURIComponent(result.order.orderNumber)}`;
    });
  }

  async function renderPayPalPayment(result) {
    const config=state.paymentConfig.paypal;
    const src=`https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(config.clientId)}&currency=${encodeURIComponent(result.order.currency)}&intent=capture`;
    await loadExternalScript(src, 'paypal');
    const form=$('#checkoutForm');
    form.innerHTML=`<span class="eyebrow">SECURE PAYMENT / PAYPAL</span><h2>Pay ${money(result.order.totalCents)}</h2><div id="paypalButtons" class="provider-element"></div><p class="form-note" id="paymentMessage"></p>`;
    await window.paypal.Buttons({
      createOrder: () => result.payment.paypalOrderId,
      onApprove: async () => { const captured=await api(`/orders/${encodeURIComponent(result.order.orderNumber)}/paypal/capture`,{method:'POST'}); toast('PayPal payment complete'); location.hash=`#/order/${encodeURIComponent(captured.order.orderNumber)}`; },
      onError: err => { $('#paymentMessage').textContent=err?.message||'PayPal payment failed'; }
    }).render('#paypalButtons');
  }

  async function renderOrder(orderNumber) {
    if (!state.token) return renderAccountRequired('Order', 'Log in to view this order.');
    app.innerHTML = `<div class="page-shell"><section class="page-hero"><div class="page-hero-inner"><span class="eyebrow">ORDER / ${esc(orderNumber)}</span><h1>Loading order…</h1></div></section></div>`;
    try {
      const o = await api(`/orders/${encodeURIComponent(orderNumber)}`);
      app.innerHTML = `<div class="page-shell"><section class="page-hero"><div class="page-hero-inner"><span class="eyebrow">ORDER / ${esc(o.orderNumber)}</span><h1>${titleCase(o.status)}.</h1><p>${money(o.totalCents)} · Payment ${titleCase(o.paymentStatus)} · ${new Date(o.createdAt).toLocaleString()}</p></div></section><section class="section"><div class="section-inner"><div class="data-list">${o.items.map(i=>`<div class="data-row" style="grid-template-columns:1fr 120px 120px"><div><strong>${esc(i.name)}</strong><small>${esc(i.sku)} · Qty ${i.quantity} · ${i.sourceType==='MARKETPLACE'?'Seller listing':'Supplier stock'}</small></div><span>${money(i.totalPriceCents)}</span><span class="status">${i.sellerTrackingNumber?`Shipped ${esc(i.sellerCarrier||'')}`:i.sourceType==='MARKETPLACE'?'Seller fulfillment':'Supplier fulfillment'}</span></div>`).join('')}</div><div style="margin-top:35px"><a class="secondary-btn" href="#/account">Back to account</a></div></div></section></div>`;
    } catch(e){app.innerHTML=`<div class="page-shell"><section class="page-hero"><div class="page-hero-inner"><h1>Order unavailable.</h1><p>${esc(e.message)}</p></div></section></div>`;}
  }

  function renderAbout() {
    app.innerHTML = `<div class="about-page"><img class="logo-large" src="/assets/sandman-logo.png" alt="SANDMAN"><div class="about-copy"><h1>Dream while awake.</h1><div><p><strong>SANDMAN is an engine-parts marketplace built around two kinds of inventory:</strong> connected dropshipping suppliers and parts listed by independent sellers.</p><p>The market is intentionally search-first. Buyers can browse directly by part, engine code, brand, category or part number instead of being forced through a vehicle selector before they can see the catalog.</p><p>Vehicle fitment data can still live behind individual parts when useful, but the marketplace is the product.</p></div></div></div>`;
  }

  async function logout() {
    try { await fetch('/api/auth/logout', { method:'POST', credentials:'same-origin', headers: state.token ? { Authorization:`Bearer ${state.token}` } : {} }); } catch {}
    setToken('', null); state.cart=null; updateCartCount(); location.hash='#/'; toast('Signed out');
  }

  async function route() {
    closeCart(); closeAuth(); $('#searchPanel').classList.remove('open');
    const { path, params } = queryFromHash();
    window.scrollTo(0, 0);
    if (!path) await renderHome();
    else if (path === 'shop') await renderShop(params);
    else if (path.startsWith('product/')) await renderProduct(decodeURIComponent(path.slice('product/'.length)));
    else if (path === 'sell') await renderSell();
    else if (path === 'seller') await renderSeller();
    else if (path === 'account') await renderAccount();
    else if (path === 'checkout') await renderCheckout();
    else if (path.startsWith('order/')) await renderOrder(decodeURIComponent(path.slice('order/'.length)));
    else if (path === 'about') renderAbout();
    else app.innerHTML = `<div class="page-shell"><section class="page-hero"><div class="page-hero-inner"><span class="eyebrow">404 / SANDMAN</span><h1>Lost in the market.</h1><a class="primary-btn" href="#/">Return home</a></div></section></div>`;
    app.focus({ preventScroll:true });
  }

  function bindGlobalUi() {
    window.addEventListener('scroll', () => $('#siteHeader').classList.toggle('scrolled', scrollY > 20), { passive:true });
    window.addEventListener('hashchange', route);
    $('#searchToggle').addEventListener('click', () => { const p=$('#searchPanel'); p.classList.toggle('open'); p.setAttribute('aria-hidden', p.classList.contains('open')?'false':'true'); if(p.classList.contains('open')) setTimeout(()=>$('#globalSearchInput').focus(),120); });
    $('#globalSearchForm').addEventListener('submit', e => { e.preventDefault(); const q=$('#globalSearchInput').value.trim(); $('#searchPanel').classList.remove('open'); location.hash=`#/shop${q?`?q=${encodeURIComponent(q)}`:''}`; });
    $('#accountButton').addEventListener('click', () => { if(state.token) location.hash='#/account'; else openAuth('login'); });
    $('#cartButton').addEventListener('click', openCart); $('#cartClose').addEventListener('click', closeCart); $('#authClose').addEventListener('click', closeAuth); $('#backdrop').addEventListener('click', () => { closeCart(); closeAuth(); });
    $('#mobileMenuButton').addEventListener('click', () => { $('#mobileMenu').classList.add('open'); $('#mobileMenu').setAttribute('aria-hidden','false'); });
    $('#mobileMenuClose').addEventListener('click', closeMobileMenu); $$('#mobileMenu a').forEach(a=>a.addEventListener('click',closeMobileMenu));
    $$('.auth-tabs button').forEach(b=>b.addEventListener('click',()=>switchAuthTab(b.dataset.authTab)));
    $('#loginForm').addEventListener('submit', async e => { e.preventDefault(); const f=new FormData(e.currentTarget); try { const data=await api('/auth/login',{method:'POST',body:JSON.stringify({email:f.get('email'),password:f.get('password')})}); setToken(data.token,data.user); await loadCart(false); closeAuth(); toast(`Welcome back${data.user.firstName?`, ${data.user.firstName}`:''}`); route(); } catch(err){toast(err.message,'error');} });
    $('#registerForm').addEventListener('submit', async e => { e.preventDefault(); const f=new FormData(e.currentTarget); try { const data=await api('/auth/register',{method:'POST',body:JSON.stringify({email:f.get('email'),password:f.get('password'),firstName:f.get('firstName'),lastName:f.get('lastName')})}); setToken(data.token,data.user); await loadCart(false); closeAuth(); toast('SANDMAN account created'); route(); } catch(err){toast(err.message,'error');} });
    document.addEventListener('keydown', e => { if(e.key==='Escape'){closeCart();closeAuth();closeMobileMenu();$('#searchPanel').classList.remove('open');} });
  }
  function closeMobileMenu(){ $('#mobileMenu').classList.remove('open'); $('#mobileMenu').setAttribute('aria-hidden','true'); }

  async function boot() {
    bindGlobalUi();
    await Promise.all([loadCategories(), hydrateUser()]);
    updateCartCount();
    await route();
  }
  boot();
})();
