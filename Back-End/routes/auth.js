const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const pool = require('../config/db');
const { jwtSecret, jwtExpiresIn, resetTokenExpiresHours } = require('../config/auth');
const { authLimiter } = require('../middleware/rateLimiter');
const { authenticate } = require('../middleware/auth');
const passwordUtil = require('../utils/password');

// Apply stricter rate limiting to all auth routes
router.use(authLimiter);

// --- REGISTER ---
router.post('/register', [
    body('username').trim().isLength({ min: 3, max: 50 }).withMessage('Username must be 3-50 characters'),
    body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
    body('password')
        .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
        .matches(/[A-Z]/).withMessage('Password must contain an uppercase letter')
        .matches(/[0-9]/).withMessage('Password must contain a number')
        .matches(/[!@#$%^&*]/).withMessage('Password must contain a special character'),
    body('first_name').optional().trim().isLength({ max: 100 }),
    body('last_name').optional().trim().isLength({ max: 100 })
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { username, email, password, first_name, last_name } = req.body;

        // Check if user already exists — parameterized query prevents SQL injection
        const [existing] = await pool.execute(
            'SELECT id FROM users WHERE username = ? OR email = ?',
            [username, email]
        );
        if (existing.length > 0) {
            return res.status(409).json({ error: 'Username or email already registered.' });
        }

        // Hash password with PBKDF2-HMAC-SHA512 (FIPS 140-2/3 approved)
        // Salt is generated inside the utility and embedded in the returned string
        const passwordHash = await passwordUtil.hash(password);

        // Insert new user — parameterized query prevents SQL injection
        const [result] = await pool.execute(
            'INSERT INTO users (username, email, password_hash, first_name, last_name) VALUES (?, ?, ?, ?, ?)',
            [username, email, passwordHash, first_name || null, last_name || null]
        );

        const token = jwt.sign(
            { id: result.insertId, username, role: 'user' },
            jwtSecret,
            { expiresIn: jwtExpiresIn }
        );

        res.status(201).json({
            message: 'Registration successful.',
            token,
            user: { id: result.insertId, username, email, role: 'user' }
        });
    } catch (err) {
        console.error('Register error:', err.message);
        res.status(500).json({ error: 'Registration failed.' });
    }
});

// --- LOGIN ---
router.post('/login', [
    body('username').trim().notEmpty().withMessage('Username is required'),
    body('password').notEmpty().withMessage('Password is required')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { username, password } = req.body;

        // Parameterized query prevents SQL injection
        const [users] = await pool.execute(
            'SELECT * FROM users WHERE username = ? AND is_active = TRUE',
            [username]
        );

        if (users.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials.' });
        }

        const user = users[0];

        // Constant-time comparison via PBKDF2 verify
        const validPassword = await passwordUtil.verify(password, user.password_hash);
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials.' });
        }

        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role },
            jwtSecret,
            { expiresIn: jwtExpiresIn }
        );

        res.json({
            message: 'Login successful.',
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                first_name: user.first_name,
                last_name: user.last_name,
                role: user.role
            }
        });
    } catch (err) {
        console.error('Login error:', err.message);
        res.status(500).json({ error: 'Login failed.' });
    }
});

// --- FORGOT PASSWORD ---
router.post('/forgot-password', [
    body('email').isEmail().normalizeEmail().withMessage('Valid email is required')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { email } = req.body;

        const [users] = await pool.execute(
            'SELECT id FROM users WHERE email = ? AND is_active = TRUE',
            [email]
        );

        // Always return success to prevent email enumeration
        if (users.length === 0) {
            return res.json({ message: 'If that email exists, a reset link has been sent.' });
        }

        // Generate secure random token
        const resetToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + resetTokenExpiresHours * 60 * 60 * 1000);

        // Invalidate any existing tokens for this user
        await pool.execute(
            'UPDATE password_reset_tokens SET used = TRUE WHERE user_id = ? AND used = FALSE',
            [users[0].id]
        );

        // Store hashed token (so DB compromise doesn't leak reset tokens)
        const tokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
        await pool.execute(
            'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
            [users[0].id, tokenHash, expiresAt]
        );

        // In production, send email with reset link containing resetToken
        // For development, return the token directly
        if (process.env.NODE_ENV === 'development') {
            return res.json({
                message: 'Reset token generated (dev mode).',
                resetToken,
                expiresAt
            });
        }

        res.json({ message: 'If that email exists, a reset link has been sent.' });
    } catch (err) {
        console.error('Forgot password error:', err.message);
        res.status(500).json({ error: 'Password reset request failed.' });
    }
});

// --- RESET PASSWORD ---
router.post('/reset-password', [
    body('token').notEmpty().withMessage('Reset token is required'),
    body('password')
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

        const { token, password } = req.body;

        // Hash the provided token to compare with stored hash
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

        const [tokens] = await pool.execute(
            'SELECT * FROM password_reset_tokens WHERE token = ? AND used = FALSE AND expires_at > NOW()',
            [tokenHash]
        );

        if (tokens.length === 0) {
            return res.status(400).json({ error: 'Invalid or expired reset token.' });
        }

        const resetRecord = tokens[0];
        const passwordHash = await passwordUtil.hash(password);

        // Update password and mark token as used — both in a transaction
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();
            await connection.execute(
                'UPDATE users SET password_hash = ? WHERE id = ?',
                [passwordHash, resetRecord.user_id]
            );
            await connection.execute(
                'UPDATE password_reset_tokens SET used = TRUE WHERE id = ?',
                [resetRecord.id]
            );
            await connection.commit();
        } catch (txErr) {
            await connection.rollback();
            throw txErr;
        } finally {
            connection.release();
        }

        res.json({ message: 'Password has been reset successfully.' });
    } catch (err) {
        console.error('Reset password error:', err.message);
        res.status(500).json({ error: 'Password reset failed.' });
    }
});

// --- GET CURRENT USER (for session validation) ---
router.get('/me', authenticate, async (req, res) => {
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
        console.error('Get user error:', err.message);
        res.status(500).json({ error: 'Failed to fetch user.' });
    }
});

module.exports = router;
