# Katalog use case AI Vision (MAGNIVision) yang bisa ditawarkan ke pembeli

Disusun 2026-11-04. Tujuannya: daftar use case computer vision di atas CCTV yang bisa dijual lini AI Vision MAGNET, dipetakan per sektor yang sudah dilayani MAGNET (pertambangan, perkebunan, pelabuhan, oil & gas, manufaktur, logistik, konstruksi, energi, keamanan, dan kini wisata), dengan masalah pembeli, mekanisme, KPI, dan kesiapan terhadap stack yang sudah kita punya.

## 1. Cara membaca

Setiap use case diberi **tingkat kesiapan**:

- **A, siap pilot.** Memakai kemampuan yang sudah berjalan di Zoo Vision: deteksi orang dan kendaraan, pelacakan, garis hitung dua arah, zona poligon, batas waktu (dwell), plat nomor format Indonesia, klip bukti 30 detik, dashboard dan log kejadian. Tinggal pasang kamera dan gambar zona.
- **B, perlu model tambahan yang sudah umum.** Deteksi APD (helm, rompi, sepatu), forklift dan alat berat, api dan asap, nomor kontainer. Dataset publik tersedia, pelatihan beberapa minggu, tetap perlu data lokasi untuk akurasi.
- **C, riset bersama klien.** Butuh data dari lokasi klien dalam jumlah besar atau sensor di luar CCTV: grading buah, kelelahan pengemudi, perilaku satwa, inspeksi kerusakan.

Dan **jenis nilai** untuk pembeli, karena ini yang menentukan siapa yang menandatangani:

- **Kebocoran**: uang atau barang yang seharusnya tercatat tetapi tidak. Pembelinya keuangan dan audit internal.
- **Keselamatan dan kepatuhan**: insiden, denda, audit SMK3 atau SMKP. Pembelinya HSE dan manajemen site.
- **Efisiensi**: antrean, waktu tunggu, utilisasi, jam kerja investigasi. Pembelinya operasional.

Pola yang sama di semua sektor: **kamera membaca kejadian, tiap kejadian membawa bukti, angkanya dibandingkan dengan sistem pencatat (POS, timbangan, TOS, WMS, ERP)**. Itu kalimat jual lini AI Vision, apa pun sektornya.

## 2. Katalog per sektor

### 2.1 Pertambangan

Konteks: pemegang IUP wajib menerapkan SMKP (Permen ESDM 26/2018, Kepmen ESDM 1827 K/30/MEM/2018 Lampiran IV, Kepdirjen Minerba 185/2019). Audit SMKP menilai elemen implementasi, dan tinjauan literatur menyebut tingkat penerapannya masih tidak merata antar perusahaan. Perusahaan besar (Antam, Timah) mempublikasikan target zero fatality dan teknologi pengawasan. Artinya pembeli punya kewajiban yang bisa dibantu dengan bukti terdokumentasi.

| Use case | Masalah pembeli | Mekanisme | KPI | Kesiapan | Nilai |
|---|---|---|---|---|---|
| Kepatuhan APD di area wajib | Pelanggaran helm, rompi, sepatu hanya ketahuan saat inspeksi | Deteksi orang plus klasifikasi APD di zona wajib, kejadian dengan foto | Pelanggaran per shift per area | B | Keselamatan |
| Zona eksklusi alat berat | Orang berjalan terlalu dekat dengan excavator, dump truck, atau area dumping | Zona dinamis di sekitar alat berat, alarm bila orang masuk | Kejadian nyaris celaka per minggu | B | Keselamatan |
| Kendaraan ringan vs alat berat di jalan tambang | Light vehicle masuk jalur haul tanpa izin, jarak iring terlalu dekat | Klasifikasi kendaraan, garis hitung per jalur, batas waktu | Pelanggaran jalur per hari | B | Keselamatan |
| Jembatan timbang dan gerbang | Truk melewati timbangan tanpa tercatat, plat tidak cocok dengan dokumen | ANPR di timbangan dan gerbang, cocokkan dengan log timbangan | Selisih lintasan vs tiket timbang | A | Kebocoran |
| Stasiun BBM | Pengisian ke kendaraan yang tidak terdaftar, durasi pengisian tidak wajar | ANPR plus batas waktu di zona pompa, cocokkan dengan log dispenser | Pengisian tanpa pasangan log | A | Kebocoran |
| Area peledakan dan zona terlarang | Orang di radius peledakan atau area longsor saat jam tertentu | Zona plus jadwal, alarm ke pengawas | Intrusi per bulan | A | Keselamatan |
| Pos pengawas dan checkpoint terisi | Pos kosong pada jam wajib | Zona kehadiran plus batas waktu (pola loket kasir) | Menit pos kosong per shift | A | Kepatuhan |
| Kelelahan pengemudi | Microsleep di kabin | Kamera kabin dan model wajah/mata, perangkat berbeda dari CCTV | Peringatan per jam kerja | C | Keselamatan |

### 2.2 Perkebunan kelapa sawit

Konteks: MAGNET sudah punya pelanggan sawit (Sawit Indonesia Award 2024 untuk komunikasi perkebunan). Stasiun penerimaan PKS terdiri dari jembatan timbang, grading, dan loading ramp; sortasi TBS di banyak pabrik masih manual. Celah kebocoran klasik ada di timbangan dan grading.

| Use case | Masalah pembeli | Mekanisme | KPI | Kesiapan | Nilai |
|---|---|---|---|---|---|
| Verifikasi truk di jembatan timbang | Plat tidak cocok dengan SPB, truk ditimbang dua kali, orang berdiri di atas muatan saat timbang | ANPR, zona bak truk, deteksi orang di zona timbang, cocokkan dengan log timbangan | Timbangan tanpa pasangan log, orang di muatan | A | Kebocoran |
| Muatan terlihat vs dokumen | Bak terlihat setengah kosong tetapi dokumen penuh | Estimasi tinggi muatan dari kamera samping, bandingkan dengan tonase | Selisih estimasi vs timbangan | C | Kebocoran |
| Grading TBS di loading ramp | Buah mentah lolos, penilaian grader subjektif | Klasifikasi kematangan per tandan (penelitian lokal melaporkan akurasi tinggi pada satu dataset pabrik), dengan data pabrik sendiri | Persentase mentah per pemasok | C | Kebocoran dan mutu |
| Gerbang estate dan pos satpam | Kendaraan keluar masuk estate tanpa catatan, pencurian TBS malam hari | ANPR dan garis hitung di gerbang, zona perimeter malam | Lintasan tanpa catatan, intrusi malam | A | Kebocoran dan keamanan |
| Kehadiran pemanen di blok | Kehadiran dilaporkan tetapi blok tidak dikerjakan | Garis hitung di pintu blok atau titik kumpul, dibandingkan dengan absensi | Selisih absensi vs hitungan | A | Kebocoran |
| APD di pabrik (sterilizer, boiler) | Pelanggaran APD di area panas | Deteksi APD di zona wajib | Pelanggaran per shift | B | Keselamatan |

### 2.3 Pelabuhan dan terminal

Konteks: Pelindo menyatakan CCTV sudah dipasang di gate, lapangan penumpukan, dermaga, dan kantor, serta memakai automasi untuk menekan pungli. Riset lokal (Makassar New Port, BJTI) sudah mencoba YOLO untuk deteksi kerusakan kontainer di gate. Jadi kamera ada, analitiknya belum.

| Use case | Masalah pembeli | Mekanisme | KPI | Kesiapan | Nilai |
|---|---|---|---|---|---|
| Gate in/out truk | Antrean truk dan durasi gate tidak terukur, plat tidak cocok dengan booking | ANPR dua arah, batas waktu di zona gate, cocokkan dengan TOS atau booking | Waktu gate rata-rata, plat tanpa booking | A | Efisiensi dan kepatuhan |
| Nomor kontainer di gate | Pencocokan nomor kontainer manual | OCR nomor kontainer (ISO 6346) plus ANPR | Kontainer tanpa pasangan dokumen | B | Kebocoran |
| Kerusakan kontainer di gate | Klaim kerusakan tanpa bukti kondisi saat masuk | Snapshot empat sisi per lintasan, model deteksi penyok dan lubang | Foto kondisi per kontainer, klaim yang tertolak | B | Kebocoran |
| Zona bahaya di bawah crane dan di dermaga | Orang di area ayun crane atau antara truk | Zona eksklusi dan deteksi orang | Intrusi per hari | B | Keselamatan |
| APD di lapangan penumpukan | Rompi dan helm | Deteksi APD | Pelanggaran per shift | B | Keselamatan |
| Antrean truk di luar terminal | Kemacetan akses, keluhan pengemudi | Hitung truk di ruas antre, waktu tunggu | Panjang antrean per jam | A | Efisiensi |

### 2.4 Logistik dan pergudangan

Sudah ada di deck Dima sebagai MagniVision: dock terukur, klip saat muat, okupansi lantai, APD, barang keluar dicocokkan order. Tambahan yang belum ada di sana:

| Use case | Masalah pembeli | Mekanisme | KPI | Kesiapan | Nilai |
|---|---|---|---|---|---|
| Forklift dan pejalan kaki | Tabrakan di lorong | Deteksi forklift dan orang, zona dekat dan kecepatan relatif | Nyaris celaka per minggu | B | Keselamatan |
| Pintu darurat dan jalur evakuasi terhalang | Pallet menutup jalur | Zona harus kosong, batas waktu | Jam jalur terhalang | A | Kepatuhan |
| Area staging per kurir | Paket keluar tanpa scan | Garis hitung per pintu dibandingkan dengan jumlah scan | Selisih hitung vs scan | A | Kebocoran |
| Kehadiran di gudang dingin | Orang terlalu lama di cold room | Batas waktu per orang di zona | Kejadian lewat batas | A | Keselamatan |

### 2.5 Manufaktur

| Use case | Masalah pembeli | Mekanisme | KPI | Kesiapan | Nilai |
|---|---|---|---|---|---|
| Line berhenti terdeteksi dari kamera | Downtime tidak tercatat kalau PLC tidak terhubung | Deteksi gerakan konveyor atau produk lewat garis per menit | Menit berhenti per shift | A | Efisiensi |
| Zona mesin berbahaya | Tangan atau tubuh di zona press saat beroperasi | Zona eksklusi dengan deteksi orang, integrasi ke lampu peringatan | Intrusi per hari | B | Keselamatan |
| APD per stasiun | Kacamata, sarung tangan, helm | Deteksi APD per zona | Pelanggaran per shift | B | Keselamatan |
| Hitung produk keluar per line | Output dihitung manual di akhir shift | Garis hitung produk di konveyor | Output per jam | A | Efisiensi |
| Inspeksi visual cacat | QC manual tidak konsisten | Model cacat per produk, perlu data klien | Persentase cacat terdeteksi | C | Mutu |

### 2.6 Konstruksi

| Use case | Masalah pembeli | Mekanisme | KPI | Kesiapan | Nilai |
|---|---|---|---|---|---|
| Jumlah orang di site vs absensi | Pekerja subkontraktor dilaporkan lebih banyak dari yang hadir | Garis hitung di gerbang pekerja dibandingkan absensi | Selisih per hari | A | Kebocoran |
| APD dan zona galian | Pelanggaran helm, orang di tepi galian | Deteksi APD, zona tepi galian | Pelanggaran per hari | B | Keselamatan |
| Perimeter malam | Pencurian material | Zona dan jadwal | Intrusi per malam | A | Keamanan |
| Progres visual | Laporan progres tidak berbukti | Snapshot terjadwal per titik, dibandingkan antar hari | Foto harian per titik | A | Efisiensi |

### 2.7 Energi, oil & gas

| Use case | Masalah pembeli | Mekanisme | KPI | Kesiapan | Nilai |
|---|---|---|---|---|---|
| Api dan asap | Deteksi dini di area terbuka yang tidak terjangkau sensor | Model api dan asap, verifikasi dengan klip | Alarm terverifikasi | B | Keselamatan |
| Zona hot work dan izin kerja | Pekerjaan panas di zona tanpa izin aktif | Zona plus jadwal izin, deteksi orang | Pekerjaan di luar jadwal izin | A | Kepatuhan |
| Perimeter tank farm dan gardu | Intrusi | Zona dan jadwal | Intrusi | A | Keamanan |
| Kendaraan di area terbatas | Kendaraan tanpa izin masuk area berbahaya | ANPR plus daftar izin | Kendaraan tanpa izin | A | Kepatuhan |

### 2.8 Wisata, hospitality, dan retail

Zoo Vision sudah mencakup gerbang kendaraan, loket, wahana, feeding, restoran, dan roadmap (gerbang pejalan kaki, bus, parkir, antrean, intrusi, pintu ganda kandang, keselamatan safari journey, foto momen, papan waktu tunggu). Yang bisa dibawa ke sektor sejenis:

| Use case | Sektor | Mekanisme | Kesiapan | Nilai |
|---|---|---|---|---|
| Kasir kosong dan antrean | Hotel front office, retail, waterpark | Pola loket | A | Mutu layanan |
| Hitung pengunjung vs tiket | Museum, waterpark, konser, tempat wisata | Garis hitung di pintu | A | Kebocoran |
| Okupansi area vs kapasitas | Mall, arena, kolam renang | Hitung orang per zona | A | Keselamatan dan efisiensi |
| Parkir dan durasi | Mall, hotel, rumah sakit | ANPR masuk keluar | A | Kebocoran |
| Kebersihan terjadwal | Toilet dan area umum, kehadiran petugas per jadwal | Zona kehadiran plus jadwal | A | Mutu layanan |

### 2.9 Lintas sektor, dijual sebagai fitur platform

- **Pencarian kejadian dengan bahasa biasa** dan **ringkasan kejadian otomatis** dari klip. Efek demo besar, prototipe dalam hitungan minggu, biaya inferensi perlu dihitung. Kesiapan B.
- **Laporan audit harian otomatis** per titik, PDF dan CSV, dengan selisih terhadap sistem pencatat. Sudah ada.
- **Integrasi sistem pencatat**: POS, timbangan, TOS, WMS, absensi, ERP, lewat API. Nilainya ada di pembandingan, bukan di kamera.

## 3. Prioritas: sepuluh use case untuk katalog pertama

Dipilih dengan tiga kriteria: nilai yang bisa dihitung pembeli, kesiapan A atau B, dan kecocokan dengan sektor tempat MAGNET sudah punya hubungan.

1. Jembatan timbang dan gerbang dengan ANPR, dicocokkan dengan log timbangan (sawit, tambang, pelabuhan). Kesiapan A, nilai kebocoran, satu modul untuk tiga sektor.
2. Gate in/out truk pelabuhan: waktu gate dan plat vs booking. Kesiapan A, efisiensi dan kepatuhan.
3. Kepatuhan APD di zona wajib (tambang, pabrik, pelabuhan, konstruksi). Kesiapan B, kebutuhan paling sering disebut HSE.
4. Zona eksklusi alat berat dan forklift. Kesiapan B, keselamatan, cerita yang mudah dipahami direksi.
5. Hitung orang masuk vs tiket atau absensi (wisata, konstruksi, estate). Kesiapan A, kebocoran.
6. Kasir atau pos kosong dan antrean (wisata, retail, pos tambang). Kesiapan A, sudah terbukti di loket Mini Train.
7. Perimeter dan zona terlarang dengan jadwal (semua sektor). Kesiapan A, keamanan, modul pengisi yang hampir selalu diminta.
8. Stasiun BBM dan kendaraan tanpa izin di area terbatas (tambang, migas). Kesiapan A, kebocoran dan kepatuhan.
9. Nomor kontainer dan kondisi kontainer di gate (pelabuhan). Kesiapan B, kebocoran klaim.
10. Api dan asap di area terbuka (migas, pabrik, gudang). Kesiapan B, keselamatan.

Yang ditunda ke roadmap: grading TBS, estimasi muatan, kelelahan pengemudi, inspeksi cacat produk, perilaku satwa. Semuanya kesiapan C dan butuh program data bersama klien.

## 4. Pola presentasi per sektor

Deck Zoo Vision bisa dijadikan cetakan: alur kerja klien, tantangan per titik, lima modul, topologi, use case dengan Masalah, Cara kerja, Hasil, lalu investasi. Untuk sektor baru yang belum punya footage, visual use case memakai ilustrasi bergaya deck Dima dan ditandai sebagai pilot, bukan foto stok yang terlihat seperti bukti.

## 5. Yang sebaiknya tidak ditawarkan

- Pengenalan wajah publik (pengunjung, pelanggan) karena izin dan privasi; pengenalan wajah karyawan hanya kalau klien sudah punya dasar hukumnya dan memintanya sendiri.
- Use case yang butuh perangkat baru di luar CCTV sebelum ada kebutuhan jelas: kamera kabin, termal, drone.
- Klaim angka perbaikan (persentase) sebelum ada pilot. Katalog ini memakai KPI yang akan diukur, bukan hasil yang dijanjikan.

## 6. Sumber

- SMKP dan kewajiban IUP: Permen ESDM 26/2018 Pasal 18, Kepmen ESDM 1827 K/30/MEM/2018 Lampiran IV, Kepdirjen Minerba 185.K/37.04/DJB/2019; tinjauan penerapan SMKP di jurnal K3 Uniba Balikpapan dan ITATS: https://jurnal.d4k3.uniba-bpn.ac.id/index.php/identifikasi/article/download/1387/672/4596 dan https://ejournal.itats.ac.id/jsemitan/article/download/4902/3325
- Antam zero fatality 2023: https://ekonomi.republika.co.id/berita/s10ffl349/ini-cara-antam-untuk-capai-komitmen-zero-fatality-di-2023
- PT Timah menerapkan SMKP: https://babel.antaranews.com/berita/478213/pt-timah-terapkan-smkp-tingkatkan-keamanan-operasional
- Pelindo I: CCTV di gate, lapangan, dermaga, dan automasi menekan pungli: https://ekonomi.bisnis.com/read/20210616/98/1406054/gaduh-pungli-di-pelabuhan-pelindo-i-pakai-sistem-automasi
- Pelindo III: sistem informasi dan CCTV di terminal: https://www.industry.co.id/read/87294/cegah-terjadinya-pungli-pelindo-iii-terapkan-sistem-informasi-pada-layanan-operasional
- Deteksi kerusakan kontainer di gate dengan YOLO (Makassar New Port): https://jurnal.poliupg.ac.id/index.php/snp2m/article/download/5287/4161/13597
- Deteksi kerusakan badan kontainer di gate in BJTI dengan YOLOv11: https://openlibrary.telkomuniversity.ac.id/pustaka/files/236684/daftaristilah/deteksi-kerusakan-badan-kontainer-di-gate-in-pt-berlian-jasa-terminal-indonesia-menggunakan-yolov11-dalam-bentuk-buku-karya-ilmiah.pdf
- Stasiun penerimaan PKS dan klasifikasi TBS (UGM): https://etd.repository.ugm.ac.id/home/detail_pencarian_downloadfiles/1507820
- Sortasi TBS masih manual dan sistem kamera konveyor: https://kfi.ejournal.unri.ac.id/index.php/JKFI/article/download/7995/pdf
- Profil dan sektor MAGNET: https://www.magnet.id/tentang-kami/
