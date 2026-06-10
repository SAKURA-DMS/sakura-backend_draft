-- ============================================================
-- MIGRATION: Fix avatar column — VARCHAR(500) → MEDIUMTEXT
-- ============================================================
-- ROOT CAUSE: VARCHAR(500) hanya menampung 500 karakter.
-- Gambar base64 ukuran rata-rata 100KB = ~133.000 karakter.
-- MySQL TRUNCATE data tanpa error (silent truncation),
-- sehingga string base64 terpotong dan menjadi URL tidak valid.
--
-- MEDIUMTEXT menampung hingga 16MB — cukup untuk semua ukuran foto profil.
-- ============================================================

USE sakura_dms;

ALTER TABLE users
  MODIFY COLUMN avatar MEDIUMTEXT DEFAULT NULL;

-- Verifikasi hasil:
-- SHOW COLUMNS FROM users WHERE Field = 'avatar';