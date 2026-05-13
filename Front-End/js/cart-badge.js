// Refresh the cart count badge in the nav. Safe to include on any page —
// it does nothing if there's no #cart-badge element or the user is logged out.
async function refreshCartBadge() {
    const badge = document.getElementById('cart-badge');
    if (!badge || !api.isLoggedIn()) return;
    try {
        const data = await api.get('/cart');
        const count = (data.cart.items || []).reduce((s, it) => s + it.quantity, 0);
        if (count > 0) {
            badge.textContent = count;
            badge.style.display = 'inline-block';
        } else {
            badge.style.display = 'none';
        }
    } catch (e) {
        // Silently ignore — cart errors shouldn't break navigation.
    }
}

if (api && api.isLoggedIn()) {
    refreshCartBadge();
}
