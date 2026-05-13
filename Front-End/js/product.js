// Single-product detail page.
// URL pattern: /product.html?id=<id>
// Loads product info + reviews and renders the page. Logged-in users can post
// a review; admins can hide/delete any review.

(function() {
    const params  = new URLSearchParams(location.search);
    const id      = parseInt(params.get('id'), 10);
    const me      = api.getUser();
    const isAdmin = !!(me && me.role === 'admin');

    // ---- guard: bad / missing id ------------------------------------------
    if (!Number.isInteger(id) || id <= 0) {
        document.getElementById('loading').style.display    = 'none';
        document.getElementById('not-found').style.display  = 'block';
        document.title = 'Product not found - Sparko';
        return;
    }

    // ---- DOM refs ---------------------------------------------------------
    const loadingEl   = document.getElementById('loading');
    const notFoundEl  = document.getElementById('not-found');
    const detailEl    = document.getElementById('product-detail');
    const reviewsEl   = document.getElementById('reviews-section');
    const nudgeEl     = document.getElementById('signin-nudge');

    // ---- helpers ----------------------------------------------------------
    function starRow(rating) {
        const r = Math.round(Number(rating) || 0);
        let s = '<span class="star-row" aria-label="' + r + ' of 5 stars">';
        for (let i = 1; i <= 5; i++) {
            s += '<span class="star ' + (i <= r ? 'filled' : '') + '">★</span>';
        }
        s += '</span>';
        return s;
    }

    function fail(msg) {
        loadingEl.style.display = 'none';
        notFoundEl.style.display = 'block';
        notFoundEl.querySelector('h3').textContent = msg || 'Product not found';
        document.title = 'Product not found - Sparko';
    }

    // ---- main: fetch product + reviews ------------------------------------
    Promise.all([
        api.get('/products/' + id),
        api.get('/reviews/product/' + id + '?limit=50')
    ]).then(([productData, reviewData]) => {
        const p = productData.product;
        renderProduct(p);
        renderReviews(p, reviewData);
        loadingEl.style.display = 'none';
        detailEl.style.display = 'grid';
        reviewsEl.style.display = 'block';
    }).catch(err => {
        console.error('Failed to load product:', err);
        fail((err && err.message && err.message.includes('not found')) ? 'Product not found' : 'Could not load product');
    });

    // ---- render: hero / detail panel --------------------------------------
    function renderProduct(p) {
        document.title = p.name + ' - Sparko';
        setText('bc-name',      p.name);
        setText('p-name',       p.name);
        setText('p-category',   p.category || '');
        setText('p-size',       p.size || '');
        setText('p-price',      formatCurrency(p.price));
        setText('p-description', p.description || '');
        setText('img-letter',   (p.name || 'S')[0]);

        const avg   = Number(p.avg_rating).toFixed(1);
        const count = Number(p.review_count);
        document.getElementById('p-stars').outerHTML = starRow(avg);
        setText('p-avg', avg);
        setText('p-count', count);

        document.getElementById('add-btn').addEventListener('click', () => addToCart(p.id));
    }

    async function addToCart(productId) {
        if (!api.isLoggedIn()) {
            toast('Sign in to add items to your cart.', { type: 'warn' });
            setTimeout(() => { location.href = 'login.html'; }, 800);
            return;
        }
        const qty = Math.max(1, parseInt(document.getElementById('qty').value || '1', 10));
        const btn = document.getElementById('add-btn');
        const oldLabel = btn.textContent;
        btn.disabled = true; btn.textContent = 'Adding…';
        try {
            await api.post('/cart/items', { product_id: productId, quantity: qty });
            toast('Added ' + qty + ' to your cart.', { type: 'success' });
            if (typeof refreshCartBadge === 'function') refreshCartBadge();
        } catch (e) {
            toast(e.message || 'Failed to add to cart.', { type: 'error' });
        } finally {
            btn.textContent = oldLabel;
            btn.disabled = false;
        }
    }

    // ---- render: reviews panel --------------------------------------------
    function renderReviews(p, reviewData) {
        renderRatingSummary(reviewData);

        if (!api.isLoggedIn()) {
            nudgeEl.style.display = 'block';
        } else {
            renderReviewForm(p, reviewData);
        }

        renderReviewList(p, reviewData);
    }

    function renderRatingSummary(reviewData) {
        const total = reviewData.summary.total;
        const dist  = reviewData.summary.distribution;
        const el    = document.getElementById('rating-summary');
        if (total === 0) {
            el.innerHTML = '<p class="empty-reviews">No ratings yet — be the first.</p>';
            return;
        }
        let html = '';
        for (let s = 5; s >= 1; s--) {
            const n   = dist[s] || 0;
            const pct = (n / total) * 100;
            html += '<div class="rating-row">';
            html += '  <span class="rating-row-label">' + s + '★</span>';
            html += '  <div class="rating-row-bar"><div class="rating-row-fill" style="width:' + pct.toFixed(0) + '%"></div></div>';
            html += '  <span class="rating-row-count">' + n + '</span>';
            html += '</div>';
        }
        el.innerHTML = html;
    }

    function renderReviewForm(p, reviewData) {
        const mine = reviewData.reviews.find(r => r.user_id === me.id);
        const wrap = document.getElementById('review-form-wrap');

        let html = '<div class="review-form">';
        html += '<h4>' + (mine ? 'Update your review' : 'Write a review') + '</h4>';
        html += '<div class="star-picker" id="star-picker">';
        for (let i = 1; i <= 5; i++) {
            html += '<span class="star pick" data-val="' + i + '">★</span>';
        }
        html += '</div>';
        html += '<input type="text" id="rv-title" placeholder="Title (optional)" maxlength="150" value="'
              + escapeHtml(mine ? (mine.title || '') : '') + '">';
        html += '<textarea id="rv-comment" placeholder="Share your experience…" maxlength="5000">'
              + escapeHtml(mine ? (mine.comment || '') : '') + '</textarea>';
        html += '<div class="review-form-actions">';
        html += '  <button class="btn btn-primary" id="rv-submit">' + (mine ? 'Update review' : 'Submit review') + '</button>';
        if (mine) {
            html += '  <button class="btn btn-danger" id="rv-delete">Delete</button>';
        }
        html += '</div>';
        html += '<div id="rv-status" class="review-status"></div>';
        html += '</div>';
        wrap.innerHTML = html;

        // Wire the star picker
        let selectedRating = mine ? mine.rating : 5;
        const picker = document.getElementById('star-picker');
        const paint = () => {
            for (const s of picker.querySelectorAll('.star')) {
                s.classList.toggle('filled', parseInt(s.dataset.val, 10) <= selectedRating);
            }
        };
        paint();
        for (const s of picker.querySelectorAll('.star')) {
            s.addEventListener('click', () => { selectedRating = parseInt(s.dataset.val, 10); paint(); });
        }

        document.getElementById('rv-submit').addEventListener('click', async () => {
            const title   = document.getElementById('rv-title').value.trim();
            const comment = document.getElementById('rv-comment').value.trim();
            const status  = document.getElementById('rv-status');
            status.textContent = '';
            try {
                if (mine) {
                    await api.put('/reviews/' + mine.id, { rating: selectedRating, title, comment });
                    toast('Review updated.', { type: 'success' });
                } else {
                    await api.post('/reviews', { product_id: p.id, rating: selectedRating, title, comment });
                    toast('Review submitted — +25 reward points!', { type: 'success', duration: 4500 });
                }
                refreshPage();
            } catch (e) {
                status.textContent = e.message || 'Could not submit review.';
            }
        });

        if (mine) {
            document.getElementById('rv-delete').addEventListener('click', async () => {
                if (!confirm('Delete your review?')) return;
                try {
                    await api.delete('/reviews/' + mine.id);
                    toast('Review deleted.', { type: 'success' });
                    refreshPage();
                } catch (e) {
                    toast(e.message || 'Delete failed.', { type: 'error' });
                }
            });
        }
    }

    function renderReviewList(p, reviewData) {
        const list = document.getElementById('review-list');
        if (!reviewData.reviews.length) {
            list.innerHTML = '<p class="empty-reviews">No reviews yet. Be the first!</p>';
            return;
        }

        let html = '';
        for (const r of reviewData.reviews) {
            const isMine = me && r.user_id === me.id;
            html += '<div class="review-item">';
            html += '  <div class="review-head">';
            html += '    <span class="review-author">' + escapeHtml(r.username) + (isMine ? ' (you)' : '') + '</span>';
            html += '    ' + starRow(r.rating);
            html += '    <span class="review-date">' + escapeHtml(formatDate(r.created_at)) + '</span>';
            html += '  </div>';
            if (r.title)   html += '<div class="review-title-line">' + escapeHtml(r.title) + '</div>';
            if (r.comment) html += '<div class="review-comment">' + escapeHtml(r.comment) + '</div>';
            if (isAdmin && !isMine) {
                html += '<div style="margin-top:0.8vh;">';
                html += '  <button class="btn btn-small btn-secondary" data-hide="' + r.id + '">Hide (admin)</button>';
                html += '  <button class="btn btn-small btn-danger" data-admin-del="' + r.id + '">Delete (admin)</button>';
                html += '</div>';
            }
            html += '</div>';
        }
        list.innerHTML = html;

        for (const btn of list.querySelectorAll('[data-hide]')) {
            btn.addEventListener('click', async () => {
                try {
                    await api.put('/reviews/' + btn.dataset.hide + '/hide', { is_hidden: true });
                    toast('Review hidden.', { type: 'success' });
                    refreshPage();
                } catch (e) { toast(e.message, { type: 'error' }); }
            });
        }
        for (const btn of list.querySelectorAll('[data-admin-del]')) {
            btn.addEventListener('click', async () => {
                if (!confirm('Delete this review as admin?')) return;
                try {
                    await api.delete('/reviews/' + btn.dataset.adminDel);
                    toast('Deleted.', { type: 'success' });
                    refreshPage();
                } catch (e) { toast(e.message, { type: 'error' }); }
            });
        }
    }

    // Re-fetch on review changes rather than juggling local state.
    function refreshPage() {
        location.reload();
    }
})();
