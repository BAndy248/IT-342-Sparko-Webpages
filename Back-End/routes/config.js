const express = require('express');
const router = express.Router();

/**
 * Public client config.
 *
 * The frontend needs to know:
 *   - Square's publishable application id (NOT the access token — that's secret)
 *   - Square's location id
 *   - Whether we're in sandbox or production (drives which SDK URL to load)
 *
 * None of these are sensitive. Exposing them here lets the frontend stay
 * pristine HTML/JS without baked-in credentials and lets us rotate the
 * Square app id by simply updating Secrets Manager + restarting the API.
 */
router.get('/', (req, res) => {
    res.json({
        square: {
            applicationId: process.env.SQUARE_APP_ID || '',
            locationId:    process.env.SQUARE_LOCATION_ID || '',
            environment:   process.env.SQUARE_ENVIRONMENT || 'sandbox'
        }
    });
});

module.exports = router;
