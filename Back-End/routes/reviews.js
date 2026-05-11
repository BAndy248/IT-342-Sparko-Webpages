const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { logger } = require('../utils/logger');
const rewards = require('../utils/rewards');

// --- LIST REVIEWS FOR A PRODUCT (public) ---
// Includes the reviewer's username so the UI can attribute the comment.
router.get('/product/:productId', async (req, res) => {
    try {
        const productId = parseInt(req.params.productId, 10);
        if (!Number.isInteger(productId)) {
            return res.status(400).json({ error: 'Invalid product id.' });
        }

        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const offset = (page - 1) * limit;

        const [reviews] = await pool.execute(
            `SELECT r.id, r.user_id, r.rating, r.title, r.comment, r.created_at, r.updated_at,
                    u.username
             FROM reviews r
             JOIN users u ON r.user_id = u.id
             WHERE r.product_id = ? AND r.is_hidden = FALSE
             ORDER BY r.created_at DESC
             LIMIT ? OFFSET ?`,
            [productId, limit, offset]
        );

        // Aggregate so the product page can render an average + 1..5 star
        // distribution next to the list of reviews.
        const [[summary]] = await pool.execute(
            `SELECT
                COUNT(*)                                   AS total,
                COALESCE(AVG(rating), 0)                   AS average,
                SUM(CASE WHEN rating = 5 THEN 1 ELSE 0 END) AS stars_5,
                SUM(CASE WHEN rating = 4 THEN 1 ELSE 0 END) AS stars_4,
                SUM(CASE WHEN rating = 3 THEN 1 ELSE 0 END) AS stars_3,
                SUM(CASE WHEN rating = 2 THEN 1 ELSE 0 END) AS stars_2,
                SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) AS stars_1
             FROM reviews
             WHERE product_id = ? AND is_hidden = FALSE`,
            [productId]
        );

        res.json({
            reviews,
            summary: {
                total: Number(summary.total),
                average: Number(summary.average),
                distribution: {
                    5: Number(summary.stars_5),
                    4: Number(summary.stars_4),
                    3: Number(summary.stars_3),
                    2: Number(summary.stars_2),
                    1: Number(summary.stars_1)
                }
            },
            pagination: { page, limit }
        });
    } catch (err) {
        logger.error('reviews_list_failed', {
            requestId: req.requestId,
            productId: req.params.productId,
            error: err.message
        });
        res.status(500).json({ error: 'Failed to load reviews.' });
    }
});

// --- CREATE REVIEW (authenticated) ---
// One review per (user, product) — enforced by unique key in schema.
// Awards 25 reward points for the user's first review on a product.
router.post('/', authenticate, [
    body('product_id').isInt().withMessage('Valid product id required'),
    body('rating').isInt({ min: 1, max: 5 }).withMessage('Rating must be 1-5'),
    body('title').optional().trim().isLength({ max: 150 }),
    body('comment').optional().trim().isLength({ max: 5000 })
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

        const { product_id, rating, title, comment } = req.body;

        // Verify the product exists & is available before recording a review.
        const [[product]] = await pool.execute(
            'SELECT id FROM products WHERE id = ? AND is_available = TRUE',
            [product_id]
        );
        if (!product) return res.status(404).json({ error: 'Product not found.' });

        try {
            const [result] = await pool.execute(
                'INSERT INTO reviews (user_id, product_id, rating, title, comment) VALUES (?, ?, ?, ?, ?)',
                [req.user.id, product_id, rating, title || null, comment || null]
            );

            // Try to award points; if rewards fails, don't fail the review
            // creation — log it and continue (rewards are nice-to-have).
            try {
                await rewards.award(pool, req.user.id, 25, 'Posted a product review', {
                    type: 'review', id: result.insertId
                });
            } catch (rewardErr) {
                logger.warn('reviews_award_points_failed', {
                    requestId: req.requestId,
                    userId: req.user.id,
                    reviewId: result.insertId,
                    error: rewardErr.message
                });
            }

            res.status(201).json({ message: 'Review submitted.', id: result.insertId });
        } catch (dbErr) {
            // Translate the unique-key violation into a clean 409.
            if (dbErr && dbErr.code === 'ER_DUP_ENTRY') {
                return res.status(409).json({ error: 'You have already reviewed this product.' });
            }
            throw dbErr;
        }
    } catch (err) {
        logger.error('reviews_create_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to submit review.' });
    }
});

// --- UPDATE REVIEW (owner only) ---
router.put('/:id', authenticate, [
    param('id').isInt(),
    body('rating').optional().isInt({ min: 1, max: 5 }),
    body('title').optional().trim().isLength({ max: 150 }),
    body('comment').optional().trim().isLength({ max: 5000 })
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

        const [[existing]] = await pool.execute(
            'SELECT user_id FROM reviews WHERE id = ?',
            [req.params.id]
        );
        if (!existing) return res.status(404).json({ error: 'Review not found.' });
        if (existing.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not allowed to edit this review.' });
        }

        const { rating, title, comment } = req.body;
        await pool.execute(
            `UPDATE reviews SET
                rating  = COALESCE(?, rating),
                title   = COALESCE(?, title),
                comment = COALESCE(?, comment)
             WHERE id = ?`,
            [rating ?? null, title || null, comment || null, req.params.id]
        );

        res.json({ message: 'Review updated.' });
    } catch (err) {
        logger.error('reviews_update_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to update review.' });
    }
});

// --- DELETE REVIEW (owner or admin) ---
router.delete('/:id', authenticate, async (req, res) => {
    try {
        const [[existing]] = await pool.execute(
            'SELECT user_id FROM reviews WHERE id = ?',
            [req.params.id]
        );
        if (!existing) return res.status(404).json({ error: 'Review not found.' });
        if (existing.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not allowed to delete this review.' });
        }

        await pool.execute('DELETE FROM reviews WHERE id = ?', [req.params.id]);
        res.json({ message: 'Review deleted.' });
    } catch (err) {
        logger.error('reviews_delete_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to delete review.' });
    }
});

// --- ADMIN: hide/unhide a review ---
router.put('/:id/hide', authenticate, async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin only.' });
        }
        const hidden = !!req.body.is_hidden;
        const [result] = await pool.execute(
            'UPDATE reviews SET is_hidden = ? WHERE id = ?',
            [hidden, req.params.id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Review not found.' });
        res.json({ message: hidden ? 'Review hidden.' : 'Review shown.' });
    } catch (err) {
        logger.error('reviews_hide_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to update review visibility.' });
    }
});

module.exports = router;
