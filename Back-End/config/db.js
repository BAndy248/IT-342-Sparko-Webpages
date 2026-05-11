const mysql = require('mysql2/promise');

// DB_SSL controls TLS to the database.
//   - "true"     → require SSL with verified CA (use for AWS RDS)
//   - "relaxed"  → require SSL but skip CA verification (RDS without cert bundle)
//   - "false" or unset → no SSL (self-hosted MariaDB/MySQL on EC2)
// Since traffic stays inside the VPC between BE-SG and DB-SG, TLS is optional.
let sslConfig = false;
if (process.env.DB_SSL === 'true') {
    sslConfig = { rejectUnauthorized: true };
} else if (process.env.DB_SSL === 'relaxed') {
    sslConfig = { rejectUnauthorized: false };
}

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    ssl: sslConfig
});

module.exports = pool;
