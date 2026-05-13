-- Migration 001: Reviews, Shopping Cart, Rewards, Bundle Promotions, Payments
-- Run against an existing sparko_water database that already has the base
-- tables from schema.sql but doesn't yet have the e-commerce extensions.
--
-- Safe to re-run: each statement uses IF NOT EXISTS / IGNORE where MySQL allows.

USE sparko_water;

-- Reviews
CREATE TABLE IF NOT EXISTS reviews (
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

-- Cart
CREATE TABLE IF NOT EXISTS carts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cart_items (
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

-- Rewards
CREATE TABLE IF NOT EXISTS user_rewards (
    user_id INT PRIMARY KEY,
    points_balance INT NOT NULL DEFAULT 0,
    lifetime_points INT NOT NULL DEFAULT 0,
    tier ENUM('bronze', 'silver', 'gold', 'platinum') NOT NULL DEFAULT 'bronze',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CHECK (points_balance >= 0)
);

CREATE TABLE IF NOT EXISTS reward_history (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    points INT NOT NULL,
    type ENUM('earned', 'redeemed', 'adjusted', 'expired') NOT NULL,
    reason VARCHAR(255),
    reference_type VARCHAR(50),
    reference_id INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bundle_rewards (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    description TEXT,
    min_items INT NOT NULL,
    category VARCHAR(50),
    discount_percent DECIMAL(5,2) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    starts_at TIMESTAMP NULL,
    ends_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CHECK (min_items > 0),
    CHECK (discount_percent BETWEEN 0 AND 100)
);

-- Payments
CREATE TABLE IF NOT EXISTS payments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    order_id INT NOT NULL,
    user_id INT NOT NULL,
    provider VARCHAR(20) NOT NULL DEFAULT 'square',
    provider_payment_id VARCHAR(255),
    provider_order_id VARCHAR(255),
    amount DECIMAL(10,2) NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    status ENUM('pending', 'authorized', 'captured', 'failed', 'refunded') NOT NULL DEFAULT 'pending',
    raw_response TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY uniq_provider_payment (provider_payment_id)
);

-- Indexes
CREATE INDEX idx_reviews_product ON reviews(product_id);
CREATE INDEX idx_reviews_user ON reviews(user_id);
CREATE INDEX idx_reviews_rating ON reviews(rating);
CREATE INDEX idx_cart_items_cart ON cart_items(cart_id);
CREATE INDEX idx_reward_history_user ON reward_history(user_id);
CREATE INDEX idx_reward_history_created ON reward_history(created_at);
CREATE INDEX idx_bundle_active ON bundle_rewards(is_active);
CREATE INDEX idx_payments_order ON payments(order_id);
CREATE INDEX idx_payments_user ON payments(user_id);

-- Seed bundles
INSERT IGNORE INTO bundle_rewards (id, name, description, min_items, category, discount_percent, is_active) VALUES
(1, 'Buy 3, Save 5%',   'Buy any 3 items and save 5% on your order',     3, NULL,        5.00,  TRUE),
(2, 'Buy 6, Save 10%',  'Buy any 6 items and save 10% on your order',    6, NULL,        10.00, TRUE),
(3, 'Buy 10, Save 15%', 'Buy any 10 items and save 15% on your order',   10, NULL,       15.00, TRUE),
(4, 'Sparkling Bundle', 'Buy 4 Sparkling items and save 12%',             4, 'Sparkling', 12.00, TRUE);
