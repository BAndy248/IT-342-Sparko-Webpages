const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// Public route — no authentication required
router.get('/', async (req, res) => {
    try {
        const category = req.query.category;
        let query = 'SELECT * FROM products WHERE is_available = TRUE';
        const params = [];

        if (category) {
            query += ' AND category = ?';
            params.push(category);
        }

        query += ' ORDER BY category, name';
        const [products] = await pool.execute(query, params);
        res.json({ products });
    } catch (err) {
        console.error('Get products error:', err.message);
        res.status(500).json({ error: 'Failed to fetch products.' });
    }
});

router.get('/:id', async (req, res) => {
    try {
        const [products] = await pool.execute(
            'SELECT * FROM products WHERE id = ? AND is_available = TRUE',
            [req.params.id]
        );
        if (products.length === 0) {
            return res.status(404).json({ error: 'Product not found.' });
        }
        res.json({ product: products[0] });
    } catch (err) {
        console.error('Get product error:', err.message);
        res.status(500).json({ error: 'Failed to fetch product.' });
    }
});

module.exports = router;
