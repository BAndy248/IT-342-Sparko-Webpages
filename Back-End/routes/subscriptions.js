const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { logger } = require('../utils/logger');

router.use(authenticate);

// --- GET USER'S SUBSCRIPTIONS ---
router.get('/', async (req, res) => {
    try {
        const [subscriptions] = await pool.execute(
            `SELECT s.*, a.street, a.city, a.state, a.zip_code
             FROM subscriptions s
             LEFT JOIN addresses a ON s.address_id = a.id
             WHERE s.user_id = ?
             ORDER BY s.created_at DESC`,
            [req.user.id]
        );

        // Get items for each subscription
        for (const sub of subscriptions) {
            const [items] = await pool.execute(
                `SELECT si.*, p.name, p.price, p.size, p.category
                 FROM subscription_items si
                 JOIN products p ON si.product_id = p.id
                 WHERE si.subscription_id = ?`,
                [sub.id]
            );
            sub.items = items;
        }

        res.json({ subscriptions });
    } catch (err) {
        logger.error('subs_list_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to fetch subscriptions.' });
    }
});

// --- CREATE SUBSCRIPTION ---
router.post('/', [
    body('plan_name').trim().notEmpty().withMessage('Plan name is required'),
    body('frequency').isIn(['weekly', 'biweekly', 'monthly']).withMessage('Invalid frequency'),
    body('address_id').isInt().withMessage('Delivery address is required'),
    body('items').isArray({ min: 1 }).withMessage('At least one item is required'),
    body('items.*.product_id').isInt().withMessage('Valid product ID required'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('Quantity must be at least 1')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { plan_name, frequency, address_id, items } = req.body;

        // Verify address belongs to user
        const [addresses] = await pool.execute(
            'SELECT id FROM addresses WHERE id = ? AND user_id = ?',
            [address_id, req.user.id]
        );
        if (addresses.length === 0) {
            return res.status(400).json({ error: 'Invalid delivery address.' });
        }

        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            const startDate = new Date();
            const nextDelivery = calculateNextDelivery(startDate, frequency);

            const [subResult] = await connection.execute(
                `INSERT INTO subscriptions (user_id, plan_name, frequency, start_date, next_delivery, address_id)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [req.user.id, plan_name, frequency, startDate, nextDelivery, address_id]
            );

            for (const item of items) {
                await connection.execute(
                    'INSERT INTO subscription_items (subscription_id, product_id, quantity) VALUES (?, ?, ?)',
                    [subResult.insertId, item.product_id, item.quantity]
                );
            }

            await connection.commit();
            res.status(201).json({ message: 'Subscription created.', id: subResult.insertId });
        } catch (txErr) {
            await connection.rollback();
            throw txErr;
        } finally {
            connection.release();
        }
    } catch (err) {
        logger.error('subs_create_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to create subscription.' });
    }
});

// --- UPDATE SUBSCRIPTION STATUS (pause/resume/cancel) ---
router.put('/:id/status', [
    body('status').isIn(['active', 'paused', 'cancelled']).withMessage('Invalid status')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const [result] = await pool.execute(
            'UPDATE subscriptions SET status = ? WHERE id = ? AND user_id = ?',
            [req.body.status, req.params.id, req.user.id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Subscription not found.' });
        }

        res.json({ message: `Subscription ${req.body.status}.` });
    } catch (err) {
        logger.error('subs_update_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to update subscription.' });
    }
});

// --- UPDATE FREQUENCY ---
router.put('/:id/frequency', [
    body('frequency').isIn(['weekly', 'biweekly', 'monthly']).withMessage('Invalid frequency')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const nextDelivery = calculateNextDelivery(new Date(), req.body.frequency);

        const [result] = await pool.execute(
            'UPDATE subscriptions SET frequency = ?, next_delivery = ? WHERE id = ? AND user_id = ?',
            [req.body.frequency, nextDelivery, req.params.id, req.user.id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Subscription not found.' });
        }

        res.json({ message: 'Frequency updated.', next_delivery: nextDelivery });
    } catch (err) {
        logger.error('subs_update_frequency_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to update frequency.' });
    }
});

function calculateNextDelivery(fromDate, frequency) {
    const date = new Date(fromDate);
    switch (frequency) {
        case 'weekly':   date.setDate(date.getDate() + 7); break;
        case 'biweekly': date.setDate(date.getDate() + 14); break;
        case 'monthly':  date.setMonth(date.getMonth() + 1); break;
    }
    return date;
}

module.exports = router;
