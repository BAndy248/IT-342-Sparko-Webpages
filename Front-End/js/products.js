// Products listing + detail / reviews modal.
// Requires api.js (api object + escapeHtml / setText / formatCurrency).

if (!requireAuth()) throw new Error('redirect');

let currentPage = 1;
let currentProductId = null;

const searchInput   = document.getElementById('search-input');
const categoryEl    = document.getElementById('category-filter');
const sortEl        = document.getElementById('sort-filter');

document.getElementById('search-btn').addEventListener('click', () => { currentPage = 1; loadProducts(); });
document.getElementById('clear-btn').addEventListener('click', () => {
    searchInput.value = '';
    categoryEl.value  = '';
    sortEl.value      = '';
    currentPage = 1;
    loadProducts();
});
searchInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { currentPage = 1; loadProducts(); }
});
categoryEl.addEventListener('change', () => { currentPage = 1; loadProducts(); });
sortEl.addEventListener('change',     () => { currentPage = 1; loadProducts(); });

// Live search: refresh as the user types (debounced).
let searchTimer = null;
searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { currentPage = 1; loadProducts(); }, 300);
});

loadCategories();
loadProducts();

async function loadCategories() {
    try {
        const data = await api.get('/products/categories');
        for (const cat of data.categories) {
            const opt = document.createElement('option');
            opt.value = cat;
            opt.textContent = cat;
            categoryEl.appendChild(opt);
        }
    } catch (err) {
        console.error('Load categories error:', err);
    }
}

function buildStars(rating) {
    const r = Math.round(Number(rating) || 0);
    let html = '<span class="star-row" aria-label="' + r + ' of 5 stars">';
    for (let i = 1; i <= 5; i++) {
        html += '<span class="star ' + (i <= r ? 'filled' : '') + '">★</span>';
    }
    html += '</span>';
    return html;
}

async function loadProducts(page) {
    if (page) currentPage = page;
    const grid = document.getElementById('products-grid');
    const params = new URLSearchParams();
    params.set('page', currentPage);
    params.set('limit', 12);
    if (searchInput.value.trim())  params.set('search', searchInput.value.trim());
    if (categoryEl.value)           params.set('category', categoryEl.value);
    if (sortEl.value)               params.set('sort', sortEl.value);

    try {
        const data = await api.get('/products?' + params.toString());
        const info = document.getElementById('result-info');
        info.textContent = data.pagination.total + ' product(s) found';

        if (!data.products.length) {
            grid.innerHTML = '<div class="empty-state"><h3>No products match your search</h3><p>Try a different keyword or clear the filters.</p></div>';
            document.getElementById('pagination').innerHTML = '';
            return;
        }

        let html = '';
        for (const p of data.products) {
            const rating = Number(p.avg_rating).toFixed(1);
            const count  = Number(p.review_count);
            html += '<div class="product-card">';
            html += '  <div class="product-card-img"><div class="product-card-placeholder">'
                  + escapeHtml((p.name || 'Sparko')[0]) + '</div></div>';
            html += '  <div class="product-card-body">';
            html += '    <div class="product-card-title">' + escapeHtml(p.name) + '</div>';
            html += '    <div class="product-card-meta">' + escapeHtml(p.category || '') + ' · ' + escapeHtml(p.size || '') + '</div>';
            html += '    <div class="product-card-rating">' + buildStars(rating)
                  + ' <span class="rating-text">' + rating + ' (' + count + ')</span></div>';
            html += '    <div class="product-card-price">' + escapeHtml(formatCurrency(p.price)) + '</div>';
            html += '    <div class="product-card-actions">';
            // "Details" is a real link now — opens the per-product page where
            // reviews live. The whole card is also clickable for convenience.
            html += '      <a href="product.html?id=' + p.id + '" class="btn btn-small btn-secondary">Details</a>';
            html += '      <button class="btn btn-small btn-primary" data-add="' + p.id + '">Add to cart</button>';
            html += '    </div>';
            html += '  </div>';
            html += '</div>';
        }
        grid.innerHTML = html;

        for (const btn of grid.querySelectorAll('[data-add]')) {
            btn.addEventListener('click', () => addToCart(parseInt(btn.dataset.add, 10), btn));
        }

        renderPagination(data.pagination);
    } catch (err) {
        console.error('Load products error:', err);
        grid.innerHTML = '<div class="empty-state"><p>Could not load products.</p></div>';
    }
}

function renderPagination(pag) {
    let html = '';
    html += '<button ' + (pag.page <= 1 ? 'disabled' : '') + ' data-page="' + (pag.page - 1) + '">Prev</button>';
    for (let i = 1; i <= pag.pages; i++) {
        html += '<button class="' + (i === pag.page ? 'active' : '') + '" data-page="' + i + '">' + i + '</button>';
    }
    html += '<button ' + (pag.page >= pag.pages ? 'disabled' : '') + ' data-page="' + (pag.page + 1) + '">Next</button>';
    const el = document.getElementById('pagination');
    el.innerHTML = html;
    for (const b of el.querySelectorAll('button[data-page]')) {
        b.addEventListener('click', () => loadProducts(parseInt(b.dataset.page, 10)));
    }
}

async function addToCart(productId, btn) {
    const oldLabel = btn ? btn.textContent : null;
    if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
    try {
        await api.post('/cart/items', { product_id: productId, quantity: 1 });
        if (btn) { btn.textContent = 'Added ✓'; }
        if (typeof refreshCartBadge === 'function') refreshCartBadge();
        setTimeout(() => { if (btn) { btn.textContent = oldLabel; btn.disabled = false; } }, 1200);
    } catch (err) {
        if (btn) { btn.textContent = oldLabel; btn.disabled = false; }
        toast(err.message || 'Failed to add to cart.', { type: 'error' });
    }
}

