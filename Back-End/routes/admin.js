const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const pool = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { logger } = require('../utils/logger');

// All admin routes require authentication + admin role
// This prevents forceful browsing — users cannot access admin endpoints
router.use(authenticate);
router.use(authorize('admin'));

// --- DASHBOARD STATS ---
router.get('/stats', async (req, res) => {
    try {
        const [userCount] = await pool.execute('SELECT COUNT(*) as count FROM users');
        const [activeSubCount] = await pool.execute("SELECT COUNT(*) as count FROM subscriptions WHERE status = 'active'");
        const [orderCount] = await pool.execute('SELECT COUNT(*) as count FROM orders');
        const [pendingOrders] = await pool.execute("SELECT COUNT(*) as count FROM orders WHERE status = 'pending'");
        const [revenue] = await pool.execute("SELECT COALESCE(SUM(total), 0) as total FROM orders WHERE status != 'cancelled'");

        res.json({
            stats: {
                total_users: userCount[0].count,
                active_subscriptions: activeSubCount[0].count,
                total_orders: orderCount[0].count,
                pending_orders: pendingOrders[0].count,
                total_revenue: revenue[0].total
            }
        });
    } catch (err) {
        logger.error('admin_stats_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to fetch stats.' });
    }
});

// --- USER MANAGEMENT ---

// List all users
router.get('/users', async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const offset = (page - 1) * limit;
        const search = req.query.search;

        let query = 'SELECT id, username, email, first_name, last_name, phone, role, is_active, created_at FROM users';
        const params = [];

        if (search) {
            query += ' WHERE username LIKE ? OR email LIKE ? OR first_name LIKE ? OR last_name LIKE ?';
            const searchTerm = `%${search}%`;
            params.push(searchTerm, searchTerm, searchTerm, searchTerm);
        }

        query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);

        const [users] = await pool.execute(query, params);

        const countQuery = search
            ? 'SELECT COUNT(*) as total FROM users WHERE username LIKE ? OR email LIKE ? OR first_name LIKE ? OR last_name LIKE ?'
            : 'SELECT COUNT(*) as total FROM users';
        const countParams = search
            ? [`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`]
            : [];
        const [countResult] = await pool.execute(countQuery, countParams);

        res.json({
            users,
            pagination: {
                page,
                limit,
                total: countResult[0].total,
                pages: Math.ceil(countResult[0].total / limit)
            }
        });
    } catch (err) {
        logger.error('admin_list_users_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to fetch users.' });
    }
});

// Update user role
router.put('/users/:id/role', [
    body('role').isIn(['user', 'admin']).withMessage('Invalid role')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        // Prevent admin from changing their own role
        if (parseInt(req.params.id) === req.user.id) {
            return res.status(400).json({ error: 'Cannot change your own role.' });
        }

        const [result] = await pool.execute(
            'UPDATE users SET role = ? WHERE id = ?',
            [req.body.role, req.params.id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'User not found.' });
        }

        res.json({ message: 'User role updated.' });
    } catch (err) {
        logger.error('admin_update_role_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to update role.' });
    }
});

// Activate/deactivate user
router.put('/users/:id/status', [
    body('is_active').isBoolean().withMessage('is_active must be boolean')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        if (parseInt(req.params.id) === req.user.id) {
            return res.status(400).json({ error: 'Cannot deactivate your own account.' });
        }

        const [result] = await pool.execute(
            'UPDATE users SET is_active = ? WHERE id = ?',
            [req.body.is_active, req.params.id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'User not found.' });
        }

        res.json({ message: `User ${req.body.is_active ? 'activated' : 'deactivated'}.` });
    } catch (err) {
        logger.error('admin_update_user_status_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to update user status.' });
    }
});

// --- ORDER MANAGEMENT ---

// List all orders
router.get('/orders', async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const offset = (page - 1) * limit;
        const status = req.query.status;

        let query = `
            SELECT o.*, u.username, u.email, a.street, a.city, a.state, a.zip_code
            FROM orders o
            JOIN users u ON o.user_id = u.id
            LEFT JOIN addresses a ON o.address_id = a.id
        `;
        const params = [];

        if (status) {
            query += ' WHERE o.status = ?';
            params.push(status);
        }

        query += ' ORDER BY o.created_at DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);

        const [orders] = await pool.execute(query, params);

        const countQuery = status
            ? "SELECT COUNT(*) as total FROM orders WHERE status = ?"
            : 'SELECT COUNT(*) as total FROM orders';
        const [countResult] = await pool.execute(countQuery, status ? [status] : []);

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
        logger.error('admin_list_orders_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to fetch orders.' });
    }
});

// Update order status
router.put('/orders/:id/status', [
    body('status').isIn(['pending', 'confirmed', 'out_for_delivery', 'delivered', 'cancelled'])
        .withMessage('Invalid status')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const [result] = await pool.execute(
            'UPDATE orders SET status = ? WHERE id = ?',
            [req.body.status, req.params.id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Order not found.' });
        }

        res.json({ message: 'Order status updated.' });
    } catch (err) {
        logger.error('admin_update_order_status_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to update order status.' });
    }
});

// --- PRODUCT MANAGEMENT ---

// Add product
router.post('/products', [
    body('name').trim().notEmpty().withMessage('Product name is required'),
    body('price').isFloat({ min: 0.01 }).withMessage('Valid price is required'),
    body('size').optional().trim(),
    body('category').optional().trim(),
    body('description').optional().trim()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { name, description, price, size, category } = req.body;
        const [result] = await pool.execute(
            'INSERT INTO products (name, description, price, size, category) VALUES (?, ?, ?, ?, ?)',
            [name, description || null, price, size || null, category || null]
        );

        res.status(201).json({ message: 'Product added.', id: result.insertId });
    } catch (err) {
        logger.error('admin_add_product_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to add product.' });
    }
});

// Update product
router.put('/products/:id', [
    body('name').optional().trim().notEmpty(),
    body('price').optional().isFloat({ min: 0.01 }),
    body('is_available').optional().isBoolean()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { name, description, price, size, category, is_available } = req.body;
        const [result] = await pool.execute(
            `UPDATE products SET
                name = COALESCE(?, name),
                description = COALESCE(?, description),
                price = COALESCE(?, price),
                size = COALESCE(?, size),
                category = COALESCE(?, category),
                is_available = COALESCE(?, is_available)
            WHERE id = ?`,
            [name || null, description || null, price || null, size || null, category || null, is_available ?? null, req.params.id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Product not found.' });
        }

        res.json({ message: 'Product updated.' });
    } catch (err) {
        logger.error('admin_update_product_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to update product.' });
    }
});

module.exports = router;
