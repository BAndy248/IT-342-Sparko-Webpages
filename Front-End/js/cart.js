// Cart + checkout flow.
// Square Web Payments SDK is loaded on demand by loadSquare() (from
// js/square-loader.js), which picks the right host (sandbox vs production)
// based on /api/config.

if (!requireAuth()) throw new Error('redirect');

let squareCard = null;
let currentCart = null;
let availablePoints = 0;

document.getElementById('clear-cart-btn').addEventListener('click', async () => {
    if (!confirm('Empty your cart?')) return;
    await api.delete('/cart');
    loadCart();
});

document.getElementById('redeem-points').addEventListener('input', () => {
    // Debounce preview refresh so we don't spam the API on each keypress.
    clearTimeout(window._previewTimer);
    window._previewTimer = setTimeout(refreshPreview, 250);
});

document.getElementById('checkout-btn').addEventListener('click', checkout);

loadCart();
loadAddresses();
loadPoints();
initSquare();

async function loadCart() {
    try {
        const data = await api.get('/cart');
        currentCart = data.cart;

        const empty   = document.getElementById('cart-empty');
        const loaded  = document.getElementById('cart-loaded');

        if (!currentCart.items.length) {
            empty.style.display  = 'block';
            loaded.style.display = 'none';
            return;
        }
        empty.style.display  = 'none';
        loaded.style.display = 'grid';

        renderItems();
        refreshPreview();
        if (typeof refreshCartBadge === 'function') refreshCartBadge();
    } catch (err) {
        console.error('Cart load failed:', err);
    }
}

function renderItems() {
    const html = currentCart.items.map(it => {
        return ''
            + '<div class="cart-item">'
            + '  <div class="cart-item-img">' + escapeHtml((it.name || 'S')[0]) + '</div>'
            + '  <div class="cart-item-info">'
            + '    <span class="cart-item-name">' + escapeHtml(it.name) + '</span>'
            + '    <span class="cart-item-meta">' + escapeHtml(it.category || '') + ' · ' + escapeHtml(it.size || '') + '</span>'
            + '    <span class="cart-item-price">' + escapeHtml(formatCurrency(it.price)) + ' each</span>'
            + '  </div>'
            + '  <div class="cart-qty">'
            + '    <input type="number" min="1" max="100" value="' + it.quantity + '" data-update="' + it.cart_item_id + '">'
            + '  </div>'
            + '  <div class="cart-item-price">' + escapeHtml(formatCurrency(it.price * it.quantity)) + '</div>'
            + '  <button class="btn btn-small btn-danger" data-remove="' + it.cart_item_id + '">×</button>'
            + '</div>';
    }).join('');
    const container = document.getElementById('cart-items');
    container.innerHTML = html;

    for (const inp of container.querySelectorAll('[data-update]')) {
        inp.addEventListener('change', async () => {
            const qty = Math.max(1, parseInt(inp.value || '1', 10));
            try {
                await api.put('/cart/items/' + inp.dataset.update, { quantity: qty });
                loadCart();
            } catch (e) { toast(e.message, { type: 'error' }); }
        });
    }

    for (const btn of container.querySelectorAll('[data-remove]')) {
        btn.addEventListener('click', async () => {
            try {
                await api.delete('/cart/items/' + btn.dataset.remove);
                loadCart();
            } catch (e) { toast(e.message, { type: 'error' }); }
        });
    }
}

async function loadPoints() {
    try {
        const data = await api.get('/rewards/me');
        availablePoints = data.rewards.points_balance;
        document.getElementById('points-available').textContent =
            availablePoints + ' pts (' + formatCurrency(data.rewards.redeem_value_usd) + ' max)';
        document.getElementById('redeem-points').max = availablePoints;
    } catch (e) {
        // user_rewards row may not exist yet — that's fine, defaults to 0.
    }
}

async function loadAddresses() {
    try {
        const data = await api.get('/users/addresses');
        const sel = document.getElementById('address-select');
        if (!data.addresses.length) {
            sel.innerHTML = '<option value="">No addresses — add one in Profile</option>';
            return;
        }
        sel.innerHTML = data.addresses.map(a =>
            '<option value="' + a.id + '"' + (a.is_default ? ' selected' : '') + '>'
            + escapeHtml(a.street) + ', ' + escapeHtml(a.city) + ', ' + escapeHtml(a.state)
            + '</option>'
        ).join('');
    } catch (e) { console.error('Addresses error:', e); }
}

async function refreshPreview() {
    if (!currentCart || !currentCart.items.length) return;
    const redeem = parseInt(document.getElementById('redeem-points').value || '0', 10);
    try {
        const data = await api.post('/checkout/preview', { redeem_points: redeem });
        setText('sum-subtotal', formatCurrency(data.cart.subtotal));
        const discountRow = document.getElementById('sum-discount-row');
        if (data.cart.discount > 0) {
            discountRow.style.display = 'flex';
            setText('sum-discount', '−' + formatCurrency(data.cart.discount));
        } else {
            discountRow.style.display = 'none';
        }

        const redeemRow = document.getElementById('sum-redeem-row');
        if (data.redeem.applied > 0) {
            redeemRow.style.display = 'flex';
            setText('sum-redeem', '−' + formatCurrency(data.redeem.value_usd));
        } else {
            redeemRow.style.display = 'none';
        }

        setText('sum-total',  formatCurrency(data.final_total));
        setText('sum-points', '+' + data.points_to_earn + ' pts');

        const banner = document.getElementById('bundle-banner');
        if (data.cart.bundle) {
            banner.innerHTML = '<div class="bundle-banner">🎉 <b>' + escapeHtml(data.cart.bundle.name) + '</b> applied – '
                + data.cart.bundle.discount_percent + '% off!</div>';
        } else {
            banner.innerHTML = '';
        }
    } catch (e) {
        console.error('Preview error:', e);
    }
}

async function initSquare() {
    const status = document.getElementById('payment-status');
    try {
        // loadSquare() fetches /api/config, injects the correct SDK URL
        // (sandbox vs production), then returns a ready Payments object.
        const { payments, config } = await loadSquare();
        squareCard = await payments.card();
        await squareCard.attach('#card-container');
        status.textContent = '';
        // Tiny banner so the operator can tell at a glance which mode is live.
        if (config.environment === 'production') {
            status.textContent = '';
        } else {
            status.textContent = 'Sandbox mode — use Square test card 4111 1111 1111 1111';
        }
    } catch (e) {
        // Most common cause: invalid app id, blocked from non-HTTPS origin in
        // production mode, or the backend is in stub mode. The backend's
        // checkout route still accepts a stub source_id so the rest of the
        // flow can be exercised without a working card field.
        console.warn('Square SDK init failed:', e.message);
        status.textContent = 'Card form unavailable: ' + e.message;
    }
}

async function checkout() {
    const btn = document.getElementById('checkout-btn');
    const status = document.getElementById('payment-status');
    btn.disabled = true;
    btn.textContent = 'Processing…';
    status.textContent = '';

    const addressId = parseInt(document.getElementById('address-select').value || '0', 10);
    if (!addressId) {
        status.textContent = 'Choose a delivery address (set one up in Profile).';
        btn.disabled = false;
        btn.textContent = 'Pay & place order';
        return;
    }

    const redeem = parseInt(document.getElementById('redeem-points').value || '0', 10);

    // Tokenize the card. If the Square SDK isn't initialized (no/invalid creds)
    // we send a stub source so the backend can process via its stub path.
    let sourceId = 'stub-source-' + Date.now();
    if (squareCard) {
        try {
            const result = await squareCard.tokenize();
            if (result.status === 'OK') {
                sourceId = result.token;
            } else {
                status.textContent = 'Card error: ' + (result.errors && result.errors[0]
                    ? result.errors[0].message : 'unknown');
                btn.disabled = false;
                btn.textContent = 'Pay & place order';
                return;
            }
        } catch (e) {
            status.textContent = 'Card tokenization failed: ' + e.message;
            btn.disabled = false;
            btn.textContent = 'Pay & place order';
            return;
        }
    }

    try {
        const result = await api.post('/checkout', {
            source_id: sourceId,
            address_id: addressId,
            redeem_points: redeem
        });
        status.textContent = '';
        toast(
            'Order placed! Order #' + result.order_id
            + (result.points_earned ? ' (+' + result.points_earned + ' points earned)' : ''),
            { type: 'success', duration: 4000 }
        );
        // Give the toast a moment to register before navigating away.
        setTimeout(() => { window.location.href = '/orders.html'; }, 800);
    } catch (e) {
        status.textContent = e.message || 'Checkout failed.';
        btn.disabled = false;
        btn.textContent = 'Pay & place order';
    }
}
