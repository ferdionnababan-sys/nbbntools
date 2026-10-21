# Audit Fase 1 — Identitas Pemilik, Administrasi, dan Penyimpanan Data

Tanggal audit: 2026-10-21
Basis audit: branch `main`, commit `e1b682dd5a3e46d020972aacea38ddf9af9b0874`
Ruang lingkup: pembacaan source repository; belum merupakan penetration test atau verifikasi penuh website produksi.

## Ringkasan

Kasir Digital saat ini adalah aplikasi browser-side berbasis HTML/JavaScript dan `localStorage`, bukan sistem kasir berbasis akun/server. Dalam file yang diaudit tidak ditemukan alur autentikasi, sesi pengguna, backend API, atau pemeriksaan otorisasi server untuk fungsi kasir. Karena itu, identitas pemilik website belum dapat dianggap diverifikasi oleh aplikasi dan fungsi kelola produk/transaksi bukan admin yang diamankan oleh server.

Ini tidak membuktikan ada akses jarak jauh ke data kasir: data tersimpan pada browser/perangkat/origin yang digunakan. Namun siapa pun yang memakai browser/profil yang sama dapat berpotensi membuka dan mengubah data lokal tersebut.

## Temuan berbasis bukti

### HIGH — Kasir tidak memiliki autentikasi/otorisasi server
- Lokasi: `kasir/index.html`, inisialisasi aplikasi pada baris 121–134 dan event-handler fungsi produk/transaksi di bagian script berikutnya.
- Bukti: aplikasi langsung menginisialisasi `db=loadDB()`; fungsi `loadDB()` membaca `localStorage.getItem('nbbntools_kasir_v1')`; tidak terlihat proses login, sesi, panggilan API, atau pemeriksaan izin server dalam alur tersebut.
- Dampak: pengguna yang memiliki akses ke halaman dan browser yang menyimpan data dapat menggunakan fungsi kelola produk, stok, transaksi, backup, restore, dan reset. Tidak ada batasan berbasis akun/pemilik pada sisi server.
- Rekomendasi: bila produk akan mendukung akun, multi-perangkat, atau akses admin jarak jauh, bangun backend dengan autentikasi terverifikasi dan otorisasi server-side. Jangan menganggap menyembunyikan tombol sebagai keamanan.
- Pengujian: uji setiap endpoint sensitif sebagai anonim, pengguna biasa, pemilik, dan pengguna lain setelah backend tersedia. Saat ini belum ada endpoint aplikasi yang dapat diuji untuk otorisasi server.

### HIGH — Data bisnis berada di localStorage dan tidak terpisah per akun
- Lokasi: `kasir/index.html`, konstanta `KEY` dan fungsi `loadDB()`/`saveDB()` pada baris 124, 132–133.
- Bukti: kunci penyimpanan tetap `nbbntools_kasir_v1`; data produk/transaksi/settings dimuat dan disimpan di browser.
- Dampak: data tidak otomatis tersinkron antarperangkat, tidak memiliki isolasi per akun, dapat hilang saat data browser dihapus, dan bisa dilihat/diubah oleh orang yang memakai profil browser yang sama. Skrip same-origin yang berhasil dieksekusi juga dapat mengakses data ini.
- Rekomendasi: jangan memindahkan data ke layanan eksternal tanpa keputusan infrastruktur, kebijakan privasi, persetujuan, dan rencana migrasi. Untuk multi-user diperlukan backend, user ID terverifikasi, pemeriksaan kepemilikan data di setiap operasi, backup server, serta migrasi yang dapat dipulihkan. Sementara itu, jelaskan secara tegas bahwa data hanya tersimpan lokal dan anjurkan backup berkala.
- Pengujian: validasi persistensi lokal dan backup/restore dengan data sintetis terisolasi. Uji isolasi akun hanya setelah autentikasi/backend benar-benar tersedia.

### MEDIUM — Identitas pemilik belum dibuktikan oleh aplikasi
- Lokasi: homepage `index.html` dan `kasir/index.html`.
- Bukti: metadata homepage mengidentifikasi brand sebagai NBBNTOOLS dan kasir memakai nama toko default `Warung Saya`; bukti yang diperiksa tidak menunjukkan mekanisme verifikasi identitas pemilik atau klaim admin yang terikat ke identitas terautentikasi.
- Dampak: nama brand atau nama toko saja bukan bukti bahwa pengguna yang sedang mengakses adalah pemilik sah.
- Rekomendasi: pisahkan identitas pemilik repositori/domain dari identitas akun aplikasi. Jika diperlukan panel pemilik, gunakan autentikasi dan otorisasi server-side; jangan menanam token/password di JavaScript publik.
- Pengujian: periksa konfigurasi hosting/domain dan backend yang sebenarnya, lalu uji alur autentikasi/otorisasi setelah tersedia. Kepemilikan domain/akun hosting tidak dapat dipastikan hanya dari file HTML.

### LOW — Service worker membatasi cache ke halaman publik/aset statis
- Lokasi: `service-worker.js`.
- Bukti: daftar shell hanya halaman publik/aset; handler navigasi membatasi cache dengan `isPublicPage()`; komentar dan logika fetch mengecualikan API/JSON dinamis.
- Dampak: kebijakan ini mengurangi risiko cache data dinamis secara sembarangan. Namun halaman kasir publik tetap dapat dibuka offline dan data kasirnya tetap berada di localStorage browser.
- Rekomendasi: pertahankan pembatasan cache ini. Jika kelak ada login atau respons berisi data privat, pastikan respons privat tidak masuk cache umum dan lakukan pengujian logout/cache pada perangkat bersama.
- Pengujian: source review selesai; uji browser/offline langsung belum dilakukan dalam audit ini.

## Kontrol yang tampak sudah ada (belum dianggap sebagai audit menyeluruh)

- ID catatan dibuat memakai `crypto.getRandomValues` pada `kasir/index.html`.
- Pesan kegagalan `localStorage` ditangani oleh `saveDB()`.
- Ekspor CSV melakukan quoting dan menambahkan awalan apostrof untuk nilai yang berpotensi menjadi formula spreadsheet.
- Backup divalidasi sebelum restore; source review menunjukkan validasi struktur dasar dan konfirmasi pengguna.
- Service worker tidak menangani cache endpoint dinamis/JSON secara umum.

Keberadaan kontrol di atas tidak membuktikan seluruh skenario barcode, checkout, backup, restore, laporan, atau responsif telah lulus pengujian browser.

## Prioritas implementasi berikutnya

1. Fase 2: petakan seluruh skema data dan batasan localStorage; pertahankan format lama dan buat pengujian migrasi/backup tanpa menyentuh data produksi.
2. Fase 4: tinjau mendalam barcode, penghapusan produk, checkout/rollback, validasi backup, dan laporan; tambahkan pengujian regresi terisolasi.
3. Infrastruktur: sebelum membangun akun/admin multi-user, tentukan backend dan mekanisme autentikasi yang benar. Jangan membuat login simulasi di frontend.
4. Setelah setiap perubahan: jalankan workflow CI dan browser evidence yang tersedia, tinjau diff, lalu ajukan PR terpisah. Jangan merge bila pemeriksaan wajib gagal.

## Batas audit

- Source code repository telah dibaca untuk homepage, kasir, service worker, dan workflow CI terkait.
- Tidak dilakukan pengujian destruktif atau perubahan pada data produksi.
- Website produksi belum dinyatakan terverifikasi langsung.
- Tidak ada perubahan kode aplikasi pada commit audit ini; dokumen ini hanya mencatat hasil audit awal.
