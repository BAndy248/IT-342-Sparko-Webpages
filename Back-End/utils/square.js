/**
 * Square API client.
 *
 * Centralized so:
 *   - The SDK is initialized once at module load (cheap reuse across requests).
 *   - The rest of the app doesn't need to know whether we're hitting sandbox or
 *     production — that's controlled by SQUARE_ENVIRONMENT.
 *   - If SQUARE_ACCESS_TOKEN is missing (local dev without keys), the client
 *     falls back to a stub mode that simulates a successful payment so the
 *     full checkout flow can still be exercised.
 */

const crypto = require('crypto');
const { logger } = require('./logger');

let client = null;
let stubMode = false;

function init() {
    if (client !== null || stubMode) return;

    const token = process.env.SQUARE_ACCESS_TOKEN;
    if (!token) {
        logger.warn('square_no_token_using_stub', {
            note: 'SQUARE_ACCESS_TOKEN is not set; running in stub mode.'
        });
        stubMode = true;
        return;
    }

    try {
        const { Client, Environment } = require('square');
        const env = process.env.SQUARE_ENVIRONMENT === 'production'
            ? Environment.Production
            : Environment.Sandbox;

        client = new Client({
            accessToken: token,
            environment: env
        });
        logger.info('square_client_initialized', { environment: env });
    } catch (e) {
        // SDK not installed locally — fall back to stub so the rest of the
        // app still runs in dev.
        logger.warn('square_sdk_missing_using_stub', { error: e.message });
        stubMode = true;
    }
}

/**
 * Charge a Square `sourceId` (a payment nonce produced by the Square Web
 * Payments SDK on the frontend) for the given amount in USD.
 *
 * In stub mode (no token / no SDK), returns a fake successful payment so
 * the rest of the checkout pipeline can be tested locally.
 *
 * @param {object}  params
 * @param {string}  params.sourceId       Payment nonce from Square JS SDK
 * @param {number}  params.amountUsd      Amount in dollars, e.g. 12.99
 * @param {number}  params.orderId        Our internal order id (for idempotency + note)
 * @param {string}  params.idempotencyKey Optional override; one is generated otherwise
 * @returns {Promise<{ paymentId: string, status: string, raw: object }>}
 */
async function createPayment({ sourceId, amountUsd, orderId, idempotencyKey }) {
    init();

    const locationId = process.env.SQUARE_LOCATION_ID;
    const amountCents = Math.round(amountUsd * 100);
    const key = idempotencyKey || crypto.randomUUID();

    if (stubMode) {
        // Stub: pretend the charge succeeded. Tagged so we can tell stub
        // payments apart in the DB.
        return {
            paymentId: `stub_${crypto.randomBytes(8).toString('hex')}`,
            status:    'COMPLETED',
            raw:       { stub: true, amountCents, orderId, sourceId, idempotencyKey: key }
        };
    }

    try {
        const { result } = await client.paymentsApi.createPayment({
            sourceId,
            idempotencyKey: key,
            amountMoney: {
                amount: BigInt(amountCents),
                currency: 'USD'
            },
            locationId,
            note: `Sparko order #${orderId}`,
            autocomplete: true
        });

        return {
            paymentId: result.payment.id,
            status:    result.payment.status,
            raw:       JSON.parse(JSON.stringify(result.payment, (k, v) => typeof v === 'bigint' ? v.toString() : v))
        };
    } catch (err) {
        // Surface only the user-safe message; full error stays in logs.
        const detail =
            err && err.result && err.result.errors && err.result.errors[0]
                ? err.result.errors[0].detail
                : err.message;
        logger.error('square_payment_failed', { orderId, error: detail });
        const e = new Error('Payment failed: ' + detail);
        e.squareError = true;
        throw e;
    }
}

module.exports = { createPayment };
