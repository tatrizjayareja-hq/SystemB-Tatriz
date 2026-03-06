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
    if (!tId) return res.send("<script>alert('Sesi habis, silakan login kembali'); window.location='/';</script>");

    const { 
        nama_perusahaan, alamat, no_hp, nominal_buffer, 
        target_bonus, nominal_bonus_dasar, beban_tetap, nama_mesin_baru 
    } = req.body;

    try {
        let logoUrl = null;

        // 1. Upload Logo (Pastikan bucket 'uploads' sudah PUBLIC di Supabase)
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

        // 2. Update Settings
        let sql = `UPDATE settings SET 
                    nama_perusahaan = $1, alamat = $2, no_hp = $3, 
                    nominal_buffer = $4, target_bonus = $5, 
                    nominal_bonus_dasar = $6, beban_tetap = $7`;
        
        let params = [
            nama_perusahaan || 'Tatriz Unit', 
            alamat || '', 
            no_hp || '', 
            parseFloat(nominal_buffer) || 0, 
            parseFloat(target_bonus) || 0, 
            parseFloat(nominal_bonus_dasar) || 0, 
            parseFloat(beban_tetap) || 0
        ];

        if (logoUrl) {
            sql += `, logo_path = $8 WHERE tenant_id = $9`;
            params.push(logoUrl, tId);
        } else {
            sql += ` WHERE tenant_id = $8`;
            params.push(tId);
        }

        await db.query(sql, params);

        // 3. Tambah Mesin Baru
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

app.post('/update-po/:id', async (req, res) => {
    const poId = req.params.id;
    const tId = req.session.tenantId;
    if (!tId) return res.redirect('/');

    const { 
        tanggal, nama_po, customer, status, 
        jenis_bordir, nama_desain, jumlah, 
        harga_cmt, harga_operator, harga_customer 
    } = req.body;

    try {
        await db.query("BEGIN");

        // 1. Hitung ulang total harga customer untuk Header PO
        let totalHargaCust = 0;
        const jmlArray = Array.isArray(jumlah) ? jumlah : [jumlah];
        const hrgCustArray = Array.isArray(harga_customer) ? harga_customer : [harga_customer];
        
        jmlArray.forEach((qty, i) => {
            totalHargaCust += (parseFloat(qty) || 0) * (parseFloat(hrgCustArray[i]) || 0);
        });

        // 2. Update Header PO
        await db.query(`
            UPDATE po_utama SET 
                tanggal = $1, nama_po = $2, customer = $3, 
                status = $4, total_harga_customer = $5 
            WHERE id = $6 AND tenant_id = $7`,
            [tanggal, nama_po, customer, status, totalHargaCust, poId, tId]
        );

        // 3. Hapus detail lama, lalu masukkan yang baru (Metode paling bersih)
        await db.query("DELETE FROM po_detail WHERE po_id = $1", [poId]);

        if (Array.isArray(jenis_bordir)) {
            for (let i = 0; i < jenis_bordir.length; i++) {
                if (jenis_bordir[i].trim() !== "") {
                    await db.query(`
                        INSERT INTO po_detail 
                        (po_id, jenis_bordir, nama_desain, jumlah, harga_cmt, harga_operator, harga_customer) 
                        VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                        [
                            poId, 
                            jenis_bordir[i], 
                            nama_desain[i], 
                            parseFloat(jumlah[i]) || 0, 
                            parseFloat(harga_cmt[i]) || 0, 
                            parseFloat(harga_operator[i]) || 0, 
                            parseFloat(harga_customer[i]) || 0
                        ]
                    );
                }
            }
        } else if (jenis_bordir) { // Jika hanya ada 1 baris (bukan array)
            await db.query(`
                INSERT INTO po_detail 
                (po_id, jenis_bordir, nama_desain, jumlah, harga_cmt, harga_operator, harga_customer) 
                VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [poId, jenis_bordir, nama_desain, jumlah, harga_cmt, harga_operator, harga_customer]
            );
        }

        await db.query("COMMIT");
        res.send("<script>alert('PO Berhasil Diperbarui!'); window.location='/po-data';</script>");

    } catch (err) {
        await db.query("ROLLBACK").catch(() => {});
        console.error("🔥 Update PO Error:", err.message);
        res.status(500).send("Gagal memperbarui PO: " + err.message);
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
    let ids = req.query.ids; // Menangkap array ID dari checkbox modal
    
    if (!ids) return res.send("Tidak ada PO yang dipilih.");
    
    // Pastikan ids dalam bentuk array angka
    if (!Array.isArray(ids)) ids = [ids];
    const idList = ids.map(id => parseInt(id));

    try {
        // 1. Ambil Setting Perusahaan untuk Header (Logo, Nama Toko, Alamat)
        const config = await db.get("SELECT * FROM settings WHERE tenant_id = $1", [tId]);

        // 2. Query Header PO-PO yang dipilih
        // Menggunakan ANY($1) untuk menangani array ID di PostgreSQL
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

        if (!orders || orders.length === 0) {
            return res.send("Data PO tidak ditemukan.");
        }

        // 3. Ambil rincian detail untuk semua PO tersebut
        const sqlDetails = `SELECT * FROM po_detail WHERE po_id = ANY($1::int[])`;
        const details = await db.all(sqlDetails, [idList]);

        // 4. Render halaman EJS (Pastikan nama file sesuai: print-nota-gabungan.ejs)
        res.render('print-nota-gabungan', { 
            orders, 
            details, 
            config: config || {} 
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
        // 0. Ambil Config
        const config = await db.get("SELECT * FROM settings WHERE tenant_id = $1", [tId]);
        const conf = config || { beban_tetap: 0, nominal_buffer: 0 };

        // 1. Query Statistik Keuangan (Gunakan LIKE dengan $1 || '%')
        const sqlData = `
            SELECT 
                (SELECT SUM(h.jumlah_setor * d.harga_customer) FROM hasil_kerja h JOIN po_detail d ON h.detail_id = d.id WHERE h.tanggal LIKE $1 || '%' AND h.tenant_id = $2) as prod_bln,
                (SELECT SUM(jumlah) FROM arus_kas WHERE jenis = 'PENGELUARAN' AND kategori NOT IN ('BIAYA KONTRAKAN', 'BAYAR HUTANG') AND tanggal LIKE $1 || '%' AND tenant_id = $2) as op_bln,
                (SELECT SUM(jumlah) FROM arus_kas WHERE kategori = 'BIAYA KONTRAKAN' AND tanggal LIKE $1 || '%' AND tenant_id = $2) as k_bayar_bln,
                (SELECT SUM(CASE WHEN kategori = 'HUTANG' THEN jumlah WHEN kategori = 'BAYAR HUTANG' THEN -jumlah ELSE 0 END) FROM arus_kas WHERE tenant_id = $2) as hutang_riil,
                (SELECT SUM(CASE WHEN jenis = 'PEMASUKAN' THEN jumlah ELSE -jumlah END) FROM arus_kas WHERE tenant_id = $2) as saldo_laci
        `;
        const data = await db.get(sqlData, [bulanIni, tId]);

        // 2. Query Piutang Berjalan (Akumulatif)
        const sqlPiutang = `
            SELECT (
                COALESCE((SELECT SUM(h2.jumlah_setor * d2.harga_customer) FROM hasil_kerja h2 JOIN po_detail d2 ON h2.detail_id = d2.id WHERE h2.tenant_id = $1), 0) - 
                COALESCE((SELECT SUM(jumlah) FROM arus_kas WHERE kategori IN ('PEMBAYARAN BORDIR', 'PELUNASAN', 'DP/CICILAN') AND tenant_id = $1), 0)
            ) as piutang_total
        `;
        const rowP = await db.get(sqlPiutang, [tId]);

        // 3. Query Rincian Transaksi
        const rincian = await db.all(`
            SELECT ak.*, p.customer, p.nama_po 
            FROM arus_kas ak 
            LEFT JOIN po_utama p ON ak.po_id = p.id 
            WHERE ak.tanggal LIKE $1 || '%' AND ak.tenant_id = $2
            ORDER BY ak.tanggal DESC, ak.id DESC
        `, [bulanIni, tId]);

        // 4. Query Omzet Harian
        const monitor = await db.all(`
            SELECT h.tanggal, SUM(h.jumlah_setor * d.harga_customer) as total_harian
            FROM hasil_kerja h 
            JOIN po_detail d ON h.detail_id = d.id 
            WHERE h.tanggal LIKE $1 || '%' AND h.tenant_id = $2
            GROUP BY h.tanggal 
            ORDER BY h.tanggal DESC
        `, [bulanIni, tId]);

        // PERHITUNGAN
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
            monitorHarian: monitor || [],
            rincianKas: rincian || [],
            config: conf
        });

    } catch (err) {
        console.error("🔥 Laporan Kas Error:", err.message);
        res.status(500).send("Gagal memuat laporan kas.");
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

