/**
 * Transactional email sender (AWS SES).
 *
 * Three behaviors:
 *   - If SES_FROM is set and the SES v2 SDK is installed → send via SES.
 *   - Otherwise → log the email to stdout so dev/test still has a record.
 *
 * Keeping it in this single module means routes don't need to know which
 * provider they're talking to; swap in SendGrid later by changing only this
 * file.
 */

const { logger } = require('./logger');

const SES_FROM = process.env.SES_FROM || '';
const ENABLE   = !!SES_FROM;

let sesClient = null;
let SendEmailCommand = null;
if (ENABLE) {
    try {
        const ses = require('@aws-sdk/client-sesv2');
        sesClient = new ses.SESv2Client({ region: process.env.AWS_REGION || 'us-east-1' });
        SendEmailCommand = ses.SendEmailCommand;
    } catch (err) {
        logger.warn('email_sdk_missing', { error: err.message });
    }
}

/**
 * Send an email. Returns { sent: bool, mode: 'ses' | 'log' | 'disabled' }.
 *
 * @param {object} opts
 * @param {string} opts.to        Recipient address.
 * @param {string} opts.subject
 * @param {string} opts.text      Plain-text body.
 * @param {string} [opts.html]    Optional HTML body.
 */
async function sendEmail({ to, subject, text, html }) {
    if (!to || !subject || !text) {
        throw new Error('email: to/subject/text are required');
    }

    if (!sesClient) {
        logger.info('email_logged_not_sent', { to, subject, mode: ENABLE ? 'sdk_missing' : 'disabled' });
        return { sent: false, mode: ENABLE ? 'sdk_missing' : 'disabled' };
    }

    try {
        await sesClient.send(new SendEmailCommand({
            FromEmailAddress: SES_FROM,
            Destination: { ToAddresses: [to] },
            Content: {
                Simple: {
                    Subject: { Data: subject },
                    Body: html
                        ? { Text: { Data: text }, Html: { Data: html } }
                        : { Text: { Data: text } }
                }
            }
        }));
        logger.info('email_sent', { to, subject });
        return { sent: true, mode: 'ses' };
    } catch (err) {
        // Don't crash the request — log and report sent=false so the caller
        // can decide whether to retry or surface the failure.
        logger.error('email_send_failed', { to, subject, error: err.message });
        return { sent: false, mode: 'ses', error: err.message };
    }
}

module.exports = { sendEmail };
