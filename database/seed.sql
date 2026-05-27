-- =====================================================
-- Sakura DMS — Seed Data
-- Jalankan SETELAH schema.sql
-- Default password untuk semua user demo: "password123"
-- Hash bcrypt di bawah dihasilkan dengan cost 10.
-- =====================================================
USE sakura_dms;

-- ====== USERS (password = "password123") ======
INSERT INTO users (id, nama, email, password_hash, role, departemen, nip, status) VALUES
(1, 'Budi Santoso',       'admin@sakura.sch.id',     '$2b$10$Yk1lN3qK3iVbpZkX7CkqHuq9b8gQK0EJ6w1n8e8x3PvW6gXG.bX3a', 'Operator/TU',     'Operator / TU',         '',              'active'),
(2, 'Dr. Siti Rahayu',    'principal@sakura.sch.id', '$2b$10$Yk1lN3qK3iVbpZkX7CkqHuq9b8gQK0EJ6w1n8e8x3PvW6gXG.bX3a', 'Kepala Sekolah',  'Kepala Sekolah',        '',              'active'),
(3, 'Ahmad Fauzi',        'teacher@sakura.sch.id',   '$2b$10$Yk1lN3qK3iVbpZkX7CkqHuq9b8gQK0EJ6w1n8e8x3PvW6gXG.bX3a', 'Guru',            'Guru Mata Pelajaran',   '198723450001',  'active');

-- ====== PERMISSIONS ======
INSERT INTO permissions (permission_key, description) VALUES
('documents.upload',  'Mengunggah dokumen baru'),
('documents.edit',    'Mengedit metadata dokumen'),
('documents.delete',  'Menghapus / memulihkan dokumen'),
('documents.approve', 'Menyetujui dokumen yang menunggu'),
('documents.reject',  'Menolak dokumen yang menunggu'),
('documents.view',    'Melihat dokumen'),
('folders.manage',    'Membuat/edit/hapus folder kustom'),
('users.view',        'Melihat daftar user'),
('users.manage',      'Mengelola profil user'),
('users.approve',     'Approve/reject pendaftaran user baru'),
('users.manageRole',  'Mengubah role user'),
('roles.manage',      'Mengelola permission per role'),
('audit.view',        'Melihat audit log'),
('audit.addNote',     'Menambah catatan admin pada dokumen');

-- ====== ROLE PERMISSIONS ======
-- Kepala Sekolah → semua kecuali manageRole hanya untuk Operator/TU
INSERT INTO role_permissions (role_name, permission_id)
SELECT 'Kepala Sekolah', permission_id FROM permissions
WHERE permission_key IN (
  'documents.view','documents.approve','documents.reject','documents.edit',
  'documents.delete','audit.view','audit.addNote','users.view'
);

-- Operator/TU → administrasi penuh
INSERT INTO role_permissions (role_name, permission_id)
SELECT 'Operator/TU', permission_id FROM permissions
WHERE permission_key IN (
  'documents.upload','documents.edit','documents.delete','documents.view',
  'documents.approve','documents.reject',
  'folders.manage','users.view','users.manage','users.approve','users.manageRole',
  'roles.manage','audit.view','audit.addNote'
);

-- Guru → upload & lihat dokumennya
INSERT INTO role_permissions (role_name, permission_id)
SELECT 'Guru', permission_id FROM permissions
WHERE permission_key IN ('documents.upload','documents.view','documents.edit');

-- ====== CATEGORIES ======
INSERT INTO categories (category_id, category_name) VALUES
(1, 'Data Siswa'),
(2, 'Data Guru'),
(3, 'Sarana Prasarana'),
(4, 'Surat Menyurat');

-- ====== DOCUMENT TYPES ======
INSERT INTO document_types (type_id, category_id, type_name, code_prefix) VALUES
(1,  1, 'Buku Klapper',                                'BKL'),
(2,  1, 'Buku Induk Register Peserta Didik',           'BIR'),
(3,  1, 'Surat Keterangan Hasil Ujian (SKHU)',         'SKH'),
(4,  1, 'Ijazah SMP',                                  'IJZ'),
(5,  2, 'Buku Induk Pegawai',                          'BIP'),
(6,  2, 'Sertifikat Pendidik',                         'SRP'),
(7,  2, 'Catatan Diklat',                              'CDK'),
(8,  3, 'Buku Inventaris Barang dan Penghapusan Barang','BIB'),
(9,  3, 'Buku Pemeliharaan & Perbaikan',               'BPP'),
(10, 4, 'Buku Agenda Surat Masuk',                     'ASM'),
(11, 4, 'Buku Agenda Surat Keluar',                    'ASK'),
(12, 4, 'Kumpulan Surat Keputusan (SK)',               'KSK'),
(13, 4, 'Lainnya',                                     'LNR');

-- ====== FOLDERS (hierarki sesuai mockData.js) ======
INSERT INTO folders (folder_id, folder_name, parent_id, category_id, type_id, description, is_custom) VALUES
(1,  'Data Siswa',         NULL, 1, NULL, 'Berisi dokumen administrasi siswa.', 0),
(2,  'Data Guru',           NULL, 2, NULL, 'Berisi dokumen kepegawaian guru.', 0),
(3,  'Sarana Prasarana',    NULL, 3, NULL, 'Berisi dokumen inventaris sekolah.', 0),
(4,  'Surat Menyurat',      NULL, 4, NULL, 'Berisi arsip surat masuk, keluar, dan SK.', 0),

(10, 'Buku Klapper',                              1, 1, 1,  'Daftar nama siswa berdasarkan abjad.', 0),
(11, 'Buku Induk Register Peserta Didik',         1, 1, 2,  'Data lengkap peserta didik.', 0),
(12, 'Surat Keterangan Hasil Ujian (SKHU)',       1, 1, 3,  'Arsip SKHU siswa.', 0),
(13, 'Ijazah SMP',                                1, 1, 4,  'Arsip ijazah SMP.', 0),

(20, 'Buku Induk Pegawai',                        2, 2, 5,  'Data pokok pegawai.', 0),
(21, 'Sertifikat Pendidik',                       2, 2, 6,  'Arsip sertifikat pendidik.', 0),
(22, 'Catatan Diklat',                            2, 2, 7,  'Catatan pelatihan & pendidikan guru.', 0),

(30, 'Buku Inventaris Barang dan Penghapusan Barang', 3, 3, 8, 'Daftar inventaris sekolah.', 0),
(31, 'Buku Pemeliharaan & Perbaikan',                 3, 3, 9, 'Catatan pemeliharaan sarana.', 0),

(40, 'Buku Agenda Surat Masuk',                   4, 4, 10, 'Arsip surat masuk.', 0),
(41, 'Buku Agenda Surat Keluar',                  4, 4, 11, 'Arsip surat keluar.', 0),
(42, 'Kumpulan Surat Keputusan (SK)',             4, 4, 12, 'Arsip SK resmi sekolah.', 0),
(43, 'Lainnya',                                   4, 4, 13, 'Dokumen lain-lain.', 0);
