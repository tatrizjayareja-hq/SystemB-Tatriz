const sqlite3 = require("sqlite3").verbose();
const fs = require("fs");
const path = require("path");

// Pastikan jalur file database benar
const dbPath = path.join(__dirname, "tatriz.db"); 
const db = new sqlite3.Database(dbPath);

db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'", [], (err, tables) => {
  if (err) throw err;

  tables.forEach((table) => {
    const tableName = table.name;

    db.all(`SELECT * FROM "${tableName}"`, [], (err, rows) => {
      if (err) {
        console.error(`❌ Gagal membaca tabel ${tableName}:`, err.message);
        return;
      }

      if (rows.length === 0) {
        console.log(`⚠️  Tabel ${tableName} kosong, dilewati.`);
        return;
      }

      // Ambil header dan tambahkan tenant_id jika belum ada
      let columnNames = Object.keys(rows[0]);
      if (!columnNames.includes('tenant_id')) {
        columnNames.push('tenant_id');
      }
      
      const headers = columnNames.join(",");

      const csvData = rows.map(row => {
        // Tambahkan nilai tenant_id = 1 ke setiap baris
        if (row.tenant_id === undefined) {
          row.tenant_id = 1;
        }

        return columnNames.map(col => {
          let val = row[col];
          if (val === null || val === undefined) return '""';
          // Bersihkan teks agar tidak merusak format CSV
          let escaped = String(val).replace(/"/g, '""').replace(/\n/g, ' ');
          return `"${escaped}"`;
        }).join(",");
      });

      const finalContent = headers + "\n" + csvData.join("\n");

      fs.writeFileSync(`${tableName}.csv`, finalContent);
      console.log(`✅ Berhasil: ${tableName}.csv (${rows.length} baris)`);
    });
  });
});