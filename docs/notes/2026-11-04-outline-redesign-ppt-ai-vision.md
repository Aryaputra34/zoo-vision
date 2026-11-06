# Outline redesign deck AI Vision Taman Safari (v3)

Disusun 2026-11-04. Acuan gaya: deck HTML "Solusi Terintegrasi PT Dima v3" (21 slide). Acuan isi dan bukti: deck PPT "Sistem Computer Vision & AI Analytics Taman Safari (v2)" (12 slide).

Prinsip yang diambil dari Dima:

- Cerita dimulai dari alur kerja klien, bukan dari produk.
- Satu slide masalah per langkah alur, ditutup "akibatnya".
- Tiap use case memakai pola tetap: ilustrasi 4 langkah di kiri, kotak **Masalah**, daftar **Cara kerja** 4 langkah, tiga kartu **Hasil** di kanan.
- Satu slide "cara terhubung" ke sistem eksisting klien.
- Penutup berisi langkah konkret dan kontak.

Yang dipertahankan dari v2: semua screenshot AI dan dashboard asli, slide investasi, slide dashboard dan laporan, angka kapasitas.

Total 17 slide (16 kalau slide 11 dibuang).

---

## 1. Cover

- Logo MAGNET kiri atas.
- Eyebrow (mono, kapital): `AI VISION PADA CCTV • ON-PREMISE`.
- Judul: **Zoo Vision AI** / **Sistem Audit Operasional Taman Safari Berbasis Computer Vision**. (Nama produk masih harus diputuskan, lihat bagian "Keputusan yang masih terbuka".)
- Subjudul: Otomasi audit pendapatan gerbang, akuntabilitas loket, dan pengawasan wahana dari kamera yang sudah ada.
- Kanan: satu screenshot AI terbaik (ai_restaurant atau ai_pony) dalam frame, atau ilustrasi orbit ikon lima use case seperti cover Dima.
- Footer: PT Mitra Akses Globalindo (MAGNET) • November 2026.

## 2. Alur pengunjung taman

Padanan slide "Alur kerja industri" Dima. Enam langkah, dibagi dua kelompok.

| Kelompok | Langkah | Keterangan singkat |
|---|---|---|
| DI GERBANG | 1. Tiba di gerbang | Kendaraan masuk, tiket gerbang |
| DI GERBANG | 2. Beli tiket di loket | Antre, dilayani kasir |
| DI DALAM TAMAN | 3. Naik wahana tunggang | Tiket per putaran |
| DI DALAM TAMAN | 4. Beli dan beri pakan satwa | Kotak pakan per transaksi |
| DI DALAM TAMAN | 5. Makan di restoran | Meja, kapasitas aula |
| DI GERBANG | 6. Pulang lewat gerbang keluar | Kendaraan keluar |

Kalimat penutup: Setiap langkah adalah titik transaksi atau layanan. Angkanya hari ini hanya ada di POS, tanpa bukti kejadian di lapangan.

## 3. Tantangan di tiap langkah

Padanan slide "Tantangan industri" Dima: grid kartu, satu per langkah, ikon merah, label `Langkah N • nama`, plus satu kartu merah "Akibatnya".

1. **Tiba di gerbang**: kendaraan masuk dihitung manual, tidak ada bukti per kendaraan, plat tidak tercatat.
2. **Loket tiket**: kasir kosong dan tamu menunggu tidak terdeteksi; komplain baru ketahuan belakangan.
3. **Wahana tunggang**: putaran riil tidak terhitung, penunggang tanpa tiket tidak bisa dibuktikan.
4. **Feeding satwa**: kotak pakan yang diserahkan tidak dicocokkan dengan yang terjual di POS.
5. **Restoran**: kepadatan aula dan lama duduk tidak terpantau, perputaran meja lambat saat ramai.
6. **Gerbang keluar**: kendaraan keluar tidak direkonsiliasi dengan yang masuk.

Kartu akibatnya: **Angka POS tidak bisa dibuktikan dengan kejadian di lapangan. Memutar ulang CCTV untuk satu kasus memakan jam.**

## 4. Zoo Vision: satu solusi untuk lima titik

Padanan slide "Empat solusi" Dima, tapi satu produk dengan lima modul. Lima kartu, tiap kartu: ikon, nama modul, satu kalimat, dua bullet, chip langkah alur yang dilayani.

| Modul | Label | Melayani langkah | Bullet |
|---|---|---|---|
| Gerbang Kendaraan | Revenue audit | 1, 6 | Hitung masuk/keluar per jam; baca plat nomor format Indonesia |
| Loket Kasir | Service SLA | 2 | Deteksi kasir kosong saat tamu antre; klip bukti 30 detik |
| Wahana Tunggang | Anti-fraud | 3 | Hitung putaran lewat tripwire; cocokkan dengan tiket POS |
| Feeding Satwa | Anti-fraud | 4 | Hitung kotak pakan yang diserahkan; cocokkan dengan penjualan |
| Restoran | F&B capacity | 5 | Kepadatan aula vs kapasitas; status meja dan lama duduk |

Kalimat bawah: Semua modul memakai kamera IP yang sudah ada dan berjalan di satu server edge di dalam taman.

## 5. Topologi dan model deteksi

Padanan slide "vision-intro" Dima. Tiga bagian.

**Topologi dan alur data** (baris kartu dengan panah):
Kamera CCTV eksisting → (RTSP) → MediaMTX hub, rekam bergulir 7 hari → (stream) → Python AI Core, YOLO + ByteTrack + state machine → (kejadian) → Web dashboard, event dan klip bukti → (API) → sistem tiket/POS klien untuk rekonsiliasi.

**Model deteksi** (daftar ikon kecil):
deteksi orang, deteksi kendaraan, pembacaan plat nomor (ANPR), deteksi penunggang dan satwa tunggang, garis hitung (tripwire), zona dan okupansi, batas waktu (dwell time).

**Angka kapasitas** (empat stat besar, diambil dari v2):
12 kamera analitik per server • 7 hari rekaman lokal • 30 detik klip bukti per kejadian • 100% on-premise, tanpa video keluar ke cloud.

## 6. Use case: Gerbang kendaraan

Pola Masalah / Cara kerja / Hasil. Judul: **Setiap kendaraan masuk tercatat dengan bukti**.

- Stepper atas: 1 Lewat garis → 2 Hitung dan baca plat → 3 Tercatat + snapshot → 4 Rekap vs tiket.
- Visual kiri: screenshot `ui_vehicles` (total masuk/keluar dan distribusi per jam) dan `ui_vehicle_log_head` (log lintasan dengan foto). Kalau perlu ilustrasi langkah, pakai mock stepper statis.
- Masalah: kendaraan dihitung manual, tidak ada bukti per kendaraan, plat tidak tercatat.
- Cara kerja: (1) kendaraan melintasi garis hitung kamera gerbang; (2) AI menghitung arah masuk/keluar dan membaca plat format Korlantas, filter stempel pajak; (3) tiap lintasan tersimpan dengan referensi dan snapshot; (4) rekap per jam dicocokkan dengan tiket gerbang.
- Hasil: volume masuk/keluar per jam terbukti; plat per kendaraan untuk penelusuran; selisih tiket ketahuan hari itu juga.

## 7. Use case: Loket kasir

Judul: **Kasir kosong saat tamu antre langsung ketahuan**.

- Stepper: 1 Tamu masuk zona antre → 2 Zona kasir kosong → 3 Lewat 3 detik → 4 Alarm + klip.
- Visual: `ai_cashier` (zona kasir merah, zona antrean biru, status CUSTOMER WAITING) dan `ui_cashier` (durasi loket kosong, pengunjung menunggu).
- Masalah: kasir meninggalkan loket tanpa ketahuan; tamu menunggu, komplain baru sampai ke manajemen belakangan.
- Cara kerja: (1) dua zona terpisah, kursi kasir dan antrean di luar kaca; (2) state machine memantau keduanya; (3) filter dwell 3 detik agar pejalan kaki yang lewat tidak memicu alarm; (4) alarm prioritas tinggi dan klip 30 detik untuk evaluasi staf.
- Hasil: durasi loket kosong terukur per shift; alarm palsu disaring; bukti video untuk pembinaan staf.

## 8. Use case: Wahana tunggang satwa

Judul: **Setiap putaran dihitung, dicocokkan dengan tiket**.

- Stepper: 1 Berangkat lewat tripwire → 2 Filter pawang → 3 Kembali → 4 Rekap vs POS.
- Visual: `ai_pony_portrait` (tripwire berangkat dan kembali) dan `ui_rides` (keberangkatan per jam, rekap 14 hari).
- Masalah: putaran riil tidak terhitung; penunggangan tanpa tiket tidak bisa dibuktikan.
- Cara kerja: (1) kamera fokus di titik sempit gerbang keberangkatan; (2) AI membedakan penunggang dan pawang jalan kaki; (3) tripwire mencatat berangkat dan kembali; (4) rekap harian dicocokkan dengan log tiket POS.
- Hasil: jumlah putaran per jam dan per hari; selisih putaran vs tiket terlihat; menutup celah tunggang tanpa tiket.

## 9. Use case: Feeding satwa

Slide baru, belum ada di v2. Judul: **Kotak pakan yang diserahkan sama dengan yang terjual**.

- Stepper: 1 Transaksi di POS → 2 Kotak diserahkan ke tamu → 3 AI hitung serah terima → 4 Cocokkan dengan POS.
- Visual: belum ada footage dan screenshot. Pakai mock dashboard bergaya sama, dan tandai di speaker notes bahwa footage diambil saat site survey. Jangan pakai foto stok yang terlihat seperti bukti asli.
- Masalah: satu kotak terjual bisa dibagi jadi dua di konter; selisih tidak terlihat di POS.
- Cara kerja: (1) kamera di konter serah terima; (2) AI menghitung kotak yang berpindah ke tamu lewat garis hitung; (3) hitungan per jam dibandingkan dengan transaksi POS; (4) selisih di atas ambang memicu kejadian dan klip.
- Hasil: audit serah terima vs penjualan; selisih per shift; bukti klip saat selisih.
- Catatan jujur untuk presenter: modul ini masuk sebagai tahap pilot, parameter dan ambang ditentukan setelah data lapangan ada.

## 10. Use case: Restoran

Judul: **Kepadatan aula dan meja terpantau tanpa petugas berkeliling**.

- Stepper: 1 Tamu masuk aula → 2 Hitung vs kapasitas → 3 Status meja → 4 Peringatan dan perputaran.
- Visual: `ai_restaurant` (zona poligon dan hitungan), `ui_tables` (denah status meja), `ui_restaurant_chart` (kurva okupansi dengan batas warning).
- Masalah: kepadatan aula dan lama duduk tidak terpantau; saat ramai, meja kotor lambat dibersihkan.
- Cara kerja: (1) kamera aula menghitung pengunjung real-time; (2) dibandingkan dengan batas warning dan kapasitas; (3) zona meja menampilkan terisi/kosong dan lama duduk; (4) staf pembersih diarahkan ke meja yang baru kosong.
- Hasil: kurva okupansi harian; status meja live; perputaran meja lebih cepat.
- Catatan untuk presenter: meja di lapangan sering digeser dan digabung untuk rombongan. Tonjolkan kepadatan aula sebagai angka utama; status per meja disajikan sebagai fitur yang dikalibrasi ulang per tata letak.

## 11. Galeri bukti deteksi (opsional)

Padanan slide "contoh hasil" Dima: grid 2x2 snapshot AI (gerbang, loket, wahana, restoran) dengan caption satu baris. Berguna kalau deck dipakai untuk pre-read. Kalau deck dipakai live, buang slide ini karena tiap use case sudah membawa screenshot sendiri.

## 12. Dashboard pusat kendali

Dari v2 slide 9, diubah ke gaya kartu. Screenshot `ui_overview_top` besar di kiri, enam kartu fitur bernomor di kanan: Live video grid, Visual zone editor, Update real-time tanpa putus rekaman, Log bukti insiden (snapshot HD dan klip MP4), Akses berjenjang (Superadmin, Manager, Operator), Jejak audit sistem.

## 13. Log kejadian dan laporan

Dari v2 slide 10. Screenshot `ui_event_log` di kiri, empat kartu: Filter fleksibel (tanggal, kamera, use case), Ringkasan agregat (per jam atau per hari), Integritas data (catatan permanen), Ekspor 1 klik (PDF untuk rapat, CSV untuk olah data).

## 14. Cara terhubung ke sistem eksisting

Padanan slide "arsitektur" Dima. Diagram tiga kolom:

- Kiri: Kamera CCTV eksisting (gerbang, loket, wahana, feeding, restoran).
- Tengah: Zoo Vision edge server di dalam taman (kotak besar, seperti kotak Centra di Dima).
- Kanan atas: Sistem tiket / POS klien. Panah dua arah: → event dan hitungan per titik; ← data transaksi untuk rekonsiliasi.
- Kanan bawah: Dashboard web, bisa dibuka dari HP di jaringan taman.

Kalimat bawah: Video tidak pernah keluar dari jaringan taman. Integrasi ke POS lewat API, detail disepakati bersama tim IT klien.

## 15. Model investasi

Dari v2 slide 11, dua kartu besar.

- **Investasi awal (Capex)**: 1 unit AI Edge Appliance, menjadi aset klien, kapasitas 12 kamera, termasuk storage rekaman 7 hari, hemat daya tanpa rak server.
- **Biaya berlangganan (Opex)**: lisensi per titik kamera aktif. Skema tahunan (prioritas SLA dan update model) atau bulanan (cocok untuk wahana musiman).
- Baris bawah: semua lisensi mencakup akses penuh dashboard, garansi kalibrasi zona, tanpa biaya lisensi VMS tambahan.

## 16. Tahapan menuju go-live

Dari v2 slide 12, stepper enam langkah dengan ikon: Site survey → Server setup → Zone mapping → Kalibrasi AI → Pelatihan operator → Go-live. Tambahkan perkiraan durasi per tahap kalau sudah ada angka yang bisa dipertanggungjawabkan; kalau belum, biarkan tanpa durasi.

## 17. Siap memulai?

Padanan penutup Dima. Logo MAGNET, judul besar, tiga chip: Discovery workshop • Survei titik kamera • Tentukan pilot dan KPI. Tiga kartu kontak: Email info@mag.net.id, Toll free / WhatsApp 0800 1503 009 • 08880 1503 009, Perusahaan PT Mitra Akses Globalindo (MAGNET).

---

## Panduan gaya (mengikuti Dima)

- Latar terang: stage `#F4F8FC`, panel putih, garis `#DDE5F0`, teks `#15223B`, teks redup `#5F6D83`. Pola titik halus di latar slide.
- Satu warna aksen produk. Usul: ungu MagniVision `#4F4FC4` agar sejalan dengan keluarga produk MAGNET di deck Dima. Merah `#CF4444` hanya untuk kotak Masalah, hijau `#148568` hanya untuk kartu Hasil.
- Eyebrow di tiap slide: ikon kecil + teks mono kapital, contoh `ZOO VISION • GERBANG KENDARAAN`.
- Judul slide 2 baris maksimum, kalimat yang menyatakan hasil, bukan nama fitur.
- Kartu dengan sudut membulat, bayangan sangat tipis, tanpa garis aksen di tepi.
- Footer: `MAGNET • Zoo Vision AI` kiri, nomor slide kanan.
- Font: Nunito untuk judul dan isi, IBM Plex Mono untuk eyebrow dan angka. Untuk PPTX, kalau Nunito tidak terpasang di laptop presenter, pakai Calibri.
- Screenshot asli selalu diberi frame tipis dan caption satu baris di bawahnya, seperti foto di slide galeri Dima.

## Koreksi isi dari v2

- Slide 3 v2 menyebut 20 kamera, slide 11 menyebut 12 kamera per server. Pakai satu angka: 12 kamera analitik per server.
- Judul seragam Bahasa Indonesia. Istilah produk boleh Inggris (tripwire, dwell time, on-premise), label seperti SERVICE SLA dan REVENUE AUDIT dipakai hanya sebagai chip kecil.
- Kalimat "catatan transaksi permanen dan anti-manipulasi" di slide laporan perlu dicek dengan implementasi retention sebelum dipakai.

## Keputusan yang masih terbuka

1. **Nama produk**: Zoo Vision AI (v2) atau MagniVision (sudah dipakai di deck Dima untuk AI Vision pada CCTV). Mempengaruhi cover, eyebrow, dan footer semua slide.
2. **Format keluaran**: PPTX atau HTML interaktif seperti Dima. HTML memungkinkan stepper beranimasi, tapi PPTX lebih mudah diedit tim sales.
3. **Feeding satwa**: belum ada footage dan belum ada data. Ditampilkan sebagai modul pilot, atau ditunda dari deck ini.
4. **Restoran**: angka utama kepadatan aula, status per meja sebagai fitur sekunder, atau keduanya sejajar.
