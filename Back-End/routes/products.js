const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { logger } = require('../utils/logger');

// Public route — no authentication required.
// Supports filtering by category and free-text search over name/description.
router.get('/', async (req, res) => {
    try {
        const category = req.query.category;
        const search = req.query.search;

        // Pagination so the products listing scales as the catalog grows.
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
        const offset = (page - 1) * limit;

        // Sort whitelist (prevents SQL injection via ORDER BY).
        const sortMap = {
            'name':       'name ASC',
            'price_asc':  'price ASC',
            'price_desc': 'price DESC',
            'newest':     'created_at DESC',
            'rating':     'avg_rating DESC'
        };
        const sortClause = sortMap[req.query.sort] || 'category, name';

        // LEFT JOIN against an aggregate review subquery so each product
        // returns avg_rating + review_count without an extra round trip.
        let query = `
            SELECT p.*,
                   COALESCE(r.avg_rating, 0)   AS avg_rating,
                   COALESCE(r.review_count, 0) AS review_count
            FROM products p
            LEFT JOIN (
                SELECT product_id,
                       AVG(rating)   AS avg_rating,
                       COUNT(*)      AS review_count
                FROM reviews
                WHERE is_hidden = FALSE
                GROUP BY product_id
            ) r ON r.product_id = p.id
            WHERE p.is_available = TRUE
        `;
        const params = [];

        if (category) {
            query += ' AND p.category = ?';
            params.push(category);
        }

        if (search) {
            // Parameterized LIKE — wildcards are added to the bound parameter,
            // never concatenated into the SQL.
            query += ' AND (p.name LIKE ? OR p.description LIKE ? OR p.category LIKE ?)';
            const term = `%${search}%`;
            params.push(term, term, term);
        }

        query += ` ORDER BY ${sortClause} LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const [products] = await pool.execute(query, params);

        // Total count for pagination, with the same filters applied.
        let countQuery = 'SELECT COUNT(*) AS total FROM products WHERE is_available = TRUE';
        const countParams = [];
        if (category) { countQuery += ' AND category = ?'; countParams.push(category); }
        if (search)   {
            countQuery += ' AND (name LIKE ? OR description LIKE ? OR category LIKE ?)';
            const term = `%${search}%`;
            countParams.push(term, term, term);
        }
        const [countResult] = await pool.execute(countQuery, countParams);

        res.json({
            products,
            pagination: {
                page,
                limit,
                total: countResult[0].total,
                pages: Math.ceil(countResult[0].total / limit)
            }
        });
    } catch (err) {
        logger.error('products_list_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to fetch products.' });
    }
});

// Distinct category list — used to populate the products page filter dropdown.
router.get('/categories', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            'SELECT DISTINCT category FROM products WHERE is_available = TRUE AND category IS NOT NULL ORDER BY category'
        );
        res.json({ categories: rows.map(r => r.category) });
    } catch (err) {
        logger.error('products_categories_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to fetch categories.' });
    }
});

router.get('/:id', async (req, res) => {
    try {
        const [products] = await pool.execute(
            `SELECT p.*,
                    COALESCE(r.avg_rating, 0)   AS avg_rating,
                    COALESCE(r.review_count, 0) AS review_count
             FROM products p
             LEFT JOIN (
                 SELECT product_id, AVG(rating) AS avg_rating, COUNT(*) AS review_count
                 FROM reviews WHERE is_hidden = FALSE GROUP BY product_id
             ) r ON r.product_id = p.id
             WHERE p.id = ? AND p.is_available = TRUE`,
            [req.params.id]
        );
        if (products.length === 0) {
            return res.status(404).json({ error: 'Product not found.' });
        }
        res.json({ product: products[0] });
    } catch (err) {
        logger.error('products_get_failed', { requestId: req.requestId, error: err.message });
        res.status(500).json({ error: 'Failed to fetch product.' });
    }
});

module.exports = router;
