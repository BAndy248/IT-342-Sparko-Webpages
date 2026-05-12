const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { logger } = require('../utils/logger');
const square = require('../utils/square');

router.use(authenticate);

// --- LIST USER'S SAVED CARDS ---
router.get('/', async (req, res) => {
    try {
        const [cards] = await pool.execute(
            `SELECT id, provider, provider_card_id, card_brand, card_last4,
                    exp_month, exp_year, is_default, created_at
             FROM payment_methods
             WHERE user_id = ?
             ORDER BY is_default DESC, created_at DESC`,
            [req.user.id]
        );
        res.json({ payment_methods: cards });
    } catch (err) {
        logger.error('payment_methods_list_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to load payment methods.' });
    }
});

// --- SAVE A NEW CARD ON FILE ---
// Body: { source_id: <Square nonce>, cardholder_name? }
router.post('/', [
    body('source_id').isString().notEmpty(),
    body('cardholder_name').optional().isString().isLength({ max: 100 })
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

        const { source_id, cardholder_name } = req.body;

        // Tokenize via Square — falls back to stub mode in dev.
        const card = await square.saveCard({
            sourceId:       source_id,
            referenceId:    req.user.id,
            cardholderName: cardholder_name
        });

        // Atomic switch: unset any existing default, then insert the new one as default.
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            await conn.execute(
                'UPDATE payment_methods SET is_default = FALSE WHERE user_id = ?',
                [req.user.id]
            );
            const [result] = await conn.execute(
                `INSERT INTO payment_methods
                    (user_id, provider, provider_card_id, card_brand, card_last4, exp_month, exp_year, is_default)
                 VALUES (?, 'square', ?, ?, ?, ?, ?, TRUE)`,
                [req.user.id, card.cardId, card.brand, card.last4, card.expMonth, card.expYear]
            );
            await conn.commit();
            res.status(201).json({
                message: 'Card saved.',
                payment_method: {
                    id: result.insertId,
                    card_brand: card.brand,
                    card_last4: card.last4,
                    exp_month: card.expMonth,
                    exp_year: card.expYear,
                    is_default: true
                }
            });
        } catch (txErr) {
            await conn.rollback();
            throw txErr;
        } finally {
            conn.release();
        }
    } catch (err) {
        logger.error('payment_methods_create_failed', { requestId: req.requestId, error: err.message });
        res.status(err.squareError ? 402 : 500).json({ error: err.message || 'Failed to save card.' });
    }
});

// --- SET DEFAULT ---
router.put('/:id/default', async (req, res) => {
    try {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            // Verify ownership first.
            const [[card]] = await conn.execute(
                'SELECT id FROM payment_methods WHERE id = ? AND user_id = ?',
                [req.params.id, req.user.id]
            );
            if (!card) {
                await conn.commit();
                return res.status(404).json({ error: 'Payment method not found.' });
            }
            await conn.execute(
                'UPDATE payment_methods SET is_default = FALSE WHERE user_id = ?',
                [req.user.id]
            );
            await conn.execute(
                'UPDATE payment_methods SET is_default = TRUE WHERE id = ?',
                [req.params.id]
            );
            await conn.commit();
            res.json({ message: 'Default payment method updated.' });
        } catch (txErr) {
            await conn.rollback();
            throw txErr;
        } finally {
            conn.release();
        }
    } catch (err) {
        logger.error('payment_methods_default_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to update default.' });
    }
});

// --- DELETE A SAVED CARD ---
router.delete('/:id', async (req, res) => {
    try {
        const [result] = await pool.execute(
            'DELETE FROM payment_methods WHERE id = ? AND user_id = ?',
            [req.params.id, req.user.id]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Payment method not found.' });
        }
        res.json({ message: 'Payment method deleted.' });
    } catch (err) {
        logger.error('payment_methods_delete_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to delete payment method.' });
    }
});

module.exports = router;
