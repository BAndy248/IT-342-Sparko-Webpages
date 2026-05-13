/**
 * Secrets Manager loader.
 *
 * Called once at startup from server.js (before route mounting). When the
 * process is running on EC2 with the right IAM instance profile, this fetches
 * the db + app secrets from AWS Secrets Manager and writes them into
 * process.env, so the rest of the codebase keeps reading config via env vars
 * just like in local dev.
 *
 * Behavior:
 *   - If SECRETS_DB_ARN / SECRETS_APP_ARN are set, fetch and overlay.
 *   - Existing env vars are NOT overwritten — so you can override any field
 *     locally via .env without going through Secrets Manager.
 *   - Silent no-op when ARNs aren't set (local dev mode).
 *   - Falls back gracefully if the AWS SDK isn't installed.
 */

const { logger } = require('./logger');

async function loadSecrets() {
    const dbArn  = process.env.SECRETS_DB_ARN;
    const appArn = process.env.SECRETS_APP_ARN;
    if (!dbArn && !appArn) {
        logger.info('secrets_skipped', { reason: 'no_arns_configured' });
        return;
    }

    let client;
    try {
        const { SecretsManagerClient } = require('@aws-sdk/client-secrets-manager');
        client = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-1' });
    } catch (err) {
        logger.warn('secrets_sdk_missing', { error: err.message });
        return;
    }

    const { GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

    async function fetchAndOverlay(arn, mapping) {
        if (!arn) return;
        try {
            const resp = await client.send(new GetSecretValueCommand({ SecretId: arn }));
            const data = JSON.parse(resp.SecretString || '{}');
            for (const [secretKey, envKey] of Object.entries(mapping)) {
                if (data[secretKey] !== undefined && !process.env[envKey]) {
                    process.env[envKey] = String(data[secretKey]);
                }
            }
            logger.info('secrets_loaded', { arn, fields: Object.keys(data).length });
        } catch (err) {
            logger.error('secrets_fetch_failed', { arn, error: err.message });
            throw err;
        }
    }

    // Mappings keep secret JSON shape decoupled from env var names so we can
    // rename either side without churn on the other.
    await fetchAndOverlay(dbArn, {
        host:     'DB_HOST',
        port:     'DB_PORT',
        username: 'DB_USER',
        password: 'DB_PASSWORD',
        dbname:   'DB_NAME'
    });

    await fetchAndOverlay(appArn, {
        JWT_SECRET:          'JWT_SECRET',
        SQUARE_ACCESS_TOKEN: 'SQUARE_ACCESS_TOKEN',
        SQUARE_LOCATION_ID:  'SQUARE_LOCATION_ID',
        SQUARE_ENVIRONMENT:  'SQUARE_ENVIRONMENT'
    });
}

module.exports = { loadSecrets };
