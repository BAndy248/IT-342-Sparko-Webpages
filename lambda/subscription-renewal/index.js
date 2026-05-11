/**
 * Sparko subscription-renewal Lambda
 * ----------------------------------
 * Two entry modes, switched on event shape:
 *
 *   1) EventBridge "scan"   (hourly cron)
 *      - Selects subscriptions where next_delivery <= NOW() and status='active'.
 *      - Drops one SQS message per subscription onto the renewal queue.
 *
 *   2) SQS records           (consumer)
 *      - Idempotently creates the next order for each subscription:
 *          a. Inserts a new orders row + order_items mirroring subscription_items.
 *          b. Advances subscriptions.next_delivery by the frequency interval.
 *          c. Awards reward points (10 × dollars spent).
 *          d. Emails the customer via SES (if SES is configured).
 *
 * Idempotency: we use a per-subscription idempotency key derived from
 * (subscription_id, current_next_delivery_date). Re-enqueued messages either
 * find the order already exists and short-circuit, or are still safe because
 * the date-advance is conditional on the current next_delivery matching.
 */

const {
    SecretsManagerClient,
    GetSecretValueCommand
} = require('@aws-sdk/client-secrets-manager');
const {
    SQSClient,
    SendMessageCommand
} = require('@aws-sdk/client-sqs');
const {
    SESv2Client,
    SendEmailCommand
} = require('@aws-sdk/client-sesv2');
const mysql = require('mysql2/promise');

// ---------- environment ----------
const REGION         = process.env.REGION || 'us-east-1';
const DB_SECRET_ARN  = process.env.DB_SECRET_ARN;
const APP_SECRET_ARN = process.env.APP_SECRET_ARN;
const QUEUE_URL      = process.env.QUEUE_URL;
const SES_FROM       = process.env.SES_FROM;
const ENABLE_EMAIL   = process.env.ENABLE_EMAIL === '1';

// ---------- clients (created once, reused across warm invocations) ----------
const secretsClient = new SecretsManagerClient({ region: REGION });
const sqsClient     = new SQSClient({ region: REGION });
const sesClient     = new SESv2Client({ region: REGION });

let _pool = null;
async function getPool() {
    if (_pool) return _pool;
    const raw = await secretsClient.send(new GetSecretValueCommand({ SecretId: DB_SECRET_ARN }));
    const cfg = JSON.parse(raw.SecretString);
    _pool = mysql.createPool({
        host:     cfg.host,
        port:     cfg.port,
        user:     cfg.username,
        password: cfg.password,
        database: cfg.dbname,
        waitForConnections: true,
        connectionLimit: 5,
        // RDS speaks TLS but the AWS root CA isn't bundled in the Lambda
        // runtime by default — accept the cert without CA pin (still encrypted).
        ssl: { rejectUnauthorized: false }
    });
    return _pool;
}

// ---------- helpers ----------
function advanceDate(date, frequency) {
    const d = new Date(date);
    if (frequency === 'weekly')   d.setUTCDate(d.getUTCDate() + 7);
    else if (frequency === 'biweekly') d.setUTCDate(d.getUTCDate() + 14);
    else                          d.setUTCMonth(d.getUTCMonth() + 1);
    return d.toISOString().slice(0, 10);
}

function formatDate(d) {
    return new Date(d).toISOString().slice(0, 10);
}

// ---------- handler entrypoints ----------
exports.handler = async (event) => {
    // EventBridge scheduled events have a `source` field; SQS events have Records.
    if (event && event.source === 'aws.events') {
        return scan();
    }
    if (event && Array.isArray(event.Records)) {
        return consumeSqs(event);
    }
    return { ok: false, reason: 'unknown_event_shape' };
};

// ---------- scan: enqueue every due subscription ----------
async function scan() {
    const pool = await getPool();
    const [subs] = await pool.execute(
        `SELECT s.id, s.user_id, s.next_delivery
           FROM subscriptions s
          WHERE s.status = 'active'
            AND s.next_delivery IS NOT NULL
            AND s.next_delivery <= CURDATE()
          LIMIT 500`
    );

    let enqueued = 0;
    for (const row of subs) {
        // idempotency key: (subscription, due-date) so we don't double-process
        // a sub if the cron fires twice while a message is in-flight.
        const idemKey = `sub-${row.id}-${formatDate(row.next_delivery)}`;
        await sqsClient.send(new SendMessageCommand({
            QueueUrl: QUEUE_URL,
            MessageBody: JSON.stringify({
                subscription_id: row.id,
                user_id: row.user_id,
                next_delivery: formatDate(row.next_delivery),
                idem: idemKey
            }),
            MessageGroupId: idemKey
        }));
        enqueued++;
    }

    return { ok: true, enqueued, scannedAt: new Date().toISOString() };
}

// ---------- consume: process one message at a time ----------
async function consumeSqs(event) {
    const pool = await getPool();
    const batchItemFailures = [];

    for (const record of event.Records) {
        try {
            await renewOne(pool, JSON.parse(record.body));
        } catch (err) {
            // Report the failure so SQS keeps the message + sends to DLQ
            // after maxReceiveCount tries.
            console.error('renewal_failed', {
                messageId: record.messageId,
                error: err.message,
                stack: err.stack
            });
            batchItemFailures.push({ itemIdentifier: record.messageId });
        }
    }

    return { batchItemFailures };
}

// ---------- core: renew one subscription ----------
async function renewOne(pool, msg) {
    const { subscription_id, user_id, next_delivery } = msg;

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        // Re-fetch under a row lock — if next_delivery moved already, this
        // message is stale (we already processed it on a previous attempt).
        const [[sub]] = await conn.execute(
            `SELECT s.id, s.user_id, s.frequency, s.address_id, s.next_delivery, s.plan_name
               FROM subscriptions s
              WHERE s.id = ? AND s.user_id = ?
              FOR UPDATE`,
            [subscription_id, user_id]
        );
        if (!sub) {
            await conn.commit();
            return { skipped: 'subscription_not_found' };
        }
        if (formatDate(sub.next_delivery) !== next_delivery) {
            // Already advanced — nothing to do, message is stale.
            await conn.commit();
            return { skipped: 'already_advanced' };
        }

        const [items] = await conn.execute(
            `SELECT si.product_id, si.quantity, p.price, p.name
               FROM subscription_items si
               JOIN products p ON si.product_id = p.id
              WHERE si.subscription_id = ?`,
            [subscription_id]
        );

        if (items.length === 0) {
            await conn.commit();
            return { skipped: 'no_items' };
        }

        const total = items.reduce((s, it) => s + Number(it.price) * it.quantity, 0);

        // Create the order.
        const [orderResult] = await conn.execute(
            `INSERT INTO orders (user_id, subscription_id, status, total, address_id, notes)
             VALUES (?, ?, 'confirmed', ?, ?, ?)`,
            [user_id, subscription_id, total, sub.address_id, `Auto-renewal of ${sub.plan_name}`]
        );
        const orderId = orderResult.insertId;

        for (const it of items) {
            await conn.execute(
                `INSERT INTO order_items (order_id, product_id, quantity, price)
                 VALUES (?, ?, ?, ?)`,
                [orderId, it.product_id, it.quantity, it.price]
            );
        }

        // Award rewards points (10× the post-tax total).
        const points = Math.floor(total * 10);
        await conn.execute(
            'INSERT IGNORE INTO user_rewards (user_id) VALUES (?)',
            [user_id]
        );
        await conn.execute(
            `UPDATE user_rewards
                SET points_balance  = points_balance  + ?,
                    lifetime_points = lifetime_points + ?
              WHERE user_id = ?`,
            [points, points, user_id]
        );
        await conn.execute(
            `INSERT INTO reward_history (user_id, points, type, reason, reference_type, reference_id)
             VALUES (?, ?, 'earned', 'Subscription renewal', 'order', ?)`,
            [user_id, points, orderId]
        );

        // Advance next_delivery — only if it's still equal to the date we
        // claimed (defense in depth against duplicate processing).
        await conn.execute(
            `UPDATE subscriptions
                SET next_delivery = ?
              WHERE id = ? AND next_delivery = ?`,
            [advanceDate(sub.next_delivery, sub.frequency), subscription_id, formatDate(sub.next_delivery)]
        );

        await conn.commit();

        if (ENABLE_EMAIL) {
            await sendRenewalEmail(conn, user_id, orderId, total, items);
        }

        return { ok: true, order_id: orderId, points_awarded: points };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

async function sendRenewalEmail(conn, userId, orderId, total, items) {
    try {
        const [[user]] = await conn.execute(
            'SELECT email, first_name FROM users WHERE id = ?',
            [userId]
        );
        if (!user || !user.email) return;

        const lineItems = items
            .map(it => `  - ${it.name} × ${it.quantity}`)
            .join('\n');

        await sesClient.send(new SendEmailCommand({
            FromEmailAddress: SES_FROM,
            Destination: { ToAddresses: [user.email] },
            Content: {
                Simple: {
                    Subject: { Data: `Your Sparko delivery is on the way (Order #${orderId})` },
                    Body: {
                        Text: {
                            Data: [
                                `Hi ${user.first_name || ''},`.trim(),
                                ``,
                                `Your Sparko subscription just renewed. Order #${orderId}:`,
                                lineItems,
                                ``,
                                `Total: $${total.toFixed(2)}`,
                                ``,
                                `Reply to this email if anything looks off.`,
                                ``,
                                `— Sparko Water`
                            ].join('\n')
                        }
                    }
                }
            }
        }));
    } catch (err) {
        // Email is best-effort — log and continue. The order itself is
        // already committed.
        console.warn('email_send_failed', { userId, orderId, error: err.message });
    }
}
