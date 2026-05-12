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
            html += '      <button class="btn btn-small btn-secondary" data-detail="' + p.id + '">Details</button>';
            html += '      <button class="btn btn-small btn-primary" data-add="' + p.id + '">Add to cart</button>';
            html += '    </div>';
            html += '  </div>';
            html += '</div>';
        }
        grid.innerHTML = html;

        for (const btn of grid.querySelectorAll('[data-detail]')) {
            btn.addEventListener('click', () => openProduct(parseInt(btn.dataset.detail, 10)));
        }
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

async function openProduct(id) {
    currentProductId = id;
    const modal = document.getElementById('product-modal');
    const content = document.getElementById('product-modal-content');
    content.innerHTML = '<p>Loading…</p>';
    modal.classList.add('active');

    try {
        const [productData, reviewData] = await Promise.all([
            api.get('/products/' + id),
            api.get('/reviews/product/' + id + '?limit=20')
        ]);
        renderProductModal(productData.product, reviewData);
    } catch (err) {
        content.innerHTML = '<p>Could not load product.</p>';
    }
}

function closeProduct() {
    document.getElementById('product-modal').classList.remove('active');
    currentProductId = null;
}

function renderProductModal(product, reviewData) {
    const avg = Number(product.avg_rating).toFixed(1);
    const count = Number(product.review_count);
    const me = api.getUser();

    let html = '';
    html += '<div class="modal-title">' + escapeHtml(product.name) + '</div>';
    html += '<div class="product-meta">' + escapeHtml(product.category || '') + ' · ' + escapeHtml(product.size || '') + '</div>';
    html += '<div class="product-card-rating">' + buildStars(avg)
          + ' <span class="rating-text">' + avg + ' average · ' + count + ' review(s)</span></div>';
    html += '<div class="product-detail-price">' + escapeHtml(formatCurrency(product.price)) + '</div>';
    if (product.description) {
        html += '<p class="product-description">' + escapeHtml(product.description) + '</p>';
    }
    html += '<div style="margin-top:1vh; display:flex; gap:1vh; flex-wrap:wrap;">';
    html += '  <input type="number" id="modal-qty" value="1" min="1" max="50" style="width:80px; padding:0.6vh; border-radius:6px; border:2px solid #083D77;">';
    html += '  <button class="btn btn-primary" id="modal-add-btn">Add to cart</button>';
    html += '</div>';

    html += '<hr class="divider">';
    html += '<h3 class="reviews-title">Customer Reviews</h3>';

    // Rating distribution bar
    if (count > 0) {
        html += '<div class="rating-summary">';
        for (let s = 5; s >= 1; s--) {
            const n = reviewData.summary.distribution[s] || 0;
            const pct = count ? (n / count) * 100 : 0;
            html += '<div class="rating-row"><span class="rating-row-label">' + s + '★</span>';
            html += '<div class="rating-row-bar"><div class="rating-row-fill" style="width:' + pct.toFixed(0) + '%"></div></div>';
            html += '<span class="rating-row-count">' + n + '</span></div>';
        }
        html += '</div>';
    }

    // Add / edit review form
    const mine = me ? reviewData.reviews.find(r => r.user_id === me.id) : null;
    html += '<div class="review-form">';
    html += '  <h4>' + (mine ? 'Update your review' : 'Write a review') + '</h4>';
    html += '  <div id="review-star-picker" class="star-picker">';
    for (let i = 1; i <= 5; i++) {
        html += '<span class="star pick" data-val="' + i + '">★</span>';
    }
    html += '  </div>';
    html += '  <input type="text" id="review-title" placeholder="Title (optional)" maxlength="150" '
          + 'value="' + escapeHtml(mine ? (mine.title || '') : '') + '">';
    html += '  <textarea id="review-comment" placeholder="Share your experience…" maxlength="5000">'
          + escapeHtml(mine ? (mine.comment || '') : '') + '</textarea>';
    html += '  <div class="review-form-actions">';
    html += '    <button class="btn btn-primary" id="submit-review">' + (mine ? 'Update review' : 'Submit review') + '</button>';
    if (mine) {
        html += '<button class="btn btn-danger" id="delete-review">Delete</button>';
    }
    html += '  </div>';
    html += '  <div id="review-status" class="review-status"></div>';
    html += '</div>';

    // Existing reviews
    if (reviewData.reviews.length === 0) {
        html += '<p class="empty-reviews">No reviews yet. Be the first!</p>';
    } else {
        html += '<div class="review-list">';
        for (const r of reviewData.reviews) {
            const isMine = me && r.user_id === me.id;
            const isAdmin = me && me.role === 'admin';
            html += '<div class="review-item">';
            html += '  <div class="review-head">';
            html += '    <span class="review-author">' + escapeHtml(r.username) + (isMine ? ' (you)' : '') + '</span>';
            html += '    ' + buildStars(r.rating);
            html += '    <span class="review-date">' + escapeHtml(formatDate(r.created_at)) + '</span>';
            html += '  </div>';
            if (r.title)   html += '<div class="review-title-line">' + escapeHtml(r.title) + '</div>';
            if (r.comment) html += '<div class="review-comment">' + escapeHtml(r.comment) + '</div>';
            if (isAdmin && !isMine) {
                html += '<button class="btn btn-small btn-danger" data-admin-del="' + r.id + '">Delete (admin)</button>';
            }
            html += '</div>';
        }
        html += '</div>';
    }

    const content = document.getElementById('product-modal-content');
    content.innerHTML = html;

    // Add-to-cart from modal
    document.getElementById('modal-add-btn').addEventListener('click', async () => {
        const qty = parseInt(document.getElementById('modal-qty').value || '1', 10);
        try {
            await api.post('/cart/items', { product_id: product.id, quantity: qty });
            if (typeof refreshCartBadge === 'function') refreshCartBadge();
            toast('Added to cart!', { type: 'success' });
        } catch (e) { toast(e.message || 'Failed to add.', { type: 'error' }); }
    });

    // Star picker
    let selectedRating = mine ? mine.rating : 5;
    const picker = document.getElementById('review-star-picker');
    const renderPicker = () => {
        for (const s of picker.querySelectorAll('.star')) {
            s.classList.toggle('filled', parseInt(s.dataset.val, 10) <= selectedRating);
        }
    };
    renderPicker();
    for (const s of picker.querySelectorAll('.star')) {
        s.addEventListener('click', () => { selectedRating = parseInt(s.dataset.val, 10); renderPicker(); });
    }

    document.getElementById('submit-review').addEventListener('click', async () => {
        const title   = document.getElementById('review-title').value.trim();
        const comment = document.getElementById('review-comment').value.trim();
        const status  = document.getElementById('review-status');
        status.textContent = '';
        try {
            if (mine) {
                await api.put('/reviews/' + mine.id, { rating: selectedRating, title, comment });
                status.textContent = 'Review updated.';
            } else {
                await api.post('/reviews', { product_id: product.id, rating: selectedRating, title, comment });
                status.textContent = 'Review submitted! +25 points earned.';
            }
            setTimeout(() => openProduct(product.id), 600);
        } catch (e) {
            status.textContent = e.message || 'Failed to submit review.';
        }
    });

    if (mine) {
        document.getElementById('delete-review').addEventListener('click', async () => {
            if (!confirm('Delete your review?')) return;
            try {
                await api.delete('/reviews/' + mine.id);
                openProduct(product.id);
            } catch (e) { toast(e.message, { type: 'error' }); }
        });
    }

    for (const btn of content.querySelectorAll('[data-admin-del]')) {
        btn.addEventListener('click', async () => {
            if (!confirm('Delete this review as admin?')) return;
            try {
                await api.delete('/reviews/' + btn.dataset.adminDel);
                openProduct(product.id);
            } catch (e) { toast(e.message, { type: 'error' }); }
        });
    }
}
