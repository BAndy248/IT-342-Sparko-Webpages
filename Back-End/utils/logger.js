/**
 * Centralized logger that emits structured JSON to stdout (picked up by
 * CloudWatch Logs agent / ECS awslogs driver) AND, if configured, ships
 * directly to a CloudWatch Logs group/stream.
 *
 * Behavior:
 *   - Always writes JSON lines to stdout (so the awslogs / CloudWatch agent
 *     can pick them up no matter how the app is deployed).
 *   - If AWS_REGION + CLOUDWATCH_LOG_GROUP are present, additionally streams
 *     log events to that group using winston-cloudwatch.
 *   - If those packages aren't installed (local dev), falls back gracefully
 *     to a console-only logger so the app still runs.
 *
 * Every log line includes:
 *   timestamp, level, message, service, environment, instanceId, requestId
 *
 * The instanceId lets you trace which load-balanced node served a request
 * when you have multiple EC2/ECS/Fargate tasks behind an ALB.
 */

const os = require('os');
const crypto = require('crypto');

const SERVICE_NAME = 'sparko-api';
const ENVIRONMENT = process.env.NODE_ENV || 'development';
const INSTANCE_ID = process.env.INSTANCE_ID || os.hostname() || crypto.randomBytes(4).toString('hex');

let logger;

try {
    // winston + winston-cloudwatch are optional. If installed, we use them.
    const winston = require('winston');

    const transports = [
        new winston.transports.Console({
            handleExceptions: true
        })
    ];

    // Attach CloudWatch transport when configured.
    if (process.env.CLOUDWATCH_LOG_GROUP && process.env.AWS_REGION) {
        try {
            const WinstonCloudWatch = require('winston-cloudwatch');
            transports.push(new WinstonCloudWatch({
                logGroupName: process.env.CLOUDWATCH_LOG_GROUP,
                logStreamName: process.env.CLOUDWATCH_LOG_STREAM || `${SERVICE_NAME}-${INSTANCE_ID}`,
                awsRegion: process.env.AWS_REGION,
                jsonMessage: true,
                retentionInDays: parseInt(process.env.CLOUDWATCH_RETENTION_DAYS || '30', 10),
                messageFormatter: ({ level, message, ...rest }) => JSON.stringify({ level, message, ...rest })
            }));
        } catch (e) {
            // winston-cloudwatch not installed; skip silently.
        }
    }

    logger = winston.createLogger({
        level: process.env.LOG_LEVEL || 'info',
        defaultMeta: {
            service: SERVICE_NAME,
            environment: ENVIRONMENT,
            instanceId: INSTANCE_ID
        },
        format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.errors({ stack: true }),
            winston.format.json()
        ),
        transports
    });
} catch (e) {
    // winston isn't installed — fall back to JSON console logging so the
    // application still runs in dev without pulling in extra dependencies.
    const emit = (level, message, meta = {}) => {
        const entry = {
            timestamp: new Date().toISOString(),
            level,
            message: typeof message === 'string' ? message : JSON.stringify(message),
            service: SERVICE_NAME,
            environment: ENVIRONMENT,
            instanceId: INSTANCE_ID,
            ...meta
        };
        const line = JSON.stringify(entry);
        if (level === 'error' || level === 'warn') {
            process.stderr.write(line + '\n');
        } else {
            process.stdout.write(line + '\n');
        }
    };
    logger = {
        info:  (msg, meta) => emit('info',  msg, meta),
        warn:  (msg, meta) => emit('warn',  msg, meta),
        error: (msg, meta) => emit('error', msg, meta),
        debug: (msg, meta) => emit('debug', msg, meta),
        log:   (level, msg, meta) => emit(level, msg, meta)
    };
}

/**
 * Express middleware that:
 *   - Assigns or propagates an X-Request-Id (so multi-instance traces line up).
 *   - Logs the request when it completes, with status + duration + user id.
 */
function requestLogger(req, res, next) {
    const start = process.hrtime.bigint();
    const requestId =
        req.headers['x-request-id'] ||
        req.headers['x-amzn-trace-id'] ||
        crypto.randomBytes(8).toString('hex');

    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);

    res.on('finish', () => {
        const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
        const meta = {
            requestId,
            method: req.method,
            path: req.originalUrl || req.url,
            status: res.statusCode,
            durationMs: Math.round(durationMs * 100) / 100,
            ip: req.ip,
            userAgent: req.headers['user-agent'],
            userId: req.user ? req.user.id : null
        };
        if (res.statusCode >= 500) {
            logger.error('http_request', meta);
        } else if (res.statusCode >= 400) {
            logger.warn('http_request', meta);
        } else {
            logger.info('http_request', meta);
        }
    });

    next();
}

module.exports = { logger, requestLogger };
