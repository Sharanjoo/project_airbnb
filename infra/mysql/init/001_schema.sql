-- MySQL schema: transactional, strongly consistent data.
-- Runs automatically the first time the mysql container starts (empty volume).
-- To re-run: npm run infra:reset, then npm run infra:up.

CREATE DATABASE IF NOT EXISTS airbnb CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE airbnb;

-- ---------------------------------------------------------------- users
CREATE TABLE guests (
  guest_id                 VARCHAR(40)  NOT NULL PRIMARY KEY,
  first_name               VARCHAR(60)  NOT NULL,
  last_name                VARCHAR(60)  NOT NULL,
  email                    VARCHAR(255) NOT NULL,
  password_hash            VARCHAR(100) NOT NULL,
  phone                    VARCHAR(20)  NULL,
  location                 VARCHAR(120) NULL,
  profile_photo_url        VARCHAR(500) NULL,
  preferences              JSON         NULL,
  saved_properties_count   INT          NOT NULL DEFAULT 0,
  booking_count            INT          NOT NULL DEFAULT 0,
  profile_created_datetime DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  is_deleted               BOOLEAN      NOT NULL DEFAULT FALSE,
  version                  INT          NOT NULL DEFAULT 1,
  UNIQUE KEY uq_guests_email (email),
  KEY ix_guests_location (location)
) ENGINE=InnoDB;

CREATE TABLE hosts (
  host_id              VARCHAR(40)  NOT NULL PRIMARY KEY,
  name                 VARCHAR(120) NOT NULL,
  email                VARCHAR(255) NOT NULL,
  password_hash        VARCHAR(100) NOT NULL,
  phone                VARCHAR(20)  NULL,
  profile_photo_url    VARCHAR(500) NULL,
  verification_status  ENUM('pending','verified','rejected') NOT NULL DEFAULT 'pending',
  response_rate        DECIMAL(4,3) NULL,
  response_time        INT          NULL COMMENT 'median minutes, computed by analytics',
  host_since           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  access_level         ENUM('standard','superhost','admin') NOT NULL DEFAULT 'standard',
  is_deleted           BOOLEAN      NOT NULL DEFAULT FALSE,
  version              INT          NOT NULL DEFAULT 1,
  UNIQUE KEY uq_hosts_email (email)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- properties
CREATE TABLE properties (
  property_id          VARCHAR(40)   NOT NULL PRIMARY KEY,
  host_id              VARCHAR(40)   NOT NULL,
  title                VARCHAR(100)  NOT NULL,
  description          TEXT          NOT NULL,
  property_type        ENUM('entire_home','apartment','private_room','shared_room','cabin','condo') NOT NULL,
  address_line1        VARCHAR(200)  NOT NULL,
  city                 VARCHAR(80)   NOT NULL,
  state                VARCHAR(40)   NOT NULL,
  zip                  VARCHAR(10)   NOT NULL,
  lat                  DECIMAL(9,6)  NULL,
  lng                  DECIMAL(9,6)  NULL,
  capacity             TINYINT       NOT NULL,
  bedrooms             TINYINT       NOT NULL,
  bathrooms            DECIMAL(3,1)  NOT NULL,
  amenities            JSON          NOT NULL,
  pet_friendly         BOOLEAN       NOT NULL DEFAULT FALSE,
  nightly_price        DECIMAL(10,2) NOT NULL,
  cleaning_fee         DECIMAL(10,2) NOT NULL DEFAULT 0,
  status               ENUM('active','inactive','deleted') NOT NULL DEFAULT 'active',
  rating               DECIMAL(3,2)  NULL,
  review_count         INT           NOT NULL DEFAULT 0,
  availability_version INT           NOT NULL DEFAULT 1 COMMENT 'optimistic lock for availability writes (13.3)',
  version              INT           NOT NULL DEFAULT 1,
  created_datetime     DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_properties_host FOREIGN KEY (host_id) REFERENCES hosts (host_id),
  CONSTRAINT ck_capacity CHECK (capacity BETWEEN 1 AND 16),
  CONSTRAINT ck_price CHECK (nightly_price BETWEEN 10 AND 5000),
  KEY ix_properties_host (host_id),
  -- search indexes (compare with and without for the 13.8 / §9 indexing experiment)
  KEY ix_properties_search (status, city, nightly_price),
  KEY ix_properties_rating (status, rating)
) ENGINE=InnoDB;

CREATE TABLE availability_blocks (
  availability_id  VARCHAR(40) NOT NULL PRIMARY KEY,
  property_id      VARCHAR(40) NOT NULL,
  start_date       DATE        NOT NULL,
  end_date         DATE        NOT NULL COMMENT 'exclusive',
  status           ENUM('blocked','open','booked') NOT NULL,
  source           ENUM('host','booking','sync') NOT NULL,
  updated_datetime DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_avail_property FOREIGN KEY (property_id) REFERENCES properties (property_id),
  CONSTRAINT ck_avail_dates CHECK (end_date > start_date),
  KEY ix_avail_property_dates (property_id, start_date, end_date)
) ENGINE=InnoDB;

CREATE TABLE saved_properties (
  guest_id    VARCHAR(40) NOT NULL,
  property_id VARCHAR(40) NOT NULL,
  saved_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (guest_id, property_id),
  CONSTRAINT fk_saved_guest FOREIGN KEY (guest_id) REFERENCES guests (guest_id),
  CONSTRAINT fk_saved_property FOREIGN KEY (property_id) REFERENCES properties (property_id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- bookings
CREATE TABLE reservations (
  reservation_id      VARCHAR(40)   NOT NULL PRIMARY KEY,
  property_id         VARCHAR(40)   NOT NULL,
  guest_id            VARCHAR(40)   NOT NULL,
  host_id             VARCHAR(40)   NOT NULL,
  check_in            DATE          NOT NULL,
  check_out           DATE          NOT NULL COMMENT 'exclusive',
  guest_count         TINYINT       NOT NULL,
  price_breakdown     JSON          NOT NULL,
  total_price         DECIMAL(10,2) NOT NULL,
  booking_datetime    DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  status              ENUM('REQUESTED','CONFIRMED','DECLINED','REJECTED','CANCELLED','EXPIRED','COMPLETED') NOT NULL,
  cancellation_reason VARCHAR(500)  NULL,
  guest_message       VARCHAR(1000) NULL,
  trace_id            CHAR(36)      NOT NULL,
  version             INT           NOT NULL DEFAULT 1,
  CONSTRAINT fk_res_property FOREIGN KEY (property_id) REFERENCES properties (property_id),
  CONSTRAINT fk_res_guest FOREIGN KEY (guest_id) REFERENCES guests (guest_id),
  CONSTRAINT fk_res_host FOREIGN KEY (host_id) REFERENCES hosts (host_id),
  CONSTRAINT ck_res_dates CHECK (check_out > check_in),
  KEY ix_res_property_status (property_id, status, check_in),
  KEY ix_res_guest (guest_id, check_in),
  KEY ix_res_host_status (host_id, status)
) ENGINE=InnoDB;

-- Double-booking guarantee (13.1): one row per booked night; the UNIQUE key
-- lets exactly one concurrent transaction claim a night.
CREATE TABLE reservation_nights (
  property_id    VARCHAR(40) NOT NULL,
  night          DATE        NOT NULL,
  reservation_id VARCHAR(40) NOT NULL,
  PRIMARY KEY (property_id, night),
  CONSTRAINT fk_nights_res FOREIGN KEY (reservation_id) REFERENCES reservations (reservation_id) ON DELETE CASCADE,
  KEY ix_nights_res (reservation_id)
) ENGINE=InnoDB;

-- Every status change, so a reservation can be rebuilt after a restart.
CREATE TABLE reservation_status_history (
  id             BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  reservation_id VARCHAR(40)  NOT NULL,
  from_status    VARCHAR(20)  NULL,
  to_status      VARCHAR(20)  NOT NULL,
  actor_id       VARCHAR(40)  NOT NULL,
  reason         VARCHAR(500) NULL,
  trace_id       CHAR(36)     NOT NULL,
  at             DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_hist_res (reservation_id, at)
) ENGINE=InnoDB;

-- HTTP Idempotency-Key store (booking request / approve / decline / cancel, AI approval)
CREATE TABLE idempotency_keys (
  idempotency_key VARCHAR(64)  NOT NULL PRIMARY KEY,
  request_hash    CHAR(64)     NOT NULL,
  response_status SMALLINT     NOT NULL,
  response_body   JSON         NOT NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_idem_created (created_at)
) ENGINE=InnoDB;

-- Kafka consumer idempotency: insert in the same transaction as the business write.
CREATE TABLE processed_events (
  consumer_group  VARCHAR(80)  NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  event_id        CHAR(36)     NOT NULL,
  topic           VARCHAR(80)  NOT NULL,
  processed_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (consumer_group, idempotency_key)
) ENGINE=InnoDB;
