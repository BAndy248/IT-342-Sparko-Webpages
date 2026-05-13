const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { logger } = require('../utils/logger');
const rewards = require('../utils/rewards');

router.use(authenticate);

/**
 * Helper: get-or-create the cart row for the current user.
 * Wrapped in INSERT IGNORE so it's safe under concurrent first-add calls.
 */
async function getOrCreateCart(userId) {
    await pool.execute('INSERT IGNORE INTO carts (user_id) VALUES (?)', [userId]);
    const [[cart]] = await pool.execute(
        'SELECT id FROM carts WHERE user_id = ?',
        [userId]
    );
    return cart.id;
}

/**
 * Helper: load full cart with items, pricing breakdown, applicable bundle.
 */
async function loadCart(userId) {
    const cartId = await getOrCreateCart(userId);

    const [items] = await pool.execute(
        `SELECT ci.id AS cart_item_id, ci.product_id, ci.quantity,
                p.name, p.size, p.category, p.price, p.image_url
         FROM cart_items ci
         JOIN products p ON ci.product_id = p.id
         WHERE ci.cart_id = ? AND p.is_available = TRUE
         ORDER BY ci.created_at`,
        [cartId]
    );

    const [bundles] = await pool.execute(
        `SELECT * FROM bundle_rewards
         WHERE is_active = TRUE
           AND (starts_at IS NULL OR starts_at <= NOW())
           AND (ends_at   IS NULL OR ends_at   >= NOW())`
    );

    const subtotal = items.reduce(
        (sum, it) => sum + Number(it.price) * it.quantity, 0
    );

    const bundle = rewards.bestBundle(items, bundles);
    const discount = bundle ? subtotal * (Number(bundle.discount_percent) / 100) : 0;
    const total    = Math.max(0, subtotal - discount);
    const points_to_earn = rewards.pointsFromAmount(total);

    return {
        cart_id: cartId,
        items,
        subtotal: round2(subtotal),
        bundle:   bundle ? {
            id: bundle.id,
            name: bundle.name,
            description: bundle.description,
            discount_percent: Number(bundle.discount_percent)
        } : null,
        discount: round2(discount),
        total:    round2(total),
        points_to_earn
    };
}

function round2(n) { return Math.round(n * 100) / 100; }

// --- GET CART ---
router.get('/', async (req, res) => {
    try {
        const cart = await loadCart(req.user.id);
        res.json({ cart });
    } catch (err) {
        logger.error('cart_get_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to load cart.' });
    }
});

// --- ADD ITEM TO CART (or merge quantity if it already exists) ---
router.post('/items', [
    body('product_id').isInt({ min: 1 }),
    body('quantity').optional().isInt({ min: 1, max: 100 })
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

        const productId = parseInt(req.body.product_id, 10);
        const quantity = parseInt(req.body.quantity || 1, 10);

        const [[product]] = await pool.execute(
            'SELECT id FROM products WHERE id = ? AND is_available = TRUE',
            [productId]
        );
        if (!product) return res.status(404).json({ error: 'Product not available.' });

        const cartId = await getOrCreateCart(req.user.id);

        // MySQL upsert: increment quantity if the (cart, product) row exists.
        await pool.execute(
            `INSERT INTO cart_items (cart_id, product_id, quantity)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity)`,
            [cartId, productId, quantity]
        );

        const cart = await loadCart(req.user.id);
        res.status(201).json({ message: 'Added to cart.', cart });
    } catch (err) {
        logger.error('cart_add_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to add to cart.' });
    }
});

// --- UPDATE ITEM QUANTITY ---
router.put('/items/:id', [
    param('id').isInt(),
    body('quantity').isInt({ min: 1, max: 100 })
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

        // Restrict to items in the requesting user's cart.
        const [result] = await pool.execute(
            `UPDATE cart_items ci
             JOIN carts c ON ci.cart_id = c.id
             SET ci.quantity = ?
             WHERE ci.id = ? AND c.user_id = ?`,
            [parseInt(req.body.quantity, 10), req.params.id, req.user.id]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Cart item not found.' });
        }
        const cart = await loadCart(req.user.id);
        res.json({ message: 'Cart updated.', cart });
    } catch (err) {
        logger.error('cart_update_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to update cart item.' });
    }
});

// --- REMOVE ITEM ---
router.delete('/items/:id', async (req, res) => {
    try {
        const [result] = await pool.execute(
            `DELETE ci FROM cart_items ci
             JOIN carts c ON ci.cart_id = c.id
             WHERE ci.id = ? AND c.user_id = ?`,
            [req.params.id, req.user.id]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Cart item not found.' });
        }
        const cart = await loadCart(req.user.id);
        res.json({ message: 'Item removed.', cart });
    } catch (err) {
        logger.error('cart_delete_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to remove item.' });
    }
});

// --- CLEAR CART ---
router.delete('/', async (req, res) => {
    try {
        await pool.execute(
            `DELETE ci FROM cart_items ci
             JOIN carts c ON ci.cart_id = c.id
             WHERE c.user_id = ?`,
            [req.user.id]
        );
        const cart = await loadCart(req.user.id);
        res.json({ message: 'Cart cleared.', cart });
    } catch (err) {
        logger.error('cart_clear_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to clear cart.' });
    }
});

// Default export is the router (used by server.js).
// loadCart is also attached so the checkout route can reuse the helper.
router.loadCart = loadCart;
module.exports = router;
