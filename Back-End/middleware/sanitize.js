// XSS protection: sanitize all string inputs by escaping HTML entities
function sanitizeInput(req, res, next) {
    if (req.body) {
        sanitizeObject(req.body);
    }
    if (req.query) {
        sanitizeObject(req.query);
    }
    if (req.params) {
        sanitizeObject(req.params);
    }
    next();
}

function sanitizeObject(obj) {
    for (const key of Object.keys(obj)) {
        if (typeof obj[key] === 'string') {
            obj[key] = escapeHtml(obj[key]);
        } else if (typeof obj[key] === 'object' && obj[key] !== null) {
            sanitizeObject(obj[key]);
        }
    }
}

function escapeHtml(str) {
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#x27;',
        '/': '&#x2F;'
    };
    return str.replace(/[&<>"'/]/g, char => map[char]);
}

module.exports = { sanitizeInput };
