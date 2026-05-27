# Sakura DMS — Backend

Backend API untuk **Sakura DMS** (Document Management System) yang mengiringi frontend React di repo [`sakura_update`](https://github.com/aroliani/sakura_update).

## Tech Stack

Sesuai dokumen *Product Development & Operational Environment*:

| Layer            | Teknologi                                           |
| ---------------- | --------------------------------------------------- |
| Runtime          | **Node.js 18+**                                     |
| Framework        | **Express.js 4**                                    |
| Upload handler   | **Multer** (`multipart/form-data`, memory storage)  |
| Database         | **MySQL 8** (lokal: XAMPP / phpMyAdmin · produksi: Azure Database for MySQL) |
| Cloud Storage    | **Azure Blob Storage** (`@azure/storage-blob`)      |
| Auth             | **JWT** + **bcrypt** (hash password cost 10)        |
| Validasi         | **zod**                                             |
| Security         | helmet, cors, express-rate-limit                    |
| Dev tools        | nodemon, Postman                                    |
| Deploy           | Azure App Service                                   |

---

## Struktur Folder

```
backend/
├── config/
│   ├── db.js              # MySQL connection pool (mysql2/promise)
│   └── azureBlob.js       # Helper upload/delete ke Azure Blob Storage
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
| API server        | **Azure App Service** (Node.js)      |
| Database          | **Azure Database for MySQL**         |
| File storage      | **Azure Blob Storage** (container `sakura-documents`) |
| Frontend          | **Netlify** (sudah ada)              |

Set environment variable di Azure App Service mengikuti `.env.example`,
khususnya:

- `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_SSL=true`
- `AZURE_STORAGE_CONNECTION_STRING`
- `JWT_SECRET` (string acak panjang)
- `CORS_ORIGIN=https://<nama-app>.netlify.app`

---

## Endpoint Utama

Base URL: `/api`

### Auth (`/api/auth`)
| Method | Path                | Deskripsi                                |
| ------ | ------------------- | ---------------------------------------- |
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
  2. Upload buffer ke Azure Blob → dapat URL
  3. Generate nomor dokumen `PREFIX/YYYY/NNN` (transactional, baris counter dikunci `FOR UPDATE`)
  4. Insert ke `documents` + tabel metadata sesuai kategori
  5. Tulis audit trail + notifikasi ke approver
- `POST /:id/approve` · `POST /:id/reject`
- `PATCH /:id`
- `DELETE /:id` (soft delete) · `POST /:id/restore` · `DELETE /:id/permanent` (hapus blob juga)

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
6. `documents` — entitas utama, simpan URL Azure Blob + `file_blob_name` untuk delete
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
- ✅ SSL ke Azure MySQL via `DB_SSL=true`
- ✅ HTTPS handled by Azure App Service / Netlify

---

## Testing API

Gunakan **Postman**. Collection sederhana:

1. `POST /api/auth/login` → simpan `token`
2. Set header global `Authorization: Bearer {{token}}`
3. Tes `GET /api/documents`, `POST /api/documents` (form-data), dst.
