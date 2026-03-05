require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const bodyParser = require('body-parser');
const multer = require('multer');
const session = require('express-session');

const app = express();
const port = process.env.PORT || 3000;

// --- 1. KONEKSI DATABASE (PostgreSQL) ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const db = {
    query: (text, params) => pool.query(text, params),
    get: async (text, params) => {
        const res = await pool.query(text, params);
        return res.rows[0];
    },
    all: async (text, params) => {
        const res = await pool.query(text, params);
        return res.rows;
    }
};

pool.on('error', (err) => {
    console.error('🔥 Unexpected error on idle client', err);
    process.exit(-1);
});

// --- 2. KONEKSI STORAGE (Supabase SDK) ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

let supabase = null;
if (supabaseUrl && supabaseKey) {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(supabaseUrl, supabaseKey);
} else {
    console.warn("⚠️ Supabase URL/Key tidak ditemukan. Fitur Storage mungkin tidak jalan.");
}
// --- 3. KONFIGURASI MULTER (Memory Storage) ---
// File tidak disimpan di disk Vercel, tapi ditampung di RAM untuk diteruskan ke Supabase
const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 2 * 1024 * 1024 } // Batas 2MB
});

// --- 4. MIDDLEWARE DASAR ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
    secret: process.env.SESSION_SECRET || 'kunci-rahasia-tatriz',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 3600000 }
}));

// --- RUTE HALAMAN LOGIN ---
app.get('/', async (req, res) => {
    try {
        // Cek apakah sudah ada tenant di sistem untuk memunculkan link setup awal
        const result = await db.query("SELECT COUNT(*) as jml FROM settings");
        const isNewSystem = (result.rows[0].jml === '0'); // PostgreSQL mengembalikan count sebagai string

        res.render('login', { 
            isNew: isNewSystem 
        });
    } catch (err) {
        console.error(err);
        res.render('login', { isNew: false });
    }
});

// --- PROSES LOGIN ---
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    
    try {
        const sql = `
            SELECT u.*, s.level, s.password_admin 
            FROM users u 
            LEFT JOIN settings s ON u.tenant_id = s.tenant_id 
            WHERE u.username = $1
        `;
        
        const user = await db.get(sql, [username]);

        if (user && user.password === password) {
            // Simpan data ke Session
            req.session.userId = user.id;
            req.session.role = user.role;
            req.session.tenantId = user.tenant_id;
            req.session.tenantLevel = user.level || 1;

            if (user.role === 'admin') {
                return res.redirect('/dashboard');
            }
            return res.redirect('/operator');
        } else {
            return res.send("<script>alert('Login Gagal! Username atau Password salah.'); window.location='/';</script>");
        }
    } catch (err) {
        console.error("🔥 Login Error:", err.message);
        res.status(500).send("Terjadi kesalahan pada database.");
    }
});

app.use(async (req, res, next) => {
    // Data default
    res.locals.config = { 
        nama_aplikasi: "Tatriz System", 
        nama_perusahaan: "Tatriz", 
        logo_path: "default.png",
        target_bonus: 500000,
        nominal_buffer: 0,
        beban_tetap: 0
    };
    res.locals.uangKunci = { saldoLaci: 0, totalUangDikunci: 0, profitBolehAmbil: 0, statusAman: true };
    res.locals.user = req.session || {};

    const tId = req.session ? req.session.tenantId : null;
    if (!tId) return next();

    try {
        const bulanIni = new Date().toISOString().slice(0, 7); // Format: YYYY-MM

        // 1. Ambil Settings
        const config = await db.get("SELECT * FROM settings WHERE tenant_id = $1", [tId]);
        if (config) {
            res.locals.config = config;
            if (!res.locals.config.logo_path) res.locals.config.logo_path = "default.png";
        }

        // 2. Hitung Saldo Kas Riil
        const saldoRes = await db.get(`
            SELECT SUM(CASE WHEN jenis = 'PEMASUKAN' THEN jumlah ELSE -jumlah END) as saldo 
            FROM arus_kas WHERE tenant_id = $1`, [tId]);
        
        // 3. Hitung Beban Kontrakan Terbayar (Perbaikan query LIKE untuk Postgres)
        const bebanRes = await db.get(`
            SELECT SUM(jumlah) as terbayar FROM arus_kas 
            WHERE kategori = 'BIAYA KONTRAKAN' 
            AND CAST(tanggal AS TEXT) LIKE $1 
            AND tenant_id = $2`, 
            [bulanIni + '%', tId]);

        const saldoLaci = parseFloat(saldoRes?.saldo || 0);
        const terbayar = parseFloat(bebanRes?.terbayar || 0);
        const conf = res.locals.config;
        
        // Logika Uang Dikunci
        const sisaBeban = (terbayar >= (parseFloat(conf.beban_tetap) || 0)) ? 0 : (parseFloat(conf.beban_tetap) || 0);
        const uangDikunci = (parseFloat(conf.nominal_buffer) || 0) + sisaBeban;

        res.locals.uangKunci = {
            saldoLaci,
            totalUangDikunci: uangDikunci,
            profitBolehAmbil: saldoLaci - uangDikunci,
            statusAman: (saldoLaci - uangDikunci) >= 0
        };

        next();
    } catch (err) {
        console.error("🔥 DATABASE ERROR:", err.message);
        // Jika DB error, jangan lempar ke 404, tapi lanjut saja dengan data kosong
        res.locals.config = { nama_perusahaan: "Tatriz (Offline)" };
        next(); 
    }
});

app.get('/dashboard', async (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    const tId = req.session.tenantId;

    try {
        // 1. Statistik Status PO (Sudah benar)
        const stats = await db.get(`
            SELECT 
                COUNT(CASE WHEN status = 'Design' THEN 1 END) as jml_design,
                COUNT(CASE WHEN status = 'Produksi' THEN 1 END) as jml_produksi,
                COUNT(CASE WHEN status = 'Clear' THEN 1 END) as jml_invoice,
                COUNT(CASE WHEN status = 'DP/Cicil' THEN 1 END) as jml_cicil
            FROM po_utama WHERE tenant_id = $1`, [tId]);

        // 2. Hitung Total Piutang (Sudah benar)
        const piutangRes = await db.get(`
            SELECT (
                COALESCE((SELECT SUM(total_harga_customer) FROM po_utama WHERE tenant_id = $1), 0) - 
                COALESCE((SELECT SUM(jumlah) FROM arus_kas WHERE kategori IN ('PEMBAYARAN BORDIR', 'PELUNASAN', 'DP/CICILAN') AND tenant_id = $1), 0)
            ) as total_piutang`, [tId]);

        // 3. Cek Masalah Produksi (DIPERBAIKI: Tambahkan d.jumlah ke GROUP BY)
        const masalahRes = await db.get(`
            SELECT COUNT(*) as total FROM (
                SELECT h.detail_id 
                FROM hasil_kerja h 
                JOIN po_detail d ON h.detail_id = d.id 
                WHERE h.tenant_id = $1 
                GROUP BY h.detail_id, d.jumlah 
                HAVING SUM(h.jumlah_setor) > d.jumlah
            ) as subquery`, [tId]);

        res.render('dashboard', {
            stats: stats || { jml_design: 0, jml_produksi: 0, jml_invoice: 0, jml_cicil: 0 },
            totalPiutangSemua: parseFloat(piutangRes?.total_piutang || 0),
            jumlahMasalah: parseInt(masalahRes?.total || 0)
        });

    } catch (err) {
        console.error("🔥 Dashboard Error:", err.message);
        res.status(500).send("Gagal memuat dashboard: " + err.message);
    }
});


app.post('/save-settings-all', upload.single('logo'), async (req, res) => {
    const tId = req.session.tenantId;
    if (!tId) return res.redirect('/');

    const { 
        nama_perusahaan, alamat, no_hp, nominal_buffer, 
        target_bonus, nominal_bonus_dasar, beban_tetap 
    } = req.body;

    try {
        let logoUrl = null;

        // 1. Proses Upload Logo ke Supabase (Jika ada file)
        if (req.file) {
            const fileName = `logo-${tId}-${Date.now()}${path.extname(req.file.originalname)}`;
            
            const { data, error } = await supabase.storage
                .from('uploads')
                .upload(fileName, req.file.buffer, {
                    contentType: req.file.mimetype,
                    upsert: true
                });

            if (error) throw error;

            const { data: publicData } = supabase.storage
                .from('uploads')
                .getPublicUrl(fileName);
            
            logoUrl = publicData.publicUrl;
        }

        // 2. Susun Parameter Dasar (Selalu Ada)
        let params = [
            nama_perusahaan, 
            alamat, 
            no_hp, 
            parseFloat(nominal_buffer) || 0, 
            parseFloat(target_bonus) || 0, 
            parseFloat(nominal_bonus_dasar) || 0, 
            parseFloat(beban_tetap) || 0
        ];

        // 3. Susun Query SQL
        let sql = `UPDATE settings SET 
                    nama_perusahaan = $1, 
                    alamat = $2, 
                    no_hp = $3, 
                    nominal_buffer = $4, 
                    target_bonus = $5, 
                    nominal_bonus_dasar = $6, 
                    beban_tetap = $7`;

        if (logoUrl) {
            // Jika ada logo, logo_path jadi $8, tenant_id jadi $9
            sql += `, logo_path = $8 WHERE tenant_id = $9`;
            params.push(logoUrl, tId);
        } else {
            // Jika tidak ada logo, tenant_id jadi $8
            sql += ` WHERE tenant_id = $8`;
            params.push(tId);
        }

        await db.query(sql, params);
        res.send("<script>alert('Pengaturan Berhasil Disimpan!'); window.location='/dashboard';</script>");

    } catch (err) {
        console.error("🔥 Save Settings Error:", err.message);
        // Tip: Pastikan bucket 'uploads' sudah ada di Supabase Storage dan aksesnya PUBLIC
        res.status(500).send("Gagal menyimpan pengaturan: " + err.message);
    }
});

// Menampilkan Halaman Register
app.get('/register', (req, res) => {
    res.render('register');
});

// Proses Pendaftaran Tenant
app.post('/register-tenant', async (req, res) => {
    const { nama_toko, username, password } = req.body;

    try {
        const row = await db.get("SELECT MAX(tenant_id) as maxid FROM settings");
        let currentMax = parseInt(row?.maxid || 0);
        let newTenantId = (currentMax < 100) ? 100 : currentMax + 1;

        await db.query("BEGIN");
        
        // --- PERBAIKAN DI SINI ---
        // Ada 4 Kolom: tenant_id, nama_perusahaan, level, nama_aplikasi
        // Maka harus ada 4 buah $ ( $1, $2, $3, $4 )
        await db.query(
            "INSERT INTO settings (tenant_id, nama_perusahaan, level, nama_aplikasi) VALUES ($1, $2, 1, $3)",
            [newTenantId, nama_toko, 'TATRIZ ONLINE']
        );

        // Simpan Akun User
        await db.query(
            "INSERT INTO users (tenant_id, username, password, role, nama_lengkap) VALUES ($1, $2, $3, 'admin', $4)",
            [newTenantId, username, password, 'Owner ' + nama_toko]
        );

        await db.query("COMMIT");
        res.send("<script>alert('Pendaftaran Berhasil!'); window.location='/';</script>");

    } catch (err) {
        await db.query("ROLLBACK");
        console.error("🔥 Register Error:", err.message);
        res.send("<script>alert('Gagal mendaftar: " + err.message + "'); window.history.back();</script>");
    }
});

// Middleware Cek Admin (Proteksi)
function isAdmin(req, res, next) {
    if (req.session && req.session.userId && req.session.role === 'admin') {
        return next();
    }
    res.send("<script>alert('Sesi habis atau bukan Admin.'); window.location='/';</script>");
}

// Halaman Verifikasi Password Admin
app.get('/setup-auth', isAdmin, async (req, res) => {
    res.render('setup-auth');
});

// Proses Verifikasi Password Admin
app.post('/setup-auth', isAdmin, async (req, res) => {
    const { password } = req.body;
    const tId = req.session.tenantId;

    
    try {
        const row = await db.get("SELECT password_admin, password FROM settings s JOIN users u ON s.tenant_id = u.tenant_id WHERE s.tenant_id = $1 AND u.id = $2", [tId, req.session.userId]);
        
        // Cek password_admin di settings, jika kosong gunakan password login user
        const correctPassword = row?.password_admin || row?.password;

        if (password === correctPassword) {
            req.session.isAdminSetup = true; // Beri izin akses halaman setup
            res.redirect('/setup');
        } else {
            res.send("<script>alert('Password Salah!'); window.location='/setup-auth';</script>");
        }
    } catch (err) {
        res.status(500).send("Error Verifikasi");
    }
});

// Halaman Pengaturan Utama
app.get('/setup', isAdmin, async (req, res) => {
    if (!req.session.isAdminSetup) return res.redirect('/setup-auth');
    
    const tId = req.session.tenantId;
    try {
        const machines = await db.all("SELECT * FROM mesin WHERE tenant_id = $1 ORDER BY id ASC", [tId]);
        res.render('setup', { machines });
    } catch (err) {
        res.status(500).send("Error Load Setup");
    }
});

// Simpan atau Edit Mesin
app.post('/save-mesin', isAdmin, async (req, res) => {
    const tId = req.session.tenantId;
    const { mesin_id, nama_mesin } = req.body;

    try {
        if (mesin_id) {
            await db.query("UPDATE mesin SET nama_mesin = $1 WHERE id = $2 AND tenant_id = $3", [nama_mesin, mesin_id, tId]);
        } else {
            await db.query("INSERT INTO mesin (tenant_id, nama_mesin) VALUES ($1, $2)", [tId, nama_mesin]);
        }
        res.redirect('/setup');
    } catch (err) {
        res.status(500).send("Error Simpan Mesin");
    }
});

// Hapus Mesin
app.get('/delete-mesin/:id', isAdmin, async (req, res) => {
    try {
        await db.query("DELETE FROM mesin WHERE id = $1 AND tenant_id = $2", [req.params.id, req.session.tenantId]);
        res.redirect('/setup');
    } catch (err) {
        res.status(500).send("Error Hapus Mesin");
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error("🔥 Logout Error:", err);
        }
        res.redirect('/'); // Lempar kembali ke halaman login
    });
});

//RUTE PO BARU
app.get('/po-baru', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    // Data user sudah dikirim otomatis via middleware res.locals.user
    res.render('po-baru');
});

app.post('/save-po', async (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    
    const tId = req.session.tenantId;
    const { tanggal, nama_po, customer, status, jenis_bordir, nama_desain, jumlah, harga_operator, harga_customer } = req.body;

    // Pastikan data rincian diproses sebagai array (bahkan jika hanya 1 baris)
    const jbList = Array.isArray(jenis_bordir) ? jenis_bordir : [jenis_bordir];
    const dsList = Array.isArray(nama_desain) ? nama_desain : [nama_desain];
    const jmlList = Array.isArray(jumlah) ? jumlah : [jumlah];
    const hOpList = Array.isArray(harga_operator) ? harga_operator : [harga_operator];
    const hCuList = Array.isArray(harga_customer) ? harga_customer : [harga_customer];

    try {
        await db.query("BEGIN"); // Mulai Transaksi agar data konsisten

        // 1. Simpan Header PO ke po_utama
        const sqlHeader = `
            INSERT INTO po_utama (tenant_id, tanggal, nama_po, customer, status) 
            VALUES ($1, $2, $3, $4, $5) RETURNING id
        `;
        const headerRes = await db.query(sqlHeader, [tId, tanggal, nama_po, customer, status]);
        const poId = headerRes.rows[0].id;

        let totalTagihan = 0;

        // 2. Simpan Rincian ke po_detail (Looping)
        for (let i = 0; i < jbList.length; i++) {
            if (!jbList[i]) continue; // Lewati jika baris kosong

            const qty = parseInt(jmlList[i]) || 0;
            const hCu = parseFloat(hCuList[i]) || 0;
            const hOp = parseFloat(hOpList[i]) || hCu; // Jika Op kosong, samakan dengan Cust

            totalTagihan += (qty * hCu);

            const sqlDetail = `
                INSERT INTO po_detail (po_id, jenis_bordir, nama_desain, jumlah, harga_operator, harga_customer) 
                VALUES ($1, $2, $3, $4, $5, $6)
            `;
            await db.query(sqlDetail, [poId, jbList[i], dsList[i], qty, hOp, hCu]);
        }

        // 3. Update Total Harga di Header
        await db.query("UPDATE po_utama SET total_harga_customer = $1 WHERE id = $2", [totalTagihan, poId]);

        await db.query("COMMIT"); // Simpan Permanen
        res.send("<script>alert('Data PO Berhasil Disimpan!'); window.location='/po-data';</script>");

    } catch (err) {
        await db.query("ROLLBACK"); // Batalkan jika ada error
        console.error("🔥 Save PO Error:", err.message);
        res.status(500).send("Gagal menyimpan PO: " + err.message);
    }
});

app.get('/po-data', async (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    const tId = req.session.tenantId;

    try {
        // 1. Ambil data Header PO
        // Kita hitung total Qty per PO dan cek apakah ada variasi item (lebih dari 1 jenis rincian)
        const sqlOrders = `
            SELECT 
                u.*, 
                (SELECT SUM(jumlah) FROM po_detail WHERE po_id = u.id) as qty_tampil,
                (SELECT COUNT(*) FROM po_detail WHERE po_id = u.id) as variasi_jumlah
            FROM po_utama u 
            WHERE u.tenant_id = $1 
            ORDER BY u.tanggal DESC, u.id DESC
        `;
        const orders = await db.all(sqlOrders, [tId]);

        // 2. Ambil semua Rincian (Detail) untuk semua PO milik tenant ini
        const sqlDetails = `
            SELECT d.* FROM po_detail d
            JOIN po_utama u ON d.po_id = u.id
            WHERE u.tenant_id = $1
        `;
        const details = await db.all(sqlDetails, [tId]);

        res.render('po-data', { 
            orders: orders,
            details: details
        });
    } catch (err) {
        console.error("🔥 Load PO Data Error:", err.message);
        res.status(500).send("Gagal memuat data pesanan.");
    }
});

app.post('/update-status/:id', async (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    const { status_baru } = req.body;
    const poId = req.params.id;
    const tId = req.session.tenantId;

    try {
        // Pastikan hanya bisa update PO milik tenant sendiri
        await db.query(
            "UPDATE po_utama SET status = $1 WHERE id = $2 AND tenant_id = $3",
            [status_baru, poId, tId]
        );
        res.redirect('/po-data');
    } catch (err) {
        console.error("🔥 Update Status Error:", err.message);
        res.status(500).send("Gagal memperbarui status.");
    }
});

app.get('/delete-po/:id', async (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    const poId = req.params.id;
    const tId = req.session.tenantId;

    try {
        // Karena kita pakai CASCADE di database, menghapus po_utama akan otomatis menghapus po_detail terkait
        await db.query("DELETE FROM po_utama WHERE id = $1 AND tenant_id = $2", [poId, tId]);
        res.redirect('/po-data');
    } catch (err) {
        res.status(500).send("Gagal menghapus PO.");
    }
});




// --- LOGIKA ROUTES AKAN DI MASUKKAN DI SINI ---

// Handler jika rute tidak ditemukan
app.use((req, res) => {
    res.status(404).render('404', { message: "Halaman Tidak Ditemukan" });
});

// Error handling global
app.use((err, req, res, next) => {
    console.error("🔥 Server Error:", err.message);
    res.status(500).send("Terjadi kesalahan internal pada server.");
});

// Export untuk Vercel (PENTING)
module.exports = app;

// Jalankan server lokal (Hanya jika tidak di Vercel)
if (process.env.NODE_ENV !== 'production') {
    app.listen(port, () => {
        console.log(`🚀 SystemB-Tatriz Online di http://localhost:${port}`);
    });
}

