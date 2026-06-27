/**
 * Script perbaikan satu kali untuk data lama.
 *
 * Masalah: ada baris `approval_requests` yang masih berstatus 'pending'
 * padahal dokumen terkait (`documents.status`) sudah final (Diarsipkan/Ditolak),
 * karena pernah diputuskan lewat jalur lain (mis. endpoint /api/documents/:id/approve
 * yang hanya pernah update sebagian baris pending, atau percobaan approve ganda).
 *
 * Akibatnya:
 *  - Halaman "Antrian Persetujuan" (pending) menampilkan dokumen yang
 *    sebenarnya sudah diputuskan.
 *  - Klik "Setujui"/"Tolak" pada baris tersebut selalu gagal dengan error
 *    "Dokumen tidak dalam status Menunggu".
 *  - Halaman "Disetujui" (riwayat approved/rejected) kosong karena baris
 *    approval_requests yang relevan tidak pernah berstatus approved/rejected.
 *
 * Cara pakai:
 *   cd backend
 *   node scripts/fix-orphan-approvals.js
 *
 * Script ini IDEMPOTENT — aman dijalankan berkali-kali, hanya akan mengubah
 * baris yang benar-benar tidak konsisten.
 */

require("dotenv").config();
const pool = require("../config/db");

async function main() {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [orphans] = await conn.query(
      `SELECT ar.id, ar.document_id, d.judul, d.status AS doc_status
       FROM approval_requests ar
       JOIN documents d ON d.id = ar.document_id
       WHERE ar.status = 'pending' AND d.status != 'Menunggu'`
    );

    if (orphans.length === 0) {
      console.log("✓ Tidak ada approval_requests yatim. Data sudah konsisten.");
      await conn.rollback();
      return;
    }

    console.log(`Ditemukan ${orphans.length} approval_requests yatim:\n`);
    for (const o of orphans) {
      console.log(`  - request #${o.id} | dokumen "${o.judul}" (id=${o.document_id}) | status dokumen saat ini: ${o.doc_status}`);
    }
    console.log("");

    for (const o of orphans) {
      const resolvedStatus = o.doc_status === "Ditolak" ? "rejected" : "approved";
      await conn.query(
        `UPDATE approval_requests
           SET status = ?, decided_at = COALESCE(decided_at, NOW())
         WHERE id = ?`,
        [resolvedStatus, o.id]
      );
      await conn.query(
        `INSERT INTO audit_trail (document_id, approval_request_id, user_id, action)
         VALUES (?, ?, NULL, ?)`,
        [o.document_id, o.id, "Status permintaan disinkronkan otomatis dengan status dokumen terkini (perbaikan data)"]
      );
      console.log(`  ✓ request #${o.id} disinkronkan -> ${resolvedStatus}`);
    }

    await conn.commit();
    console.log(`\n✓ Selesai. ${orphans.length} baris approval_requests telah disinkronkan.`);
  } catch (e) {
    await conn.rollback();
    console.error("✗ Gagal menjalankan perbaikan:", e.message);
    process.exitCode = 1;
  } finally {
    conn.release();
    await pool.end();
  }
}

main();