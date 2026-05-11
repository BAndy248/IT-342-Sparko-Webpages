const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { logger } = require('../utils/logger');
const cartRouter = require('./cart');
const rewards = require('../utils/rewards');
const square = require('../utils/square');

router.use(authenticate);

// --- PUBLIC PRICING PREVIEW: what would I pay if I checked out now? ---
// Same shape as the cart object but also factors in points the user wants
// to redeem. Useful for the UI to render a live total before submission.
router.post('/preview', [
    body('redeem_points').optional().isInt({ min: 0 })
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

        const redeemPoints = parseInt(req.body.redeem_points || 0, 10);
        const cart = await cartRouter.loadCart(req.user.id);

        const conn = await pool.getConnection();
        let availablePoints = 0;
        try {
            const row = await rewards.ensureRow(conn, req.user.id);
            availablePoints = row.points_balance;
        } finally {
            conn.release();
        }

        const useRedeem = Math.min(redeemPoints, availablePoints);
        const redeemDiscount = rewards.redeemValue(useRedeem);
        const finalTotal = Math.max(0, cart.total - redeemDiscount);

        res.json({
            cart,
            redeem: {
                requested:        redeemPoints,
                applied:          useRedeem,
                available:        availablePoints,
                value_usd:        redeemDiscount
            },
            final_total: Math.round(finalTotal * 100) / 100,
            points_to_earn: rewards.pointsFromAmount(finalTotal)
        });
    } catch (err) {
        logger.error('checkout_preview_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to preview checkout.' });
    }
});

// --- COMPLETE CHECKOUT ---
// Body:
//   source_id      Square Web Payments SDK nonce
//   address_id     Existing user address id
//   redeem_points  Optional integer points to redeem (capped at balance)
//
// Pipeline (all within one DB transaction so partial failure rolls back
// the order + items; the Square charge is handled before the DB writes
// so a card decline never produces a phantom order):
//   1. Reload the cart server-side (don't trust client totals).
//   2. Determine bundle discount + points redemption discount.
//   3. Charge the card via Square for the final total.
//   4. Insert order, order_items, payment record.
//   5. Award/redeem points.
//   6. Empty the cart.
router.post('/', [
    body('source_id').isString().notEmpty().withMessage('Payment source is required'),
    body('address_id').isInt({ min: 1 }).withMessage('Address is required'),
    body('redeem_points').optional().isInt({ min: 0 })
], async (req, res) => {
    let orderId = null;
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

        const { source_id, address_id } = req.body;
        const redeemPoints = parseInt(req.body.redeem_points || 0, 10);

        // Make sure the address belongs to the user.
        const [[addr]] = await pool.execute(
            'SELECT id FROM addresses WHERE id = ? AND user_id = ?',
            [address_id, req.user.id]
        );
        if (!addr) return res.status(400).json({ error: 'Invalid delivery address.' });

        const cart = await cartRouter.loadCart(req.user.id);
        if (!cart.items.length) {
            return res.status(400).json({ error: 'Your cart is empty.' });
        }

        // Determine points-redemption discount, capped at available balance.
        const conn = await pool.getConnection();
        let availablePoints = 0;
        try {
            const row = await rewards.ensureRow(conn, req.user.id);
            availablePoints = row.points_balance;
        } finally {
            conn.release();
        }
        const useRedeem    = Math.min(redeemPoints, availablePoints);
        const redeemUsd    = rewards.redeemValue(useRedeem);
        const finalTotal   = Math.max(0, cart.total - redeemUsd);
        const pointsEarned = rewards.pointsFromAmount(finalTotal);

        // 1) Charge first. If this throws, we never created an order — the
        //    user can safely retry without ending up with a dangling row.
        const charge = await square.createPayment({
            sourceId:  source_id,
            amountUsd: finalTotal,
            orderId:   req.user.id  // best-effort note; we don't have orderId yet
        });
        if (charge.status !== 'COMPLETED') {
            return res.status(402).json({ error: 'Payment did not complete.' });
        }

        // 2) Persist order + items + payment in one DB transaction.
        const conn2 = await pool.getConnection();
        try {
            await conn2.beginTransaction();

            const [orderResult] = await conn2.execute(
                `INSERT INTO orders (user_id, status, total, address_id, notes)
                 VALUES (?, 'confirmed', ?, ?, ?)`,
                [
                    req.user.id,
                    finalTotal,
                    address_id,
                    cart.bundle
                        ? `Bundle: ${cart.bundle.name} (-${cart.bundle.discount_percent}%)`
                        : null
                ]
            );
            orderId = orderResult.insertId;

            for (const it of cart.items) {
                await conn2.execute(
                    'INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (?, ?, ?, ?)',
                    [orderId, it.product_id, it.quantity, it.price]
                );
            }

            await conn2.execute(
                `INSERT INTO payments
                    (order_id, user_id, provider, provider_payment_id, amount, status, raw_response)
                 VALUES (?, ?, 'square', ?, ?, 'captured', ?)`,
                [orderId, req.user.id, charge.paymentId, finalTotal, JSON.stringify(charge.raw)]
            );

            // Drain cart_items (the cart row itself stays so future adds are cheap).
            await conn2.execute(
                `DELETE ci FROM cart_items ci
                 JOIN carts c ON ci.cart_id = c.id
                 WHERE c.user_id = ?`,
                [req.user.id]
            );

            await conn2.commit();
        } catch (txErr) {
            await conn2.rollback();
            throw txErr;
        } finally {
            conn2.release();
        }

        // 3) Rewards adjustments (outside the order tx so a points hiccup
        //    can't roll back the actual order/payment that already cleared).
        if (useRedeem > 0) {
            try {
                await rewards.redeem(pool, req.user.id, useRedeem, 'Order discount', { type: 'order', id: orderId });
            } catch (e) {
                logger.warn('checkout_redeem_failed', { requestId: req.requestId, orderId, error: e.message });
            }
        }
        if (pointsEarned > 0) {
            try {
                await rewards.award(pool, req.user.id, pointsEarned, 'Order earned', { type: 'order', id: orderId });
            } catch (e) {
                logger.warn('checkout_award_failed', { requestId: req.requestId, orderId, error: e.message });
            }
        }

        logger.info('checkout_complete', {
            requestId: req.requestId,
            userId: req.user.id,
            orderId,
            total: finalTotal,
            pointsEarned,
            pointsRedeemed: useRedeem,
            bundle: cart.bundle ? cart.bundle.name : null
        });

        res.status(201).json({
            message: 'Order placed.',
            order_id: orderId,
            total: finalTotal,
            points_earned: pointsEarned,
            points_redeemed: useRedeem,
            bundle: cart.bundle
        });
    } catch (err) {
        logger.error('checkout_failed', {
            requestId: req.requestId,
            userId: req.user && req.user.id,
            orderId,
            error: err.message
        });
        res.status(err.squareError ? 402 : 500).json({ error: err.message || 'Checkout failed.' });
    }
});

module.exports = router;
