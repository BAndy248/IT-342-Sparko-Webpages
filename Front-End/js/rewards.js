// Rewards page: shows balance, tier, active bundle promotions, and history.

if (!requireAuth()) throw new Error('redirect');

// Tier thresholds — kept in sync with backend utils/rewards.js
const TIER_LADDER = [
    { name: 'Bronze',   from: 0,    to: 500 },
    { name: 'Silver',   from: 500,  to: 2000 },
    { name: 'Gold',     from: 2000, to: 5000 },
    { name: 'Platinum', from: 5000, to: null }
];

let historyPage = 1;

loadOverview();
loadBundles();
loadHistory();

async function loadOverview() {
    try {
        const data = await api.get('/rewards/me');
        const r = data.rewards;
        setText('hero-points', r.points_balance.toLocaleString());
        setText('hero-value',  formatCurrency(r.redeem_value_usd));

        const tierName = capitalize(r.tier);
        setText('hero-tier', tierName);

        // Progress bar to next tier.
        const cur  = TIER_LADDER.find(t => t.name === tierName);
        const next = TIER_LADDER[TIER_LADDER.indexOf(cur) + 1];
        if (next) {
            const span = next.from - cur.from;
            const into = Math.min(span, Math.max(0, r.lifetime_points - cur.from));
            const pct  = (into / span) * 100;
            document.getElementById('hero-progress').style.width = pct.toFixed(1) + '%';
            setText('hero-progress-label',
                r.lifetime_points + ' lifetime points · ' + (next.from - r.lifetime_points) + ' more to ' + next.name);
        } else {
            document.getElementById('hero-progress').style.width = '100%';
            setText('hero-progress-label', r.lifetime_points + ' lifetime points — top tier reached!');
        }
    } catch (err) {
        console.error('Rewards overview error:', err);
    }
}

async function loadBundles() {
    try {
        const data = await api.get('/rewards/bundles');
        const el = document.getElementById('bundles');
        if (!data.bundles.length) {
            el.innerHTML = '<div class="empty-state"><p>No active bundles right now — check back soon!</p></div>';
            return;
        }
        el.innerHTML = data.bundles.map(b => {
            return ''
                + '<div class="bundle-card">'
                + '  <div class="bundle-discount">' + Number(b.discount_percent).toFixed(0) + '% off</div>'
                + '  <div class="bundle-name">' + escapeHtml(b.name) + '</div>'
                + '  <div class="bundle-desc">' + escapeHtml(b.description || '') + '</div>'
                + '  <div class="card-label" style="margin-top:1vh;">'
                + '    Buy ' + b.min_items + (b.category ? ' ' + escapeHtml(b.category) : '') + ' item(s)'
                + '  </div>'
                + '</div>';
        }).join('');
    } catch (err) {
        document.getElementById('bundles').innerHTML =
            '<div class="empty-state"><p>Could not load bundles.</p></div>';
    }
}

async function loadHistory(page) {
    if (page) historyPage = page;
    const el = document.getElementById('history');
    try {
        const data = await api.get('/rewards/history?page=' + historyPage + '&limit=15');
        if (!data.history.length) {
            el.innerHTML = '<div class="empty-state"><p>No reward activity yet. Place an order or post a review to earn points!</p></div>';
            document.getElementById('history-pagination').innerHTML = '';
            return;
        }
        el.innerHTML = data.history.map(h => {
            const isEarned = h.points > 0;
            return ''
                + '<div class="history-row">'
                + '  <div>'
                + '    <div>' + escapeHtml(h.reason || h.type) + '</div>'
                + '    <div class="card-label" style="opacity:0.7;">' + escapeHtml(formatDate(h.created_at)) + ' · ' + escapeHtml(h.type) + '</div>'
                + '  </div>'
                + '  <div class="history-points ' + (isEarned ? 'earned' : 'redeemed') + '">'
                + (isEarned ? '+' : '') + h.points + ' pts'
                + '  </div>'
                + '</div>';
        }).join('');

        const pag = data.pagination;
        let pagHtml = '';
        pagHtml += '<button ' + (pag.page <= 1 ? 'disabled' : '') + ' data-page="' + (pag.page - 1) + '">Prev</button>';
        for (let i = 1; i <= pag.pages; i++) {
            pagHtml += '<button class="' + (i === pag.page ? 'active' : '') + '" data-page="' + i + '">' + i + '</button>';
        }
        pagHtml += '<button ' + (pag.page >= pag.pages ? 'disabled' : '') + ' data-page="' + (pag.page + 1) + '">Next</button>';
        const pagEl = document.getElementById('history-pagination');
        pagEl.innerHTML = pagHtml;
        for (const b of pagEl.querySelectorAll('button[data-page]')) {
            b.addEventListener('click', () => loadHistory(parseInt(b.dataset.page, 10)));
        }
    } catch (err) {
        el.innerHTML = '<div class="empty-state"><p>Could not load history.</p></div>';
    }
}

function capitalize(s) {
    if (!s) return s;
    return s.charAt(0).toUpperCase() + s.slice(1);
}
