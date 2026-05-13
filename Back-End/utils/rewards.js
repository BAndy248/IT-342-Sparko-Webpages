/**
 * Rewards engine.
 *
 * Rules (kept in code so they can be tuned without a DB migration):
 *   - 10 points per $1 spent (post-discount, pre-tax subtotal).
 *   - 100 points = $1 of redemption value.
 *   - Tier thresholds (lifetime points): bronze 0, silver 500, gold 2000, platinum 5000.
 *   - Bundle rewards are stored in `bundle_rewards` and applied at checkout —
 *     the BEST eligible bundle wins (highest discount the cart qualifies for),
 *     never stacked.
 */

const POINTS_PER_DOLLAR = 10;
const POINTS_PER_DOLLAR_REDEEM = 100;
const TIERS = [
    { name: 'platinum', threshold: 5000 },
    { name: 'gold',     threshold: 2000 },
    { name: 'silver',   threshold: 500 },
    { name: 'bronze',   threshold: 0 }
];

function tierFor(lifetimePoints) {
    for (const t of TIERS) {
        if (lifetimePoints >= t.threshold) return t.name;
    }
    return 'bronze';
}

function pointsFromAmount(amountUsd) {
    return Math.floor(amountUsd * POINTS_PER_DOLLAR);
}

function redeemValue(points) {
    return Math.floor((points / POINTS_PER_DOLLAR_REDEEM) * 100) / 100;
}

/**
 * Ensure a user_rewards row exists for the user. Returns the row.
 * Idempotent — safe to call repeatedly.
 */
async function ensureRow(conn, userId) {
    await conn.execute(
        'INSERT IGNORE INTO user_rewards (user_id) VALUES (?)',
        [userId]
    );
    const [rows] = await conn.execute(
        'SELECT * FROM user_rewards WHERE user_id = ?',
        [userId]
    );
    return rows[0];
}

/**
 * Award points to a user. Writes to both the balance row and the history
 * ledger inside a single transaction.
 *
 * @param {object} pool       mysql2 pool
 * @param {number} userId
 * @param {number} points     positive integer
 * @param {string} reason     human-readable description
 * @param {object} reference  { type, id } pointing at order/review/etc.
 */
async function award(pool, userId, points, reason, reference = {}) {
    if (!Number.isInteger(points) || points <= 0) {
        throw new Error('Points must be a positive integer');
    }
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        await ensureRow(conn, userId);

        await conn.execute(
            `UPDATE user_rewards
               SET points_balance  = points_balance  + ?,
                   lifetime_points = lifetime_points + ?
             WHERE user_id = ?`,
            [points, points, userId]
        );

        // Recalculate tier from new lifetime total.
        const [[row]] = await conn.execute(
            'SELECT lifetime_points FROM user_rewards WHERE user_id = ?',
            [userId]
        );
        await conn.execute(
            'UPDATE user_rewards SET tier = ? WHERE user_id = ?',
            [tierFor(row.lifetime_points), userId]
        );

        await conn.execute(
            `INSERT INTO reward_history (user_id, points, type, reason, reference_type, reference_id)
             VALUES (?, ?, 'earned', ?, ?, ?)`,
            [userId, points, reason || null, reference.type || null, reference.id || null]
        );

        await conn.commit();
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

/**
 * Redeem points for store credit (returns the dollar value redeemed).
 * Fails if the user doesn't have enough points.
 */
async function redeem(pool, userId, points, reason, reference = {}) {
    if (!Number.isInteger(points) || points <= 0) {
        throw new Error('Points must be a positive integer');
    }
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        await ensureRow(conn, userId);

        // Lock the row so we can't race another redeem call.
        const [[bal]] = await conn.execute(
            'SELECT points_balance FROM user_rewards WHERE user_id = ? FOR UPDATE',
            [userId]
        );
        if (bal.points_balance < points) {
            throw new Error('Insufficient points');
        }

        await conn.execute(
            'UPDATE user_rewards SET points_balance = points_balance - ? WHERE user_id = ?',
            [points, userId]
        );
        await conn.execute(
            `INSERT INTO reward_history (user_id, points, type, reason, reference_type, reference_id)
             VALUES (?, ?, 'redeemed', ?, ?, ?)`,
            [userId, -points, reason || null, reference.type || null, reference.id || null]
        );

        await conn.commit();
        return redeemValue(points);
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

/**
 * Given the cart items (with product info loaded) and the active bundle
 * rewards from the DB, returns the single best bundle deal the cart
 * qualifies for, or null.
 *
 * Picks the highest discount_percent among eligible bundles — never stacks.
 */
function bestBundle(items, bundles, nowMs = Date.now()) {
    const totalItems = items.reduce((s, it) => s + it.quantity, 0);
    const countByCategory = {};
    for (const it of items) {
        const cat = it.category || '__none';
        countByCategory[cat] = (countByCategory[cat] || 0) + it.quantity;
    }

    let best = null;
    for (const b of bundles) {
        if (!b.is_active) continue;
        if (b.starts_at && new Date(b.starts_at).getTime() > nowMs) continue;
        if (b.ends_at && new Date(b.ends_at).getTime() < nowMs) continue;

        const count = b.category ? (countByCategory[b.category] || 0) : totalItems;
        if (count < b.min_items) continue;

        if (!best || Number(b.discount_percent) > Number(best.discount_percent)) {
            best = b;
        }
    }
    return best;
}

module.exports = {
    POINTS_PER_DOLLAR,
    POINTS_PER_DOLLAR_REDEEM,
    tierFor,
    pointsFromAmount,
    redeemValue,
    ensureRow,
    award,
    redeem,
    bestBundle
};
