-- phpMyAdmin SQL Dump
-- version 5.2.1
-- https://www.phpmyadmin.net/
--
-- Host: 127.0.0.1
-- Generation Time: Jun 23, 2026 at 02:57 AM
-- Server version: 10.4.32-MariaDB
-- PHP Version: 8.1.25

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Database: `sakura_dms`
--

-- --------------------------------------------------------

--
-- Table structure for table `approval_requests`
--

CREATE TABLE `approval_requests` (
  `id` int(11) NOT NULL,
  `document_id` int(11) NOT NULL,
  `requester_id` int(11) NOT NULL,
  `approver_id` int(11) DEFAULT NULL,
  `status` enum('pending','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
  `requester_note` text DEFAULT NULL,
  `approver_note` text DEFAULT NULL,
  `requested_at` datetime NOT NULL DEFAULT current_timestamp(),
  `decided_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `audit_trail`
--

CREATE TABLE `audit_trail` (
  `id` int(11) NOT NULL,
  `document_id` int(11) NOT NULL,
  `approval_request_id` int(11) DEFAULT NULL,
  `user_id` int(11) DEFAULT NULL,
  `action` varchar(500) NOT NULL,
  `created_at` datetime DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `categories`
--

CREATE TABLE `categories` (
  `category_id` int(11) NOT NULL,
  `category_name` varchar(100) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `categories`
--

INSERT INTO `categories` (`category_id`, `category_name`) VALUES
(2, 'Data Guru'),
(1, 'Data Siswa'),
(3, 'Sarana Prasarana'),
(4, 'Surat Menyurat');

-- --------------------------------------------------------

--
-- Table structure for table `documents`
--

CREATE TABLE `documents` (
  `id` int(11) NOT NULL,
  `judul` varchar(255) NOT NULL,
  `nomor_dokumen` varchar(50) NOT NULL,
  `category_id` int(11) NOT NULL,
  `type_id` int(11) NOT NULL,
  `folder_id` int(11) DEFAULT NULL,
  `tahun_ajaran` varchar(20) DEFAULT NULL,
  `kelas` varchar(50) DEFAULT NULL,
  `status` enum('Menunggu','Diarsipkan','Ditolak') NOT NULL DEFAULT 'Menunggu',
  `versi` int(11) NOT NULL DEFAULT 1,
  `uploaded_by` int(11) NOT NULL,
  `file_url` varchar(1000) NOT NULL,
  `file_blob_name` varchar(500) NOT NULL,
  `file_size` bigint(20) DEFAULT NULL,
  `mime_type` varchar(120) DEFAULT NULL,
  `original_filename` varchar(255) DEFAULT NULL,
  `catatan` text DEFAULT NULL,
  `created_at` datetime DEFAULT current_timestamp(),
  `updated_at` datetime DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `deleted_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `document_counters`
--

CREATE TABLE `document_counters` (
  `prefix` varchar(10) NOT NULL,
  `year` int(11) NOT NULL,
  `last_seq` int(11) NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `document_types`
--

CREATE TABLE `document_types` (
  `type_id` int(11) NOT NULL,
  `category_id` int(11) NOT NULL,
  `type_name` varchar(150) NOT NULL,
  `code_prefix` varchar(10) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `document_types`
--

INSERT INTO `document_types` (`type_id`, `category_id`, `type_name`, `code_prefix`) VALUES
(1, 1, 'Buku Klapper', 'BKL'),
(2, 1, 'Buku Induk Register Peserta Didik', 'BIR'),
(3, 1, 'Surat Keterangan Hasil Ujian (SKHU)', 'SKH'),
(4, 1, 'Ijazah SMP', 'IJZ'),
(5, 2, 'Buku Induk Pegawai', 'BIP'),
(6, 2, 'Sertifikat Pendidik', 'SRP'),
(7, 2, 'Catatan Diklat', 'CDK'),
(8, 3, 'Buku Inventaris Barang dan Penghapusan Barang', 'BIB'),
(9, 3, 'Buku Pemeliharaan & Perbaikan', 'BPP'),
(10, 4, 'Buku Agenda Surat Masuk', 'ASM'),
(11, 4, 'Buku Agenda Surat Keluar', 'ASK'),
(12, 4, 'Kumpulan Surat Keputusan (SK)', 'KSK'),
(13, 4, 'Lainnya', 'LNR');

-- --------------------------------------------------------

--
-- Table structure for table `folders`
--

CREATE TABLE `folders` (
  `folder_id` int(11) NOT NULL,
  `folder_name` varchar(150) NOT NULL,
  `parent_id` int(11) DEFAULT NULL,
  `category_id` int(11) DEFAULT NULL,
  `type_id` int(11) DEFAULT NULL,
  `description` text DEFAULT NULL,
  `is_custom` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` datetime DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `folders`
--

INSERT INTO `folders` (`folder_id`, `folder_name`, `parent_id`, `category_id`, `type_id`, `description`, `is_custom`, `created_at`) VALUES
(1, 'Data Siswa', NULL, 1, NULL, 'Berisi dokumen administrasi siswa.', 0, '2026-06-04 10:12:02'),
(2, 'Data Guru', NULL, 2, NULL, 'Berisi dokumen kepegawaian guru.', 0, '2026-06-04 10:12:02'),
(3, 'Sarana Prasarana', NULL, 3, NULL, 'Berisi dokumen inventaris sekolah.', 0, '2026-06-04 10:12:02'),
(4, 'Surat Menyurat', NULL, 4, NULL, 'Berisi arsip surat masuk, keluar, dan SK.', 0, '2026-06-04 10:12:02'),
(10, 'Buku Klapper', 1, 1, 1, 'Daftar nama siswa berdasarkan abjad.', 0, '2026-06-04 10:12:02'),
(11, 'Buku Induk Register Peserta Didik', 1, 1, 2, 'Data lengkap peserta didik.', 0, '2026-06-04 10:12:02'),
(12, 'Surat Keterangan Hasil Ujian (SKHU)', 1, 1, 3, 'Arsip SKHU siswa.', 0, '2026-06-04 10:12:02'),
(13, 'Ijazah SMP', 1, 1, 4, 'Arsip ijazah SMP.', 0, '2026-06-04 10:12:02'),
(20, 'Buku Induk Pegawai', 2, 2, 5, 'Data pokok pegawai.', 0, '2026-06-04 10:12:02'),
(21, 'Sertifikat Pendidik', 2, 2, 6, 'Arsip sertifikat pendidik.', 0, '2026-06-04 10:12:02'),
(22, 'Catatan Diklat', 2, 2, 7, 'Catatan pelatihan & pendidikan guru.', 0, '2026-06-04 10:12:02'),
(30, 'Buku Inventaris Barang dan Penghapusan Barang', 3, 3, 8, 'Daftar inventaris sekolah.', 0, '2026-06-04 10:12:02'),
(31, 'Buku Pemeliharaan & Perbaikan', 3, 3, 9, 'Catatan pemeliharaan sarana.', 0, '2026-06-04 10:12:02'),
(40, 'Buku Agenda Surat Masuk', 4, 4, 10, 'Arsip surat masuk.', 0, '2026-06-04 10:12:02'),
(41, 'Buku Agenda Surat Keluar', 4, 4, 11, 'Arsip surat keluar.', 0, '2026-06-04 10:12:02'),
(42, 'Kumpulan Surat Keputusan (SK)', 4, 4, 12, 'Arsip SK resmi sekolah.', 0, '2026-06-04 10:12:02'),
(43, 'Lainnya', 4, 4, 13, 'Dokumen lain-lain.', 0, '2026-06-04 10:12:02');

-- --------------------------------------------------------

--
-- Table structure for table `incoming_letters`
--

CREATE TABLE `incoming_letters` (
  `id` int(11) NOT NULL,
  `document_id` int(11) NOT NULL,
  `nomor_agenda` varchar(50) DEFAULT NULL,
  `nomor_surat` varchar(50) DEFAULT NULL,
  `tanggal_surat` date DEFAULT NULL,
  `tanggal_diterima` date DEFAULT NULL,
  `pengirim` varchar(200) DEFAULT NULL,
  `perihal` varchar(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `inventory_items`
--

CREATE TABLE `inventory_items` (
  `id` int(11) NOT NULL,
  `document_id` int(11) NOT NULL,
  `kode_barang` varchar(50) DEFAULT NULL,
  `nama_barang` varchar(150) DEFAULT NULL,
  `jumlah` int(11) DEFAULT NULL,
  `tahun_pengadaan` varchar(10) DEFAULT NULL,
  `kondisi` enum('Baik','Rusak Ringan','Rusak Berat') DEFAULT NULL,
  `lokasi` varchar(150) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `notifications`
--

CREATE TABLE `notifications` (
  `id` int(11) NOT NULL,
  `user_id` int(11) NOT NULL,
  `message` varchar(500) NOT NULL,
  `type` varchar(40) DEFAULT 'info',
  `document_id` int(11) DEFAULT NULL,
  `is_read` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` datetime DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `outgoing_letters`
--

CREATE TABLE `outgoing_letters` (
  `id` int(11) NOT NULL,
  `document_id` int(11) NOT NULL,
  `nomor_agenda` varchar(50) DEFAULT NULL,
  `nomor_surat` varchar(50) DEFAULT NULL,
  `tanggal_surat` date DEFAULT NULL,
  `tujuan` varchar(200) DEFAULT NULL,
  `perihal` varchar(255) DEFAULT NULL,
  `penandatangan` varchar(150) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `permissions`
--

CREATE TABLE `permissions` (
  `permission_id` int(11) NOT NULL,
  `permission_key` varchar(80) NOT NULL,
  `description` varchar(255) DEFAULT ''
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `permissions`
--

INSERT INTO `permissions` (`permission_id`, `permission_key`, `description`) VALUES
(1, 'users.view', 'Melihat daftar user'),
(2, 'users.manage', 'Mengelola profil user'),
(3, 'users.approve', 'Approve/reject pendaftaran user baru'),
(4, 'users.manageRole', 'Mengubah role user'),
(5, 'roles.manage', 'Mengelola permission per role'),
(6, 'documents.upload', 'Mengunggah dokumen baru'),
(7, 'documents.edit', 'Mengedit metadata dokumen'),
(8, 'documents.delete', 'Menghapus / memulihkan dokumen'),
(9, 'documents.approve', 'Menyetujui dokumen yang menunggu'),
(10, 'documents.reject', 'Menolak dokumen yang menunggu'),
(11, 'documents.view', 'Melihat dokumen'),
(12, 'folders.manage', 'Membuat/edit/hapus folder kustom'),
(13, 'approvals.view', 'Melihat daftar approval request'),
(14, 'approvals.manage', 'Membuat & membatalkan approval request'),
(15, 'audit.view', 'Melihat audit log'),
(16, 'audit.addNote', 'Menambah catatan admin pada dokumen'),
(17, 'documents.archive', 'Mengarsipkan dokumen');

-- --------------------------------------------------------

--
-- Table structure for table `role_permissions`
--

CREATE TABLE `role_permissions` (
  `role_name` enum('Kepala Sekolah','Operator/TU','Guru') NOT NULL,
  `permission_id` int(11) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `role_permissions`
--

INSERT INTO `role_permissions` (`role_name`, `permission_id`) VALUES
('Kepala Sekolah', 1),
('Kepala Sekolah', 7),
('Kepala Sekolah', 8),
('Kepala Sekolah', 9),
('Kepala Sekolah', 10),
('Kepala Sekolah', 11),
('Kepala Sekolah', 13),
('Kepala Sekolah', 14),
('Kepala Sekolah', 15),
('Kepala Sekolah', 16),
('Kepala Sekolah', 17),
('Operator/TU', 1),
('Operator/TU', 2),
('Operator/TU', 3),
('Operator/TU', 4),
('Operator/TU', 5),
('Operator/TU', 6),
('Operator/TU', 7),
('Operator/TU', 8),
('Operator/TU', 9),
('Operator/TU', 10),
('Operator/TU', 11),
('Operator/TU', 12),
('Operator/TU', 13),
('Operator/TU', 14),
('Operator/TU', 15),
('Operator/TU', 16),
('Operator/TU', 17),
('Guru', 6),
('Guru', 7),
('Guru', 11),
('Guru', 14);

-- --------------------------------------------------------

--
-- Table structure for table `sk_records`
--

CREATE TABLE `sk_records` (
  `id` int(11) NOT NULL,
  `document_id` int(11) NOT NULL,
  `nomor_sk` varchar(50) DEFAULT NULL,
  `tanggal_sk` date DEFAULT NULL,
  `tentang` varchar(255) DEFAULT NULL,
  `penandatangan` varchar(150) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `student_records`
--

CREATE TABLE `student_records` (
  `id` int(11) NOT NULL,
  `document_id` int(11) NOT NULL,
  `nama_siswa` varchar(150) DEFAULT NULL,
  `nis` varchar(30) DEFAULT NULL,
  `nisn` varchar(30) DEFAULT NULL,
  `kelas` varchar(50) DEFAULT NULL,
  `tahun_ajaran` varchar(20) DEFAULT NULL,
  `tempat_lahir` varchar(100) DEFAULT NULL,
  `tanggal_lahir` date DEFAULT NULL,
  `jenis_kelamin` enum('Laki-laki','Perempuan') DEFAULT NULL,
  `nama_orang_tua` varchar(150) DEFAULT NULL,
  `no_hp_orang_tua` varchar(20) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `teacher_records`
--

CREATE TABLE `teacher_records` (
  `id` int(11) NOT NULL,
  `document_id` int(11) NOT NULL,
  `nama_guru` varchar(150) DEFAULT NULL,
  `nip` varchar(30) DEFAULT NULL,
  `nuptk` varchar(30) DEFAULT NULL,
  `mata_pelajaran` varchar(100) DEFAULT NULL,
  `pendidikan_terakhir` varchar(100) DEFAULT NULL,
  `status_kepegawaian` enum('PNS','PPPK','Honorer','GTT') DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `users`
--

CREATE TABLE `users` (
  `id` int(11) NOT NULL,
  `nama` varchar(120) NOT NULL,
  `email` varchar(150) NOT NULL,
  `password_hash` varchar(255) NOT NULL,
  `role` enum('Kepala Sekolah','Operator/TU','Guru') NOT NULL DEFAULT 'Guru',
  `departemen` varchar(120) DEFAULT '',
  `nip` varchar(50) DEFAULT '',
  `avatar` mediumtext DEFAULT NULL,
  `is_2fa_enabled` tinyint(1) NOT NULL DEFAULT 0,
  `otp_hash` varchar(255) DEFAULT NULL,
  `otp_expires_at` datetime DEFAULT NULL,
  `otp_used` tinyint(1) NOT NULL DEFAULT 0,
  `otp_attempts` tinyint(1) NOT NULL DEFAULT 0,
  `status` enum('active','menunggu_approval','nonaktif') NOT NULL DEFAULT 'menunggu_approval',
  `is_online` tinyint(1) NOT NULL DEFAULT 0,
  `last_seen_at` datetime DEFAULT NULL,
  `created_at` datetime DEFAULT current_timestamp(),
  `updated_at` datetime DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `users`
--

INSERT INTO `users` (`id`, `nama`, `email`, `password_hash`, `role`, `departemen`, `nip`, `avatar`, `is_2fa_enabled`, `otp_hash`, `otp_expires_at`, `otp_used`, `otp_attempts`, `status`, `created_at`, `updated_at`) VALUES
(1, 'Budi Santoso', 'admin@sakura.sch.id', '$2b$10$ASlIHMLcuUJHvEQ7xTu9POT97lEWbrXR92LnJBDyJfU/ou2do.bjC', 'Operator/TU', 'Operator / TU', '', NULL, 0, NULL, NULL, 0, 0, 'active', '2026-05-30 17:46:12', '2026-05-30 17:47:23'),
(2, 'Dr. Siti Rahayu', 'principal@sakura.sch.id', '$2b$10$ASlIHMLcuUJHvEQ7xTu9POT97lEWbrXR92LnJBDyJfU/ou2do.bjC', 'Kepala Sekolah', 'Kepala Sekolah', '', NULL, 0, NULL, NULL, 0, 0, 'active', '2026-05-30 17:46:12', '2026-05-30 17:46:12'),
(3, 'Ahmad Fauzi', 'teacher@sakura.sch.id', '$2b$10$ASlIHMLcuUJHvEQ7xTu9POT97lEWbrXR92LnJBDyJfU/ou2do.bjC', 'Guru', 'Guru Mata Pelajaran', '198723450001', NULL, 0, NULL, NULL, 0, 0, 'active', '2026-05-30 17:46:12', '2026-05-30 17:46:12');


--
-- Indexes for dumped tables
--

--
-- Indexes for table `approval_requests`
--
ALTER TABLE `approval_requests`
  ADD PRIMARY KEY (`id`),
  ADD KEY `requester_id` (`requester_id`),
  ADD KEY `idx_ar_doc` (`document_id`),
  ADD KEY `idx_ar_status` (`status`),
  ADD KEY `idx_ar_approver` (`approver_id`);

--
-- Indexes for table `audit_trail`
--
ALTER TABLE `audit_trail`
  ADD PRIMARY KEY (`id`),
  ADD KEY `user_id` (`user_id`),
  ADD KEY `idx_audit_doc` (`document_id`),
  ADD KEY `idx_audit_req` (`approval_request_id`);

--
-- Indexes for table `categories`
--
ALTER TABLE `categories`
  ADD PRIMARY KEY (`category_id`),
  ADD UNIQUE KEY `category_name` (`category_name`);

--
-- Indexes for table `documents`
--
ALTER TABLE `documents`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `nomor_dokumen` (`nomor_dokumen`),
  ADD KEY `folder_id` (`folder_id`),
  ADD KEY `uploaded_by` (`uploaded_by`),
  ADD KEY `idx_docs_status` (`status`),
  ADD KEY `idx_docs_cat` (`category_id`),
  ADD KEY `idx_docs_type` (`type_id`),
  ADD KEY `idx_docs_deleted` (`deleted_at`);

--
-- Indexes for table `document_counters`
--
ALTER TABLE `document_counters`
  ADD PRIMARY KEY (`prefix`,`year`);

--
-- Indexes for table `document_types`
--
ALTER TABLE `document_types`
  ADD PRIMARY KEY (`type_id`),
  ADD KEY `idx_doctype_cat` (`category_id`);

--
-- Indexes for table `folders`
--
ALTER TABLE `folders`
  ADD PRIMARY KEY (`folder_id`),
  ADD KEY `category_id` (`category_id`),
  ADD KEY `type_id` (`type_id`),
  ADD KEY `idx_folders_parent` (`parent_id`);

--
-- Indexes for table `incoming_letters`
--
ALTER TABLE `incoming_letters`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `document_id` (`document_id`);

--
-- Indexes for table `inventory_items`
--
ALTER TABLE `inventory_items`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `document_id` (`document_id`);

--
-- Indexes for table `notifications`
--
ALTER TABLE `notifications`
  ADD PRIMARY KEY (`id`),
  ADD KEY `document_id` (`document_id`),
  ADD KEY `idx_notif_user` (`user_id`,`is_read`);

--
-- Indexes for table `outgoing_letters`
--
ALTER TABLE `outgoing_letters`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `document_id` (`document_id`);

--
-- Indexes for table `permissions`
--
ALTER TABLE `permissions`
  ADD PRIMARY KEY (`permission_id`),
  ADD UNIQUE KEY `permission_key` (`permission_key`);

--
-- Indexes for table `role_permissions`
--
ALTER TABLE `role_permissions`
  ADD PRIMARY KEY (`role_name`,`permission_id`),
  ADD KEY `permission_id` (`permission_id`);

--
-- Indexes for table `sk_records`
--
ALTER TABLE `sk_records`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `document_id` (`document_id`);

--
-- Indexes for table `student_records`
--
ALTER TABLE `student_records`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `document_id` (`document_id`);

--
-- Indexes for table `teacher_records`
--
ALTER TABLE `teacher_records`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `document_id` (`document_id`);

--
-- Indexes for table `users`
--
ALTER TABLE `users`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `email` (`email`),
  ADD KEY `idx_users_status` (`status`),
  ADD KEY `idx_users_role` (`role`);

--
-- AUTO_INCREMENT for dumped tables
--

--
-- AUTO_INCREMENT for table `approval_requests`
--
ALTER TABLE `approval_requests`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `audit_trail`
--
ALTER TABLE `audit_trail`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `categories`
--
ALTER TABLE `categories`
  MODIFY `category_id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=5;

--
-- AUTO_INCREMENT for table `documents`
--
ALTER TABLE `documents`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `document_types`
--
ALTER TABLE `document_types`
  MODIFY `type_id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=14;

--
-- AUTO_INCREMENT for table `folders`
--
ALTER TABLE `folders`
  MODIFY `folder_id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=44;

--
-- AUTO_INCREMENT for table `incoming_letters`
--
ALTER TABLE `incoming_letters`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `inventory_items`
--
ALTER TABLE `inventory_items`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `notifications`
--
ALTER TABLE `notifications`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `outgoing_letters`
--
ALTER TABLE `outgoing_letters`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `permissions`
--
ALTER TABLE `permissions`
  MODIFY `permission_id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=33;

--
-- AUTO_INCREMENT for table `sk_records`
--
ALTER TABLE `sk_records`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `student_records`
--
ALTER TABLE `student_records`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `teacher_records`
--
ALTER TABLE `teacher_records`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `users`
--
ALTER TABLE `users`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=5;

--
-- Constraints for dumped tables
--

--
-- Constraints for table `approval_requests`
--
ALTER TABLE `approval_requests`
  ADD CONSTRAINT `approval_requests_ibfk_1` FOREIGN KEY (`document_id`) REFERENCES `documents` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `approval_requests_ibfk_2` FOREIGN KEY (`requester_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `approval_requests_ibfk_3` FOREIGN KEY (`approver_id`) REFERENCES `users` (`id`) ON DELETE SET NULL;

--
-- Constraints for table `audit_trail`
--
ALTER TABLE `audit_trail`
  ADD CONSTRAINT `audit_trail_ibfk_1` FOREIGN KEY (`document_id`) REFERENCES `documents` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `audit_trail_ibfk_2` FOREIGN KEY (`approval_request_id`) REFERENCES `approval_requests` (`id`) ON DELETE SET NULL,
  ADD CONSTRAINT `audit_trail_ibfk_3` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL;

--
-- Constraints for table `documents`
--
ALTER TABLE `documents`
  ADD CONSTRAINT `documents_ibfk_1` FOREIGN KEY (`category_id`) REFERENCES `categories` (`category_id`),
  ADD CONSTRAINT `documents_ibfk_2` FOREIGN KEY (`type_id`) REFERENCES `document_types` (`type_id`),
  ADD CONSTRAINT `documents_ibfk_3` FOREIGN KEY (`folder_id`) REFERENCES `folders` (`folder_id`) ON DELETE SET NULL,
  ADD CONSTRAINT `documents_ibfk_4` FOREIGN KEY (`uploaded_by`) REFERENCES `users` (`id`);

--
-- Constraints for table `document_types`
--
ALTER TABLE `document_types`
  ADD CONSTRAINT `document_types_ibfk_1` FOREIGN KEY (`category_id`) REFERENCES `categories` (`category_id`) ON DELETE CASCADE;

--
-- Constraints for table `folders`
--
ALTER TABLE `folders`
  ADD CONSTRAINT `folders_ibfk_1` FOREIGN KEY (`parent_id`) REFERENCES `folders` (`folder_id`) ON DELETE CASCADE,
  ADD CONSTRAINT `folders_ibfk_2` FOREIGN KEY (`category_id`) REFERENCES `categories` (`category_id`) ON DELETE SET NULL,
  ADD CONSTRAINT `folders_ibfk_3` FOREIGN KEY (`type_id`) REFERENCES `document_types` (`type_id`) ON DELETE SET NULL;

--
-- Constraints for table `incoming_letters`
--
ALTER TABLE `incoming_letters`
  ADD CONSTRAINT `incoming_letters_ibfk_1` FOREIGN KEY (`document_id`) REFERENCES `documents` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `inventory_items`
--
ALTER TABLE `inventory_items`
  ADD CONSTRAINT `inventory_items_ibfk_1` FOREIGN KEY (`document_id`) REFERENCES `documents` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `notifications`
--
ALTER TABLE `notifications`
  ADD CONSTRAINT `notifications_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `notifications_ibfk_2` FOREIGN KEY (`document_id`) REFERENCES `documents` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `outgoing_letters`
--
ALTER TABLE `outgoing_letters`
  ADD CONSTRAINT `outgoing_letters_ibfk_1` FOREIGN KEY (`document_id`) REFERENCES `documents` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `role_permissions`
--
ALTER TABLE `role_permissions`
  ADD CONSTRAINT `role_permissions_ibfk_1` FOREIGN KEY (`permission_id`) REFERENCES `permissions` (`permission_id`) ON DELETE CASCADE;

--
-- Constraints for table `sk_records`
--
ALTER TABLE `sk_records`
  ADD CONSTRAINT `sk_records_ibfk_1` FOREIGN KEY (`document_id`) REFERENCES `documents` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `student_records`
--
ALTER TABLE `student_records`
  ADD CONSTRAINT `student_records_ibfk_1` FOREIGN KEY (`document_id`) REFERENCES `documents` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `teacher_records`
--
ALTER TABLE `teacher_records`
  ADD CONSTRAINT `teacher_records_ibfk_1` FOREIGN KEY (`document_id`) REFERENCES `documents` (`id`) ON DELETE CASCADE;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;