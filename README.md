# Sakura DMS — Backend

Backend API untuk **Sakura DMS** (Document Management System) yang mengiringi frontend React di repo [`sakura_update`](https://github.com/aroliani/sakura_update).

## Tech Stack

Sesuai dokumen *Product Development & Operational Environment*:

| Layer            | Teknologi                                           |
| ---------------- | --------------------------------------------------- |
| Runtime          | **Node.js 18+**                                     |
| Framework        | **Express.js 4**                                    |
| Upload handler   | **Multer** (`multipart/form-data`, memory storage)  |
| Database         | **MySQL-compatible** (lokal: XAMPP / phpMyAdmin · produksi: **TiDB Cloud**) |
| Cloud Storage    | **Supabase Storage** (`@supabase/supabase-js`) — hanya untuk file fisik, metadata tetap di TiDB/MySQL |
| Auth             | **JWT** + **bcrypt** (hash password cost 10)        |
| Validasi         | **zod**                                             |
| Security         | helmet, cors, express-rate-limit                    |
| Dev tools        | nodemon, Postman                                    |
| Deploy           | **Railway** (backend) + **Netlify** (frontend)      |

---

## Struktur Folder

```
backend/
├── config/
│   └── db.js              # MySQL/TiDB connection pool (mysql2/promise)
├── services/
│   └── supabaseStorage.js # uploadFile, getFileUrl, downloadFileBuffer, deleteFile, checkFileExists ke Supabase Storage
├── middleware/
│   ├── auth.js            # JWT verify + signToken
│   ├── rbac.js            # requirePermission(key) / requireRole(...)
│   └── upload.js          # Multer memoryStorage + filter MIME
├── routes/
│   ├── auth.js            # register, login, me, change-password
│   ├── users.js           # CRUD user, approval pendaftaran, manage role
│   ├── categories.js      # Kategori + tipe dokumen
│   ├── folders.js         # Folder hierarkis + folder kustom
│   ├── documents.js       # Upload, approve, reject, edit, soft-delete, restore
│   ├── notifications.js   # Notifikasi per user
│   ├── audit.js           # Audit trail
│   └── roles.js           # Permission per role
├── database/
│   ├── schema.sql         # DDL lengkap (15 tabel)
│   └── seed.sql           # Data master + 3 user demo + permission default
├── scripts/
│   └── migrate.js         # Auto-run schema + seed + regenerate password hash
├── server.js              # Entry point Express
├── package.json
└── .env.example
```

---

## Cara Menjalankan (Lokal — XAMPP)

```bash
# 1. Install dependency
cd backend
npm install

# 2. Siapkan database (jalankan XAMPP → start Apache + MySQL)
#    Akses phpMyAdmin di http://localhost/phpmyadmin
#    Lalu copy isi backend/.env.example ke backend/.env dan sesuaikan.
cp .env.example .env

# 3. Migrasi + seed database (otomatis create db sakura_dms)
npm run db:migrate

# 4. Jalankan server (auto-reload)
npm run dev
# → http://localhost:5000
```

### User demo (password: `password123`)

| Email                       | Role            |
| --------------------------- | --------------- |
| `admin@sakura.sch.id`       | Operator/TU     |
| `principal@sakura.sch.id`   | Kepala Sekolah  |
| `teacher@sakura.sch.id`     | Guru            |

---

## Deploy ke Produksi

| Resource          | Layanan                              |
| ----------------- | ------------------------------------ |
| API server        | **Railway** (Node.js)                |
| Database          | **TiDB Cloud** (MySQL-compatible)    |
| File storage      | **Supabase Storage** (bucket sesuai `SUPABASE_STORAGE_BUCKET`) |
| Frontend          | **Netlify** (sudah ada)              |

Set environment variable di Railway mengikuti `.env.example`,
khususnya:

- `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_SSL=true`
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET`
- `JWT_SECRET` (string acak panjang)
- `CORS_ORIGIN=https://<nama-app>.netlify.app`

---

## Endpoint Utama

Base URL: `/api`

### Auth (`/api/auth`)
| Method | Path                | Deskripsi                                |
| ------ | ------------------- | ----------------------------------------- |
| POST   | `/register`         | Daftar baru → status `menunggu_approval` |
| POST   | `/login`            | Login → return JWT                       |
| GET    | `/me`               | Profil user dari token                   |
| POST   | `/change-password`  | Ganti password                           |

### Users (`/api/users`) — perlu JWT
- `GET /` · `GET /pending` · `POST /:id/activate` · `DELETE /:id/reject`
- `PATCH /:id/role` · `PATCH /:id/avatar` · `PATCH /:id`

### Documents (`/api/documents`) — perlu JWT
- `GET /` (query: `status`, `category_id`, `type_id`, `q`, `trashed`)
- `GET /:id` — detail + audit trail + metadata kategori
- `POST /` — **multipart/form-data**, field `file` + body JSON-ish:
  ```
  judul, category_id, type_id, folder_id?, tahun_ajaran?, catatan?, metadata (JSON)
  ```
  Backend:
  1. Multer parse file → buffer
  2. Upload buffer ke Supabase Storage → dapat `file_blob_name` (path) + `file_url`
  3. Generate nomor dokumen `PREFIX/YYYY/NNN` (transactional, baris counter dikunci `FOR UPDATE`)
  4. Insert ke `documents` (TiDB/MySQL) + tabel metadata sesuai kategori
  5. Tulis audit trail + notifikasi ke approver
- `POST /:id/approve` · `POST /:id/reject`
- `PATCH /:id`
- `DELETE /:id` (soft delete) · `POST /:id/restore` (validasi file masih ada di Supabase Storage sebelum dipulihkan) · `DELETE /:id/permanent` (hapus file di Supabase Storage juga)

### Folders, Categories, Notifications, Audit, Roles
Lihat masing-masing file di `routes/`.

---

## Skema Database

Lihat `database/schema.sql`. Ringkasan tabel:

1. `users` (+ kolom `password_hash` untuk bcrypt, `status` untuk approval)
2. `permissions` & `role_permissions` — RBAC dinamis (bisa di-toggle dari UI Role Management)
3. `categories`, `document_types` — master data sesuai mockData frontend
4. `folders` — hierarkis (`parent_id`), mendukung folder kustom (`is_custom = 1`)
5. `document_counters` — generator nomor dokumen per (prefix, tahun)
6. `documents` — entitas utama, simpan `file_url` (signed URL Supabase Storage) + `file_blob_name` (path di bucket, dipakai untuk get/download/delete)
7. **Metadata per kategori** (one-to-one ke `documents`):
   - `student_records`     → Data Siswa
   - `teacher_records`     → Data Guru
   - `inventory_items`     → Sarana Prasarana
   - `incoming_letters`    → Surat Masuk (type 10)
   - `outgoing_letters`    → Surat Keluar (type 11)
   - `sk_records`          → Surat Keputusan (type 12)
8. `notifications` — per-user, dipakai bell di navbar
9. `audit_trail` — log semua aksi pada dokumen

ERD bisa di-generate via **MySQL Workbench** → Reverse Engineer untuk dokumentasi.

---

## Integrasi dengan Frontend

Tambahkan di frontend (`src/lib/`):

```js
// src/lib/api.js
const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";

export async function api(path, { method = "GET", body, isForm = false } = {}) {
  const token = localStorage.getItem("sakura_token");
  const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  if (!isForm) headers["Content-Type"] = "application/json";
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: isForm ? body : body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  return res.json();
}
```

Login:
```js
const { token, user } = await api("/auth/login", { method: "POST", body: { email, password }});
localStorage.setItem("sakura_token", token);
localStorage.setItem("sakura_currentUser", JSON.stringify(user));
```

Upload dokumen:
```js
const fd = new FormData();
fd.append("file", file);
fd.append("judul", judul);
fd.append("category_id", categoryId);
fd.append("type_id", typeId);
fd.append("metadata", JSON.stringify(metadata));
await api("/documents", { method: "POST", body: fd, isForm: true });
```

---

## Keamanan

- ✅ Password di-hash bcrypt cost 10 — tidak pernah disimpan plaintext
- ✅ JWT expiry default 1 hari, secret dari env
- ✅ Rate limit pada endpoint `/api/auth/*`
- ✅ helmet + CORS whitelist origin
- ✅ Validasi input via zod
- ✅ Upload dibatasi MIME type & ukuran (`MAX_UPLOAD_MB`)
- ✅ MySQL pakai prepared statement (`mysql2`) — anti SQL injection
- ✅ RBAC dinamis: setiap endpoint penting di-gate via `requirePermission(...)`
- ✅ SSL ke TiDB Cloud via `DB_SSL=true`
- ✅ HTTPS handled by Railway / Netlify
- ✅ Supabase Storage bucket bersifat private — file hanya bisa diakses lewat backend (service_role key) atau signed URL sementara yang dikeluarkan backend

---

## Testing API

Gunakan **Postman**. Collection sederhana:

1. `POST /api/auth/login` → simpan `token`
2. Set header global `Authorization: Bearer {{token}}`
3. Tes `GET /api/documents`, `POST /api/documents` (form-data), dst.

---

## Setup Supabase Storage — Step by Step

Panduan ini menjelaskan cara mendapatkan 3 environment variable berikut:

```env
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_STORAGE_BUCKET=
```

### 1. Buat akun & project Supabase
1. Buka **https://supabase.com** → **Start your project** → login/sign up (bisa pakai GitHub).
2. Di dashboard, klik **New Project**.
3. Isi form: Organization, Name (mis. `sakura-dms`), Database Password (simpan baik-baik), Region (mis. Singapore), Plan (Free cukup untuk development).
4. Klik **Create new project**, tunggu ± 1–2 menit sampai provisioning selesai.

### 2. Ambil `SUPABASE_URL`
1. Buka **Project Settings** (ikon gear) → tab **API**.
2. Cari **Project URL**, bentuknya:
   ```
   https://xxxxxxxxxxxxx.supabase.co
   ```
3. Copy persis → itu nilai `SUPABASE_URL`.

### 3. Ambil `SUPABASE_SERVICE_ROLE_KEY`
Di **Project Settings → API Keys**, ada dua bagian:

| Bagian | Format key | Boleh dipakai di backend? |
|---|---|---|
| **Publishable key** | `sb_publishable_...` | ❌ Tidak — ini setara `anon key`, aman untuk browser/client, dibatasi RLS |
| **Secret keys** | `sb_secret_...` | ✅ Ya — ini setara `service_role key`, akses penuh, khusus server |

Langkah:
1. Scroll ke bagian **Secret keys**.
2. Klik ikon mata 👁️ pada key `default` untuk reveal nilainya.
3. Klik ikon copy di sebelahnya.
4. Itu nilai `SUPABASE_SERVICE_ROLE_KEY`.

⚠️ **Penting:**
- Key ini setara admin (bypass Row Level Security). **Jangan** commit ke Git, taruh di frontend, atau expose ke browser.
- Simpan hanya di environment variable backend (`.env` lokal yang di-gitignore, atau Railway Variables).

### 4. Buat Storage Bucket & ambil `SUPABASE_STORAGE_BUCKET`
1. Sidebar kiri → menu **Storage**.
2. Klik **New bucket**.
3. Isi **Name** (mis. `sakura-documents`), biarkan **Public bucket TIDAK dicentang** (private) — karena backend memakai `createSignedUrl` untuk URL sementara.
4. Klik **Create bucket**.
5. Nama bucket itu nilai `SUPABASE_STORAGE_BUCKET`.

### 5. Isi ke `.env` backend
```env
SUPABASE_URL=https://xxxxxxxxxxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sb_secret_xxxxxxxxxxxxxxxxxxxxxxxx
SUPABASE_STORAGE_BUCKET=sakura-documents
```

### 6. Uji koneksi lokal
```bash
cd sakura-backend_draft
npm install
npm run dev
```
Log startup harus menampilkan:
```
Supabase Storage OK — bucket: sakura-documents — Bucket OK
```
Atau cek `GET http://localhost:5000/api/health` → field `supabaseStorage.ok` harus `true`.

### 7. Set env var yang sama di Railway (produksi)
1. Buka project backend di dashboard **Railway** → tab **Variables**.
2. Tambahkan 3 variabel yang sama persis dengan nilai dari Supabase.
3. Redeploy service agar env var baru terbaca.

Setelah langkah ini, upload/delete/signed-URL dokumen sudah sepenuhnya berjalan lewat Supabase Storage, baik di lokal maupun di Railway.