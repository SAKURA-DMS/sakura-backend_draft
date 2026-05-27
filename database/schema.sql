-- =====================================================
-- Sakura DMS — MySQL Schema
-- Target: MySQL 8.x / Azure Database for MySQL
-- Charset: utf8mb4 (mendukung emoji & karakter Indonesia)
-- =====================================================

CREATE DATABASE IF NOT EXISTS sakura_dms
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE sakura_dms;

SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS audit_trail;
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS sk_records;
DROP TABLE IF EXISTS outgoing_letters;
DROP TABLE IF EXISTS incoming_letters;
DROP TABLE IF EXISTS inventory_items;
DROP TABLE IF EXISTS teacher_records;
DROP TABLE IF EXISTS student_records;
DROP TABLE IF EXISTS documents;
DROP TABLE IF EXISTS document_counters;
DROP TABLE IF EXISTS folders;
DROP TABLE IF EXISTS document_types;
DROP TABLE IF EXISTS categories;
DROP TABLE IF EXISTS role_permissions;
DROP TABLE IF EXISTS permissions;
DROP TABLE IF EXISTS users;
SET FOREIGN_KEY_CHECKS = 1;

-- =====================================================
-- USERS & AUTHENTICATION
-- =====================================================
CREATE TABLE users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  nama          VARCHAR(120) NOT NULL,
  email         VARCHAR(150) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,             -- bcrypt
  role          ENUM('Kepala Sekolah','Operator/TU','Guru') NOT NULL DEFAULT 'Guru',
  departemen    VARCHAR(120) DEFAULT '',
  nip           VARCHAR(50)  DEFAULT '',
  avatar        VARCHAR(500) DEFAULT NULL,
  status        ENUM('active','menunggu_approval','nonaktif') NOT NULL DEFAULT 'menunggu_approval',
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_users_status (status),
  INDEX idx_users_role (role)
) ENGINE=InnoDB;

-- =====================================================
-- ROLE-BASED ACCESS CONTROL
-- =====================================================
CREATE TABLE permissions (
  permission_id   INT AUTO_INCREMENT PRIMARY KEY,
  permission_key  VARCHAR(80) NOT NULL UNIQUE,
  description     VARCHAR(255) DEFAULT ''
) ENGINE=InnoDB;

CREATE TABLE role_permissions (
  role_name      ENUM('Kepala Sekolah','Operator/TU','Guru') NOT NULL,
  permission_id  INT NOT NULL,
  PRIMARY KEY (role_name, permission_id),
  FOREIGN KEY (permission_id) REFERENCES permissions(permission_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- =====================================================
-- KATEGORI & TIPE DOKUMEN
-- =====================================================
CREATE TABLE categories (
  category_id    INT AUTO_INCREMENT PRIMARY KEY,
  category_name  VARCHAR(100) NOT NULL UNIQUE
) ENGINE=InnoDB;

CREATE TABLE document_types (
  type_id       INT AUTO_INCREMENT PRIMARY KEY,
  category_id   INT NOT NULL,
  type_name     VARCHAR(150) NOT NULL,
  code_prefix   VARCHAR(10) NOT NULL,
  FOREIGN KEY (category_id) REFERENCES categories(category_id) ON DELETE CASCADE,
  INDEX idx_doctype_cat (category_id)
) ENGINE=InnoDB;

-- =====================================================
-- FOLDERS (hierarkis)
-- =====================================================
CREATE TABLE folders (
  folder_id    INT AUTO_INCREMENT PRIMARY KEY,
  folder_name  VARCHAR(150) NOT NULL,
  parent_id    INT DEFAULT NULL,
  category_id  INT DEFAULT NULL,
  type_id      INT DEFAULT NULL,
  description  TEXT,
  is_custom    TINYINT(1) NOT NULL DEFAULT 0,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (parent_id)   REFERENCES folders(folder_id) ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES categories(category_id) ON DELETE SET NULL,
  FOREIGN KEY (type_id)     REFERENCES document_types(type_id) ON DELETE SET NULL,
  INDEX idx_folders_parent (parent_id)
) ENGINE=InnoDB;

-- =====================================================
-- COUNTER NOMOR DOKUMEN (PREFIX/YEAR/SEQ)
-- =====================================================
CREATE TABLE document_counters (
  prefix    VARCHAR(10) NOT NULL,
  year      INT NOT NULL,
  last_seq  INT NOT NULL DEFAULT 0,
  PRIMARY KEY (prefix, year)
) ENGINE=InnoDB;

-- =====================================================
-- DOCUMENTS (utama)
-- =====================================================
CREATE TABLE documents (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  judul              VARCHAR(255) NOT NULL,
  nomor_dokumen      VARCHAR(50)  NOT NULL UNIQUE,
  category_id        INT NOT NULL,
  type_id            INT NOT NULL,
  folder_id          INT DEFAULT NULL,
  tahun_ajaran       VARCHAR(20) DEFAULT NULL,
  status             ENUM('Menunggu','Diarsipkan','Ditolak') NOT NULL DEFAULT 'Menunggu',
  versi              INT NOT NULL DEFAULT 1,
  uploaded_by        INT NOT NULL,
  file_url           VARCHAR(1000) NOT NULL,        -- URL Azure Blob
  file_blob_name     VARCHAR(500)  NOT NULL,        -- key blob untuk delete
  file_size          BIGINT DEFAULT NULL,
  mime_type          VARCHAR(120) DEFAULT NULL,
  original_filename  VARCHAR(255) DEFAULT NULL,
  catatan            TEXT,
  created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at         DATETIME DEFAULT NULL,         -- soft delete (Trash)
  FOREIGN KEY (category_id) REFERENCES categories(category_id),
  FOREIGN KEY (type_id)     REFERENCES document_types(type_id),
  FOREIGN KEY (folder_id)   REFERENCES folders(folder_id)  ON DELETE SET NULL,
  FOREIGN KEY (uploaded_by) REFERENCES users(id),
  INDEX idx_docs_status (status),
  INDEX idx_docs_cat    (category_id),
  INDEX idx_docs_type   (type_id),
  INDEX idx_docs_deleted (deleted_at)
) ENGINE=InnoDB;

-- =====================================================
-- METADATA PER KATEGORI
-- =====================================================

-- Data Siswa
CREATE TABLE student_records (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  document_id       INT NOT NULL UNIQUE,
  nama_siswa        VARCHAR(150),
  nis               VARCHAR(30),
  nisn              VARCHAR(30),
  kelas             VARCHAR(50),
  tahun_ajaran      VARCHAR(20),
  tempat_lahir      VARCHAR(100),
  tanggal_lahir     DATE,
  jenis_kelamin     ENUM('Laki-laki','Perempuan'),
  nama_orang_tua    VARCHAR(150),
  no_hp_orang_tua   VARCHAR(20),
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Data Guru
CREATE TABLE teacher_records (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  document_id           INT NOT NULL UNIQUE,
  nama_guru             VARCHAR(150),
  nip                   VARCHAR(30),
  nuptk                 VARCHAR(30),
  mata_pelajaran        VARCHAR(100),
  pendidikan_terakhir   VARCHAR(100),
  status_kepegawaian    ENUM('PNS','PPPK','Honorer','GTT'),
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Sarana Prasarana
CREATE TABLE inventory_items (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  document_id       INT NOT NULL UNIQUE,
  kode_barang       VARCHAR(50),
  nama_barang       VARCHAR(150),
  jumlah            INT,
  tahun_pengadaan   VARCHAR(10),
  kondisi           ENUM('Baik','Rusak Ringan','Rusak Berat'),
  lokasi            VARCHAR(150),
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Surat Masuk
CREATE TABLE incoming_letters (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  document_id       INT NOT NULL UNIQUE,
  nomor_agenda      VARCHAR(50),
  nomor_surat       VARCHAR(50),
  tanggal_surat     DATE,
  tanggal_diterima  DATE,
  pengirim          VARCHAR(200),
  perihal           VARCHAR(255),
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Surat Keluar
CREATE TABLE outgoing_letters (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  document_id     INT NOT NULL UNIQUE,
  nomor_agenda    VARCHAR(50),
  nomor_surat     VARCHAR(50),
  tanggal_surat   DATE,
  tujuan          VARCHAR(200),
  perihal         VARCHAR(255),
  penandatangan   VARCHAR(150),
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Surat Keputusan (SK)
CREATE TABLE sk_records (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  document_id     INT NOT NULL UNIQUE,
  nomor_sk        VARCHAR(50),
  tanggal_sk      DATE,
  tentang         VARCHAR(255),
  penandatangan   VARCHAR(150),
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- =====================================================
-- NOTIFICATIONS
-- =====================================================
CREATE TABLE notifications (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  user_id      INT NOT NULL,
  message      VARCHAR(500) NOT NULL,
  type         VARCHAR(40) DEFAULT 'info',
  document_id  INT DEFAULT NULL,
  is_read      TINYINT(1) NOT NULL DEFAULT 0,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id)     REFERENCES users(id)     ON DELETE CASCADE,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
  INDEX idx_notif_user (user_id, is_read)
) ENGINE=InnoDB;

-- =====================================================
-- AUDIT TRAIL
-- =====================================================
CREATE TABLE audit_trail (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  document_id  INT NOT NULL,
  user_id      INT,
  action       VARCHAR(500) NOT NULL,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)     REFERENCES users(id)     ON DELETE SET NULL,
  INDEX idx_audit_doc (document_id)
) ENGINE=InnoDB;
