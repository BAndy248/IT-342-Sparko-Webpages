require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const { apiLimiter } = require('./middleware/rateLimiter');
const { sanitizeInput } = require('./middleware/sanitize');
const { logger, requestLogger } = require('./utils/logger');
const { loadSecrets } = require('./utils/secrets');

// --- Load secrets from AWS Secrets Manager BEFORE validating env ---
// This async IIFE keeps startup linear: secrets first, then env validation,
// then app boot. On EC2 the env vars come from Secrets Manager; locally the
// loader no-ops and we rely on the .env file already populated by dotenv.
(async function start() {
    try {
        await loadSecrets();
    } catch (err) {
        logger.error('startup_secrets_failed', { error: err.message });
        process.exit(1);
    }

    // --- Validate required environment variables at startup ---
    const required = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'JWT_SECRET'];
    const missing = required.filter(key => !process.env[key]);
    if (missing.length > 0) {
        logger.error('startup_missing_env', { missing });
        console.error('Missing required environment variables:', missing.join(', '));
        console.error('Copy .env.example to .env and fill in values.');
        process.exit(1);
    }

    bootServer();
})();

function bootServer() {

const app = express();

// --- Trust the AWS Application Load Balancer ---
// Required so req.ip, rate limiting, and protocol detection work behind ALB.
// 'loopback, linklocal, uniquelocal' covers the typical VPC subnet ranges
// where the ALB lives without trusting arbitrary X-Forwarded-For headers.
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal');

// --- Request logger (assigns request IDs, logs every request to CloudWatch) ---
app.use(requestLogger);

// --- Security middleware ---
// HSTS tells browsers "only use HTTPS for this host from now on". If the site
// is served over plain HTTP (no domain / no ACM cert), sending HSTS can cause
// browsers that previously cached the header to refuse future HTTP requests.
// Disable it explicitly when ENABLE_HSTS is not 'true' — the default mode.
// Set ENABLE_HSTS=true in .env once you front the ALB with HTTPS.
app.use(helmet({
    hsts: process.env.ENABLE_HSTS === 'true' ? undefined : false
}));
app.use(cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5500',
    credentials: true
}));
app.use(express.json({ limit: '10kb' }));
app.use(sanitizeInput);
app.use('/api', apiLimiter);

// --- Health check endpoints for ALB target group ---
// /healthz: liveness — process is up. Used as ALB target group health check.
// /readyz:  readiness — process can serve traffic (DB reachable).
//   When the ALB sees /readyz returning non-2xx, it drains the instance
//   so requests are routed to healthy peers (redundancy).
app.get('/healthz', (req, res) => {
    res.status(200).json({ status: 'ok', instanceId: process.env.INSTANCE_ID || require('os').hostname() });
});

app.get('/readyz', async (req, res) => {
    try {
        const pool = require('./config/db');
        await pool.query('SELECT 1');
        res.status(200).json({ status: 'ready' });
    } catch (err) {
        logger.warn('readiness_check_failed', { error: err.message });
        res.status(503).json({ status: 'not_ready', error: 'database_unreachable' });
    }
});

// --- Serve frontend static files ---
app.use(express.static(path.join(__dirname, '..', 'Front-End')));

// --- API Routes ---
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/subscriptions', require('./routes/subscriptions'));
app.use('/api/products', require('./routes/products'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/reviews', require('./routes/reviews'));
app.use('/api/cart', require('./routes/cart'));
app.use('/api/rewards', require('./routes/rewards'));
app.use('/api/checkout', require('./routes/checkout'));
app.use('/api/payment-methods', require('./routes/payment-methods'));
app.use('/api/config', require('./routes/config'));

// --- 404 fallback ---
// Unknown /api/* paths return a JSON 404 instead of dumping the HTML page.
// Unknown non-API paths get the friendly Front-End/404.html.
app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Not found.', path: req.originalUrl });
});

app.get('*', (req, res) => {
    res.status(404).sendFile(path.join(__dirname, '..', 'Front-End', '404.html'));
});

// --- Global error handler ---
app.use((err, req, res, next) => {
    logger.error('unhandled_error', {
        requestId: req.requestId,
        error: err.message,
        stack: err.stack,
        path: req.originalUrl
    });
    res.status(500).json({ error: 'Internal server error.' });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
    logger.info('server_started', { port: PORT, environment: process.env.NODE_ENV || 'development' });
    console.log(`Sparko API running on port ${PORT}`);
});

// --- Graceful shutdown for ALB deregistration ---
// When the ALB takes this instance out of rotation (deploy, scale-in, instance
// replacement), AWS sends SIGTERM. Finish in-flight requests, then exit.
function shutdown(signal) {
    logger.info('shutdown_initiated', { signal });
    server.close(err => {
        if (err) {
            logger.error('shutdown_error', { error: err.message });
            process.exit(1);
        }
        logger.info('shutdown_complete');
        process.exit(0);
    });
    // Hard exit if we haven't shut down within ALB's deregistration_delay.
    setTimeout(() => {
        logger.warn('shutdown_forced');
        process.exit(1);
    }, 30000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('uncaughtException', err => {
    logger.error('uncaught_exception', { error: err.message, stack: err.stack });
});
process.on('unhandledRejection', reason => {
    logger.error('unhandled_rejection', { reason: reason && reason.message ? reason.message : String(reason) });
});

} // end bootServer()
