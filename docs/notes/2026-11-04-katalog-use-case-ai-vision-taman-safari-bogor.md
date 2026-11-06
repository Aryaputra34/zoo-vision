# Katalog use case AI Vision untuk Taman Safari Bogor

Disusun 2026-11-04. Fokus satu lokasi: Taman Safari Indonesia Cisarua, Bogor. Use case disusun mengikuti area dan atraksi yang ada di sana, bukan per teknologi, supaya tim sales bisa menunjuk titik di peta taman dan klien bisa membayangkan kameranya.

Tingkat kesiapan:
- **A, siap pilot**: memakai kemampuan yang sudah berjalan di Zoo Vision (deteksi orang dan kendaraan, garis hitung, zona, batas waktu, plat nomor, klip bukti, dashboard).
- **B, perlu model tambahan yang umum**: deteksi satwa per spesies, api dan asap, kondisi pintu, orang jatuh.
- **C, riset bersama taman**: butuh data lapangan berbulan-bulan atau sensor di luar CCTV.

Jenis nilai: **Kebocoran** (uang yang sudah dibayar tamu tetapi tidak sampai ke keuangan taman), **Keselamatan**, **Layanan** (antrean, kepadatan, kebersihan), **Satwa** (kesejahteraan dan keamanan satwa), **Pendapatan baru**.

Kolom "Kamera" adalah perkiraan jumlah titik kamera analitik untuk satu lokasi penerapan, untuk dihitung terhadap kapasitas 12 kamera per server edge.

## 1. Gerbang dan parkir

| Use case | Masalah | Mekanisme | KPI | Kesiapan | Nilai | Kamera |
|---|---|---|---|---|---|---|
| Gerbang kendaraan masuk dan keluar | Kendaraan dihitung manual, tidak ada bukti per kendaraan | Garis hitung dua arah, plat nomor, snapshot per lintasan, bandingkan dengan tiket gerbang | Selisih lintasan vs tiket per jam | **Ada** | Kebocoran | 1 sampai 2 per gerbang |
| Durasi kunjungan per kendaraan | Tidak tahu berapa lama tamu di dalam, berapa kendaraan masih di dalam menjelang tutup | Plat masuk dicocokkan plat keluar | Kendaraan di dalam per jam, rata-rata durasi | A | Layanan | memakai kamera gerbang |
| Okupansi parkir | Parkir penuh saat libur, petugas mengarahkan dengan perkiraan | Hitung kendaraan per zona parkir, tampilkan sisa kapasitas | Okupansi per zona per jam | A | Layanan | 1 per 40 sampai 60 petak |
| Antrean kendaraan di akses masuk | Antrean sampai jalan raya saat libur tanpa data | Hitung kendaraan di ruas antre, waktu tunggu dari garis ke gerbang | Panjang antrean, waktu tunggu | A | Layanan | 1 sampai 2 |
| Gerbang bus pariwisata | Penumpang bus masuk tanpa hitungan terpisah dari tiket rombongan | Garis hitung orang di pintu turun bus atau jalur masuk rombongan | Orang masuk vs tiket rombongan | A | Kebocoran | 1 |

## 2. Loket dan pintu masuk pejalan kaki

| Use case | Masalah | Mekanisme | KPI | Kesiapan | Nilai | Kamera |
|---|---|---|---|---|---|---|
| Loket kosong saat tamu antre | Kasir meninggalkan loket, keluhan baru sampai belakangan | Zona kasir dan zona antre, filter 3 detik, alarm dan klip | Menit loket kosong per shift | **Ada** | Layanan | 1 per loket atau per 2 loket bersebelahan |
| Panjang antrean dan waktu tunggu loket | Keputusan buka loket tambahan reaktif | Hitung orang di zona antre, lama tiap orang di zona, ambang alarm | Waktu tunggu rata-rata per jam | A | Layanan | memakai kamera loket |
| Orang masuk vs tiket terscan | Jumlah tamu yang benar-benar masuk tidak dihitung independen | Garis hitung di turnstile atau pintu masuk, bandingkan dengan scan tiket | Selisih orang vs scan per jam | A | Kebocoran | 1 per pintu |
| Tiket Reguler masuk wahana Premium | Reguler tidak termasuk Istana Panda, wahana, Curug Jaksa; pemeriksaan di pintu wahana longgar | Garis hitung di pintu wahana berbayar, bandingkan dengan scan di pintu itu | Masuk vs scan per wahana | A | Kebocoran | 1 per pintu wahana |

## 3. Safari Journey (drive-through)

| Use case | Masalah | Mekanisme | KPI | Kesiapan | Nilai | Kamera |
|---|---|---|---|---|---|---|
| Orang keluar kendaraan di zona satwa | Pelanggaran hanya ketahuan jika ranger melihat | Deteksi orang di zona khusus kendaraan, alarm ke ranger dengan klip | Kejadian per hari per segmen | A | Keselamatan | 1 per segmen rawan (karnivora) |
| Kendaraan berhenti terlalu lama | Konvoi tertahan, satwa mendekat ke mobil | Batas waktu kendaraan di zona, alarm | Kejadian per hari | A | Keselamatan dan Layanan | memakai kamera segmen |
| Arah salah dan menyalip | Kendaraan melawan arah atau keluar jalur | Garis hitung berarah dan zona jalur | Pelanggaran per hari | A | Keselamatan | memakai kamera segmen |
| Jendela terbuka, tangan keluar, memberi makan dari mobil | Dilarang tetapi tidak terpantau | Model khusus untuk jendela dan lengan di luar bodi | Pelanggaran per hari | C | Keselamatan | 1 per segmen |
| Satwa mendekati atau menaiki kendaraan | Insiden satwa dan mobil, kerusakan kendaraan | Deteksi satwa per spesies, zona jarak ke kendaraan | Kejadian per hari | B | Keselamatan dan Satwa | memakai kamera segmen |
| Satwa di jalur, lalu lintas tertahan | Konvoi berhenti lama tanpa diketahui pusat kendali | Deteksi satwa di zona jalan plus batas waktu | Menit jalur tertahan | B | Layanan | memakai kamera segmen |
| Peta satwa terlihat secara live | Tamu tidak tahu satwa mana yang sedang dekat jalan | Deteksi satwa per segmen, tampilkan di layar pintu masuk atau aplikasi | Segmen dengan satwa terlihat | B | Pendapatan baru dan Layanan | memakai kamera segmen |
| Penjualan wortel di kios dan titik feeding | Jumlah wortel terjual tidak dicocokkan dengan transaksi | Garis hitung serah terima di kios (pola feeding) | Selisih serah terima vs POS | A | Kebocoran | 1 per kios |
| Safari Malam | Cahaya rendah, kendaraan dan kereta wisata di malam hari | Kamera IR atau low-light, model yang sama dengan siang | Sama dengan siang | A dengan syarat kamera IR | Keselamatan | mengikuti siang |

## 4. Bus safari, kereta wisata, Istana Panda

| Use case | Masalah | Mekanisme | KPI | Kesiapan | Nilai | Kamera |
|---|---|---|---|---|---|---|
| Penumpang naik per keberangkatan bus safari | Penumpang per bus tidak dihitung independen dari tiket | Garis hitung di pintu bus atau peron | Penumpang vs tiket per keberangkatan | A | Kebocoran | 1 per peron |
| Bus internal Istana Panda | Antrean bus dan okupansi tidak terukur | Hitung orang di antrean dan yang naik per bus | Waktu tunggu, orang per bus | A | Layanan | 1 |
| Kereta wisata dan kereta gantung | Penumpang per kabin, pintu kabin tertutup saat berangkat | Hitung orang per kabin di titik naik, deteksi pintu | Penumpang vs tiket, kejadian pintu terbuka | A untuk hitung, B untuk pintu | Kebocoran dan Keselamatan | 1 per stasiun naik |

## 5. Wahana berbayar dan aktivitas satwa

| Use case | Masalah | Mekanisme | KPI | Kesiapan | Nilai | Kamera |
|---|---|---|---|---|---|---|
| Wahana tunggang (kuda poni, gajah, unta) | Tamu sudah bayar tetapi tidak semua putaran masuk POS | Tripwire berangkat dan kembali, filter pawang, bandingkan dengan tiket POS | Selisih putaran vs tiket per hari | **Ada** | Kebocoran | 1 per wahana |
| Feeding interaction (jerapah, gajah, baby zoo) | Satu kotak terjual dibagi dua di konter | Garis hitung serah terima kotak, bandingkan per jam dengan POS | Selisih kotak vs transaksi per shift | **Ada** (pilot) | Kebocoran | 1 per konter |
| Foto dengan satwa | Sesi foto tidak dicocokkan dengan tiket | Zona sesi plus batas waktu, hitung sesi | Selisih sesi vs tiket | A | Kebocoran | 1 per spot |
| Swimming with dolphin dan sesi encounter | Peserta per sesi vs tiket | Hitung orang masuk area sesi per jadwal | Peserta vs tiket per sesi | A | Kebocoran | 1 per area |
| Wahana permainan (sekitar 23) | Naik tanpa tiket terpisah, kapasitas per putaran | Garis hitung di pintu naik, bandingkan dengan scan | Masuk vs scan per wahana | A | Kebocoran | 1 per wahana prioritas |
| Perahu dan kolam | Jumlah penumpang per perahu, jaket pelampung | Hitung orang per perahu di dermaga, deteksi pelampung | Penumpang per perahu, pelanggaran pelampung | A untuk hitung, B untuk pelampung | Keselamatan | 1 |
| Foto momen otomatis | Tidak ada pendapatan dari momen tamu dengan satwa | Tangkap foto terbaik di feeding dan tunggang, jual lewat QR tiket | Foto terjual per hari | B | Pendapatan baru | memakai kamera wahana |

## 6. Pertunjukan, exhibit, dan zona pejalan kaki

| Use case | Masalah | Mekanisme | KPI | Kesiapan | Nilai | Kamera |
|---|---|---|---|---|---|---|
| Okupansi amfiteater dan area presentasi edukasi | Kapasitas dan jadwal tambahan diputuskan dari pengamatan | Hitung orang per zona terhadap kapasitas, per jadwal show | Okupansi per show | A | Layanan dan Keselamatan | 1 per arena |
| Kepadatan exhibit (Baby Zoo, Penguin House, Reptile House) | Ruang tertutup penuh tanpa pengaturan | Hitung orang di dalam, alarm mendekati kapasitas | Puncak okupansi per jam | A | Keselamatan | 1 per exhibit tertutup |
| Melewati pagar pembatas kandang | Bukti hanya jika ada yang merekam | Zona terlarang di tepi kandang, alarm dan klip | Kejadian per hari | A | Keselamatan dan Satwa | 1 per kandang prioritas |
| Satwa keluar dari area pamer | Satwa lepas baru ketahuan setelah dilaporkan | Deteksi satwa di zona yang seharusnya kosong | Alarm terverifikasi | B | Satwa dan Keselamatan | memakai kamera kandang |
| Heatmap pengunjung | Exhibit mana yang paling lama dikunjungi, jam ramai | Agregasi hitungan dan lama tinggal per zona | Lama tinggal per exhibit | A | Layanan dan Pendapatan baru | memakai kamera yang ada |
| Papan waktu tunggu publik | Tamu menumpuk di wahana populer | Angka antrean dari kamera ke layar publik atau aplikasi | Penyebaran tamu antar wahana | A | Layanan | memakai kamera antrean |
| Orang jatuh atau tergeletak | Tamu pingsan di area sepi tidak segera ditolong | Deteksi postur jatuh, verifikasi klip | Waktu respons | B | Keselamatan | memakai kamera area |
| Anak terpisah | Pencarian memutar CCTV manual | Pencarian ulang berdasarkan warna pakaian di beberapa kamera, tanpa wajah | Waktu pencarian | C | Layanan | memakai kamera yang ada |

## 7. Restoran, kios, dan suvenir

| Use case | Masalah | Mekanisme | KPI | Kesiapan | Nilai | Kamera |
|---|---|---|---|---|---|---|
| Kepadatan aula dan status meja | Aula penuh, staf tidak tahu meja yang baru kosong | Hitung tamu vs kapasitas, zona meja, arahan staf pembersih | Perputaran meja per jam | **Ada** | Layanan | 1 sampai 2 per aula |
| Antrean kasir restoran dan kios | Antrean panjang di jam makan | Pola loket: zona antre dan kasir | Waktu tunggu | A | Layanan | 1 per kasir |
| Kasir suvenir kosong | Toko ramai tanpa kasir | Pola loket | Menit kasir kosong | A | Layanan | 1 |
| Kebersihan terjadwal toilet dan area makan | Petugas tidak hadir sesuai jadwal | Zona kehadiran petugas plus jadwal | Jadwal terlewat per hari | A | Layanan | 1 per titik |

## 8. Safari Waterpark

| Use case | Masalah | Mekanisme | KPI | Kesiapan | Nilai | Kamera |
|---|---|---|---|---|---|---|
| Okupansi kolam vs kapasitas | Kolam terlalu padat | Hitung orang per kolam | Okupansi per jam | A | Keselamatan | 1 per kolam |
| Kehadiran lifeguard di pos | Pos kosong | Zona kehadiran plus jadwal | Menit pos kosong | A | Keselamatan | memakai kamera kolam |
| Orang tenggelam atau tidak bergerak di air | Deteksi dini | Model khusus orang di bawah permukaan, perlu kamera bawah air atau sudut tinggi | Alarm terverifikasi | C | Keselamatan | khusus |
| Masuk waterpark vs tiket | Tiket terpisah | Garis hitung di pintu | Masuk vs scan | A | Kebocoran | 1 |

## 9. Operasional satwa dan keeper

| Use case | Masalah | Mekanisme | KPI | Kesiapan | Nilai | Kamera |
|---|---|---|---|---|---|---|
| Pintu ganda kandang satwa buas | Dua pintu airlock terbuka bersamaan, baru ketahuan setelah insiden | Status dua pintu dan kehadiran keeper, pelanggaran jadi kejadian | Pelanggaran per minggu | B | Keselamatan | 1 per airlock |
| Kehadiran keeper per jadwal pakan | Pemberian pakan tidak terbukti waktunya | Zona kandang plus jadwal | Jadwal terlewat | A | Satwa | memakai kamera kandang |
| Perilaku satwa | Stres (mondar-mandir berulang), tidak bergerak, kandang pamer kosong terlalu lama | Deteksi satwa per spesies, pelacakan, pola gerak per hari | Laporan aktivitas per satwa | C | Satwa | 1 per kandang prioritas |
| Pemantauan malam dan kelahiran | Kondisi satwa di luar jam kerja | Kamera IR, deteksi satwa, alarm anomali | Alarm terverifikasi | C | Satwa | 1 per kandang |
| Kendaraan operasional pakan | Truk pakan tidak sampai ke titik pada jam yang ditentukan | Plat nomor dan zona per titik pakan | Jadwal terlewat | A | Satwa | memakai kamera segmen |

## 10. Keamanan umum

| Use case | Masalah | Mekanisme | KPI | Kesiapan | Nilai | Kamera |
|---|---|---|---|---|---|---|
| Perimeter di luar jam buka | Intrusi malam, pencurian | Zona dan jadwal, alarm | Intrusi per malam | A | Keselamatan | 1 per segmen perimeter |
| Area staf dan gudang pakan | Tamu masuk area staf | Zona terlarang | Kejadian per hari | A | Keselamatan | 1 per pintu |
| Pergantian sesi siang ke Safari Malam | Kendaraan siang masih di dalam saat sesi malam mulai | Pencocokan plat masuk dan keluar | Kendaraan belum keluar saat batas | A | Keselamatan | memakai kamera gerbang |
| Kemacetan keluar sore | Antrean keluar sampai jalan raya | Hitung kendaraan di jalur keluar, waktu tempuh dari zona parkir ke gerbang | Waktu keluar per jam | A | Layanan | 1 sampai 2 |

## 11. Fitur platform yang berlaku untuk semua titik

- Log kejadian dengan foto dan klip 30 detik, filter per zona, tipe, kamera, ekspor PDF dan CSV. **Ada**.
- Pembandingan otomatis dengan POS atau sistem tiket lewat API. **Ada**, detail integrasi disepakati dengan tim IT taman.
- Pencarian kejadian dengan bahasa biasa dan ringkasan kejadian otomatis. **B**.
- Laporan harian per titik ke manajemen. **Ada**.

## 12. Urutan yang disarankan untuk Taman Safari Bogor

Kriteria: nilai yang bisa dihitung keuangan, kesiapan, dan footage yang sudah ada.

**Gelombang 1, sudah terbukti (5 modul):** gerbang kendaraan, loket, wahana tunggang, restoran, feeding. Ini isi deck sekarang.

**Gelombang 2, pilot dengan mekanisme yang sama, 6 sampai 8 minggu per modul:**
1. Orang masuk vs tiket di pintu pejalan kaki dan pintu wahana berbayar. Menutup celah tiket Reguler.
2. Bus safari dan peron Istana Panda. Pola yang sama dengan wahana tunggang.
3. Antrean dan waktu tunggu di loket dan wahana populer, sekaligus menjadi dasar papan waktu tunggu.
4. Safari Journey: orang keluar kendaraan dan kendaraan berhenti terlalu lama di segmen karnivora. Use case paling khas taman safari.
5. Perimeter malam dan area staf.
6. Pintu ganda kandang satwa buas, kalau ada footage airlock untuk dilatih.

**Gelombang 3, roadmap bersama taman:** foto momen otomatis, peta satwa terlihat, perilaku dan pemantauan satwa, pelanggaran di dalam kendaraan, deteksi tenggelam di waterpark, anak terpisah.

## 13. Perkiraan jumlah kamera dan server

Dengan 12 kamera analitik per server edge:
- Gelombang 1: sekitar 6 sampai 8 kamera (gerbang 2, loket 1 sampai 2, wahana 1, restoran 1 sampai 2, feeding 1). Satu server.
- Gelombang 2: tambahan sekitar 10 sampai 14 kamera (pintu pejalan kaki 2, pintu wahana 3, peron bus 2, segmen safari 3 sampai 4, perimeter 2, airlock 1). Server kedua.
- Gelombang 3 mengikuti hasil survei.

Angka ini perkiraan untuk menghitung proposal, bukan hasil survei; jumlah pasti bergantung pada sudut kamera yang sudah ada dan titik yang dipilih taman.

## 14. Yang tidak ditawarkan di Taman Safari Bogor

- Pengenalan wajah pengunjung.
- Pengukuran kecepatan kendaraan di Safari Journey dari kamera, karena butuh kalibrasi per kamera dan hasilnya mudah diperdebatkan; batas waktu berhenti dan arah lebih aman.
- Angka persentase perbaikan sebelum pilot. Semua KPI di atas adalah ukuran yang dihitung selama pilot.

Sumber konteks taman: lihat dokumen 2026-11-04-riset-alur-masalah-solusi-taman-safari-bogor.md (tiket Premium dan Reguler, aktivitas berbayar, nontunai, jam buka, Safari Malam, kemacetan dan parkir saat libur).
