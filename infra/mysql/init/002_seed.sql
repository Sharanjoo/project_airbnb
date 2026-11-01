-- Small seed so every service has something to read on day one.
-- Password for every seed user is "password123" (bcrypt hash below).
-- The 200-property benchmark pool is generated later by scripts/ (slice 5).
USE airbnb;

INSERT INTO hosts (host_id, name, email, password_hash, phone, verification_status, response_rate, response_time, access_level) VALUES
('hst_0001', 'Maya Chen',   'maya.host@example.com',  '$2a$10$Xxq3oADEySHsjwD9bUKb.OYUm.CA9KWTPeltUnSEuZp7WtZjbuTxK', '+14085550101', 'verified', 0.950, 45,  'superhost'),
('hst_0002', 'Luis Ortega', 'luis.host@example.com',  '$2a$10$Xxq3oADEySHsjwD9bUKb.OYUm.CA9KWTPeltUnSEuZp7WtZjbuTxK', '+14085550102', 'verified', 0.700, 300, 'standard');

INSERT INTO guests (guest_id, first_name, last_name, email, password_hash, phone, location, preferences) VALUES
('gst_0001', 'Ana',   'Rivera', 'ana@example.com',   '$2a$10$Xxq3oADEySHsjwD9bUKb.OYUm.CA9KWTPeltUnSEuZp7WtZjbuTxK', '+14085550201', 'San Jose, CA',     '{"budget_max": 250, "amenities": ["parking", "kitchen"]}'),
('gst_0002', 'Ben',   'Okafor', 'ben@example.com',   '$2a$10$Xxq3oADEySHsjwD9bUKb.OYUm.CA9KWTPeltUnSEuZp7WtZjbuTxK', '+14085550202', 'San Francisco, CA', '{"pet_friendly": true}');

INSERT INTO properties (property_id, host_id, title, description, property_type, address_line1, city, state, zip, lat, lng,
                        capacity, bedrooms, bathrooms, amenities, pet_friendly, nightly_price, cleaning_fee, rating, review_count) VALUES
('prp_0001', 'hst_0001', 'Downtown loft with parking', 'Bright loft two blocks from SAP Center.', 'apartment',
 '100 S Market St', 'San Jose', 'CA', '95113', 37.333000, -121.890000, 3, 1, 1.0, '["wifi","kitchen","parking","ac"]', FALSE, 189.00, 40.00, 4.70, 58),
('prp_0002', 'hst_0001', 'Willow Glen cottage', 'Quiet cottage with garden and full kitchen.', 'entire_home',
 '1200 Lincoln Ave', 'San Jose', 'CA', '95125', 37.307000, -121.900000, 4, 2, 1.0, '["wifi","kitchen","parking","washer"]', TRUE, 229.00, 60.00, 4.80, 41),
('prp_0003', 'hst_0002', 'Budget room near SJSU', 'Private room, shared bath, walk to campus.', 'private_room',
 '400 E San Fernando St', 'San Jose', 'CA', '95112', 37.336000, -121.881000, 2, 1, 1.0, '["wifi","workspace"]', FALSE, 79.00, 15.00, 4.20, 12);
