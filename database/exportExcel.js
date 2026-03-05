const sqlite3 = require("sqlite3").verbose();
const XLSX = require("xlsx");

const db = new sqlite3.Database("./tatriz.db");
const workbook = XLSX.utils.book_new();

// Ambil semua nama tabel
db.all(
  "SELECT name FROM sqlite_master WHERE type='table'",
  [],
  (err, tables) => {
    if (err) throw err;

    if (tables.length === 0) {
      console.log("Tidak ada tabel ditemukan.");
      return;
    }

    let completed = 0;

    tables.forEach((table) => {
      const tableName = table.name;

      db.all(`SELECT * FROM ${tableName}`, [], (err, rows) => {
        if (!err && rows.length > 0) {
          const worksheet = XLSX.utils.json_to_sheet(rows);
          XLSX.utils.book_append_sheet(workbook, worksheet, tableName);
        }

        completed++;

        // Jika semua tabel sudah diproses
        if (completed === tables.length) {
          if (workbook.SheetNames.length === 0) {
            console.log("Semua tabel kosong.");
          } else {
            XLSX.writeFile(workbook, "backup_tatriz.xlsx");
           console.log(tables);
          }

          db.close();
        }
      });
    });
  }
);
