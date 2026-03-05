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

// --- 2. KONEKSI STORAGE (Supabase SDK) ---
const supabase = createClient(
    process.env.SUPABASE_URL, 
    process.env.SUPABASE_ANON_KEY
);

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