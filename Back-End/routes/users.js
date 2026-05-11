const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
const passwordUtil = require('../utils/password');
const { logger } = require('../utils/logger');

// All user routes require authentication
router.use(authenticate);

// --- GET PROFILE ---
router.get('/profile', async (req, res) => {
    try {
        const [users] = await pool.execute(
            'SELECT id, username, email, first_name, last_name, phone, role, created_at FROM users WHERE id = ?',
            [req.user.id]
        );
        if (users.length === 0) {
            return res.status(404).json({ error: 'User not found.' });
        }
        res.json({ user: users[0] });
    } catch (err) {
        logger.error('users_get_profile_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to fetch profile.' });
    }
});

// --- UPDATE PROFILE ---
router.put('/profile', [
    body('first_name').optional().trim().isLength({ max: 100 }),
    body('last_name').optional().trim().isLength({ max: 100 }),
    body('phone').optional().trim().isLength({ max: 20 }),
    body('email').optional().isEmail().normalizeEmail()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { first_name, last_name, phone, email } = req.body;

        // Check email uniqueness if changing
        if (email) {
            const [existing] = await pool.execute(
                'SELECT id FROM users WHERE email = ? AND id != ?',
                [email, req.user.id]
            );
            if (existing.length > 0) {
                return res.status(409).json({ error: 'Email already in use.' });
            }
        }

        await pool.execute(
            `UPDATE users SET
                first_name = COALESCE(?, first_name),
                last_name = COALESCE(?, last_name),
                phone = COALESCE(?, phone),
                email = COALESCE(?, email)
            WHERE id = ?`,
            [first_name || null, last_name || null, phone || null, email || null, req.user.id]
        );

        res.json({ message: 'Profile updated successfully.' });
    } catch (err) {
        logger.error('users_update_profile_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to update profile.' });
    }
});

// --- CHANGE PASSWORD ---
router.put('/change-password', [
    body('current_password').notEmpty().withMessage('Current password is required'),
    body('new_password')
        .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
        .matches(/[A-Z]/).withMessage('Password must contain an uppercase letter')
        .matches(/[0-9]/).withMessage('Password must contain a number')
        .matches(/[!@#$%^&*]/).withMessage('Password must contain a special character')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { current_password, new_password } = req.body;

        const [users] = await pool.execute(
            'SELECT password_hash FROM users WHERE id = ?',
            [req.user.id]
        );

        const valid = await passwordUtil.verify(current_password, users[0].password_hash);
        if (!valid) {
            return res.status(401).json({ error: 'Current password is incorrect.' });
        }

        const newHash = await passwordUtil.hash(new_password);
        await pool.execute(
            'UPDATE users SET password_hash = ? WHERE id = ?',
            [newHash, req.user.id]
        );

        res.json({ message: 'Password changed successfully.' });
    } catch (err) {
        logger.error('users_change_password_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to change password.' });
    }
});

// --- ADDRESS MANAGEMENT ---

// Get all addresses
router.get('/addresses', async (req, res) => {
    try {
        const [addresses] = await pool.execute(
            'SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, created_at DESC',
            [req.user.id]
        );
        res.json({ addresses });
    } catch (err) {
        logger.error('users_get_addresses_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to fetch addresses.' });
    }
});

// Add address
router.post('/addresses', [
    body('street').trim().notEmpty().withMessage('Street is required'),
    body('city').trim().notEmpty().withMessage('City is required'),
    body('state').trim().notEmpty().withMessage('State is required'),
    body('zip_code').trim().matches(/^\d{5}(-\d{4})?$/).withMessage('Valid ZIP code is required'),
    body('is_default').optional().isBoolean()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { street, city, state, zip_code, is_default } = req.body;

        // If setting as default, unset other defaults
        if (is_default) {
            await pool.execute(
                'UPDATE addresses SET is_default = FALSE WHERE user_id = ?',
                [req.user.id]
            );
        }

        const [result] = await pool.execute(
            'INSERT INTO addresses (user_id, street, city, state, zip_code, is_default) VALUES (?, ?, ?, ?, ?, ?)',
            [req.user.id, street, city, state, zip_code, is_default || false]
        );

        res.status(201).json({ message: 'Address added.', id: result.insertId });
    } catch (err) {
        logger.error('users_add_address_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to add address.' });
    }
});

// Delete address (only own addresses)
router.delete('/addresses/:id', async (req, res) => {
    try {
        const [result] = await pool.execute(
            'DELETE FROM addresses WHERE id = ? AND user_id = ?',
            [req.params.id, req.user.id]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Address not found.' });
        }
        res.json({ message: 'Address deleted.' });
    } catch (err) {
        logger.error('users_delete_address_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to delete address.' });
    }
});

module.exports = router;
