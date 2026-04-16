module.exports = {
    jwtSecret: process.env.JWT_SECRET,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '24h',
    bcryptRounds: 12,
    resetTokenExpiresHours: parseInt(process.env.RESET_TOKEN_EXPIRES_HOURS) || 1
};
