# Riset ulang: alur wisata Taman Safari Bogor, masalah per alur, dan solusi AI Vision

Disusun 2026-11-04 sebagai kerangka berpikir ala skripsi: latar belakang, alur (workflow), masalah per alur, rumusan masalah, solusi, kesimpulan. File ini berdiri sendiri; menghapusnya tidak memengaruhi deck atau outline.

Sumber publik yang dipakai untuk bagian alur: pemberitaan tiket dua kategori (Fortune IDN, 2024), rincian tiket premium dan Safari Malam (Metro TV, 2026), pembayaran nontunai menyeluruh termasuk tiket tunggang satwa (Investortrust), panduan kunjungan (Jakarta Post, 2018), dan laporan kepadatan libur (Republika, 2015). Bagian masalah menggabungkan sumber itu dengan pengamatan dari footage dan dashboard proyek. Angka harga sengaja tidak dicantumkan karena berubah tiap tahun.

---

## 1. Latar belakang

Taman Safari Bogor adalah taman wisata satwa berbasis kendaraan: pengunjung masuk dengan mobil pribadi atau bus safari, menempuh safari journey sekitar satu jam, lalu melanjutkan ke area pejalan kaki berisi Baby Zoo, pertunjukan, wahana, exhibit, restoran, dan toko. Pendapatan datang dari banyak titik transaksi kecil yang tersebar: tiket per orang, tiket per kendaraan, tiket wahana dan tunggang satwa yang dijual terpisah, pakan satwa, makanan dan minuman, suvenir, parkir, serta sesi khusus seperti Safari Malam.

Sejak 2024 tiket dibedakan menjadi Premium dan Reguler; sebagian atraksi (Istana Panda, wahana permainan, Curug Jaksa, tunggang satwa) dijual dengan tiket tambahan. Pembayaran sudah nontunai menyeluruh lewat QRIS, barcode, dan kartu. Artinya sisi transaksi sudah tercatat rapi di POS. Yang belum tercatat adalah sisi kejadian fisiknya: berapa kendaraan yang benar-benar lewat, berapa putaran yang benar-benar terjadi, berapa kotak pakan yang benar-benar diserahkan, berapa lama tamu menunggu, berapa meja yang terisi. Selisih antara transaksi dan kejadian itulah yang hari ini hanya bisa diperiksa dengan memutar ulang CCTV, berjam-jam per kasus.

Kamera CCTV sudah terpasang di hampir semua titik itu untuk keamanan. Computer vision memungkinkan kamera yang sama menghasilkan hitungan, status, dan bukti per kejadian, tanpa mengganti kamera dan tanpa mengirim video keluar dari jaringan taman.

## 2. Alur wisata (workflow) di Taman Safari Bogor

Alur disusun mengikuti perjalanan satu rombongan dari datang sampai pulang. Tiap alur diberi kode agar bisa dirujuk di bagian masalah dan solusi.

| Kode | Alur | Apa yang terjadi | Titik transaksi atau layanan |
|---|---|---|---|
| A1 | Kedatangan dan gerbang kendaraan | Kendaraan antre di gerbang, tiket per orang dan per kendaraan diperiksa atau dibeli | Tiket masuk, tiket kendaraan |
| A2 | Parkir dan pindah moda | Pengunjung bus atau yang parkir berganti ke bus safari atau berjalan kaki | Karcis parkir, tiket bus safari |
| A3 | Pembelian pakan sebelum safari | Kios sayur dan pakan di jalur sebelum masuk safari journey | Penjualan pakan |
| A4 | Safari journey (drive-through) | Sekitar satu jam melewati zona satwa, dilarang turun dari kendaraan, memberi pakan di titik yang diizinkan | Pengalaman inti, keselamatan |
| A5 | Loket tiket wahana dan atraksi berbayar | Loket di dalam taman untuk tunggang satwa, Istana Panda, wahana, Curug Jaksa | Tiket tambahan per wahana |
| A6 | Wahana tunggang satwa | Kuda poni, gajah, unta; satu tiket per putaran | Tiket per putaran |
| A7 | Feeding di area pejalan kaki dan Baby Zoo | Kotak pakan dibeli di konter, diserahkan ke tamu, diberikan ke satwa | Penjualan pakan per kotak |
| A8 | Pertunjukan dan exhibit | Amfiteater dan exhibit dengan jadwal dan kapasitas tempat duduk | Kapasitas, jadwal show |
| A9 | Restoran dan kafe | Aula makan, meja, antrean kasir | Penjualan F&B, perputaran meja |
| A10 | Toko suvenir dan foto bersama satwa | Kasir toko, konter foto | Penjualan ritel, sesi foto |
| A11 | Sesi khusus | Safari Malam dengan kereta wisata, event libur | Tiket sesi khusus |
| A12 | Kepulangan dan gerbang keluar | Kendaraan keluar, kemacetan sore di akses Bogor–Cianjur | Rekonsiliasi masuk vs keluar |
| B1 | Alur internal: keeper dan kandang | Keeper masuk kandang lewat pintu ganda, pemberian pakan, pembersihan | Keselamatan staf |
| B2 | Alur internal: staf loket dan kasir | Jadwal shift, kehadiran di pos, serah terima | Disiplin layanan |
| B3 | Alur internal: audit dan pelaporan | Manajemen merekonsiliasi POS dengan kenyataan, menangani komplain, memutar CCTV | Jam kerja audit |

## 3. Masalah per alur

Masalah dikelompokkan dalam tiga jenis yang sama dengan label di deck: **kebocoran pendapatan** (ada kejadian, tidak ada transaksi), **kualitas layanan** (tamu dirugikan tanpa ketahuan), dan **keselamatan** (risiko fisik). Satu alur bisa punya lebih dari satu jenis.

| Alur | Masalah | Jenis | Bukti atau indikasi |
|---|---|---|---|
| A1 | Kendaraan masuk tidak punya bukti per unit; selisih tiket kendaraan vs kendaraan riil baru ketahuan di akhir hari, kalau ketahuan | Kebocoran | Footage gerbang menunjukkan arus padat dengan banyak jenis kendaraan; penghitungan manual tidak mungkin akurat |
| A1 | Antrean gerbang saat libur, tanpa ukuran waktu tunggu | Layanan | Laporan kepadatan libur dan kemacetan akses |
| A2 | Parkir penuh saat libur, tidak ada angka okupansi real-time; penumpang bus safari tidak dihitung per keberangkatan | Layanan, kebocoran | Laporan parkir penuh saat libur |
| A3 | Pakan yang terjual di kios tidak bisa dibandingkan dengan yang diserahkan | Kebocoran | Pola sama dengan A7 |
| A4 | Pengunjung turun dari kendaraan atau membuka jendela di zona satwa buas; kendaraan berhenti terlalu lama menghambat konvoi | Keselamatan | Larangan turun dari kendaraan ditegaskan di panduan kunjungan |
| A4 | Pemberian pakan di titik yang tidak diizinkan | Keselamatan, kesejahteraan satwa | Aturan feeding yang tidak seragam dalam ulasan pengunjung |
| A5 | Kasir meninggalkan loket saat tamu antre; komplain baru sampai ke manajemen belakangan | Layanan | Snapshot loket Mini Train: kasir 0, tamu menunggu |
| A6 | Putaran tunggang tidak terhitung; penunggangan tanpa tiket tidak bisa dibuktikan | Kebocoran | Snapshot kuda poni dengan garis keberangkatan dan kepulangan |
| A7 | Satu kotak pakan terjual bisa dibagi menjadi dua di konter; selisih tidak pernah tampak di POS | Kebocoran | Hipotesis dari pengamatan operasional; belum ada footage |
| A8 | Kapasitas amfiteater tidak terukur; penonton berdiri atau duduk di tangga saat ramai | Keselamatan, layanan | Pola umum tempat pertunjukan |
| A9 | Kepadatan aula dan lama duduk tidak terpantau; meja kotor lambat dibersihkan saat ramai; meja digeser dan digabung sehingga denah tetap tidak akurat | Layanan | Snapshot Safari Cafe; catatan lapangan tentang meja yang berpindah |
| A10 | Kasir toko dan konter foto punya masalah yang sama dengan A5 dan A6 | Layanan, kebocoran | Analogi pola |
| A11 | Sesi malam dengan pencahayaan rendah; hitungan dan keamanan lebih sulit | Keselamatan | Jadwal Safari Malam 16.30–20.00 |
| A12 | Kendaraan keluar tidak direkonsiliasi dengan yang masuk; kemacetan pulang 18.00–20.00 tanpa data arus | Kebocoran, layanan | Laporan kemacetan akses saat libur |
| B1 | Dua pintu airlock kandang terbuka bersamaan; keeper sendirian di kandang | Keselamatan | Prosedur baku kebun binatang |
| B2 | Pos tanpa petugas pada jam tertentu; serah terima shift tidak tercatat | Layanan | Pola A5 |
| B3 | Audit satu kasus memakan jam kerja untuk memutar CCTV; laporan rekonsiliasi dibuat manual | Efisiensi | Keluhan umum pengelola CCTV |

## 4. Rumusan masalah

1. Bagaimana memastikan setiap kejadian yang seharusnya menghasilkan transaksi (kendaraan masuk, putaran tunggang, kotak pakan diserahkan, tiket wahana) tercatat dengan bukti, sehingga selisih terhadap POS terlihat pada hari yang sama?
2. Bagaimana mendeteksi penurunan kualitas layanan (loket kosong saat tamu antre, antrean panjang, aula penuh, meja kotor menganggur) secara real-time, bukan dari komplain belakangan?
3. Bagaimana menegakkan aturan keselamatan di safari journey dan di kandang (turun dari kendaraan, berhenti terlalu lama, pintu ganda) tanpa menambah petugas di tiap titik?
4. Bagaimana melakukan semua itu dengan kamera yang sudah ada, tanpa video keluar dari jaringan taman, dan dengan beban audit yang turun, bukan naik?

## 5. Solusi

Solusi disusun dalam tiga tingkat kesiapan. Tingkat 1 sudah berjalan dan punya bukti. Tingkat 2 memakai mekanisme yang sama (deteksi orang dan kendaraan, garis hitung, zona, batas waktu, plat nomor) dan bisa dipilot dalam 4 sampai 8 minggu per modul. Tingkat 3 butuh model atau data baru dan dijual sebagai proyek bersama.

### 5.1 Tingkat 1: tersedia sekarang

| Alur | Modul | Mekanisme | Menjawab rumusan |
|---|---|---|---|
| A1, A12 | Gerbang kendaraan | Garis hitung dua arah, pembacaan plat format Indonesia, snapshot per lintasan, rekap per jam vs tiket | 1, 4 |
| A5, B2 | Loket kasir | Zona kursi kasir dan zona antrean, filter 3 detik, alarm plus klip 30 detik | 2 |
| A6 | Wahana tunggang | Garis keberangkatan dan kepulangan di titik sempit, filter pawang, rekap harian vs POS | 1 |
| A9 | Restoran | Hitung tamu aula vs batas warning dan kapasitas, status zona meja dan lama duduk | 2 |
| A7 | Feeding (pilot) | Garis hitung kotak yang berpindah ke tamu di konter, dibandingkan transaksi POS per jam | 1 |
| B3 | Dashboard dan log kejadian | Semua kejadian dengan foto dan klip, filter, ekspor PDF dan CSV | 4 |

### 5.2 Tingkat 2: siap pilot

| Alur | Modul | Mekanisme |
|---|---|---|
| A1, A2 | Gerbang pejalan kaki dan bus safari | Garis hitung orang di turnstile dan pintu bus, vs tiket terjual atau per keberangkatan |
| A2, A12 | Parkir dan durasi kunjungan | Plat masuk dicocokkan plat keluar; okupansi lahan parkir per zona |
| A1, A5, A6, A9 | Antrean dan waktu tunggu | Jumlah orang di zona antre dan lama per orang; ambang memicu alarm buka loket tambahan |
| B2 | Kehadiran petugas di pos | Zona pos harus terisi pada jam tertentu; kosong melewati batas menjadi kejadian |
| A4 | Keselamatan safari journey | Orang terdeteksi di luar kendaraan di zona satwa; kendaraan berhenti melewati batas waktu |
| A8 | Kepadatan pertunjukan | Okupansi amfiteater vs kapasitas, peringatan saat penonton di tangga |
| A4, A8, seluruh area | Intrusi area terlarang dan perimeter malam | Orang di zona terlarang atau di luar jam buka |
| B1 | Pintu ganda kandang | Status dua pintu dan kehadiran keeper; keduanya terbuka bersamaan menjadi kejadian dengan klip |
| A10 | Kasir toko dan konter foto | Pola loket dan pola wahana dipakai ulang |

### 5.3 Tingkat 3: pengembangan

| Alur | Modul | Kebutuhan |
|---|---|---|
| A6, A7, A10 | Foto momen otomatis dijual lewat QR tiket | Halaman penjualan dan pencocokan waktu transaksi, tanpa pengenalan wajah |
| A5, A6 | Papan waktu tunggu publik dan antrean virtual | Layar di lapangan atau integrasi aplikasi |
| B3 | Pencarian kejadian dengan bahasa biasa dan ringkasan otomatis | Embedding gambar dan teks di atas snapshot; model vision-language untuk ringkasan |
| A4 | Pelanggaran di dalam kendaraan (jendela terbuka, tangan keluar, memberi pakan dari mobil) | Model khusus dari footage safari journey |
| A4 | Peta satwa terlihat live per segmen | Model deteksi satwa per spesies |
| B1, A8 | Pemantauan perilaku dan kesejahteraan satwa | Data berbulan-bulan dan kerja sama tim kurator; kamera termal untuk malam |

Yang sengaja tidak ditawarkan: pengenalan wajah pengunjung (izin dan privasi) dan modul yang mensyaratkan drone atau kamera termal sebelum ada kebutuhan jelas.

## 6. Kesimpulan

1. Masalah inti Taman Safari Bogor bukan pencatatan transaksi, yang sudah nontunai dan rapi, melainkan ketiadaan catatan kejadian fisik yang bisa dibandingkan dengan transaksi itu. Kebocoran, penurunan layanan, dan pelanggaran keselamatan sama-sama tersembunyi di celah ini.
2. Celah itu ada di hampir setiap alur, dari gerbang sampai gerbang keluar, dan pola teknisnya hanya sedikit: menghitung yang melewati garis, mengukur siapa berada di zona mana berapa lama, dan membaca plat. Lima modul yang sudah ada membuktikan pola itu bekerja di lokasi; sembilan modul berikutnya adalah pola yang sama di titik lain.
3. Nilai utamanya adalah revenue assurance dan service assurance: memastikan setiap rupiah yang seharusnya masuk tercatat dan setiap tamu benar-benar dilayani. Efisiensi audit menyusul sebagai efek, dan pendapatan baru (foto momen, antrean virtual) adalah tahap lanjutan.
4. Karena belum ada data pilot, deck tidak boleh menjanjikan persentase. Yang dijanjikan adalah KPI yang diukur selama pilot: selisih lintasan vs tiket per hari, menit loket kosong per shift, selisih putaran vs tiket, selisih kotak pakan vs penjualan, dan jam audit CCTV yang hilang. Angka dari pilot itulah bahan jual tahap berikutnya.

## 7. Dampak ke deck saat ini

Deck v3 sudah mengikuti struktur ini untuk enam titik alur (A1, A5, A6, A7, A9, A12). Yang bisa ditambahkan dari riset ini tanpa mengubah cerita: tabel alur 13 titik sebagai lampiran untuk tim sales, dan penekanan di slide tantangan bahwa POS sudah rapi sehingga masalahnya di sisi kejadian, bukan di kasir. Slide Peta solusi tiga tingkat yang sempat dibuat lalu dihapus sejalan dengan bagian 5 dokumen ini dan bisa dihidupkan kembali kapan saja.
