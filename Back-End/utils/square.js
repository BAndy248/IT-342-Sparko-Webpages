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

/**
 * Save a card on file with Square so it can be charged for subscription
 * renewals later without re-prompting the user.
 *
 * In stub mode (no SDK / token), returns a fake card ID + metadata so the
 * full flow can be tested locally.
 */
async function saveCard({ sourceId, referenceId, cardholderName }) {
    init();

    if (stubMode) {
        return {
            cardId:   `stub_card_${crypto.randomBytes(6).toString('hex')}`,
            brand:    'VISA',
            last4:    '4242',
            expMonth: 12,
            expYear:  new Date().getFullYear() + 3,
            raw:      { stub: true, sourceId, referenceId, cardholderName }
        };
    }

    try {
        // 1. Create (or reuse) a Square customer record keyed by our user id.
        const { result: customerResult } = await client.customersApi.createCustomer({
            referenceId: String(referenceId),
            givenName: cardholderName || undefined
        });
        const customerId = customerResult.customer.id;

        // 2. Tokenize the nonce into a saved card.
        const { result } = await client.cardsApi.createCard({
            idempotencyKey: crypto.randomUUID(),
            sourceId,
            card: {
                customerId,
                cardholderName: cardholderName || undefined
            }
        });

        const card = result.card;
        return {
            cardId:   card.id,
            brand:    card.cardBrand,
            last4:    card.last4,
            expMonth: Number(card.expMonth),
            expYear:  Number(card.expYear),
            raw:      JSON.parse(JSON.stringify(card, (k, v) => typeof v === 'bigint' ? v.toString() : v))
        };
    } catch (err) {
        const detail =
            err && err.result && err.result.errors && err.result.errors[0]
                ? err.result.errors[0].detail
                : err.message;
        logger.error('square_save_card_failed', { referenceId, error: detail });
        const e = new Error('Save card failed: ' + detail);
        e.squareError = true;
        throw e;
    }
}

/**
 * Charge a previously-saved Square card. Square's createPayment accepts the
 * stored card_id as the sourceId directly.
 */
async function chargeSavedCard({ cardId, amountUsd, orderId }) {
    return createPayment({ sourceId: cardId, amountUsd, orderId });
}

module.exports = { createPayment, saveCard, chargeSavedCard };
