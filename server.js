require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const bodyParser = require('body-parser');
const multer = require('multer');
const session = require('express-session');
// --- PENTING: Import pgSession di sini ---
const pgSession = require('connect-pg-simple')(session);

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
}

// --- 3. KONFIGURASI MULTER ---
const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 2 * 1024 * 1024 } 
});

// --- 4. MIDDLEWARE DASAR & PROXY ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());

// WAJIB UNTUK VERCEL agar session secure bisa terbaca
app.set('trust proxy', 1); 

// --- 5. KONFIGURASI SESSION (FIXED) ---
app.use(session({
    store: new pgSession({
        pool : pool,                
        tableName : 'session',
        createTableIfMissing: false 
    }),
    secret: process.env.SESSION_SECRET || 'kunci-rahasia-tatriz',
    resave: true, 
    saveUninitialized: false,       
    cookie: { 
        maxAge: 12 * 60 * 60 * 1000, // 12 Jam
        secure: true,                // HTTPS di Vercel
        httpOnly: true,
        sameSite: 'lax'
    }
}));

app.use((req, res, next) => {
    // res.locals membuat variabel 'user' otomatis tersedia di SEMUA file .ejs
    res.locals.user = req.session.userId ? {
        id: req.session.userId,
        username: req.session.username,
        nama_lengkap: req.session.nama_lengkap,
        role: req.session.role,
        tenantId: req.session.tenantId
    } : null;
    next(); // Sangat penting agar request berlanjut ke rute di bawahnya
});

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
    console.log(`Log: Mencoba login untuk user: ${username}`);

    try {
        const result = await db.query(
            "SELECT * FROM users WHERE username = $1 AND password = $2",
            [username, password]
        );

        if (result.rows.length > 0) {
            const loggedInUser = result.rows[0];
            console.log(`Log: User ditemukan, Tenant ID: ${loggedInUser.tenant_id}`);

            // Cek Status Tenant
            const statusRes = await db.query(
                "SELECT is_active FROM settings WHERE tenant_id = $1",
                [loggedInUser.tenant_id]
            );

            const settings = statusRes.rows[0];

            if (settings && settings.is_active === false) {
                console.log("Log: Akses ditangguhkan (Suspended)");
                return res.send("<script>alert('Akses Ditangguhkan! Hubungi Admin Tatriz.'); window.history.back();</script>");
            }

            // SIMPAN SESSION
            req.session.userId = loggedInUser.id;
            req.session.username = loggedInUser.username;
            req.session.nama_lengkap = loggedInUser.nama_lengkap;
            req.session.role = loggedInUser.role;
            req.session.tenantId = loggedInUser.tenant_id;
            req.session.tenantLevel = settings.level || 1;

            // Paksa simpan session sebelum redirect (PENTING untuk Vercel/Serverless)
            req.session.save((err) => {
                if (err) {
                    console.error("Log: Gagal simpan session:", err);
                    return res.status(500).send("Gagal menyimpan sesi.");
                }
                
                console.log(`Log: Login sukses, redirect ke role: ${loggedInUser.role}`);
                if (loggedInUser.role === 'admin') {
                    res.redirect('/dashboard');
                } else {
                    res.redirect('/operator');
                }
            });

        } else {
            console.log("Log: Username/Password salah");
            res.send("<script>alert('Username atau Password salah!'); window.history.back();</script>");
        }

    } catch (err) {
        console.error("🔥 Login Error:", err);
        res.status(500).send("Terjadi kesalahan pada server. Cek Log Vercel.");
    }
});

app.use(async (req, res, next) => {
    // 1. Data Default (Fallback jika DB error atau belum login)
    res.locals.config = { 
        nama_aplikasi: "Tatriz System", 
        nama_perusahaan: "Tatriz", 
        logo_path: "default.png",
        target_bonus: 0,
        nominal_buffer: 0,
        beban_tetap: 0,
        level: 1 // Default level standar
    };
    res.locals.uangKunci = { saldoLaci: 0, totalUangDikunci: 0, profitBolehAmbil: 0, statusAman: true };
    
    // Sinkronisasi data user untuk EJS (Level 1 vs Level 2)
    res.locals.user = req.session.userId ? {
        ...req.session,
        tenantLevel: req.session.tenantLevel || 1
    } : null;

    const tId = req.session ? req.session.tenantId : null;
    if (!tId) return next();

    try {
        const bulanIni = new Date().toISOString().slice(0, 7); // Format: YYYY-MM

        // 2. Ambil Settings (Data Perusahaan & Level Tenant)
        const config = await db.get("SELECT * FROM settings WHERE tenant_id = $1", [tId]);
        if (config) {
            res.locals.config = config;
            if (!res.locals.config.logo_path) res.locals.config.logo_path = "default.png";
            // Pastikan level terbaru dari DB masuk ke session
            if (res.locals.user) res.locals.user.tenantLevel = config.level || 1;
        }

        // 3. Hitung Saldo Kas Riil (Pemasukan - Pengeluaran)
        const saldoRes = await db.get(`
            SELECT SUM(CASE WHEN jenis = 'PEMASUKAN' THEN jumlah ELSE -jumlah END) as saldo 
            FROM arus_kas WHERE tenant_id = $1`, [tId]);
        
        // 4. Hitung Beban Kontrakan Terbayar (Gunakan TO_CHAR agar lebih stabil di Postgres)
        const bebanRes = await db.get(`
            SELECT SUM(jumlah) as terbayar FROM arus_kas 
            WHERE kategori = 'BIAYA KONTRAKAN' 
            AND TO_CHAR(tanggal::DATE, 'YYYY-MM') = $1 
            AND tenant_id = $2`, [bulanIni, tId]);

        const saldoLaci = parseFloat(saldoRes?.saldo || 0);
        const terbayar = parseFloat(bebanRes?.terbayar || 0);
        const conf = res.locals.config;
        
        // 5. Logika Uang Dikunci (Buffer + Sisa Kontrakan yang belum dibayar bulan ini)
        const targetBeban = parseFloat(conf.beban_tetap) || 0;
        const sisaBebanKontrakan = Math.max(0, targetBeban - terbayar);
        const uangDikunci = (parseFloat(conf.nominal_buffer) || 0) + sisaBebanKontrakan;

        res.locals.uangKunci = {
            saldoLaci,
            totalUangDikunci: uangDikunci,
            profitBolehAmbil: saldoLaci - uangDikunci,
            statusAman: saldoLaci >= uangDikunci
        };

        next();
    } catch (err) {
        console.error("🔥 DATABASE ERROR:", err.message);
        res.locals.config.nama_perusahaan = "Tatriz (Offline Mode)";
        next(); 
    }
});


app.get('/dashboard', async (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    const tId = req.session.tenantId;

    try {
        // 1. Statistik Status PO
        const stats = await db.get(`
            SELECT 
                COUNT(CASE WHEN status = 'Design' THEN 1 END) as jml_design,
                COUNT(CASE WHEN status = 'Produksi' THEN 1 END) as jml_produksi,
                COUNT(CASE WHEN status = 'Clear' THEN 1 END) as jml_invoice,
                COUNT(CASE WHEN status = 'DP/Cicil' THEN 1 END) as jml_cicil
            FROM po_utama WHERE tenant_id = $1`, [tId]);

        // 2. Hitung Total Piutang
        const piutangRes = await db.get(`
            SELECT (
                COALESCE((SELECT SUM(total_harga_customer) FROM po_utama WHERE tenant_id = $1), 0) - 
                COALESCE((SELECT SUM(jumlah) FROM arus_kas WHERE kategori IN ('PEMBAYARAN BORDIR', 'PELUNASAN', 'DP/CICILAN') AND tenant_id = $1), 0)
            ) as total_piutang`, [tId]);

        // 3. Cek Masalah Produksi
        const masalahRes = await db.get(`
            SELECT COUNT(*) as total FROM (
                SELECT h.detail_id 
                FROM hasil_kerja h 
                JOIN po_detail d ON h.detail_id = d.id 
                WHERE h.tenant_id = $1 
                GROUP BY h.detail_id, d.jumlah 
                HAVING SUM(h.jumlah_setor) > d.jumlah
            ) as subquery`, [tId]);

        // --- INI PERUBAHANNYA ---
        res.render('dashboard', {
            stats: stats || { jml_design: 0, jml_produksi: 0, jml_invoice: 0, jml_cicil: 0 },
            totalPiutangSemua: parseFloat(piutangRes?.total_piutang || 0),
            jumlahMasalah: parseInt(masalahRes?.total || 0),
            // Tambahkan baris di bawah ini agar data dari Middleware terkirim ke EJS:
            uangKunci: res.locals.uangKunci 
        });

    } catch (err) {
        console.error("🔥 Dashboard Error:", err.message);
        res.status(500).send("Gagal memuat dashboard: " + err.message);
    }
});


app.post('/save-settings-all', upload.single('logo'), async (req, res) => {
    const tId = req.session.tenantId;
    if (!tId) return res.send("<script>alert('Sesi habis, silakan login kembali'); window.location='/';</script>");

    // 1. Tangkap semua variabel termasuk kebijakan gaji & bonus baru
    const { 
        nama_perusahaan, alamat, no_hp, nominal_buffer, 
        target_bonus, nominal_bonus_dasar, beban_tetap,
        jam_kerja_reguler, pembagi_lembur, kelipatan_bonus, nominal_bonus_lipat, // Variabel Baru
        nama_mesin_baru 
    } = req.body;

    try {
        let logoUrl = null;

        // 2. Upload Logo ke Supabase (Jika ada file baru)
        if (req.file) {
            const fileName = `logo-${tId}-${Date.now()}${path.extname(req.file.originalname)}`;
            const { data, error } = await supabase.storage
                .from('uploads')
                .upload(fileName, req.file.buffer, {
                    contentType: req.file.mimetype,
                    upsert: true
                });

            if (error) throw error;
            const { data: publicData } = supabase.storage.from('uploads').getPublicUrl(fileName);
            logoUrl = publicData.publicUrl;
        }

        // 3. Susun SQL Update (Pastikan urutan $ sesuai dengan urutan params)
        let sql = `UPDATE settings SET 
                    nama_perusahaan = $1, alamat = $2, no_hp = $3, 
                    nominal_buffer = $4, target_bonus = $5, 
                    nominal_bonus_dasar = $6, beban_tetap = $7,
                    jam_kerja_reguler = $8, pembagi_lembur = $9,
                    kelipatan_bonus = $10, nominal_bonus_lipat = $11`;
        
        let params = [
            nama_perusahaan || 'Tatriz Unit', 
            alamat || '', 
            no_hp || '', 
            parseFloat(nominal_buffer) || 0, 
            parseFloat(target_bonus) || 0, 
            parseFloat(nominal_bonus_dasar) || 0, 
            parseFloat(beban_tetap) || 0,
            parseInt(jam_kerja_reguler) || 8,        // Default 8 jam
            parseInt(pembagi_lembur) || 4,           // Default GP/4
            parseInt(kelipatan_bonus) || 100000,     // Default lipatan 100rb
            parseInt(nominal_bonus_lipat) || 5000    // Default bonus lipatan 5rb
        ];

        // 4. Penanganan Logo Path & Tenant ID (Gunakan index $12 dan $13)
        if (logoUrl) {
            sql += `, logo_path = $12 WHERE tenant_id = $13`;
            params.push(logoUrl, tId);
        } else {
            sql += ` WHERE tenant_id = $12`;
            params.push(tId);
        }

        await db.query(sql, params);

        // 5. Tambah Mesin Baru (Jika diisi)
        if (nama_mesin_baru && nama_mesin_baru.trim() !== "") {
            await db.query(
                "INSERT INTO mesin (tenant_id, nama_mesin) VALUES ($1, $2)",
                [tId, nama_mesin_baru.trim()]
            );
        }

        res.send("<script>alert('Semua perubahan berhasil disimpan!'); window.location='/setup';</script>");

    } catch (err) {
        console.error("🔥 Setup Save Error Detail:", err);
        res.status(500).send("Gagal simpan: " + err.message);
    }
});


// Menampilkan Halaman Register
app.get('/register', (req, res) => {
    res.render('register');
});

// Proses Pendaftaran Tenant
app.post('/register-tenant', async (req, res) => {
    const { nama_toko, username, password, activation_code } = req.body;

    try {
        // 1. Ambil Kode Aktivasi yang sah dari Tenant 1 (Pusat)
        const masterRes = await db.query("SELECT registration_secret FROM settings WHERE tenant_id = 1");
        const validCode = masterRes.rows[0]?.registration_secret || 'SYSTEMB2026';

        // 2. Validasi Kode
        if (activation_code !== validCode) {
            return res.send("<script>alert('Kode Aktivasi Salah atau Kadaluwarsa!'); window.history.back();</script>");
        }

        // 3. Tentukan Tenant ID baru
        const row = await db.query("SELECT MAX(tenant_id) as maxid FROM settings");
        let currentMax = parseInt(row.rows[0]?.maxid || 0);
        let newTenantId = (currentMax < 100) ? 100 : currentMax + 1;

        await db.query("BEGIN");

        // 4. Simpan ke Settings (Nama aplikasi otomatis: Tatriz SystemB)
        await db.query(
            "INSERT INTO settings (tenant_id, nama_perusahaan, level, nama_aplikasi, registration_secret) VALUES ($1, $2, 1, $3, $4)",
            [newTenantId, nama_toko, 'Tatriz SystemB', validCode] 
        );

        // 5. Simpan Akun User
        await db.query(
            "INSERT INTO users (tenant_id, username, password, role, nama_lengkap) VALUES ($1, $2, $3, 'admin', $4)",
            [newTenantId, username, password, 'Owner ' + nama_toko]
        );

        await db.query("COMMIT");
        res.send("<script>alert('Pendaftaran Berhasil! Silakan Login.'); window.location='/';</script>");

    } catch (err) {
        if (db) await db.query("ROLLBACK");
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
        const sqlOrders = `
            SELECT 
                u.*, 
                (SELECT SUM(jumlah) FROM po_detail WHERE po_id = u.id) as qty_tampil,
                (SELECT COUNT(*) FROM po_detail WHERE po_id = u.id) as variasi_jumlah,
                (SELECT SUM(jumlah * harga_operator) FROM po_detail WHERE po_id = u.id) as total_harga_operator,
                (SELECT SUM(jumlah * harga_customer) FROM po_detail WHERE po_id = u.id) as total_harga_customer
            FROM po_utama u 
            WHERE u.tenant_id = $1 
            ORDER BY u.tanggal DESC, u.id DESC
        `;
        const orders = await db.all(sqlOrders, [tId]);

        // MODIFIKASI: Query Detail menyertakan SUM hasil_kerja (Fitur No. 1)
        const sqlDetails = `
            SELECT 
                d.*, 
                SUM(COALESCE(h.jumlah_setor, 0)) as total_produksi
            FROM po_detail d
            JOIN po_utama u ON d.po_id = u.id
            LEFT JOIN hasil_kerja h ON d.id = h.detail_id
            WHERE u.tenant_id = $1
            GROUP BY d.id, d.po_id, d.nama_desain, d.jenis_bordir, d.jumlah, d.harga_operator, d.harga_customer
            ORDER BY d.id ASC
        `;
        const details = await db.all(sqlDetails, [tId]);

        res.render('po-data', { 
            orders: orders, 
            details: details,
            user: req.session 
        });

    } catch (err) {
        console.error("🔥 Error po-data:", err.message);
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

app.get('/delete-po/:id', isAdmin, async (req, res) => {
    const poId = req.params.id;
    const tId = req.session.tenantId;

    try {
        // Mulai transaksi (agar jika satu gagal, semua batal)
        await db.query('BEGIN');

        // 1. Hapus Arus Kas yang berhubungan dengan PO ini
        await db.query("DELETE FROM arus_kas WHERE po_id = $1 AND tenant_id = $2", [poId, tId]);

        // 2. Hapus Hasil Kerja (karena hasil_kerja biasanya nyambung ke po_detail)
        // Kita gunakan subquery untuk mencari detail mana saja yang milik PO ini
        await db.query(`
            DELETE FROM hasil_kerja 
            WHERE detail_id IN (SELECT id FROM po_detail WHERE po_id = $1)
            AND tenant_id = $2
        `, [poId, tId]);

        // 3. Hapus po_detail
        await db.query("DELETE FROM po_detail WHERE po_id = $1", [poId]);

        // 4. Baru hapus po_utama (Akar masalahnya)
        await db.query("DELETE FROM po_utama WHERE id = $1 AND tenant_id = $2", [poId, tId]);

        // Selesaikan transaksi
        await db.query('COMMIT');
        
        res.redirect('/po-data');
    } catch (err) {
        await db.query('ROLLBACK'); // Batalkan semua jika ada error
        console.error("Detail Error Hapus PO:", err.message);
        res.status(500).send("Gagal menghapus PO karena masih ada data kas atau hasil kerja yang terikat.");
    }
});

app.post('/update-po/:id', isAdmin, async (req, res) => {
    const poId = req.params.id;
    const tId = req.session.tenantId;
    const tLevel = req.session.tenantLevel;

    if (!tId) return res.redirect('/');

    // Ambil data dari form EJS Anda
    let { 
        tanggal, nama_po, customer, status, 
        detail_ids, jenis_bordir, nama_desain, 
        jumlah, harga_cmt, harga_operator, harga_customer 
    } = req.body;

    // --- PENGAMAN ARRAY ---
    // Kode ini memastikan semua input terbaca sebagai daftar, bukan teks tunggal
    const idList = Array.isArray(detail_ids) ? detail_ids : (detail_ids ? [detail_ids] : []);
    const jbList = Array.isArray(jenis_bordir) ? jenis_bordir : (jenis_bordir ? [jenis_bordir] : []);
    const dsList = Array.isArray(nama_desain) ? nama_desain : [nama_desain];
    const jmlList = Array.isArray(jumlah) ? jumlah : [jumlah];
    const hrgCmtList = Array.isArray(harga_cmt) ? harga_cmt : [harga_cmt];
    const hrgOpList = Array.isArray(harga_operator) ? harga_operator : [harga_operator];
    const hrgCuList = Array.isArray(harga_customer) ? harga_customer : [harga_customer];

    try {
        await db.query("BEGIN"); // Mulai transaksi aman

        // 1. Update Header PO
        await db.query(
            `UPDATE po_utama SET tanggal=$1, nama_po=$2, customer=$3, status=$4 
             WHERE id=$5 AND tenant_id=$6`, 
            [tanggal, nama_po, customer, status, poId, tId]
        );

        let totalTagihanBaru = 0;

        // 2. Olah Rincian Item (Looping sesuai jumlah Jenis Bordir yang diisi)
        for (let i = 0; i < jbList.length; i++) {
            if (!jbList[i] || jbList[i].trim() === "") continue;

            const qty = Number(jmlList[i]) || 0;
            const hCu = Number(hrgCuList[i]) || 0;
            
            // Logika Otomatisasi Harga sesuai Level Tenant Anda
            let finalHOp, finalHCmt;
            if (tId !== 1 && tLevel < 2) {
                finalHOp = hCu;   // Disamakan dengan harga customer
                finalHCmt = 0;
            } else {
                finalHOp = Number(hrgOpList[i]) || 0;
                finalHCmt = Number(hrgCmtList[i]) || 0;
            }

            totalTagihanBaru += (qty * hCu);

            // JIKA ADA ID: Update baris yang sudah ada (Tidak akan memicu Foreign Key Error)
            if (idList[i] && idList[i] !== "") {
                await db.query(
                    `UPDATE po_detail SET 
                        jenis_bordir=$1, nama_desain=$2, jumlah=$3, 
                        harga_cmt=$4, harga_operator=$5, harga_customer=$6 
                    WHERE id=$7 AND po_id=$8`,
                    [jbList[i], dsList[i], qty, finalHCmt, finalHOp, hCu, idList[i], poId]
                );
            } 
            // JIKA TIDAK ADA ID: Berarti baris baru hasil tombol "+ Tambah Komponen"
            else {
                await db.query(
                    `INSERT INTO po_detail (po_id, jenis_bordir, nama_desain, jumlah, harga_cmt, harga_operator, harga_customer) 
                    VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [poId, jbList[i], dsList[i], qty, finalHCmt, finalHOp, hCu]
                );
            }
        }
        
        // 3. Update total tagihan di header agar sinkron dengan rincian baru
        await db.query(`UPDATE po_utama SET total_harga_customer = $1 WHERE id = $2`, [totalTagihanBaru, poId]);
        
        await db.query("COMMIT"); // Simpan semua perubahan
        res.send("<script>alert('PO Berhasil Diperbarui!'); window.location='/po-data';</script>");

    } catch (err) {
        await db.query("ROLLBACK").catch(() => {}); // Batalkan jika ada yang gagal
        console.error("🔥 Update PO Critical Error:", err.message);
        res.status(500).send("Gagal update PO: " + err.message);
    }
});

app.get('/edit-po/:id', async (req, res) => {
    const tId = req.session.tenantId;
    const poId = req.params.id;

    if (!tId) return res.redirect('/');

    try {
        const po = await db.get("SELECT * FROM po_utama WHERE id = $1 AND tenant_id = $2", [poId, tId]);
        const details = await db.all("SELECT * FROM po_detail WHERE po_id = $1 ORDER BY id ASC", [poId]);

        if (!po) return res.status(404).render('404');

        // Pastikan format tanggal aman untuk HTML5 Input Date
        if (po.tanggal) {
            po.tanggal = new Date(po.tanggal).toISOString().split('T')[0];
        }

        // --- PERBAIKAN DI SINI ---
        res.render('po-edit', { // Sesuaikan dengan nama file po-edit.ejs
            po, 
            details: details || [],
            user: req.session 
        });

    } catch (err) {
        console.error("🔥 Error Load po-edit:", err.message);
        res.status(500).render('404');
    }
});

app.get('/cetak-nota-gabungan', isAdmin, async (req, res) => {
    const tId = req.session.tenantId;
    let ids = req.query.ids; 
    const mode = req.query.mode || 'standard'; // Tangkap mode (standard/thermal)
    
    if (!ids) return res.send("Tidak ada PO yang dipilih.");
    
    // Konversi ids menjadi array jika datang sebagai string tunggal (id1,id2)
    let idList = Array.isArray(ids) ? ids : ids.split(',');
    idList = idList.map(id => parseInt(id));

    try {
        const config = await db.get("SELECT * FROM settings WHERE tenant_id = $1", [tId]);

        const sqlOrders = `
            SELECT p.*, COALESCE(bayar.total, 0) as total_bayar 
            FROM po_utama p
            LEFT JOIN (
                SELECT po_id, SUM(jumlah) as total 
                FROM arus_kas 
                GROUP BY po_id
            ) bayar ON p.id = bayar.po_id
            WHERE p.id = ANY($1::int[]) AND p.tenant_id = $2
        `;

        const orders = await db.all(sqlOrders, [idList, tId]);
        const details = await db.all(`SELECT * FROM po_detail WHERE po_id = ANY($1::int[])`, [idList]);

        if (!orders || orders.length === 0) return res.send("Data PO tidak ditemukan.");

        res.render('print-nota-gabungan', { 
            orders, 
            details, 
            config: config || {},
            mode: mode // Pastikan ini dikirim ke EJS
        });

    } catch (err) {
        console.error("🔥 Error Cetak Gabungan:", err.message);
        res.status(500).send("Gagal memproses cetak nota: " + err.message);
    }
});

// 1. Halaman Daftar Piutang
app.get('/piutang-customer', isAdmin, async (req, res) => {
    const tId = req.session.tenantId;

    const sql = `
        SELECT 
            p.customer, 
            COUNT(p.id) as total_po_aktif, 
            SUM(p.total_harga_customer) as total_nilai_po,
            SUM(COALESCE(bayar.total, 0)) as total_telah_dibayar,
            SUM(p.total_harga_customer - COALESCE(bayar.total, 0)) as sisa_piutang_customer
        FROM po_utama p
        LEFT JOIN (
            SELECT po_id, SUM(jumlah) as total 
            FROM arus_kas 
            WHERE kategori IN ('PEMBAYARAN BORDIR', 'PELUNASAN', 'DP/CICILAN') 
            GROUP BY po_id
        ) bayar ON p.id = bayar.po_id
        WHERE p.status NOT IN ('Lunas', 'Design') AND p.tenant_id = $1
        GROUP BY p.customer 
        HAVING SUM(p.total_harga_customer - COALESCE(bayar.total, 0)) > 0
        ORDER BY sisa_piutang_customer DESC`;

    try {
        const rows = await db.all(sql, [tId]);
        res.render('piutang-customer', { daftar: rows || [] });
    } catch (err) {
        console.error("🔥 Error Piutang List:", err.message);
        res.status(500).send("Error memuat piutang.");
    }
});

// 2. API Detail PO per Customer (Untuk Modal)
app.get('/api/piutang-detail/:customer', isAdmin, async (req, res) => {
    const tId = req.session.tenantId;
    const customerName = req.params.customer;

    const sql = `
        SELECT 
            p.id, p.nama_po, p.tanggal, p.total_harga_customer,
            COALESCE(SUM(ak.jumlah), 0) as telah_bayar
        FROM po_utama p
        LEFT JOIN arus_kas ak ON p.id = ak.po_id 
             AND ak.kategori IN ('PEMBAYARAN BORDIR', 'PELUNASAN', 'DP/CICILAN')
        WHERE p.customer = $1 AND p.tenant_id = $2 AND p.status != 'Lunas'
        GROUP BY p.id, p.nama_po, p.tanggal, p.total_harga_customer
        HAVING (p.total_harga_customer - COALESCE(SUM(ak.jumlah), 0)) > 0
    `;

    try {
        const rows = await db.all(sql, [customerName, tId]);
        res.json(rows);
    } catch (err) {
        console.error("🔥 Error Piutang Detail API:", err.message);
        res.status(500).json([]);
    }
});

app.get('/laporan-kas', isAdmin, async (req, res) => {
    const tId = req.session.tenantId;
    const bulanIni = req.query.bulan || new Date().toISOString().slice(0, 7);
    
    try {
        // 0. Ambil Config (Gunakan db.query)
        const configRes = await db.query("SELECT * FROM settings WHERE tenant_id = $1", [tId]);
        const conf = configRes.rows[0] || { beban_tetap: 0, nominal_buffer: 0 };

        // 1. Query Statistik Keuangan (Ganti LIKE dengan TO_CHAR)
        const sqlData = `
            SELECT 
                (SELECT SUM(h.jumlah_setor * d.harga_customer) FROM hasil_kerja h JOIN po_detail d ON h.detail_id = d.id WHERE TO_CHAR(h.tanggal::DATE, 'YYYY-MM') = $1 AND h.tenant_id = $2) as prod_bln,
                (SELECT SUM(jumlah) FROM arus_kas WHERE jenis = 'PENGELUARAN' AND kategori NOT IN ('BIAYA KONTRAKAN', 'BAYAR HUTANG') AND TO_CHAR(tanggal::DATE, 'YYYY-MM') = $1 AND tenant_id = $2) as op_bln,
                (SELECT SUM(jumlah) FROM arus_kas WHERE kategori = 'BIAYA KONTRAKAN' AND TO_CHAR(tanggal::DATE, 'YYYY-MM') = $1 AND tenant_id = $2) as k_bayar_bln,
                (SELECT SUM(CASE WHEN kategori = 'HUTANG' THEN jumlah WHEN kategori = 'BAYAR HUTANG' THEN -jumlah ELSE 0 END) FROM arus_kas WHERE tenant_id = $2) as hutang_riil,
                (SELECT SUM(CASE WHEN jenis = 'PEMASUKAN' THEN jumlah ELSE -jumlah END) FROM arus_kas WHERE tenant_id = $2) as saldo_laci
        `;
        const dataRes = await db.query(sqlData, [bulanIni, tId]);
        const data = dataRes.rows[0];

        // 2. Query Piutang Berjalan (Akumulatif)
        const sqlPiutang = `
            SELECT (
                COALESCE((SELECT SUM(h2.jumlah_setor * d2.harga_customer) FROM hasil_kerja h2 JOIN po_detail d2 ON h2.detail_id = d2.id WHERE h2.tenant_id = $1), 0) - 
                COALESCE((SELECT SUM(jumlah) FROM arus_kas WHERE kategori IN ('PEMBAYARAN BORDIR', 'PELUNASAN', 'DP/CICILAN') AND tenant_id = $1), 0)
            ) as piutang_total
        `;
        const rowPRes = await db.query(sqlPiutang, [tId]);
        const rowP = rowPRes.rows[0];

        // 3. Query Rincian Transaksi (Ganti LIKE dengan TO_CHAR)
        // Di server.js bagian rincian transaksi
        const rincianRes = await db.query(`
            SELECT ak.*, p.customer, p.nama_po 
            FROM arus_kas ak 
            LEFT JOIN po_utama p ON ak.po_id = p.id 
            WHERE TO_CHAR(ak.tanggal::DATE, 'YYYY-MM') = $1 AND ak.tenant_id = $2
            ORDER BY ak.tanggal DESC, ak.id DESC
        `, [bulanIni, tId]);

        // 4. Query Omzet Harian (Ganti LIKE dengan TO_CHAR)
        const monitorRes = await db.query(`
            SELECT TO_CHAR(h.tanggal::DATE, 'YYYY-MM-DD') as tanggal, SUM(h.jumlah_setor * d.harga_customer) as total_harian
            FROM hasil_kerja h 
            JOIN po_detail d ON h.detail_id = d.id 
            WHERE TO_CHAR(h.tanggal::DATE, 'YYYY-MM') = $1 AND h.tenant_id = $2
            GROUP BY h.tanggal 
            ORDER BY h.tanggal DESC
        `, [bulanIni, tId]);

        // PERHITUNGAN (Gunakan parseFloat karena SUM di PG seringkali String)
        const prod = parseFloat(data?.prod_bln || 0);
        const op = parseFloat(data?.op_bln || 0);
        const k_terbayar = parseFloat(data?.k_bayar_bln || 0);
        const estimasiProfit = prod - op - (parseFloat(conf.beban_tetap) || 0);
        const sisaBebanKontrakan = Math.max(0, (parseFloat(conf.beban_tetap) || 0) - k_terbayar);

        res.render('laporan-kas', {
            bulanIni,
            nilaiProduksi: prod,
            totalBiaya: op,
            sisaHutangRiil: parseFloat(data?.hutang_riil || 0),
            sisaBebanKontrakan,
            estimasiProfit,
            saldoRiil: parseFloat(data?.saldo_laci || 0),
            piutangBerjalan: parseFloat(rowP?.piutang_total || 0),
            monitorHarian: monitorRes.rows || [],
            rincianKas: rincianRes.rows || [],
            config: conf
        });

    } catch (err) {
        console.error("🔥 Laporan Kas Error:", err.message);
        res.status(500).send("Gagal memuat laporan kas: " + err.message);
    }
});

app.post('/save-kas', isAdmin, async (req, res) => {
    const tId = req.session.tenantId;
    const { kas_id, tanggal, jenis, kategori, jumlah, keterangan, po_id } = req.body;
    
    // Pastikan po_id null jika tidak dipilih
    const isPayment = ["PEMBAYARAN BORDIR", "PELUNASAN", "DP/CICILAN"].includes(kategori);
    const ref_po = (isPayment && po_id && po_id !== "") ? parseInt(po_id) : null;

    try {
        if (kas_id) {
            await db.query(`
                UPDATE arus_kas SET tanggal=$1, jenis=$2, kategori=$3, jumlah=$4, keterangan=$5, po_id=$6 
                WHERE id=$7 AND tenant_id=$8`,
                [tanggal, jenis, kategori, jumlah, keterangan, ref_po, kas_id, tId]
            );
        } else {
            await db.query(`
                INSERT INTO arus_kas (tenant_id, tanggal, jenis, kategori, jumlah, keterangan, po_id) 
                VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [tId, tanggal, jenis, kategori, jumlah, keterangan, ref_po]
            );
        }

        if (ref_po) updateStatusPO(ref_po); // Panggil fungsi helper status
        res.redirect('/laporan-kas');
    } catch (err) {
        console.error("🔥 Save Kas Error:", err.message);
        res.status(500).send("Gagal menyimpan transaksi.");
    }
});

app.get('/hapus-kas/:id', isAdmin, async (req, res) => {
    const tId = req.session.tenantId;
    const kasId = req.params.id;

    try {
        const row = await db.get("SELECT po_id FROM arus_kas WHERE id = $1 AND tenant_id = $2", [kasId, tId]);
        const poIdTerikat = row ? row.po_id : null;

        await db.query("DELETE FROM arus_kas WHERE id = $1 AND tenant_id = $2", [kasId, tId]);

        if (poIdTerikat) updateStatusPO(poIdTerikat);
        res.redirect('/laporan-kas');
    } catch (err) {
        console.error("🔥 Hapus Kas Error:", err.message);
        res.status(500).send("Gagal menghapus transaksi.");
    }
});

app.get('/input-kas', async (req, res) => { // 1. Tambahkan async
    if (!req.session.userId) return res.redirect('/');
    
    const tId = req.session.tenantId;

    // 2. Ubah ? menjadi $1
    const sqlPO = `SELECT id, nama_po, customer, total_harga_customer 
                   FROM po_utama 
                   WHERE status NOT IN ('Lunas', 'Design', 'CMT') AND tenant_id = $1
                   ORDER BY tanggal DESC`; // Tambahkan ORDER BY agar PO terbaru di atas
    
    try {
        // 3. Gunakan await (tanpa callback err, pos)
        const pos = await db.all(sqlPO, [tId]);
        res.render('input-kas', { pos: pos || [] });
    } catch (err) {
        console.error("🔥 Error Load Input Kas:", err.message);
        res.status(500).send("Gagal memuat daftar PO.");
    }
});

async function updateStatusPO(poId) {
    try {
        // 1. Hitung total tagihan vs total bayar
        const data = await db.get(`
            SELECT 
                p.total_harga_customer,
                COALESCE(SUM(ak.jumlah), 0) as total_masuk
            FROM po_utama p
            LEFT JOIN arus_kas ak ON p.id = ak.po_id
            WHERE p.id = $1
            GROUP BY p.id`, [poId]);

        if (data) {
            // 2. Jika bayar >= tagihan, set Lunas. Jika ada bayar tapi kurang, set DP/Cicil.
            let statusBaru = 'Produksi'; // Default
            if (data.total_masuk >= data.total_harga_customer) {
                statusBaru = 'Lunas';
            } else if (data.total_masuk > 0) {
                statusBaru = 'DP/Cicil';
            }
            
            await db.query("UPDATE po_utama SET status = $1 WHERE id = $2", [statusBaru, poId]);
        }
    } catch (err) {
        console.error("🔥 Error Update Status PO:", err.message);
    }
}

app.get('/karyawan', isAdmin, async (req, res) => {
    const tId = req.session.tenantId;

    try {
        // PostgreSQL menggunakan $1 sebagai placeholder
        const sql = `
            SELECT id, nama_lengkap, username, role, COALESCE(gaji_pokok, 0) as gaji_pokok 
            FROM users 
            WHERE tenant_id = $1 
            ORDER BY role DESC, nama_lengkap ASC
        `;
        
        const users = await db.all(sql, [tId]);
        
        res.render('karyawan', { users: users || [] });
    } catch (err) {
        console.error("🔥 Gagal memuat karyawan:", err.message);
        res.status(500).send("Gagal mengambil data karyawan.");
    }
});

app.post('/tambah-karyawan', isAdmin, async (req, res) => {
    const tId = req.session.tenantId;
    const { nama_lengkap, username, password, gaji_pokok, role } = req.body;

    try {
        const sql = `
            INSERT INTO users (tenant_id, nama_lengkap, username, password, gaji_pokok, role) 
            VALUES ($1, $2, $3, $4, $5, $6)
        `;

        await db.query(sql, [
            tId, 
            nama_lengkap, 
            username, 
            password, 
            parseFloat(gaji_pokok) || 0, 
            role
        ]);

        res.redirect('/karyawan');
    } catch (err) {
        console.error("🔥 Gagal tambah karyawan:", err.message);
        res.status(500).send("<script>alert('Username sudah dipakai!'); window.history.back();</script>");
    }
});

app.get('/hapus-karyawan/:id', isAdmin, async (req, res) => {
    const tId = req.session.tenantId;
    const userId = req.params.id;

    try {
        // Tambahan proteksi: Hanya hapus jika ID cocok, Tenant cocok, dan BUKAN username 'admin'
        await db.query(
            "DELETE FROM users WHERE id = $1 AND tenant_id = $2 AND username != 'admin'", 
            [userId, tId]
        );
        
        res.redirect('/karyawan');
    } catch (err) {
        console.error("🔥 Gagal hapus karyawan:", err.message);
        res.status(500).send("Gagal menghapus karyawan.");
    }
});

app.get('/operator', async (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    
    const userId = req.session.userId;
    const tId = req.session.tenantId;
    const tglHariIni = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());

    try {
        // Ambil PO Aktif
        const sqlPO = `
            SELECT p.id, p.nama_po 
            FROM po_utama p
            WHERE p.status = 'Produksi' AND p.tenant_id = $1
        `;
        const active_pos = await db.all(sqlPO, [tId]);

        // Ambil Mesin
        const daftarMesin = await db.all("SELECT id, nama_mesin FROM mesin WHERE tenant_id = $1 ORDER BY nama_mesin ASC", [tId]);

        // Hitung Pencapaian & Bonus
        const config = await db.get("SELECT target_bonus FROM settings WHERE tenant_id = $1", [tId]);
        const targetBonus = parseFloat(config?.target_bonus || 500000);

        const sqlCekHasil = `
            SELECT SUM(h.jumlah_setor * d.harga_operator) as total_upah
            FROM hasil_kerja h
            JOIN po_detail d ON h.detail_id = d.id
            WHERE h.operator_id = $1 AND h.tanggal = $2
        `;
        const row = await db.get(sqlCekHasil, [userId, tglHariIni]);
        const totalHariIni = parseFloat(row?.total_upah || 0);
        const kurangnya = Math.max(0, targetBonus - totalHariIni);

        res.render('operator', { 
            user: { nama: req.session.nama_lengkap }, // Sesuaikan dengan EJS Anda yang memanggil user.nama
            active_pos,
            daftarMesin,
            kurangnya
        });
    } catch (err) {
        res.status(500).send("Server Error");
    }
});

// --- API UNTUK DROPDOWN OTOMATIS (Akses untuk semua role yang sudah login) ---
app.get('/api/po-details/:id', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Unauthorized" });

    const poId = req.params.id;
    // Menghitung sisa per item desain secara real-time
    const sql = `
        SELECT d.id, d.jenis_bordir, d.nama_desain, d.harga_operator, d.jumlah,
               (d.jumlah - COALESCE((SELECT SUM(jumlah_setor) FROM hasil_kerja WHERE detail_id = d.id), 0)) as sisa
        FROM po_detail d
        WHERE d.po_id = $1
    `;
    try {
        const rows = await db.all(sql, [poId]);
        res.json(rows);
    } catch (err) {
        console.error("🔥 API Details Error:", err.message);
        res.status(500).json([]);
    }
});

app.post('/simpan-kerja', async (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    
    const { tanggal, shift, po_id, detail_id, jumlah_setor, mesin_id } = req.body;
    const userId = req.session.userId;
    const tId = req.session.tenantId;

    // Validasi input
    if (!jumlah_setor || parseInt(jumlah_setor) <= 0) {
        return res.send("<script>alert('Jumlah setoran harus lebih dari 0!'); window.history.back();</script>");
    }

    try {
        // 1. Simpan Hasil Kerja
        const sqlInsert = `
            INSERT INTO hasil_kerja (tenant_id, operator_id, po_id, detail_id, mesin_id, tanggal, shift, jumlah_setor) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `;
        await db.query(sqlInsert, [tId, userId, po_id, detail_id, mesin_id, tanggal, shift, parseInt(jumlah_setor)]);

        // 2. LOGIKA AUTO-QC (Cek apakah target PO sudah terpenuhi semuanya)
        const sqlCheck = `
            SELECT 
                (SELECT SUM(jumlah) FROM po_detail WHERE po_id = $1) as target,
                (SELECT SUM(jumlah_setor) FROM hasil_kerja WHERE po_id = $1) as realisasi
        `;
        const check = await db.get(sqlCheck, [po_id]);
        
        if (check && parseFloat(check.realisasi) >= parseFloat(check.target)) {
            // Jika setoran kumulatif >= target, pindahkan ke status QC
            await db.query("UPDATE po_utama SET status = 'QC' WHERE id = $1 AND tenant_id = $2", [po_id, tId]);
        }

        res.send("<script>alert('Data berhasil disimpan!'); window.location='/operator';</script>");
    } catch (err) {
        console.error("🔥 Error Simpan Kerja:", err.message);
        res.status(500).send("Gagal menyimpan data. Pastikan semua field terisi.");
    }
});

app.get('/hasil-saya', async (req, res) => {
    if (!req.session.userId) return res.redirect('/');

    const userId = req.session.userId;
    const tId = req.session.tenantId;
    const userName = req.session.nama_lengkap;

    const sql = `
        SELECT 
            h.id as log_id, 
            h.tanggal, 
            h.shift, 
            h.jumlah_setor,
            p.nama_po, 
            d.jenis_bordir, 
            d.nama_desain, 
            COALESCE(d.harga_operator, 0) as harga_operator
        FROM hasil_kerja h
        JOIN po_utama p ON h.po_id = p.id
        JOIN po_detail d ON h.detail_id = d.id
        WHERE h.operator_id = $1 AND h.tenant_id = $2
        ORDER BY h.tanggal DESC, h.id DESC
    `;

    try {
        const rows = await db.all(sql, [userId, tId]);
        res.render('hasil-kerja-operator', { 
            rows: rows || [], 
            userName: userName,
            user: req.session 
        });
    } catch (err) {
        console.error("🔥 Gagal memuat rekap operator:", err.message);
        res.status(500).send("Terjadi kesalahan saat memuat rekap kerja.");
    }
});

app.get('/input-kerja-admin', isAdmin, async (req, res) => {
    const tId = req.session.tenantId;

    try {
        // 1. Ambil PO yang statusnya Produksi
        const active_pos = await db.all(
            "SELECT id, nama_po FROM po_utama WHERE tenant_id = $1 AND status = 'Produksi'", 
            [tId]
        );

        // 2. Ambil Daftar Mesin
        const daftarMesin = await db.all(
            "SELECT id, nama_mesin FROM mesin WHERE tenant_id = $1 ORDER BY id ASC", 
            [tId]
        );

        // 3. Ambil Daftar User ber-role Operator
        const daftarOperator = await db.all(
            "SELECT id, nama_lengkap FROM users WHERE tenant_id = $1 AND role = 'operator' ORDER BY nama_lengkap ASC", 
            [tId]
        );

        // 4. Ambil Setting Toko
        const config = await db.get("SELECT * FROM settings WHERE tenant_id = $1", [tId]);

        // Kirim semua data ke EJS
        res.render('input-kerja-admin', {
            active_pos: active_pos || [],
            daftarMesin: daftarMesin || [],
            daftarOperator: daftarOperator || [], 
            config: config || { nama_perusahaan: "Tatriz" },
            kurangnya: 0, // Admin tidak menghitung target bonus personal
            user: req.session
        });

    } catch (err) {
        console.error("🔥 Error Load Input Kerja Admin:", err.message);
        res.status(500).send("Terjadi kesalahan pada server.");
    }
});

app.post('/admin/simpan-kerja', isAdmin, async (req, res) => {
    const tId = req.session.tenantId;
    const { 
        user_id_manual, tanggal, shift, po_id, 
        detail_id, jumlah_setor, mesin_id 
    } = req.body;

    // 1. Tentukan target user (Admin input untuk OP atau OP input sendiri)
    let targetUserId = user_id_manual ? parseInt(user_id_manual) : req.session.userId;

    // 2. Validasi Jumlah
    if (!jumlah_setor || parseInt(jumlah_setor) <= 0) {
        return res.send("<script>alert('Jumlah tidak valid!'); window.history.back();</script>");
    }

    try {
        // Mulai Transaksi agar data aman
        await db.query("BEGIN");

        // 3. Simpan ke Tabel hasil_kerja
        const sqlInsert = `
            INSERT INTO hasil_kerja 
            (tenant_id, operator_id, po_id, detail_id, mesin_id, tanggal, shift, jumlah_setor) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;
        
        await db.query(sqlInsert, [
            tId, 
            targetUserId, 
            parseInt(po_id), 
            parseInt(detail_id), 
            parseInt(mesin_id), 
            tanggal, 
            shift, 
            parseInt(jumlah_setor)
        ]);

        // 4. AUTO-UPDATE STATUS KE QC JIKA TARGET TERCAPAI
        const sqlCheck = `
            SELECT 
                (SELECT SUM(jumlah) FROM po_detail WHERE po_id = $1) as target,
                (SELECT SUM(jumlah_setor) FROM hasil_kerja WHERE po_id = $1) as realisasi
        `;
        const row = await db.get(sqlCheck, [parseInt(po_id)]);

        if (row && parseFloat(row.realisasi) >= parseFloat(row.target)) {
            await db.query("UPDATE po_utama SET status = 'QC' WHERE id = $1", [parseInt(po_id)]);
        }

        await db.query("COMMIT");

        // 5. Response Berdasarkan Role
        if (req.session.role === 'admin') {
            res.send("<script>alert('Data Berhasil Disimpan (Mode Admin)!'); window.location='/dashboard';</script>");
        } else {
            res.redirect('/hasil-saya');
        }

    } catch (err) {
        await db.query("ROLLBACK").catch(() => {});
        console.error("🔥 Error Simpan Kerja Admin:", err.message);
        res.status(500).send("Gagal menyimpan data: " + err.message);
    }
});

app.get('/daftar-produksi', isAdmin, async (req, res) => {
    const tId = req.session.tenantId;
    const bulanIni = req.query.bulan || new Date().toISOString().slice(0, 7);

    // Query diperbaiki untuk PostgreSQL: TO_CHAR untuk tanggal dan db.query untuk eksekusi
    const sql = `
        SELECT 
            h.id as "ID_PROD", 
            TO_CHAR(h.tanggal::DATE, 'YYYY-MM-DD') as "TANGGAL", 
            h.shift as "SHIFT", 
            u.nama_lengkap as "OP", 
            p.nama_po as "NAMA_PO", 
            p.customer as "PEMILIK", 
            d.nama_desain as "NAMA_BORDIR", 
            d.jenis_bordir as "JENIS_BORDIR", 
            d.jumlah as "TARGET_PO", 
            h.jumlah_setor as "JML", 
            COALESCE(d.harga_operator, 0) as "HARGA_PABRIK", 
            (h.jumlah_setor * COALESCE(d.harga_operator, 0)) as "TOTAL_H_PABRIK",
            (SELECT SUM(jumlah_setor) FROM hasil_kerja WHERE detail_id = h.detail_id) as "TOTAL_SDH_SETOR"
        FROM hasil_kerja h
        JOIN users u ON h.operator_id = u.id
        JOIN po_utama p ON h.po_id = p.id
        JOIN po_detail d ON h.detail_id = d.id
        WHERE TO_CHAR(h.tanggal::DATE, 'YYYY-MM') = $1 AND h.tenant_id = $2
        ORDER BY h.tanggal DESC, h.id DESC
    `;

    try {
        // Gunakan db.query (PostgreSQL) bukan db.all (SQLite)
        const result = await db.query(sql, [bulanIni, tId]);
        
        res.render('admin/daftar-produksi', { 
            dataProduksi: result.rows || [], // Data ada di properti .rows
            bulanIni: bulanIni,
            user: req.session 
        });
    } catch (err) {
        console.error("🔥 Error Daftar Produksi:", err.message);
        res.status(500).send("Gagal memuat log produksi: " + err.message);
    }
});

app.post('/update-produksi', isAdmin, async (req, res) => {
    const tId = req.session.tenantId;
    const { 
        id_prod, tanggal, op, shift, 
        nama_po, nama_bordir, jenis_bordir, 
        jumlah, harga 
    } = req.body;

    try {
        // 1. Ambil relasi ID tabel induk
        const row = await db.get("SELECT po_id, detail_id FROM hasil_kerja WHERE id = $1 AND tenant_id = $2", [id_prod, tId]);
        
        if (!row) return res.status(404).send("Data tidak ditemukan.");

        const poId = row.po_id;
        const detailId = row.detail_id;

        // 2. Jalankan rangkaian update dalam satu blok try
        // Update PO Utama
        await db.query("UPDATE po_utama SET nama_po = $1 WHERE id = $2 AND tenant_id = $3", [nama_po, poId, tId]);
        
        // Update PO Detail (Nama Desain & Harga)
        await db.query("UPDATE po_detail SET nama_desain = $1, jenis_bordir = $2, harga_operator = $3 WHERE id = $4", 
            [nama_bordir, jenis_bordir, parseFloat(harga), detailId]);

        // Update Log Hasil Kerja (Tanggal, Shift, Jumlah)
        await db.query("UPDATE hasil_kerja SET tanggal = $1, shift = $2, jumlah_setor = $3 WHERE id = $4 AND tenant_id = $5", 
            [tanggal, shift, parseInt(jumlah), id_prod, tId]);

        res.redirect('/daftar-produksi'); 

    } catch (err) {
        console.error("🔥 Gagal Update Produksi:", err.message);
        res.status(500).send("Gagal memperbarui data.");
    }
});

app.get('/hapus-produksi/:id', isAdmin, async (req, res) => {
    const idProd = req.params.id;
    const tId = req.session.tenantId;

    try {
        await db.query("DELETE FROM hasil_kerja WHERE id = $1 AND tenant_id = $2", [idProd, tId]);
        res.redirect('/daftar-produksi');
    } catch (err) {
        console.error("🔥 Gagal Hapus Produksi:", err.message);
        res.status(500).send("Gagal menghapus data.");
    }
});

app.get('/laporan-produksi', isAdmin, async (req, res) => {
    const tId = req.session.tenantId;

    try {
        // 1. Query Ringkasan Progres per Desain
        // MODIFIKASI: Filter diperketat hanya untuk status Produksi, QC, dan DP/Cicil
        const sqlRingkasan = `
            SELECT 
                d.id as detail_id, 
                p.nama_po, 
                d.nama_desain, 
                d.jenis_bordir, 
                d.jumlah as target_po,
                SUM(COALESCE(h.jumlah_setor, 0)) as total_produksi
            FROM po_detail d
            JOIN po_utama p ON d.po_id = p.id
            LEFT JOIN hasil_kerja h ON d.id = h.detail_id
            WHERE p.tenant_id = $1 
              AND p.status IN ('Produksi', 'QC', 'DP/Cicil') 
            GROUP BY d.id, p.nama_po, d.nama_desain, d.jenis_bordir, d.jumlah, p.tanggal
            ORDER BY p.tanggal DESC, d.id DESC
        `;

        // 2. Query Detail Log (Tetap sama)
        const sqlLogs = `
            SELECT h.*, u.nama_lengkap 
            FROM hasil_kerja h
            JOIN users u ON h.operator_id = u.id
            WHERE h.tenant_id = $1
            ORDER BY h.tanggal DESC, h.id DESC
        `;

        const [ringkasan, detailLog] = await Promise.all([
            db.all(sqlRingkasan, [tId]),
            db.all(sqlLogs, [tId])
        ]);

        res.render('admin/laporan-produksi', { 
            ringkasan: ringkasan || [], 
            detailLog: detailLog || [] 
        });

    } catch (err) {
        console.error("🔥 Error Monitor Produksi:", err.message);
        res.status(500).send("Gagal memuat monitor produksi.");
    }
});

app.post('/admin/update-koreksi-produksi', isAdmin, async (req, res) => {
    const tId = req.session.tenantId;
    const { 
        log_id, 
        tanggal_baru, 
        shift_baru, 
        detail_id_baru, 
        jumlah_baru 
    } = req.body;

    try {
        const sql = `
            UPDATE hasil_kerja 
            SET tanggal = $1, 
                shift = $2, 
                detail_id = $3, 
                jumlah_setor = $4 
            WHERE id = $5 AND tenant_id = $6
        `;

        await db.query(sql, [
            tanggal_baru, 
            shift_baru, 
            parseInt(detail_id_baru), 
            parseInt(jumlah_baru), 
            parseInt(log_id), 
            tId
        ]);
        
        res.redirect('/laporan-produksi'); 
    } catch (err) {
        console.error("🔥 Gagal Koreksi Produksi:", err.message);
        res.status(500).send("Gagal menyimpan koreksi.");
    }
});

app.get('/admin/hapus-produksi/:id', isAdmin, async (req, res) => {
    const tId = req.session.tenantId;
    const logId = req.params.id;

    try {
        await db.query("DELETE FROM hasil_kerja WHERE id = $1 AND tenant_id = $2", [logId, tId]);
        res.redirect('/laporan-produksi');
    } catch (err) {
        console.error("🔥 Gagal Hapus Log:", err.message);
        res.status(500).send("Gagal menghapus log.");
    }
});

// --- 1. RUTE INPUT GAJI (Sudah Oke, cuma pastikan config terupdate) ---
app.get('/input-gaji', isAdmin, async (req, res) => {
    const tId = req.session.tenantId;
    const { tgl_awal, tgl_akhir } = req.query;

    try {
        const config = await db.get("SELECT * FROM settings WHERE tenant_id = $1", [tId]);
        const activeConfig = config || { 
            target_bonus: 500000, 
            nominal_bonus_dasar: 10000, 
            kelipatan_bonus: 100000, 
            nominal_bonus_lipat: 5000,
            jam_kerja_reguler: 8, // Tambahkan default jika null
            pembagi_lembur: 4      // Tambahkan default jika null
        };

        if (!tgl_awal || !tgl_akhir) {
            return res.render('admin/pilih-tanggal-gaji', { config: activeConfig, user: req.session });
        }

        const sql = `
            SELECT u.id, u.nama_lengkap, u.gaji_pokok, u.role, 
                   h.tanggal, h.jumlah_setor, d.harga_operator
            FROM users u
            LEFT JOIN hasil_kerja h ON u.id = h.operator_id AND h.tanggal BETWEEN $1 AND $2
            LEFT JOIN po_detail d ON h.detail_id = d.id
            WHERE u.tenant_id = $3 AND u.role IN ('operator', 'QC')
            ORDER BY u.nama_lengkap ASC
        `;

        const rows = await db.all(sql, [tgl_awal, tgl_akhir, tId]);

        const rekap = {};
        rows.forEach(row => {
            if (!rekap[row.id]) {
                rekap[row.id] = { 
                    id: row.id, nama: row.nama_lengkap, role: row.role, 
                    gp: parseFloat(row.gaji_pokok || 0), borongan: 0, bonus: 0, harian: {} 
                };
            }
            if (row.tanggal && row.role === 'operator') {
                const sub = (parseInt(row.jumlah_setor) || 0) * (parseFloat(row.harga_operator) || 0);
                rekap[row.id].borongan += sub;
                rekap[row.id].harian[row.tanggal] = (rekap[row.id].harian[row.tanggal] || 0) + sub;
            }
        });

        Object.values(rekap).forEach(op => {
            Object.values(op.harian).forEach(totalHari => {
                if (totalHari >= parseFloat(activeConfig.target_bonus)) {
                    let kelipatan = parseFloat(activeConfig.kelipatan_bonus) || 100000;
                    let bonusDasar = parseFloat(activeConfig.nominal_bonus_dasar) || 0;
                    let bonusLipat = Math.floor((totalHari - parseFloat(activeConfig.target_bonus)) / kelipatan) * (parseFloat(activeConfig.nominal_bonus_lipat) || 0);
                    op.bonus += (bonusDasar + bonusLipat);
                }
            });
        });

        res.render('admin/input-gaji', { rekap, tgl_awal, tgl_akhir, config: activeConfig, user: req.session });

    } catch (err) {
        console.error("🔥 Error Input Gaji:", err.message);
        res.status(500).send("Gagal memuat data gaji.");
    }
});

// --- 2. PROSES CETAK SLIP (REVISI TOTAL - DENGAN ADJ MANUAL) ---
app.post('/proses-print-gaji', isAdmin, async (req, res) => {
    const tId = req.session.tenantId;
    const { tgl_awal, tgl_akhir, operator_ids, nama, gp, hari_kerja, lembur, bonus, adj_manual, kasbon } = req.body;

    try {
        // AMBIL CONFIG (Gunakan db.get dan placeholder $1)
        const config = await db.get("SELECT * FROM settings WHERE tenant_id = $1", [tId]);
        
        // Ambil variabel fleksibel dari DB
        const jamReguler = parseInt(config?.jam_kerja_reguler) || 8;
        const pembagiLembur = parseInt(config?.pembagi_lembur) || 4;

        // Helper untuk memastikan input adalah array (agar tidak error jika hanya 1 karyawan)
        const toArray = (val) => Array.isArray(val) ? val : [val];
        
        const ids = toArray(operator_ids);
        const nmList = toArray(nama);
        const gpList = toArray(gp);
        const hkList = toArray(hari_kerja);
        const lbList = toArray(lembur);
        const bnList = toArray(bonus);
        const adjList = toArray(adj_manual); // Deklarasikan adjList di sini
        const kbList = toArray(kasbon);

        let dataGaji = [];

        for (let i = 0; i < ids.length; i++) {
            let gajiPokok = Number(gpList[i]) || 0;
            let inputHK = String(hkList[i] || "0").replace(',', '.');
            let jamLembur = Number(lbList[i]) || 0;
            let bonusTarget = Number(bnList[i]) || 0;
            let penyesuaian = Number(adjList[i]) || 0; // Ambil nilai Adj dari list
            let totalKasbon = Number(kbList[i]) || 0;

            let hariFull = 0;
            let jamSisa = 0;

            if (inputHK.includes('.')) {
                let bagian = inputHK.split('.');
                hariFull = parseInt(bagian[0]) || 0;
                jamSisa = parseInt(bagian[1]) || 0;
            } else {
                hariFull = parseInt(inputHK) || 0;
            }

            // RUMUS FLEKSIBEL (Menggunakan variabel dinamis & penyesuaian manual)
            let nominalHari = hariFull * gajiPokok;
            let nominalJamSisa = (gajiPokok / jamReguler) * jamSisa;
            let nominalLembur = (gajiPokok / pembagiLembur) * jamLembur; 
            
            // TOTAL FINAL: Termasuk Penyesuaian (+/-)
            let totalFinal = nominalHari + nominalJamSisa + nominalLembur + bonusTarget + penyesuaian - totalKasbon;

            dataGaji.push({
                nama: nmList[i],
                gp: gajiPokok,
                hari_kerja_tampil: inputHK,
                hari_full: hariFull,
                jam_sisa: jamSisa,
                lembur: jamLembur,
                bonus_target: bonusTarget,
                adjustment: penyesuaian, // Kirim data adj ke EJS cetak jika ingin ditampilkan
                kasbon: totalKasbon,
                totalFinal: Math.round(totalFinal)
            });
        }

        // Render ke halaman cetak dengan variabel asli (dataGaji, config, user)
        res.render('admin/cetak-slip', { 
            dataGaji, 
            tgl_awal, 
            tgl_akhir, 
            config: config || { nama_perusahaan: "Tatriz" }, 
            user: req.session 
        });

    } catch (err) {
        console.error("🔥 Error Proses Slip:", err.message);
        res.status(500).send("Gagal memproses cetak slip.");
    }
});

app.get('/cetak-nota/:id', isAdmin, async (req, res) => {
    const tId = req.session.tenantId;
    const poId = req.params.id;
    const mode = req.query.mode || 'standard'; // TANGKAP MODE DI SINI

    try {
        // 1. Ambil Pengaturan Toko
        const configRes = await db.query("SELECT * FROM settings WHERE tenant_id = $1", [tId]);
        const config = configRes.rows[0] || { 
            nama_perusahaan: "Tatriz System", 
            alamat: "Alamat belum diatur", 
            no_hp: "-", 
            logo_path: "default-logo.png" 
        };

        // 2. Query PO
        const sqlPO = `
            SELECT p.*, 
            (SELECT SUM(jumlah) FROM arus_kas WHERE po_id = p.id AND jenis = 'PEMASUKAN') as total_bayar 
            FROM po_utama p 
            WHERE p.id = $1 AND p.tenant_id = $2
        `;

        const poRes = await db.query(sqlPO, [poId, tId]);
        const po = poRes.rows[0];

        if (!po) {
            return res.status(404).send("<script>alert('Data PO tidak ditemukan!'); window.close();</script>");
        }

        // 3. Ambil Detail PO
        const detailsRes = await db.query("SELECT * FROM po_detail WHERE po_id = $1", [poId]);
        const details = detailsRes.rows;

        // 4. Render ke halaman nota (Kirim variabel mode)
        res.render('cetak-nota', { 
            po, 
            details, 
            config,
            mode, // PASTIKAN MODE DIKIRIM KE EJS
            tgl_sekarang: new Date().toLocaleDateString('id-ID')
        });

    } catch (err) {
        console.error("Kesalahan SQL Cetak Nota:", err.message);
        res.status(500).send("Gagal memproses nota: " + err.message);
    }
});

app.get('/cetak-nota-rinci/:id', isAdmin, async (req, res) => {
    const tId = req.session.tenantId;
    const poId = req.params.id;

    try {
        // 1. Ambil data Pengaturan (Config)
        const configRes = await db.query("SELECT * FROM settings WHERE tenant_id = $1", [tId]);
        const config = configRes.rows[0] || { 
            nama_perusahaan: "Tatriz System", 
            alamat: "-", 
            no_hp: "-", 
            logo_path: "default.png" 
        };

        // 2. Ambil data Header PO + Total Bayar (Gunakan $1, $2 untuk PostgreSQL)
        const sqlPo = `
            SELECT p.*, 
            (SELECT SUM(jumlah) FROM arus_kas WHERE po_id = p.id AND tenant_id = $1 AND jenis = 'PEMASUKAN') as total_bayar
            FROM po_utama p 
            WHERE p.id = $2 AND p.tenant_id = $3
        `;

        const poRes = await db.query(sqlPo, [tId, poId, tId]);
        const po = poRes.rows[0];

        if (!po) return res.status(404).send("Nota tidak ditemukan.");

        // 3. Ambil detail item bordir
        const sqlDetails = `SELECT * FROM po_detail WHERE po_id = $1`;
        const detailsRes = await db.query(sqlDetails, [poId]);

        // 4. Render ke halaman (Pastikan nama file cetak-nota-rinci.ejs)
        res.render('cetak-nota-rinci', { 
            po: po, 
            details: detailsRes.rows || [],
            config: config
        });

    } catch (err) {
        console.error("Error Cetak Nota Rinci:", err.message);
        res.status(500).send("Gagal memuat nota rinci.");
    }
});

// --- RUTE NOTA MANUAL ---
app.get('/nota-manual', isAdmin, async (req, res) => {
    const tId = req.session.tenantId;

    try {
        // Ambil config perusahaan agar logo dan alamat muncul di nota
        const config = await db.get("SELECT * FROM settings WHERE tenant_id = $1", [tId]);
        
        res.render('nota-manual', { 
            config: config || { nama_perusahaan: "Tatriz", logo_path: "default.png", alamat: "-" },
            user: req.session 
        });
    } catch (err) {
        console.error("🔥 Error Load Nota Manual:", err.message);
        res.status(500).send("Gagal memuat halaman nota.");
    }
});

app.get('/cetak-nota-vendor', isAdmin, async (req, res) => {
    const tId = req.session.tenantId;
    let ids = req.query.ids;
    
    if (!ids) return res.send("Pilih minimal satu PO.");
    const idList = ids.split(',').map(id => parseInt(id));

    try {
        const config = await db.get("SELECT * FROM settings WHERE tenant_id = $1", [tId]);
        
        // Ambil Header PO
        const orders = await db.all(`SELECT * FROM po_utama WHERE id = ANY($1::int[]) AND tenant_id = $2`, [idList, tId]);
        
        // Ambil Rincian Detail
        const details = await db.all(`SELECT * FROM po_detail WHERE po_id = ANY($1::int[])`, [idList]);

        res.render('admin/print-nota-vendor', { 
            orders, 
            details, 
            config: config || {} 
        });
    } catch (err) {
        res.status(500).send("Error cetak nota vendor: " + err.message);
    }
});

app.get('/performa-operator', isAdmin, async (req, res) => {
    const tId = req.session.tenantId;
    // Ambil bulan dari query atau default bulan sekarang (YYYY-MM)
    const bulanIni = req.query.bulan || new Date().toISOString().slice(0, 7);
    const targetHarian = 500000;

    try {
        // 1. Ambil daftar operator
        const sqlOps = `
            SELECT id, nama_lengkap 
            FROM users 
            WHERE tenant_id = $1 AND role = 'operator' 
            ORDER BY nama_lengkap ASC
        `;
        const opsRes = await db.query(sqlOps, [tId]);
        const operators = opsRes.rows;

        // 2. Ambil data hasil kerja berdasarkan bulan
        // Menggunakan TO_CHAR(tanggal, 'YYYY-MM') untuk filter bulan di PostgreSQL
        // Ganti query sqlData Anda dengan yang ini:
        const sqlData = `
            SELECT 
                TO_CHAR(h.tanggal::DATE, 'YYYY-MM-DD') as tgl_key, 
                h.operator_id, 
                SUM(h.jumlah_setor * d.harga_operator) as upah_op,
                SUM(h.jumlah_setor * d.harga_customer) as omzet_cust
            FROM hasil_kerja h
            JOIN po_detail d ON h.detail_id = d.id
            WHERE TO_CHAR(h.tanggal::DATE, 'YYYY-MM') = $1 AND h.tenant_id = $2
            GROUP BY TO_CHAR(h.tanggal::DATE, 'YYYY-MM-DD'), h.operator_id
        `;
        const dataRes = await db.query(sqlData, [bulanIni, tId]);
        const records = dataRes.rows;

        // 3. Olah data ke dalam Matriks dan Performa
        const matriks = {};
        const performaOps = {};

        // Inisialisasi performa tiap operator agar tidak undefined di Chart
        operators.forEach(op => {
            performaOps[op.id] = { nama: op.nama_lengkap, totalUpah: 0, kaliCapaiTarget: 0 };
        });

        records.forEach(r => {
            // Gunakan tgl_key (Format: YYYY-MM-DD)
            if (!matriks[r.tgl_key]) {
                matriks[r.tgl_key] = { total_omzet_cust: 0, total_upah_op: 0 };
            }
            
            // Masukkan data ke matriks tabel
            matriks[r.tgl_key][r.operator_id] = parseFloat(r.upah_op);
            matriks[r.tgl_key].total_upah_op += parseFloat(r.upah_op);
            matriks[r.tgl_key].total_omzet_cust += parseFloat(r.omzet_cust);

            // Akumulasi performa untuk Chart
            if (performaOps[r.operator_id]) {
                performaOps[r.operator_id].totalUpah += parseFloat(r.upah_op);
                if (parseFloat(r.upah_op) >= targetHarian) {
                    performaOps[r.operator_id].kaliCapaiTarget += 1;
                }
            }
        });

        // 4. Hitung Jumlah Hari dalam bulan tersebut
        const [tahun, bulan] = bulanIni.split('-').map(Number);
        const jumlahHari = new Date(tahun, bulan, 0).getDate();

        // 5. Render ke halaman
        res.render('admin/performa-operator', {
            bulanIni,
            operators,
            matriks,
            performaOps,
            jumlahHari,
            config: res.locals.config || { nama_aplikasi: "Tatriz System" }
        });

    } catch (err) {
        console.error("Error Performa Operator:", err.message);
        res.status(500).send("Gagal memuat data performa: " + err.message);
    }
});

app.get('/admin/data-cmt', isAdmin, async (req, res) => {
    const tId = req.session.tenantId;

    try {
        // 1. Query Utama: PO Status CMT
        // PostgreSQL mewajibkan semua kolom non-aggregate masuk ke GROUP BY
        const sqlOrders = `
            SELECT p.id, p.tanggal, p.nama_po, p.customer, p.status, p.tenant_id,
            SUM(d.jumlah * (d.harga_customer - d.harga_cmt)) as total_untung
            FROM po_utama p
            JOIN po_detail d ON p.id = d.po_id
            WHERE p.status = 'CMT' AND p.tenant_id = $1
            GROUP BY p.id, p.tanggal, p.nama_po, p.customer, p.status, p.tenant_id
            ORDER BY p.tanggal DESC
        `;

        const ordersRes = await db.query(sqlOrders, [tId]);
        const orders = ordersRes.rows;

        // 2. Query Detail: Untuk rincian di dalam "Laci" (Drawer)
        const sqlDetails = `
            SELECT d.* FROM po_detail d
            JOIN po_utama p ON d.po_id = p.id
            WHERE p.status = 'CMT' AND p.tenant_id = $1
        `;

        const detailsRes = await db.query(sqlDetails, [tId]);
        const allDetails = detailsRes.rows;

        // 3. Render ke halaman
        res.render('admin/data-cmt', { 
            orders: orders || [], 
            details: allDetails || [] 
        });

    } catch (err) {
        console.error("Database Error CMT:", err.message);
        res.status(500).send("Gagal memuat data CMT: " + err.message);
    }
});

app.get('/cek-balance', isAdmin, async (req, res) => {
    const tId = req.session.tenantId;
    const bulanIni = req.query.bulan || new Date().toISOString().slice(0, 7);

    try {
        const configRes = await db.query("SELECT * FROM settings WHERE tenant_id = $1", [tId]);
        const conf = configRes.rows[0] || { beban_tetap: 0 };

        // Perbaikan Query: Gunakan COALESCE dan Casting ::DATE yang tepat
        const sqlAudit = `
            SELECT 
                (SELECT COALESCE(SUM(CASE WHEN jenis = 'PEMASUKAN' THEN jumlah ELSE -jumlah END), 0) 
                 FROM arus_kas WHERE tenant_id = $1) AS s_laci,

                (SELECT COALESCE(SUM(h.jumlah_setor * d.harga_customer), 0) 
                 FROM hasil_kerja h 
                 JOIN po_detail d ON h.detail_id = d.id 
                 WHERE TO_CHAR(h.tanggal::DATE, 'YYYY-MM') = $2 AND h.tenant_id = $1) AS p_prod,

                (SELECT COALESCE(SUM(jumlah), 0) 
                 FROM arus_kas 
                 WHERE kategori IN ('PEMBAYARAN BORDIR', 'PELUNASAN', 'DP/CICILAN') 
                 AND TO_CHAR(tanggal::DATE, 'YYYY-MM') = $2 AND tenant_id = $1) AS p_kas,

                (SELECT COALESCE(SUM(CASE WHEN kategori = 'PIUTANG' THEN jumlah WHEN kategori = 'SARUTANGAN' THEN -jumlah ELSE 0 END), 0) 
                 FROM arus_kas WHERE tenant_id = $1) AS k_kry,

                (SELECT COALESCE(SUM(CASE WHEN kategori = 'HUTANG' THEN jumlah WHEN kategori = 'BAYAR HUTANG' THEN -jumlah ELSE 0 END), 0) 
                 FROM arus_kas WHERE tenant_id = $1) AS s_hutang,

                (SELECT COALESCE(SUM(jumlah), 0) 
                 FROM arus_kas 
                 WHERE kategori = 'BIAYA KONTRAKAN' 
                 AND TO_CHAR(tanggal::DATE, 'YYYY-MM') = $2 AND tenant_id = $1) AS k_bayar,

                (SELECT COALESCE(SUM(jumlah), 0) 
                 FROM arus_kas 
                 WHERE kategori = 'JATAH PROFIT OWNER' 
                 AND TO_CHAR(tanggal::DATE, 'YYYY-MM') = $2 AND tenant_id = $1) AS j_owner
        `;

        const auditRes = await db.query(sqlAudit, [tId, bulanIni]);
        const row = auditRes.rows[0];

        // Pastikan konversi ke Number/Float dilakukan di sini
        const data = {
            saldoLaci: parseFloat(row.s_laci || 0),
            piutangProduksi: parseFloat(row.p_prod || 0) - parseFloat(row.p_kas || 0),
            kasbonKaryawan: parseFloat(row.k_kry || 0),
            sisaHutang: parseFloat(row.s_hutang || 0),
            kontrakan_terbayar: parseFloat(row.k_bayar || 0),
            jatahSudahDiambil: parseFloat(row.j_owner || 0)
        };

        const totalUangAda = data.saldoLaci + data.piutangProduksi + data.kasbonKaryawan;
        const bebanTetap = parseFloat(conf.beban_tetap || 0);
        const sisaKontrakan = Math.max(0, bebanTetap - data.kontrakan_terbayar);
        const profitBersih = totalUangAda - data.sisaHutang - sisaKontrakan - data.jatahSudahDiambil;

        res.render('cek-balance', { 
            data: { ...data, totalUangAda, kontrakan: sisaKontrakan, sisaProfitBersih: profitBersih }, 
            bulanIni: bulanIni 
        });

    } catch (err) {
        console.error("❌ Audit Balance Error:", err.message);
        res.status(500).send("Gagal menghitung balance: " + err.message);
    }
});

const ExcelJS = require('exceljs');

app.get('/backup-database', isAdmin, async (req, res) => {
    const tId = req.session.tenantId;
    const tgl = new Date().toISOString().slice(0, 10);
    const fileName = `Backup_Produksi_Tatriz_${tgl}.xlsx`;

    try {
        const workbook = new ExcelJS.Workbook();
        
        // --- SHEET 1: PRODUKSI & OPERATOR ---
        const sheetProduksi = workbook.addWorksheet('Data Produksi Lengkap');
        
        sheetProduksi.columns = [
            { header: 'Tanggal Kerja', key: 'tgl_kerja', width: 15 },
            { header: 'Nama PO', key: 'nama_po', width: 25 },
            { header: 'Customer', key: 'customer', width: 20 },
            { header: 'Nama Desain', key: 'nama_desain', width: 25 },
            { header: 'Operator', key: 'nama_operator', width: 20 },
            { header: 'Jumlah Setor', key: 'jumlah_setor', width: 12 },
            { header: 'Harga Cust', key: 'harga_customer', width: 15 },
            { header: 'Harga Op', key: 'harga_operator', width: 15 },
            { header: 'Omzet (Cust)', key: 'omzet', width: 18 },
            { header: 'Upah (Op)', key: 'upah', width: 18 }
        ];

        // Query JOIN 4 Tabel: PO Utama, PO Detail, Hasil Kerja, dan Users (Operator)
        const sqlProduksi = `
            SELECT 
                TO_CHAR(h.tanggal, 'YYYY-MM-DD') as tgl_kerja,
                p.nama_po, p.customer,
                d.nama_desain,
                u.nama_lengkap as nama_operator,
                h.jumlah_setor,
                d.harga_customer,
                d.harga_operator,
                (h.jumlah_setor * d.harga_customer) as omzet,
                (h.jumlah_setor * d.harga_operator) as upah
            FROM hasil_kerja h
            JOIN po_detail d ON h.detail_id = d.id
            JOIN po_utama p ON d.po_id = p.id
            JOIN users u ON h.operator_id = u.id
            WHERE h.tenant_id = $1
            ORDER BY h.tanggal DESC, p.nama_po ASC
        `;

        const prodRes = await db.query(sqlProduksi, [tId]);
        sheetProduksi.addRows(prodRes.rows);

        // --- SHEET 2: ARUS KAS ---
        const sheetKas = workbook.addWorksheet('Arus Kas');
        sheetKas.columns = [
            { header: 'Tanggal', key: 'tgl_kas', width: 15 },
            { header: 'Kategori', key: 'kategori', width: 20 },
            { header: 'Keterangan', key: 'keterangan', width: 35 },
            { header: 'Jenis', key: 'jenis', width: 12 },
            { header: 'Jumlah (Rp)', key: 'jumlah', width: 15 }
        ];

        const kasRes = await db.query(
            "SELECT TO_CHAR(tanggal, 'YYYY-MM-DD') as tgl_kas, kategori, keterangan, jenis, jumlah FROM arus_kas WHERE tenant_id = $1 ORDER BY tanggal DESC", 
            [tId]
        );
        sheetKas.addRows(kasRes.rows);

        // --- STYLING & FORMATTING ---
        [sheetProduksi, sheetKas].forEach(sheet => {
            // Header Tebal
            sheet.getRow(1).font = { bold: true };
            // Auto-filter agar mudah dicari di Excel
            sheet.autoFilter = {
                from: { row: 1, column: 1 },
                to: { row: 1, column: sheet.columns.length }
            };
        });

        // --- PROSES KIRIM ---
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);

        await workbook.xlsx.write(res);
        res.end();

    } catch (err) {
        console.error("Gagal Backup Excel:", err.message);
        res.status(500).send("Gagal mengeksport data ke Excel.");
    }
});

// --- 1. HALAMAN MASTER USERS + LOG ---
app.get('/master-users', isAdmin, async (req, res) => {
    if (req.session.tenantId !== 1) {
        return res.status(403).send("Akses Ditolak: Fitur Khusus Developer!");
    }

    try {
        // Ambil Data User & Tenant
        const userSql = `
            SELECT u.id, u.username, u.nama_lengkap, u.role, u.tenant_id, 
                   s.nama_perusahaan, s.level, s.is_active 
            FROM users u 
            LEFT JOIN settings s ON u.tenant_id = s.tenant_id 
            ORDER BY u.tenant_id ASC
        `;
        const users = await db.query(userSql);

        // Ambil 10 Log Terakhir
        const logSql = `
            SELECT l.*, u.username as admin_name 
            FROM dev_logs l
            JOIN users u ON l.admin_id = u.id
            ORDER BY l.created_at DESC LIMIT 10
        `;
        const logs = await db.query(logSql);

        res.render('admin/master-users', { 
            users: users.rows || [],
            devLogs: logs.rows || []
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Gagal memuat data master.");
    }
});

// --- 2. UPDATE LEVEL TENANT + LOG ---
app.get('/update-level/:tId/:newLevel', isAdmin, async (req, res) => {
    if (req.session.tenantId !== 1) return res.status(403).send("Ditolak!");
    const { tId, newLevel } = req.params;

    try {
        await db.query("UPDATE settings SET level = $1 WHERE tenant_id = $2", [newLevel, tId]);
        
        await db.query(`INSERT INTO dev_logs (admin_id, aksi, target_info, keterangan) 
                        VALUES ($1, $2, $3, $4)`, 
            [req.session.userId, 'UPDATE_LEVEL', `Tenant #${tId}`, `Level diubah ke ${newLevel == 2 ? 'PRO' : 'STD'}`]);

        res.redirect('/master-users');
    } catch (err) {
        res.status(500).send("Gagal update level.");
    }
});

// --- 3. RESET PASSWORD MASTER + LOG ---
app.get('/developer/reset-pass/:uId/:newPass', isAdmin, async (req, res) => {
    if (req.session.tenantId !== 1) return res.status(403).send("Ditolak!");
    const { uId, newPass } = req.params;

    try {
        const user = await db.query("SELECT username FROM users WHERE id = $1", [uId]);
        await db.query("UPDATE users SET password = $1 WHERE id = $2", [newPass, uId]);

        await db.query(`INSERT INTO dev_logs (admin_id, aksi, target_info, keterangan) 
                        VALUES ($1, $2, $3, $4)`, 
            [req.session.userId, 'RESET_PASSWORD', user.rows[0].username, `Password baru diset manual.`]);

        res.send("<script>alert('Sukses Reset Password!'); window.location='/master-users';</script>");
    } catch (err) {
        res.status(500).send("Gagal reset password.");
    }
});

// --- 4. RESET KODE AKTIVASI + LOG ---
app.get('/developer/reset-kode/:tId/:newCode', isAdmin, async (req, res) => {
    if (req.session.tenantId !== 1) return res.status(403).send("Ditolak!");
    const { tId, newCode } = req.params;

    try {
        await db.query("UPDATE settings SET registration_secret = $1 WHERE tenant_id = $2", [newCode, tId]);

        await db.query(`INSERT INTO dev_logs (admin_id, aksi, target_info, keterangan) 
                        VALUES ($1, $2, $3, $4)`, 
            [req.session.userId, 'RESET_KODE', `Tenant #${tId}`, `Kode baru: ${newCode}`]);

        res.send("<script>alert('Kode Aktivasi Berhasil Diubah!'); window.location='/master-users';</script>");
    } catch (err) {
        res.status(500).send("Gagal reset kode.");
    }
});

// --- 5. PROSES HAPUS USER GLOBAL + LOG ---
app.get('/delete-user-global/:id', isAdmin, async (req, res) => {
    const userId = req.params.id;
    if (req.session.tenantId !== 1) return res.status(403).send("Ditolak!");
    if (userId == req.session.userId) {
        return res.send("<script>alert('Bahaya! Jangan hapus akun sendiri.'); window.history.back();</script>");
    }

    try {
        const userRes = await db.query("SELECT username FROM users WHERE id = $1", [userId]);
        const targetUser = userRes.rows[0]?.username || "Unknown";

        await db.query("DELETE FROM users WHERE id = $1", [userId]);

        await db.query(`INSERT INTO dev_logs (admin_id, aksi, target_info, keterangan) 
                        VALUES ($1, $2, $3, $4)`, 
            [req.session.userId, 'DELETE_USER', targetUser, `Akun user id ${userId} dihapus permanen.`]);

        res.redirect('/master-users');
    } catch (err) {
        res.status(500).send("Gagal menghapus user.");
    }
});

// --- 6. FITUR HAPUS TOTAL DATA TENANT (TOKO) + LOG ---
app.get('/delete-tenant-complete/:tId', isAdmin, async (req, res) => {
    const targetId = req.params.tId;
    if (req.session.tenantId !== 1 || targetId == 1) return res.status(403).send("Akses Ditolak!");

    try {
        const settingRes = await db.query("SELECT nama_perusahaan FROM settings WHERE tenant_id = $1", [targetId]);
        const targetStore = settingRes.rows[0]?.nama_perusahaan || `Tenant #${targetId}`;

        // Hapus berantai (PostgreSQL)
        await db.query("DELETE FROM hasil_kerja WHERE tenant_id = $1", [targetId]);
        await db.query("DELETE FROM arus_kas WHERE tenant_id = $1", [targetId]);
        await db.query("DELETE FROM po_detail WHERE po_id IN (SELECT id FROM po_utama WHERE tenant_id = $1)", [targetId]);
        await db.query("DELETE FROM po_utama WHERE tenant_id = $1", [targetId]);
        await db.query("DELETE FROM users WHERE tenant_id = $1", [targetId]);
        await db.query("DELETE FROM settings WHERE tenant_id = $1", [targetId]);

        await db.query(`INSERT INTO dev_logs (admin_id, aksi, target_info, keterangan) 
                        VALUES ($1, $2, $3, $4)`, 
            [req.session.userId, 'DELETE_TENANT_TOTAL', targetStore, `Seluruh data toko dimusnahkan.`]);

        res.redirect('/master-users');
    } catch (err) {
        res.status(500).send("Gagal menghapus tenant.");
    }
});

// --- 7. TOGGLE SUSPEND / AKTIFKAN ---
app.get('/toggle-tenant-status/:tId/:status', isAdmin, async (req, res) => {
    if (req.session.tenantId !== 1) return res.status(403).send("Ditolak!");
    const { tId, status } = req.params;

    try {
        await db.query("UPDATE settings SET is_active = $1 WHERE tenant_id = $2", [status, tId]);

        await db.query(`INSERT INTO dev_logs (admin_id, aksi, target_info, keterangan) 
                        VALUES ($1, $2, $3, $4)`, 
            [req.session.userId, status === 'true' ? 'ACTIVATE' : 'SUSPEND', `Tenant #${tId}`, `Status diubah menjadi ${status === 'true' ? 'Aktif' : 'Terblokir'}`]
        );

        res.redirect('/master-users');
    } catch (err) {
        res.status(500).send("Gagal mengubah status toko.");
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

