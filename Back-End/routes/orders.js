const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { logger } = require('../utils/logger');

router.use(authenticate);

// --- GET USER'S ORDERS ---
router.get('/', async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
        const offset = (page - 1) * limit;
        const status = req.query.status;

        let query = `
            SELECT o.*, a.street, a.city, a.state, a.zip_code
            FROM orders o
            LEFT JOIN addresses a ON o.address_id = a.id
            WHERE o.user_id = ?
        `;
        const params = [req.user.id];

        if (status) {
            query += ' AND o.status = ?';
            params.push(status);
        }

        query += ' ORDER BY o.created_at DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);

        const [orders] = await pool.execute(query, params);

        // Get total count for pagination
        const [countResult] = await pool.execute(
            'SELECT COUNT(*) as total FROM orders WHERE user_id = ?' + (status ? ' AND status = ?' : ''),
            status ? [req.user.id, status] : [req.user.id]
        );

        res.json({
            orders,
            pagination: {
                page,
                limit,
                total: countResult[0].total,
                pages: Math.ceil(countResult[0].total / limit)
            }
        });
    } catch (err) {
        logger.error('orders_list_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to fetch orders.' });
    }
});

// --- GET SINGLE ORDER WITH ITEMS ---
router.get('/:id', async (req, res) => {
    try {
        const [orders] = await pool.execute(
            `SELECT o.*, a.street, a.city, a.state, a.zip_code
             FROM orders o
             LEFT JOIN addresses a ON o.address_id = a.id
             WHERE o.id = ? AND o.user_id = ?`,
            [req.params.id, req.user.id]
        );

        if (orders.length === 0) {
            return res.status(404).json({ error: 'Order not found.' });
        }

        const [items] = await pool.execute(
            `SELECT oi.*, p.name, p.size, p.category
             FROM order_items oi
             JOIN products p ON oi.product_id = p.id
             WHERE oi.order_id = ?`,
            [req.params.id]
        );

        res.json({ order: orders[0], items });
    } catch (err) {
        logger.error('orders_get_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to fetch order.' });
    }
});

// --- CANCEL ORDER (only pending orders) ---
router.put('/:id/cancel', async (req, res) => {
    try {
        const [result] = await pool.execute(
            `UPDATE orders SET status = 'cancelled'
             WHERE id = ? AND user_id = ? AND status = 'pending'`,
            [req.params.id, req.user.id]
        );

        if (result.affectedRows === 0) {
            return res.status(400).json({ error: 'Order cannot be cancelled (not found or not pending).' });
        }

        res.json({ message: 'Order cancelled.' });
    } catch (err) {
        logger.error('orders_cancel_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to cancel order.' });
    }
});

module.exports = router;
