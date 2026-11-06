# Riset ulang: alur wisata Taman Safari Bogor, masalah per alur, dan solusi AI Vision

Disusun 2026-11-04. Kerangka mengikuti pola skripsi: latar belakang, metode, pemetaan alur, identifikasi masalah, rumusan masalah, solusi, batasan, kesimpulan.

Setiap masalah diberi label sumber bukti supaya jelas mana yang sudah terbukti dan mana yang masih dugaan:

- **[F]** terbukti dari footage dan data yang sudah kita pegang (demo_gate.mp4, snapshot loket, restoran, kuda poni).
- **[P]** dari sumber publik (pemberitaan, situs tiket, ulasan pengunjung).
- **[H]** hipotesis internal yang masih harus divalidasi saat site survey.

---

## 1. Latar belakang

Taman Safari Bogor (Cisarua) adalah taman satwa dengan dua model kunjungan sekaligus: safari drive-through dengan kendaraan pribadi atau bus safari, dan zona pejalan kaki berisi exhibit, pertunjukan, wahana, dan restoran. Beberapa fakta yang membentuk konteks operasionalnya:

- Tiket masuk dibagi dua kategori sejak 1 Juli 2024: Premium dan Reguler. Reguler lebih murah karena beberapa atraksi (Istana Panda, wahana permainan, Curug Jaksa) dijual dengan tiket terpisah. [P]
- Di luar tiket masuk ada aktivitas berbayar tambahan: satwa tunggang, berfoto dengan satwa, Feeding Animal Interaction, kereta gantung dan kereta wisata, perahu, 4D/8D, waterpark, swimming with dolphin. [P]
- Pembayaran nontunai menyeluruh (QRIS, barcode, kartu debit) diterapkan sejak Februari 2024 di loket, tunggang satwa, wahana, waterpark, dan kereta gantung; tunai dihapus bertahap. Artinya setiap transaksi resmi sudah tercatat digital di POS. [P]
- Jam buka 08.30 sampai 17.00, gerbang ditutup 16.00; Safari Malam di waktu tertentu dengan tiket terpisah. [P]
- Pada puncak libur, parkir penuh dan jalur keluar macet dari gerbang sampai simpang Bogor-Cianjur pada pukul 18.00 sampai 20.00. [P, laporan 2015]
- Kamera CCTV sudah terpasang di banyak titik; cakupan satu site sekitar 12 kamera analitik per server edge. [F]

Inti persoalannya: transaksi sudah digital, tetapi **kejadian fisiknya** (kendaraan yang lewat, putaran tunggang, kotak pakan yang berpindah, tamu yang menunggu) tidak tercatat. POS mencatat apa yang dibayar, bukan apa yang terjadi. Selisih antara keduanya tidak terlihat, dan membuktikannya hari ini berarti memutar ulang CCTV berjam-jam.

## 2. Metode

1. Pemetaan alur dari sumber publik: pemberitaan harga dan kategori tiket, situs operator tur, panduan perjalanan, ulasan pengunjung.
2. Observasi footage dan snapshot yang sudah ada: gerbang kendaraan (Main Vehicle Gate 1), loket Mini Train, Safari Cafe Dining Hall, wahana kuda poni.
3. Diskusi internal tentang pola kecurangan yang pernah disebut (pembagian kotak pakan).
4. Belum dilakukan: wawancara terstruktur dengan manajemen taman, akses data POS, dan survei lapangan menyeluruh. Semua masalah berlabel [H] bergantung pada langkah ini.

## 3. Pemetaan alur

### 3.1 Alur pengunjung

| Kode | Alur | Apa yang terjadi | Titik transaksi atau layanan |
|---|---|---|---|
| W1 | Kedatangan dan parkir | Kendaraan masuk dari jalan raya Puncak, antre di gerbang, parkir di area yang penuh saat libur | Tiket kendaraan, karcis parkir |
| W2 | Tiket masuk | Beli di loket atau daring, pilih Premium/Reguler, dewasa/anak, scan di gerbang | Tiket per orang, pembayaran nontunai |
| W3 | Safari Journey | Berkendara sekitar satu jam melewati zona satwa dengan mobil pribadi atau bus safari; dilarang turun; memberi makan hanya di titik yang ditandai, wortel dibeli di kios sebelum masuk | Tiket bus safari, penjualan wortel |
| W4 | Zona pejalan kaki | Exhibit (Baby Zoo, Bird Aviary, Komodo, Reptile, Penguin, Primate, Kampung Papua), presentasi edukasi satwa, sekitar 23 wahana permainan, Istana Panda dengan bus internal | Sebagian wahana tiket terpisah untuk Reguler |
| W5 | Aktivitas berbayar tambahan | Satwa tunggang, foto dengan satwa, feeding interaction, kereta gantung, perahu, 4D/8D | Tiket per sesi atau per putaran di konter masing-masing |
| W6 | Makan dan minum | Restoran dan kios; aula makan dengan meja yang sering digeser dan digabung rombongan | Transaksi F&B, kapasitas aula |
| W7 | Kepulangan | Keluar lewat gerbang, kemacetan sore saat libur; sesi Safari Malam masuk setelah pengunjung siang keluar | Rekonsiliasi kendaraan keluar, pergantian sesi |

### 3.2 Alur operasional internal

| Kode | Alur | Apa yang terjadi |
|---|---|---|
| O1 | Loket dan kasir | Petugas melayani di kursi kasir, transaksi masuk POS, shift bergantian, rekonsiliasi harian |
| O2 | Keeper dan pakan | Pemberian pakan, pembersihan kandang, prosedur pintu ganda di kandang satwa buas, serah terima kotak pakan ke tamu |
| O3 | Keamanan | Patroli, pemantauan CCTV di ruang kontrol, penanganan insiden, investigasi dengan memutar rekaman |
| O4 | Pelaporan manajemen | Rekap pendapatan per titik per hari, laporan insiden, audit internal |

## 4. Masalah per alur

### W1 Kedatangan dan parkir
- Jumlah kendaraan masuk dan keluar hanya diketahui dari tiket, tidak ada hitungan independen; selisih baru terlihat di akhir hari, tanpa bukti per kendaraan. [F: footage gerbang menunjukkan arus padat dengan mobil dan motor bercampur]
- Parkir penuh saat libur tanpa data okupansi real-time, petugas mengarahkan dengan perkiraan. [P]
- Kemacetan keluar sore hari tidak terukur, tidak ada dasar untuk membuka jalur atau menambah petugas. [P]

### W2 Tiket masuk
- Tamu menunggu di depan loket yang kosong; komplain sampai ke manajemen belakangan, tanpa catatan durasi. [F: snapshot loket Mini Train, status customer waiting, kasir kosong]
- Panjang antrean dan waktu tunggu tidak diukur, sehingga keputusan membuka loket tambahan bersifat reaktif. [H]
- Jumlah orang yang benar-benar masuk (pejalan kaki, penumpang bus) tidak dihitung terpisah dari tiket. [H]

### W3 Safari Journey
- Pengunjung turun dari kendaraan atau membuka jendela di zona satwa buas; pelanggaran hanya ketahuan jika ranger melihat langsung. [P: larangan turun dinyatakan di panduan; H: frekuensi pelanggaran]
- Kendaraan berhenti terlalu lama di satu titik, menghambat konvoi dan mendekatkan satwa ke mobil. [H]
- Penjualan wortel dan pemberian makan di luar titik yang ditandai tidak terpantau. [P: aturan feeding tidak seragam menurut ulasan]
- Penumpang bus safari per keberangkatan tidak dihitung independen dari tiket. [H]

### W4 Zona pejalan kaki
- Kepadatan di exhibit dan area pertunjukan tidak diketahui real-time; kapasitas amfiteater dan jadwal tambahan diputuskan dari pengamatan petugas. [H]
- Pengunjung melewati pagar pembatas kandang; bukti kejadian hanya ada jika ada yang merekam. [H]
- Wahana dengan tiket terpisah untuk Reguler membuka celah masuk tanpa tiket bila pemeriksaan di pintu wahana longgar. [H]

### W5 Aktivitas berbayar tambahan
- Satwa tunggang: putaran riil tidak terhitung, penunggangan tanpa tiket tidak bisa dibuktikan. [F: snapshot kuda poni dengan tripwire berangkat dan kembali]
- Feeding interaction: satu kotak pakan terjual bisa dibagi menjadi dua di konter; selisih tidak pernah terlihat di POS. [H, dari diskusi internal; belum ada data]
- Foto dengan satwa dan sesi berbayar lain: jumlah sesi vs tiket tidak direkonsiliasi. [H]

### W6 Makan dan minum
- Kepadatan aula dan lama duduk tidak terpantau; saat ramai, meja kotor lambat dibersihkan dan tamu baru tidak kebagian tempat. [F: snapshot Safari Cafe Dining Hall]
- Meja sering digeser dan digabung, sehingga status per meja sulit dijaga dengan zona tetap. [F: catatan 2026-10-26 restaurant movable tables]

### W7 Kepulangan
- Kendaraan keluar tidak direkonsiliasi dengan kendaraan masuk; durasi kunjungan per kendaraan tidak diketahui. [H]
- Pergantian sesi siang ke Safari Malam tidak punya hitungan kendaraan yang masih di dalam. [H]

### O1 Loket dan kasir
- Durasi loket kosong per shift tidak tercatat; evaluasi staf tanpa bukti. [F]
- Rekonsiliasi harian hanya membandingkan POS dengan uang masuk, bukan dengan kejadian fisik. [H]

### O2 Keeper dan pakan
- Prosedur pintu ganda kandang satwa buas tidak terdokumentasi per kejadian; pelanggaran baru ketahuan setelah insiden. [H]
- Serah terima kotak pakan ke tamu tidak diaudit. [H]

### O3 Keamanan
- Investigasi satu kasus memakan jam kerja untuk memutar ulang rekaman dari beberapa kamera. [F: alasan utama klip 30 detik per kejadian]
- Intrusi area terlarang dan perimeter di luar jam buka bergantung pada patroli. [H]

### O4 Pelaporan manajemen
- Laporan pendapatan per titik tidak punya pembanding independen, sehingga kebocoran tidak terlihat sebagai angka. [H]
- Tidak ada log kejadian yang bisa difilter per zona, tipe, dan kamera dengan bukti foto. [F: fungsi ini yang diisi dashboard]

## 5. Rumusan masalah

1. Bagaimana mencatat **kejadian fisik** di tiap titik transaksi (kendaraan lewat, putaran tunggang, kotak pakan berpindah, orang masuk) secara independen dari POS, dengan bukti yang bisa dibuka dalam hitungan detik?
2. Bagaimana mengukur **kualitas layanan** yang sekarang tidak tercatat (loket kosong saat tamu menunggu, antrean, kepadatan aula) sehingga keputusan staf dan kapasitas berdasar angka?
3. Bagaimana mendeteksi **pelanggaran keselamatan** yang khas taman safari (turun dari kendaraan, pintu ganda kandang, intrusi area) tanpa bergantung pada pengamatan langsung petugas?
4. Bagaimana semua itu dilakukan dengan **kamera yang sudah ada**, tanpa video keluar dari jaringan taman, dan dengan biaya yang mengikuti jumlah kamera?

## 6. Solusi per masalah

Status: **Ada** = sudah berjalan dan punya bukti; **Pilot** = mekanisme sama, tinggal pasang kamera dan zona; **Roadmap** = butuh model atau data baru.

| Alur | Masalah | Solusi Zoo Vision | Mekanisme | Status | KPI pilot |
|---|---|---|---|---|---|
| W1, W7 | Kendaraan masuk/keluar tanpa bukti | Gerbang kendaraan | Garis hitung dua arah, baca plat, snapshot per lintasan, rekap per jam vs tiket | Ada | Selisih lintasan vs tiket per hari |
| W1, W7 | Durasi kunjungan dan parkir | Pencocokan plat masuk-keluar, okupansi parkir | Plat masuk dicocokkan plat keluar; zona parkir dihitung | Pilot | Kendaraan di dalam per jam, okupansi parkir |
| W2, O1 | Loket kosong saat tamu menunggu | Loket kasir | Zona kasir dan zona antrean, filter 3 detik, alarm dan klip | Ada | Menit loket kosong per shift |
| W2 | Antrean dan waktu tunggu | Modul antrean | Hitung orang di zona antre, lama tiap orang di zona, ambang alarm | Pilot | Waktu tunggu rata-rata per jam |
| W2 | Orang masuk vs tiket | Gerbang pejalan kaki | Garis hitung di turnstile atau pintu | Pilot | Selisih orang masuk vs tiket |
| W3 | Turun dari kendaraan, berhenti terlalu lama | Keselamatan safari journey | Deteksi orang di zona khusus kendaraan, batas waktu kendaraan berhenti | Pilot | Jumlah kejadian per hari per segmen |
| W3 | Jendela terbuka, memberi makan dari mobil | Pelanggaran dalam kendaraan | Model khusus, perlu footage dari jalur safari | Roadmap | Belum ditetapkan |
| W3 | Penumpang bus vs tiket | Bus safari | Garis hitung di pintu bus per keberangkatan | Pilot | Selisih penumpang vs tiket |
| W4 | Kepadatan exhibit dan pertunjukan | Okupansi area | Hitung orang per zona terhadap kapasitas | Pilot | Puncak okupansi per area per jam |
| W4 | Melewati pagar pembatas | Intrusi area terlarang | Zona terlarang, alarm dan klip | Pilot | Kejadian per hari |
| W5 | Putaran tunggang tanpa tiket | Wahana tunggang | Tripwire berangkat dan kembali, filter pawang, rekap vs POS | Ada | Selisih putaran vs tiket per hari |
| W5 | Kotak pakan dibagi dua | Feeding satwa | Garis hitung di konter serah terima, cocokkan per jam dengan POS | Ada (pilot) | Selisih kotak vs transaksi per shift |
| W5 | Sesi foto vs tiket | Konter foto satwa | Zona sesi dan batas waktu, hitung sesi | Pilot | Selisih sesi vs tiket |
| W6 | Aula penuh, meja kotor lambat | Restoran | Hitung tamu vs kapasitas, status zona meja, arahan staf pembersih | Ada | Perputaran meja per jam, waktu meja kosong-dibersihkan |
| O2 | Pintu ganda kandang | Kepatuhan pintu ganda | Status dua pintu dan kehadiran keeper, pelanggaran jadi kejadian | Pilot | Pelanggaran per minggu |
| O3 | Investigasi memakan jam | Log kejadian dan klip | Klip 30 detik per kejadian, filter zona, tipe, kamera, ekspor PDF/CSV | Ada | Jam kerja investigasi per kasus |
| O3 | Perimeter di luar jam buka | Intrusi perimeter | Zona dan jadwal | Pilot | Kejadian per malam |
| O4 | Kebocoran tidak terlihat sebagai angka | Dashboard pusat kendali dan rekap | KPI per titik, rekap per jam dan per hari, akses berjenjang, jejak audit | Ada | Laporan harian terbit otomatis |
| W4, W5 | Pendapatan baru dari kamera yang sama | Foto momen otomatis, papan waktu tunggu | Tangkap momen, jual lewat QR tiket; angka antrean ke layar publik | Roadmap | Belum ditetapkan |
| Semua | Investigasi cepat | Cari kejadian dengan bahasa biasa, ringkasan otomatis | Pencarian embedding dan deskripsi klip | Roadmap | Belum ditetapkan |

Prinsip yang berlaku untuk semua baris: video diproses di server edge di jaringan taman, kamera eksisting dipakai, lisensi per kamera aktif, dan tiap kejadian membawa bukti (snapshot dan klip) yang bisa dibuka tanpa memutar rekaman panjang.

## 7. Batasan dan yang harus divalidasi saat site survey

- Semua masalah berlabel [H] perlu dikonfirmasi dengan manajemen taman dan, bila diizinkan, data POS beberapa minggu untuk mengukur selisih awal.
- Feeding belum punya footage. Posisi kamera di konter serah terima menentukan apakah garis hitung bisa dipakai.
- Restoran: meja yang digeser membuat status per meja perlu kalibrasi ulang per tata letak; angka utama yang aman dijanjikan adalah kepadatan aula.
- Safari journey: kamera di tepi jalur dan kondisi cahaya belum disurvei; modul keselamatan dijanjikan sebagai pilot, bukan sebagai fitur siap.
- Angka harga tiket di sumber publik berbeda antar tahun; jangan dipakai untuk menghitung nilai kebocoran sebelum ada angka resmi dari klien.
- Belum ada angka persentase perbaikan apa pun. Semua KPI di tabel adalah ukuran yang akan dihitung selama pilot, bukan klaim.

## 8. Kesimpulan

Taman Safari Bogor sudah mendigitalkan transaksinya, tetapi belum mendigitalkan kejadiannya. Di tujuh alur pengunjung dan empat alur operasional, pola masalahnya sama: angka yang ada hanya dari POS, kejadian fisik tidak tercatat, dan bukti hanya bisa didapat dengan memutar CCTV. Zoo Vision AI menjawab ini dengan satu mekanisme yang sama di semua titik: kamera eksisting membaca kejadian (garis hitung, zona, batas waktu, plat), tiap kejadian disimpan dengan bukti, dan angkanya dicocokkan dengan POS.

Lima modul yang sudah berjalan menutup titik dengan nilai paling jelas: gerbang kendaraan, loket, wahana tunggang, restoran, dan feeding. Delapan modul berikutnya memakai mekanisme yang sama dan bisa dipilot per kamera. Modul yang butuh model baru dijual sebagai roadmap. Nilai produk ini terutama **menutup kebocoran pendapatan dan menjaga kualitas layanan**; efisiensi investigasi dan penempatan staf adalah efek lanjutannya, dan pendapatan baru datang dari roadmap.

Langkah berikutnya yang logis: discovery workshop untuk memvalidasi masalah [H], survei titik kamera, lalu pilot di satu atau dua titik dengan KPI dari tabel di atas.

## Sumber publik

- Fortune IDN, pembagian tiket Premium dan Reguler sejak 1 Juli 2024, kutipan GM Lies Yuwati: https://www.fortuneidn.com/business/taman-safari-bogor-bedakan-tiket-masuk-jadi-dua-kategori-00-xkln4-ztk6jt
- Metro TV News, rincian fasilitas tiket Premium dan aktivitas berbayar tambahan: https://www.metrotvnews.com/read/KvJCJz9R-harga-tiket-taman-safari-bogor-terbaru-cek-rincian-dan-fasilitasnya
- Investortrust, pembayaran nontunai menyeluruh sejak Februari 2024: https://investortrust.id/lifestyle/14030/catat-taman-safari-bogor-mulai-terapkan-pembayaran-nontunai-menyeluruh
- The Jakarta Post, panduan kunjungan: wortel, titik feeding, larangan turun dari kendaraan: https://www.thejakartapost.com/travel/2018/09/29/jakpost-guide-to-taman-safari-indonesia-bogor.html
- Wotif, deskripsi safari journey sekitar satu jam, Baby Zoo, pertunjukan, Curug Jaksa: https://www.wotif.com/things-to-do/jakarta-taman-safari-panda-palace-and-waterfall.a51896050.activity-details
- Republika 2015, parkir penuh dan kemacetan keluar 18.00 sampai 20.00 saat libur: https://news.republika.co.id/berita/nroybr/taman-safari-dipadati-pengunjung
- Metro TV News, jadwal Safari Malam libur sekolah 2026: https://www.metrotvnews.com/read/kpLCQjml-cek-harga-tiket-masuk-taman-safari-bogor-selama-libur-sekolah-2026-ini-rinciannya
