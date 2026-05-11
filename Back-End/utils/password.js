/**
 * FIPS 140-2/140-3 compliant password hashing using PBKDF2-HMAC-SHA512.
 *
 * - Algorithm: PBKDF2-HMAC-SHA512 (NIST SP 800-132 approved)
 * - Salt: 16 bytes from crypto.randomBytes (CSPRNG)
 * - Iterations: 210,000 (OWASP 2023 recommendation for SHA-512)
 * - Output: 64-byte (512-bit) derived key
 *
 * Storage format (single string in password_hash column):
 *   pbkdf2_sha512$<iterations>$<salt_hex>$<hash_hex>
 *
 * This format self-describes the parameters, allowing iteration counts
 * to be increased over time without breaking existing hashes.
 */

const crypto = require('crypto');
const { promisify } = require('util');

const pbkdf2Async = promisify(crypto.pbkdf2);

const ALGORITHM = 'sha512';
const SALT_BYTES = 16;
const KEY_BYTES = 64;
const ITERATIONS = 210000;

/**
 * Hash a plaintext password.
 * @param {string} password
 * @returns {Promise<string>} storage-ready hash string
 */
async function hash(password) {
    if (typeof password !== 'string' || password.length === 0) {
        throw new Error('Password must be a non-empty string');
    }
    const salt = crypto.randomBytes(SALT_BYTES);
    const derived = await pbkdf2Async(password, salt, ITERATIONS, KEY_BYTES, ALGORITHM);
    return `pbkdf2_${ALGORITHM}$${ITERATIONS}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/**
 * Verify a plaintext password against a stored hash.
 * Uses constant-time comparison to prevent timing attacks.
 * @param {string} password
 * @param {string} stored
 * @returns {Promise<boolean>}
 */
async function verify(password, stored) {
    if (typeof password !== 'string' || typeof stored !== 'string') {
        return false;
    }

    const parts = stored.split('$');
    if (parts.length !== 4 || !parts[0].startsWith('pbkdf2_')) {
        return false;
    }

    const algorithm = parts[0].slice('pbkdf2_'.length);
    const iterations = parseInt(parts[1], 10);
    const salt = Buffer.from(parts[2], 'hex');
    const expected = Buffer.from(parts[3], 'hex');

    if (!Number.isFinite(iterations) || iterations < 1 || salt.length === 0 || expected.length === 0) {
        return false;
    }

    const derived = await pbkdf2Async(password, salt, iterations, expected.length, algorithm);

    // timingSafeEqual requires equal-length buffers; the length check above guarantees that.
    return crypto.timingSafeEqual(derived, expected);
}

module.exports = { hash, verify };
