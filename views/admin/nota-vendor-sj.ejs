<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <title>Nota Vendor - SJ #<%= sj.id %></title>
    <style>
        body { font-family: 'Courier New', Courier, monospace; width: 148mm; margin: auto; padding: 10mm; border: 1px solid #eee; }
        .header { text-align: center; border-bottom: 2px double #333; padding-bottom: 10px; margin-bottom: 15px; }
        .info-nota { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 15px; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
        th { border-bottom: 1px solid #333; text-align: left; font-size: 12px; padding: 5px; }
        td { padding: 5px; font-size: 11px; border-bottom: 1px dotted #ccc; }
        .total-box { text-align: right; font-weight: bold; font-size: 14px; border-top: 1px solid #333; padding-top: 5px; }
        .footer { display: flex; justify-content: space-between; margin-top: 30px; text-align: center; font-size: 10px; }
        @media print { .no-print { display: none; } }
    </style>
</head>
<body>
    <div class="no-print" style="margin-bottom: 20px; text-align: right;">
        <button onclick="window.print()" style="padding: 10px 20px; cursor: pointer; background: #27ae60; color: white; border: none; border-radius: 5px;">🖨️ CETAK NOTA</button>
    </div>

    <div class="header">
        <h2 style="margin:0; font-size: 16px;">SURAT JALAN / NOTA CMT</h2>
        <small><%= config.nama_perusahaan %></small>
    </div>

    <div class="info-nota">
        <div>
            Vendor: <strong><%= sj.nama_vendor %></strong><br>
            Tgl Kirim: <%= new Date(sj.tanggal_kirim).toLocaleDateString('id-ID') %>
        </div>
        <div style="text-align: right;">
            No. SJ: <strong>#<%= sj.id %></strong><br>
            Status: <strong><%= sj.status %></strong>
        </div>
    </div>

    <table>
        <thead>
            <tr>
                <th>Detail Item (PO)</th>
                <th style="text-align: center;">Qty</th>
                <th style="text-align: right;">Hrg CMT</th>
                <th style="text-align: right;">Subtotal</th>
            </tr>
        </thead>
        <tbody>
            <% 
               let grandTotal = 0; 
               items.forEach(item => { 
                 let sub = Number(item.qty_dikirim) * Number(item.harga_cmt_saat_ini);
                 grandTotal += sub;
            %>
                <tr>
                    <td>
                        <strong><%= item.nama_po %></strong><br>
                        <small><%= item.nama_desain %> (<%= item.jenis_bordir %>)</small>
                    </td>
                    <td style="text-align: center;"><%= item.qty_dikirim %></td>
                    <td style="text-align: right;"><%= Number(item.harga_cmt_saat_ini).toLocaleString('id-ID') %></td>
                    <td style="text-align: right;"><%= sub.toLocaleString('id-ID') %></td>
                </tr>
            <% }); %>
        </tbody>
    </table>

    <div class="total-box">
        ESTIMASI TAGIHAN VENDOR: Rp <%= grandTotal.toLocaleString('id-ID') %>
    </div>

    <div class="footer">
        <div style="width: 40%;">Pengirim (Admin),<br><br><br><br>( <%= config.nama_perusahaan %> )</div>
        <div style="width: 40%;">Penerima (Vendor),<br><br><br><br>( <%= sj.nama_vendor %> )</div>
    </div>
</body>
</html>