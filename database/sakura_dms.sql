-- sakura_dms.approval_requests definition

CREATE TABLE `approval_requests` (
  `id` int NOT NULL,
`document_id` int NOT NULL,
`requester_id` int NOT NULL,
`approver_id` int DEFAULT NULL,
`status` enum('pending', 'approved', 'rejected', 'cancelled') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'pending',
`requester_note` text COLLATE utf8mb4_general_ci DEFAULT NULL,
`approver_note` text COLLATE utf8mb4_general_ci DEFAULT NULL,
`requested_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
`decided_at` datetime DEFAULT NULL,
PRIMARY KEY (`id`)/*T![clustered_index] NONCLUSTERED */
,
KEY `requester_id` (`requester_id`),
KEY `idx_ar_doc` (`document_id`),
KEY `idx_ar_status` (`status`),
KEY `idx_ar_approver` (`approver_id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_general_ci;
-- sakura_dms.audit_trail definition

CREATE TABLE `audit_trail` (
  `id` int NOT NULL,
`document_id` int NOT NULL,
`approval_request_id` int DEFAULT NULL,
`user_id` int DEFAULT NULL,
`action` varchar(500) COLLATE utf8mb4_general_ci NOT NULL,
`created_at` datetime DEFAULT CURRENT_TIMESTAMP,
`previous_hash` char(64) COLLATE utf8mb4_general_ci DEFAULT NULL,
`current_hash` char(64) COLLATE utf8mb4_general_ci DEFAULT NULL,
`old_value` json DEFAULT NULL,
`new_value` json DEFAULT NULL,
PRIMARY KEY (`id`)/*T![clustered_index] NONCLUSTERED */
,
KEY `user_id` (`user_id`),
KEY `idx_audit_doc` (`document_id`),
KEY `idx_audit_req` (`approval_request_id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_general_ci;
-- sakura_dms.categories definition

CREATE TABLE `categories` (
  `category_id` int NOT NULL,
`category_name` varchar(100) COLLATE utf8mb4_general_ci NOT NULL,
`code_prefix` varchar(10) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'OTH',
PRIMARY KEY (`category_id`)/*T![clustered_index] NONCLUSTERED */
,
UNIQUE KEY `category_name` (`category_name`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_general_ci;
-- sakura_dms.document_counters definition

CREATE TABLE `document_counters` (
  `prefix` varchar(10) COLLATE utf8mb4_general_ci NOT NULL,
`year` int NOT NULL,
`last_seq` int NOT NULL DEFAULT '0',
PRIMARY KEY (`prefix`,
`year`)/*T![clustered_index] NONCLUSTERED */
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_general_ci;
-- sakura_dms.document_types definition

CREATE TABLE `document_types` (
  `type_id` int NOT NULL,
`category_id` int NOT NULL,
`type_name` varchar(150) COLLATE utf8mb4_general_ci NOT NULL,
`code_prefix` varchar(10) COLLATE utf8mb4_general_ci NOT NULL,
PRIMARY KEY (`type_id`)/*T![clustered_index] NONCLUSTERED */
,
KEY `idx_doctype_cat` (`category_id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_general_ci;
-- sakura_dms.documents definition

CREATE TABLE `documents` (
  `id` int NOT NULL,
`judul` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
`nomor_dokumen` varchar(50) COLLATE utf8mb4_general_ci NOT NULL,
`category_id` int NOT NULL,
`type_id` int NOT NULL,
`folder_id` int DEFAULT NULL,
`tahun_ajaran` varchar(20) COLLATE utf8mb4_general_ci DEFAULT NULL,
`kelas` varchar(50) COLLATE utf8mb4_general_ci DEFAULT NULL,
`status` enum('Menunggu', 'Diarsipkan', 'Ditolak') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'Menunggu',
`versi` int NOT NULL DEFAULT '1',
`uploaded_by` int NOT NULL,
`file_url` varchar(1000) COLLATE utf8mb4_general_ci NOT NULL,
`file_blob_name` varchar(500) COLLATE utf8mb4_general_ci NOT NULL,
`file_size` bigint DEFAULT NULL,
`mime_type` varchar(120) COLLATE utf8mb4_general_ci DEFAULT NULL,
`original_filename` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
`catatan` text COLLATE utf8mb4_general_ci DEFAULT NULL,
`created_at` datetime DEFAULT CURRENT_TIMESTAMP,
`updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON
UPDATE
    CURRENT_TIMESTAMP,
    `deleted_at` datetime DEFAULT NULL,
    PRIMARY KEY (`id`)/*T![clustered_index] NONCLUSTERED */
    ,
    UNIQUE KEY `nomor_dokumen` (`nomor_dokumen`),
    KEY `folder_id` (`folder_id`),
    KEY `uploaded_by` (`uploaded_by`),
    KEY `idx_docs_status` (`status`),
    KEY `idx_docs_cat` (`category_id`),
    KEY `idx_docs_type` (`type_id`),
    KEY `idx_docs_deleted` (`deleted_at`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_general_ci;
-- sakura_dms.folders definition

CREATE TABLE `folders` (
  `folder_id` int NOT NULL,
`folder_name` varchar(150) COLLATE utf8mb4_general_ci NOT NULL,
`parent_id` int DEFAULT NULL,
`category_id` int DEFAULT NULL,
`type_id` int DEFAULT NULL,
`description` text COLLATE utf8mb4_general_ci DEFAULT NULL,
`is_custom` tinyint(1) NOT NULL DEFAULT '0',
`created_at` datetime DEFAULT CURRENT_TIMESTAMP,
PRIMARY KEY (`folder_id`)/*T![clustered_index] NONCLUSTERED */
,
KEY `category_id` (`category_id`),
KEY `type_id` (`type_id`),
KEY `idx_folders_parent` (`parent_id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_general_ci;
-- sakura_dms.incoming_letters definition

CREATE TABLE `incoming_letters` (
  `id` int NOT NULL,
`document_id` int NOT NULL,
`nomor_agenda` varchar(50) COLLATE utf8mb4_general_ci DEFAULT NULL,
`nomor_surat` varchar(50) COLLATE utf8mb4_general_ci DEFAULT NULL,
`tanggal_surat` date DEFAULT NULL,
`tanggal_diterima` date DEFAULT NULL,
`pengirim` varchar(200) COLLATE utf8mb4_general_ci DEFAULT NULL,
`perihal` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
PRIMARY KEY (`id`)/*T![clustered_index] NONCLUSTERED */
,
UNIQUE KEY `document_id` (`document_id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_general_ci;
-- sakura_dms.inventory_items definition

CREATE TABLE `inventory_items` (
  `id` int NOT NULL,
`document_id` int NOT NULL,
`kode_barang` varchar(50) COLLATE utf8mb4_general_ci DEFAULT NULL,
`nama_barang` varchar(150) COLLATE utf8mb4_general_ci DEFAULT NULL,
`jumlah` int DEFAULT NULL,
`tahun_pengadaan` varchar(10) COLLATE utf8mb4_general_ci DEFAULT NULL,
`kondisi` enum('Baik', 'Rusak Ringan', 'Rusak Berat') COLLATE utf8mb4_general_ci DEFAULT NULL,
`lokasi` varchar(150) COLLATE utf8mb4_general_ci DEFAULT NULL,
PRIMARY KEY (`id`)/*T![clustered_index] NONCLUSTERED */
,
UNIQUE KEY `document_id` (`document_id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_general_ci;
-- sakura_dms.notifications definition

CREATE TABLE `notifications` (
  `id` int NOT NULL,
`user_id` int NOT NULL,
`message` varchar(500) COLLATE utf8mb4_general_ci NOT NULL,
`type` varchar(40) COLLATE utf8mb4_general_ci DEFAULT 'info',
`document_id` int DEFAULT NULL,
`is_read` tinyint(1) NOT NULL DEFAULT '0',
`created_at` datetime DEFAULT CURRENT_TIMESTAMP,
PRIMARY KEY (`id`)/*T![clustered_index] NONCLUSTERED */
,
KEY `document_id` (`document_id`),
KEY `idx_notif_user` (`user_id`,
`is_read`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_general_ci;
-- sakura_dms.outgoing_letters definition

CREATE TABLE `outgoing_letters` (
  `id` int NOT NULL,
`document_id` int NOT NULL,
`nomor_agenda` varchar(50) COLLATE utf8mb4_general_ci DEFAULT NULL,
`nomor_surat` varchar(50) COLLATE utf8mb4_general_ci DEFAULT NULL,
`tanggal_surat` date DEFAULT NULL,
`tujuan` varchar(200) COLLATE utf8mb4_general_ci DEFAULT NULL,
`perihal` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
`penandatangan` varchar(150) COLLATE utf8mb4_general_ci DEFAULT NULL,
PRIMARY KEY (`id`)/*T![clustered_index] NONCLUSTERED */
,
UNIQUE KEY `document_id` (`document_id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_general_ci;
-- sakura_dms.permissions definition

CREATE TABLE `permissions` (
  `permission_id` int NOT NULL,
`permission_key` varchar(80) COLLATE utf8mb4_general_ci NOT NULL,
`description` varchar(255) COLLATE utf8mb4_general_ci DEFAULT '',
PRIMARY KEY (`permission_id`)/*T![clustered_index] NONCLUSTERED */
,
UNIQUE KEY `permission_key` (`permission_key`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_general_ci;
-- sakura_dms.role_permissions definition

CREATE TABLE `role_permissions` (
  `role_name` enum('Kepala Sekolah', 'Operator/TU', 'Guru') COLLATE utf8mb4_general_ci NOT NULL,
`permission_id` int NOT NULL,
PRIMARY KEY (`role_name`,
`permission_id`)/*T![clustered_index] NONCLUSTERED */
,
KEY `permission_id` (`permission_id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_general_ci;
-- sakura_dms.sk_records definition

CREATE TABLE `sk_records` (
  `id` int NOT NULL,
`document_id` int NOT NULL,
`nomor_sk` varchar(50) COLLATE utf8mb4_general_ci DEFAULT NULL,
`tanggal_sk` date DEFAULT NULL,
`tentang` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
`penandatangan` varchar(150) COLLATE utf8mb4_general_ci DEFAULT NULL,
PRIMARY KEY (`id`)/*T![clustered_index] NONCLUSTERED */
,
UNIQUE KEY `document_id` (`document_id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_general_ci;
-- sakura_dms.student_records definition

CREATE TABLE `student_records` (
  `id` int NOT NULL,
`document_id` int NOT NULL,
`nama_siswa` varchar(150) COLLATE utf8mb4_general_ci DEFAULT NULL,
`nis` varchar(30) COLLATE utf8mb4_general_ci DEFAULT NULL,
`nisn` varchar(30) COLLATE utf8mb4_general_ci DEFAULT NULL,
`kelas` varchar(50) COLLATE utf8mb4_general_ci DEFAULT NULL,
`tahun_ajaran` varchar(20) COLLATE utf8mb4_general_ci DEFAULT NULL,
`tempat_lahir` varchar(100) COLLATE utf8mb4_general_ci DEFAULT NULL,
`tanggal_lahir` date DEFAULT NULL,
`jenis_kelamin` enum('Laki-laki', 'Perempuan') COLLATE utf8mb4_general_ci DEFAULT NULL,
`nama_orang_tua` varchar(150) COLLATE utf8mb4_general_ci DEFAULT NULL,
`no_hp_orang_tua` varchar(20) COLLATE utf8mb4_general_ci DEFAULT NULL,
PRIMARY KEY (`id`)/*T![clustered_index] NONCLUSTERED */
,
UNIQUE KEY `document_id` (`document_id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_general_ci;
-- sakura_dms.teacher_records definition

CREATE TABLE `teacher_records` (
  `id` int NOT NULL,
`document_id` int NOT NULL,
`nama_guru` varchar(150) COLLATE utf8mb4_general_ci DEFAULT NULL,
`nip` varchar(30) COLLATE utf8mb4_general_ci DEFAULT NULL,
`nuptk` varchar(30) COLLATE utf8mb4_general_ci DEFAULT NULL,
`mata_pelajaran` varchar(100) COLLATE utf8mb4_general_ci DEFAULT NULL,
`pendidikan_terakhir` varchar(100) COLLATE utf8mb4_general_ci DEFAULT NULL,
`status_kepegawaian` enum('PNS', 'PPPK', 'Honorer', 'GTT') COLLATE utf8mb4_general_ci DEFAULT NULL,
PRIMARY KEY (`id`)/*T![clustered_index] NONCLUSTERED */
,
UNIQUE KEY `document_id` (`document_id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_general_ci;
-- sakura_dms.users definition

CREATE TABLE `users` (
  `id` int NOT NULL,
`nama` varchar(120) COLLATE utf8mb4_general_ci NOT NULL,
`email` varchar(150) COLLATE utf8mb4_general_ci NOT NULL,
`password_hash` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
`role` enum('Kepala Sekolah', 'Operator/TU', 'Guru') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'Guru',
`departemen` varchar(120) COLLATE utf8mb4_general_ci DEFAULT '',
`nip` varchar(50) COLLATE utf8mb4_general_ci DEFAULT '',
`avatar` mediumtext COLLATE utf8mb4_general_ci DEFAULT NULL,
`is_2fa_enabled` tinyint(1) NOT NULL DEFAULT '0',
`otp_hash` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
`otp_expires_at` datetime DEFAULT NULL,
`otp_used` tinyint(1) NOT NULL DEFAULT '0',
`otp_attempts` tinyint(1) NOT NULL DEFAULT '0',
`status` enum('active', 'menunggu_approval', 'nonaktif') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'menunggu_approval',
`is_online` tinyint(1) NOT NULL DEFAULT '0',
`last_seen_at` datetime DEFAULT NULL,
`created_at` datetime DEFAULT CURRENT_TIMESTAMP,
`updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON
UPDATE
    CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`)/*T![clustered_index] NONCLUSTERED */
    ,
    UNIQUE KEY `email` (`email`),
    KEY `idx_users_status` (`status`),
    KEY `idx_users_role` (`role`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_general_ci;
