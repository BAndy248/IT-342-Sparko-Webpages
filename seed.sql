-- Sparko Water Subscription Service - Seed Data
USE sparko_water;

-- Default admin user (password: Admin123!)
-- Hash generated with bcrypt, 12 rounds
INSERT INTO users (username, email, password_hash, first_name, last_name, role) VALUES
('admin', 'admin@sparkowater.com', '$2b$12$placeholder.hash.replace.with.real.bcrypt.hash', 'Sparko', 'Admin', 'admin');

-- Sample products
INSERT INTO products (name, description, price, size, category) VALUES
('Spring Water 5 Gallon',    'Natural spring water sourced from mountain springs',         8.99,  '5 Gallon',      'Spring'),
('Spring Water 1 Gallon',    'Natural spring water in convenient gallon jugs',             3.49,  '1 Gallon',      'Spring'),
('Purified Water 5 Gallon',  'Triple-filtered purified drinking water',                    7.99,  '5 Gallon',      'Purified'),
('Purified Water Case',      '24-pack of 16.9oz purified water bottles',                   5.99,  '16.9 oz Case',  'Purified'),
('Alkaline Water 1 Gallon',  'pH-balanced alkaline water for optimal hydration',           4.99,  '1 Gallon',      'Alkaline'),
('Alkaline Water Case',      '24-pack of 16.9oz alkaline water bottles',                   7.99,  '16.9 oz Case',  'Alkaline'),
('Sparkling Water Case',     '24-pack of 12oz naturally carbonated sparkling water',       8.99,  '12 oz Case',    'Sparkling'),
('Sparkling Water Variety',  'Mixed flavor sparkling water - lemon, lime, berry, plain',   9.99,  '12 oz Case',    'Sparkling');
