-- ============================================================================
-- Migration: audit_trail.document_id -> nullable
-- ============================================================================
-- ROOT CAUSE (Task 1 - Log System):
-- Kolom `document_id` pada tabel `audit_trail` didefinisikan NOT NULL.
-- Akibatnya, seluruh aktivitas yang TIDAK terikat pada satu dokumen spesifik
-- (login, logout, membuat folder, mengubah nama folder, menghapus folder,
-- serta proses OCR yang terjadi SEBELUM dokumen diupload/punya ID) tidak
-- pernah bisa dicatat ke audit_trail sama sekali — INSERT akan gagal karena
-- melanggar constraint NOT NULL.
--
-- Migration ini membuat document_id nullable agar aktivitas level-sistem
-- tersebut bisa dicatat dengan document_id = NULL, tanpa mengubah perilaku
-- untuk log yang memang terikat dokumen (upload/edit/delete/restore/
-- approve/reject/download), yang tetap mengisi document_id seperti biasa.
--
-- Cara menjalankan (TiDB / MySQL compatible):
--   mysql -h <DB_HOST> -P <DB_PORT> -u <DB_USER> -p <DB_NAME> < database/migration_audit_trail_nullable_document_id.sql
-- ============================================================================

ALTER TABLE `audit_trail`
  MODIFY COLUMN `document_id` int NULL;