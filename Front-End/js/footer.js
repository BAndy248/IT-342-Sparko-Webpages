// Shared footer injector. Looks for #footer-mount and replaces it with the
// canonical Sparko footer. Falls back to appending to <body> if the mount
// element isn't on the page.

(function() {
    function render() {
        const year = new Date().getFullYear();
        const html = `
            <footer class="site-footer">
              <div class="site-footer-grid">
                <div>
                  <h4>Sparko</h4>
                  <a href="/about.html">About us</a>
                  <a href="/contact.html">Contact</a>
                  <a href="/faq.html">FAQ</a>
                </div>
                <div>
                  <h4>Shop</h4>
                  <a href="/products.html">Products</a>
                  <a href="/subscription.html">Subscriptions</a>
                  <a href="/rewards.html">Rewards</a>
                </div>
                <div>
                  <h4>Account</h4>
                  <a href="/login.html">Sign in</a>
                  <a href="/register.html">Create account</a>
                  <a href="/dashboard.html">Dashboard</a>
                </div>
                <div>
                  <h4>Legal</h4>
                  <a href="/terms.html">Terms of Service</a>
                  <a href="/privacy.html">Privacy Policy</a>
                </div>
              </div>
              <div class="site-footer-bar">
                © ${year} Sparko Water Delivery Service — built for IT-342
              </div>
            </footer>
        `;

        const mount = document.getElementById('footer-mount');
        if (mount) {
            mount.outerHTML = html;
        } else {
            // Page didn't add a placeholder; append at end of <body>.
            const wrap = document.createElement('div');
            wrap.innerHTML = html;
            document.body.appendChild(wrap.firstElementChild || wrap);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', render);
    } else {
        render();
    }
})();
