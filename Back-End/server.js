require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const { apiLimiter } = require('./middleware/rateLimiter');
const { sanitizeInput } = require('./middleware/sanitize');

// --- Validate required environment variables at startup ---
const required = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'JWT_SECRET'];
const missing = required.filter(key => !process.env[key]);
if (missing.length > 0) {
    console.error('Missing required environment variables:', missing.join(', '));
    console.error('Copy .env.example to .env and fill in values.');
    process.exit(1);
}

const app = express();

// --- Security middleware ---
app.use(helmet());                                        // Secure HTTP headers
app.use(cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5500',
    credentials: true
}));
app.use(express.json({ limit: '10kb' }));                 // Body parser with size limit
app.use(sanitizeInput);                                    // XSS protection on all inputs
app.use('/api', apiLimiter);                               // Rate limiting on all API routes

// --- Serve frontend static files ---
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// --- API Routes ---
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/subscriptions', require('./routes/subscriptions'));
app.use('/api/products', require('./routes/products'));
app.use('/api/admin', require('./routes/admin'));

// --- SPA fallback: serve index.html for non-API routes ---
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

// --- Global error handler ---
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Sparko API running on port ${PORT}`);
});
