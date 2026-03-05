const sqlite3 = require("sqlite3").verbose();
const fs = require("fs");

const db = new sqlite3.Database("./tatriz.db");

db.all("SELECT name FROM sqlite_master WHERE type='table'", [], (err, tables) => {
  if (err) throw err;

  tables.forEach((table) => {
    const tableName = table.name;

    // 1. Ambil info kolom terlebih dahulu untuk mendapatkan header (meski data kosong)
    db.all(`PRAGMA table_info("${tableName}")`, [], (err, columns) => {
      if (err) {
        console.error(`❌ Gagal mengambil skema tabel ${tableName}:`, err.message);
        return;
      }

      // Ambil semua nama kolom untuk dijadikan header CSV
      const headers = columns.map(col => col.name).join(",");

      // 2. Ambil datanya
      db.all(`SELECT * FROM "${tableName}"`, [], (err, rows) => {
        if (err) {
          console.error(`❌ Gagal membaca data ${tableName}:`, err.message);
          return;
        }

        let csvContent = headers + "\n"; // Inisialisasi dengan header

        if (rows.length > 0) {
          const data = rows.map(row =>
            Object.values(row).map(val => {
              if (val === null) return '""';
              let escaped = String(val).replace(/"/g, '""');
              return `"${escaped}"`;
            }).join(",")
          );
          csvContent += data.join("\n");
        }

        // 3. Tulis file (Akan tetap jalan meskipun rows.length === 0)
        try {
          fs.writeFileSync(`${tableName}.csv`, csvContent);
          if (rows.length === 0) {
            console.log(`⚠️  ${tableName}.csv dibuat (Hanya Header - Tabel Kosong)`);
          } else {
            console.log(`✅ ${tableName}.csv berhasil dibuat (${rows.length} baris)`);
          }
        } catch (fsErr) {
          console.error(`❌ Gagal menulis file ${tableName}.csv:`, fsErr.message);
        }
      });
    });
  });
});