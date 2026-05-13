-- Sparko Water Subscription Service
-- MySQL Schema for AWS RDS
-- All queries in the backend use parameterized statements to prevent SQL injection

CREATE DATABASE IF NOT EXISTS sparko_water;
USE sparko_water;

-- Users table with role-based access
CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) NOT NULL UNIQUE,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,  -- PBKDF2-HMAC-SHA512 (FIPS 140-2/3 approved), format: pbkdf2_sha512$iterations$salt_hex$hash_hex
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    phone VARCHAR(20),
    role ENUM('user', 'admin') NOT NULL DEFAULT 'user',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Delivery addresses
CREATE TABLE addresses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    street VARCHAR(255) NOT NULL,
    city VARCHAR(100) NOT NULL,
    state VARCHAR(50) NOT NULL,
    zip_code VARCHAR(10) NOT NULL,
    is_default BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Water products catalog
CREATE TABLE products (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    price DECIMAL(10,2) NOT NULL,
    size VARCHAR(50),             -- e.g. '5 Gallon', '1 Gallon', '16.9 oz Case'
    category VARCHAR(50),         -- e.g. 'Spring', 'Purified', 'Alkaline', 'Sparkling'
    is_available BOOLEAN DEFAULT TRUE,
    image_url VARCHAR(500),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Subscription plans
CREATE TABLE subscriptions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    plan_name VARCHAR(100) NOT NULL,    -- e.g. 'Basic', 'Family', 'Office'
    status ENUM('active', 'paused', 'cancelled') NOT NULL DEFAULT 'active',
    frequency ENUM('weekly', 'biweekly', 'monthly') NOT NULL DEFAULT 'monthly',
    start_date DATE NOT NULL,
    next_delivery DATE,
    address_id INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (address_id) REFERENCES addresses(id) ON DELETE SET NULL
);

-- Items included in a subscription
CREATE TABLE subscription_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    subscription_id INT NOT NULL,
    product_id INT NOT NULL,
    quantity INT NOT NULL DEFAULT 1,
    FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

-- Orders generated from subscriptions or one-off
CREATE TABLE orders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    subscription_id INT,
    status ENUM('pending', 'confirmed', 'out_for_delivery', 'delivered', 'cancelled') NOT NULL DEFAULT 'pending',
    total DECIMAL(10,2) NOT NULL,
    delivery_date DATE,
    address_id INT,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE SET NULL,
    FOREIGN KEY (address_id) REFERENCES addresses(id) ON DELETE SET NULL
);

-- Individual items in an order
CREATE TABLE order_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    order_id INT NOT NULL,
    product_id INT NOT NULL,
    quantity INT NOT NULL DEFAULT 1,
    price DECIMAL(10,2) NOT NULL,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

-- Password reset tokens (time-limited, single-use)
CREATE TABLE password_reset_tokens (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    token VARCHAR(255) NOT NULL UNIQUE,
    expires_at TIMESTAMP NOT NULL,
    used BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- =========================================================================
-- Product Reviews & Ratings
-- =========================================================================
-- One review per (user, product). Star rating 1-5. Soft-hide via is_hidden so
-- admins can moderate without losing audit history.
CREATE TABLE reviews (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    product_id INT NOT NULL,
    rating TINYINT NOT NULL,
    title VARCHAR(150),
    comment TEXT,
    is_hidden BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
    UNIQUE KEY uniq_user_product_review (user_id, product_id),
    CHECK (rating BETWEEN 1 AND 5)
);

-- =========================================================================
-- Shopping Cart
-- =========================================================================
-- One persistent cart row per user (created lazily on first add).
CREATE TABLE carts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE cart_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cart_id INT NOT NULL,
    product_id INT NOT NULL,
    quantity INT NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (cart_id) REFERENCES carts(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
    UNIQUE KEY uniq_cart_product (cart_id, product_id),
    CHECK (quantity > 0)
);

-- =========================================================================
-- Rewards: points balance + history
-- =========================================================================
-- Single row per user that tracks the running points balance + lifetime totals.
-- Maintained transactionally alongside reward_history inserts so the balance
-- and the ledger never drift.
CREATE TABLE user_rewards (
    user_id INT PRIMARY KEY,
    points_balance INT NOT NULL DEFAULT 0,
    lifetime_points INT NOT NULL DEFAULT 0,
    tier ENUM('bronze', 'silver', 'gold', 'platinum') NOT NULL DEFAULT 'bronze',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CHECK (points_balance >= 0)
);

-- Append-only ledger of point earn/redeem/adjust events.
-- 'reason' is free text; 'reference_type' + 'reference_id' link to the source
-- entity (order, review, manual_adjustment) for traceability.
CREATE TABLE reward_history (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    points INT NOT NULL,                  -- positive = earned, negative = redeemed
    type ENUM('earned', 'redeemed', 'adjusted', 'expired') NOT NULL,
    reason VARCHAR(255),
    reference_type VARCHAR(50),
    reference_id INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Bundle promotions: "buy X items in category Y, get Z% off".
-- Active window via starts_at / ends_at lets admins schedule promos.
CREATE TABLE bundle_rewards (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    description TEXT,
    min_items INT NOT NULL,               -- threshold of items required
    category VARCHAR(50),                 -- optional: limit to a category
    discount_percent DECIMAL(5,2) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    starts_at TIMESTAMP NULL,
    ends_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CHECK (min_items > 0),
    CHECK (discount_percent BETWEEN 0 AND 100)
);

-- =========================================================================
-- Payment methods on file (Square Cards on File)
-- =========================================================================
-- Stores Square's card ID (NOT the card number) so subscription renewals
-- can charge the saved card. Card data stays on Square's PCI-compliant servers.
CREATE TABLE payment_methods (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    provider VARCHAR(20) NOT NULL DEFAULT 'square',
    provider_card_id VARCHAR(255) NOT NULL,
    card_brand VARCHAR(50),
    card_last4 VARCHAR(4),
    exp_month INT,
    exp_year INT,
    is_default BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY uniq_provider_card (provider_card_id)
);

-- =========================================================================
-- Payments (Square API integration)
-- =========================================================================
-- Records the linkage between an order and the Square payment ID.
-- Storing the Square payment_id lets us refund/void via Square's API later.
CREATE TABLE payments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    order_id INT NOT NULL,
    user_id INT NOT NULL,
    provider VARCHAR(20) NOT NULL DEFAULT 'square',
    provider_payment_id VARCHAR(255),     -- Square payment ID
    provider_order_id VARCHAR(255),       -- Square order ID
    amount DECIMAL(10,2) NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    status ENUM('pending', 'authorized', 'captured', 'failed', 'refunded') NOT NULL DEFAULT 'pending',
    raw_response TEXT,                    -- JSON blob from Square for debugging
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY uniq_provider_payment (provider_payment_id)
);

-- Indexes for performance
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_orders_user ON orders(user_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX idx_subscriptions_status ON subscriptions(status);
CREATE INDEX idx_reset_tokens_token ON password_reset_tokens(token);
CREATE INDEX idx_reset_tokens_expires ON password_reset_tokens(expires_at);
CREATE INDEX idx_reviews_product ON reviews(product_id);
CREATE INDEX idx_reviews_user ON reviews(user_id);
CREATE INDEX idx_reviews_rating ON reviews(rating);
CREATE INDEX idx_cart_items_cart ON cart_items(cart_id);
CREATE INDEX idx_reward_history_user ON reward_history(user_id);
CREATE INDEX idx_reward_history_created ON reward_history(created_at);
CREATE INDEX idx_bundle_active ON bundle_rewards(is_active);
CREATE INDEX idx_payments_order ON payments(order_id);
CREATE INDEX idx_payments_user ON payments(user_id);
CREATE INDEX idx_products_category ON products(category);
CREATE INDEX idx_products_available ON products(is_available);
