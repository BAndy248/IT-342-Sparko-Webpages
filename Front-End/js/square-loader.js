// Loads Square's Web Payments SDK with the right host (sandbox or production)
// driven by /api/config.
//
// Usage:
//   const { payments, config } = await loadSquare();
//   const card = await payments.card();
//   await card.attach('#card-container');
//
// Caches the SDK so calling loadSquare() multiple times on a page reuses it.

(function() {
    let cachedPromise = null;

    function injectScript(src) {
        return new Promise((resolve, reject) => {
            // If a script with this src is already on the page, resolve immediately.
            const existing = document.querySelector('script[data-square-sdk]');
            if (existing) {
                if (window.Square) return resolve();
                existing.addEventListener('load', () => resolve());
                existing.addEventListener('error', () => reject(new Error('Square SDK failed to load')));
                return;
            }
            const s = document.createElement('script');
            s.src = src;
            s.async = true;
            s.dataset.squareSdk = '1';
            s.addEventListener('load',  () => resolve());
            s.addEventListener('error', () => reject(new Error('Square SDK failed to load from ' + src)));
            document.head.appendChild(s);
        });
    }

    async function loadSquare() {
        if (cachedPromise) return cachedPromise;
        cachedPromise = (async () => {
            // Pull publishable credentials from the public config endpoint.
            const cfgRes = await fetch('/api/config');
            if (!cfgRes.ok) throw new Error('Could not load /api/config');
            const config = (await cfgRes.json()).square;
            if (!config || !config.applicationId || !config.locationId) {
                throw new Error('Square is not configured on this server');
            }

            // Production and sandbox have separate hosts. Loading the wrong one
            // makes Square.payments() return an error.
            const host = config.environment === 'production'
                ? 'https://web.squarecdn.com/v1/square.js'
                : 'https://sandbox.web.squarecdn.com/v1/square.js';

            await injectScript(host);

            if (!window.Square) {
                throw new Error('window.Square not present after SDK load');
            }

            const payments = window.Square.payments(config.applicationId, config.locationId);
            return { payments, config };
        })();
        return cachedPromise;
    }

    window.loadSquare = loadSquare;
})();
