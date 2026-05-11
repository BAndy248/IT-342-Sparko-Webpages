const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { logger } = require('../utils/logger');
const rewards = require('../utils/rewards');

// All rewards routes require login.
router.use(authenticate);

// --- GET CURRENT USER'S POINTS BALANCE + TIER ---
router.get('/me', async (req, res) => {
    try {
        const conn = await pool.getConnection();
        try {
            const row = await rewards.ensureRow(conn, req.user.id);
            res.json({
                rewards: {
                    points_balance:    row.points_balance,
                    lifetime_points:   row.lifetime_points,
                    tier:              row.tier,
                    redeem_value_usd:  rewards.redeemValue(row.points_balance),
                    points_per_dollar: rewards.POINTS_PER_DOLLAR,
                    redeem_ratio:      rewards.POINTS_PER_DOLLAR_REDEEM
                }
            });
        } finally {
            conn.release();
        }
    } catch (err) {
        logger.error('rewards_me_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to load rewards.' });
    }
});

// --- REWARDS HISTORY (paginated) ---
router.get('/history', async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const offset = (page - 1) * limit;

        const [history] = await pool.execute(
            `SELECT id, points, type, reason, reference_type, reference_id, created_at
             FROM reward_history
             WHERE user_id = ?
             ORDER BY created_at DESC
             LIMIT ? OFFSET ?`,
            [req.user.id, limit, offset]
        );

        const [[countResult]] = await pool.execute(
            'SELECT COUNT(*) AS total FROM reward_history WHERE user_id = ?',
            [req.user.id]
        );

        res.json({
            history,
            pagination: {
                page, limit,
                total: countResult.total,
                pages: Math.ceil(countResult.total / limit)
            }
        });
    } catch (err) {
        logger.error('rewards_history_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to load history.' });
    }
});

// --- ACTIVE BUNDLE REWARDS (public-ish — gated to authed users) ---
// Listed on the Rewards page so users can see what they can earn.
router.get('/bundles', async (req, res) => {
    try {
        const [bundles] = await pool.execute(
            `SELECT id, name, description, min_items, category, discount_percent,
                    starts_at, ends_at, is_active
             FROM bundle_rewards
             WHERE is_active = TRUE
               AND (starts_at IS NULL OR starts_at <= NOW())
               AND (ends_at   IS NULL OR ends_at   >= NOW())
             ORDER BY discount_percent DESC`
        );
        res.json({ bundles });
    } catch (err) {
        logger.error('rewards_bundles_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to load bundles.' });
    }
});

// --- ADMIN: list ALL bundles (incl. inactive) ---
router.get('/admin/bundles', authorize('admin'), async (req, res) => {
    try {
        const [bundles] = await pool.execute(
            'SELECT * FROM bundle_rewards ORDER BY is_active DESC, discount_percent DESC'
        );
        res.json({ bundles });
    } catch (err) {
        logger.error('rewards_admin_bundles_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to load bundles.' });
    }
});

// --- ADMIN: create bundle ---
router.post('/admin/bundles', authorize('admin'), async (req, res) => {
    try {
        const { name, description, min_items, category, discount_percent, starts_at, ends_at, is_active } = req.body;
        if (!name || !min_items || discount_percent === undefined) {
            return res.status(400).json({ error: 'name, min_items, and discount_percent are required.' });
        }
        const [result] = await pool.execute(
            `INSERT INTO bundle_rewards (name, description, min_items, category, discount_percent, starts_at, ends_at, is_active)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                name,
                description || null,
                parseInt(min_items, 10),
                category || null,
                parseFloat(discount_percent),
                starts_at || null,
                ends_at || null,
                is_active === undefined ? true : !!is_active
            ]
        );
        res.status(201).json({ message: 'Bundle created.', id: result.insertId });
    } catch (err) {
        logger.error('rewards_admin_create_bundle_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to create bundle.' });
    }
});

// --- ADMIN: update bundle ---
router.put('/admin/bundles/:id', authorize('admin'), async (req, res) => {
    try {
        const { name, description, min_items, category, discount_percent, starts_at, ends_at, is_active } = req.body;
        const [result] = await pool.execute(
            `UPDATE bundle_rewards SET
                name             = COALESCE(?, name),
                description      = COALESCE(?, description),
                min_items        = COALESCE(?, min_items),
                category         = COALESCE(?, category),
                discount_percent = COALESCE(?, discount_percent),
                starts_at        = COALESCE(?, starts_at),
                ends_at          = COALESCE(?, ends_at),
                is_active        = COALESCE(?, is_active)
             WHERE id = ?`,
            [
                name || null,
                description || null,
                min_items === undefined ? null : parseInt(min_items, 10),
                category || null,
                discount_percent === undefined ? null : parseFloat(discount_percent),
                starts_at || null,
                ends_at || null,
                is_active === undefined ? null : !!is_active,
                req.params.id
            ]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Bundle not found.' });
        res.json({ message: 'Bundle updated.' });
    } catch (err) {
        logger.error('rewards_admin_update_bundle_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to update bundle.' });
    }
});

// --- ADMIN: delete bundle ---
router.delete('/admin/bundles/:id', authorize('admin'), async (req, res) => {
    try {
        const [result] = await pool.execute('DELETE FROM bundle_rewards WHERE id = ?', [req.params.id]);
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Bundle not found.' });
        res.json({ message: 'Bundle deleted.' });
    } catch (err) {
        logger.error('rewards_admin_delete_bundle_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to delete bundle.' });
    }
});

module.exports = router;
