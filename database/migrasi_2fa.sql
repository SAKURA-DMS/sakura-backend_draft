-- ============================================================
-- Migration: Tambah kolom 2FA ke tabel users
-- File: database/migration_2fa.sql
-- Jalankan: mysql -u root sakura_dms < migration_2fa.sql
-- ============================================================

-- 1. Tambah kolom is_2fa_enabled
ALTER TABLE users
  ADD COLUMN is_2fa_enabled TINYINT(1) NOT NULL DEFAULT 0
  AFTER avatar;

-- 2. Tambah kolom otp_hash  (bcrypt hash dari OTP plaintext)
ALTER TABLE users
  ADD COLUMN otp_hash VARCHAR(255) DEFAULT NULL
  AFTER is_2fa_enabled;

-- 3. Tambah kolom otp_expires_at
ALTER TABLE users
  ADD COLUMN otp_expires_at DATETIME DEFAULT NULL
  AFTER otp_hash;

-- 4. Tambah kolom otp_used  (flag one-time use)
ALTER TABLE users
  ADD COLUMN otp_used TINYINT(1) NOT NULL DEFAULT 0
  AFTER otp_expires_at;

-- 5. Tambah kolom otp_attempts  (rate-limit sederhana)
ALTER TABLE users
  ADD COLUMN otp_attempts TINYINT(1) NOT NULL DEFAULT 0
  AFTER otp_used;

-- Verifikasi
DESCRIBE users;