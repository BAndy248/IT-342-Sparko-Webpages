const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/auth');

// Verify JWT token - protects routes from unauthenticated access
function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Access denied. No token provided.' });
    }

    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, jwtSecret);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token.' });
    }
}

// Role-based access control - prevents forceful browsing to admin routes
function authorize(...allowedRoles) {
    return (req, res, next) => {
        if (!req.user || !allowedRoles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Forbidden. Insufficient permissions.' });
        }
        next();
    };
}

module.exports = { authenticate, authorize };
