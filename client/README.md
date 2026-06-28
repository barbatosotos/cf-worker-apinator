# Apinator Client — Versi Stabil dengan Perbaikan Koneksi

**client Apinator** yang telah dimodifikasi untuk mengatasi masalah koneksi yang sering terputus, terutama saat tab browser tidak aktif atau jaringan tidak stabil.  
Kode ini merupakan hasil perbaikan dari [Apinator sdk-js](https://github.com/apinator-io/sdk-js) resmi, dengan tetap mempertahankan API publik yang sama.

## 🛠 Perbaikan yang Dilakukan (6 Fixes)

| # | Masalah | Solusi |
|---|---------|--------|
| 1 | **Activity timer tidak direset** saat ada pesan masuk. Koneksi tetap dianggap idle meskipun data mengalir, sehingga ping dikirim tidak perlu dan berpotensi memicu disconnect. | Timer inactivity direset **setiap kali pesan diterima** saat status `connected`. |
| 2 | **Percobaan reconnect di-reset terlalu cepat** (saat WebSocket terbuka, bukan saat server mengonfirmasi sesi). Akibatnya *exponential backoff* sering dilewati. | Counter `reconnectAttempts` sekarang di-reset hanya setelah event `realtime:connection_established`. |
| 3 | **Tidak ada pemulihan setelah 6 kali percobaan gagal**. Status `unavailable` bersifat permanen, mengharuskan pengguna memanggil `connect()` ulang secara manual. | Menambahkan timer 60 detik (`UNAVAILABLE_RETRY_DELAY`) untuk mencoba kembali secara otomatis dari status `unavailable`. |
| 4 | **Timer ping dan pong saling tumpang tindih** karena menggunakan variabel yang sama. Ini bisa menyebabkan timer tidak dapat dibatalkan dengan benar. | Memisahkan `activityTimer` (untuk mengirim ping) dan `pongTimer` (menunggu pong) menjadi dua variabel terpisah. |
| 5 | **Socket ID basi** tetap tersimpan setelah koneksi terputus, sehingga bisa terkirim ke endpoint autentikasi sebelum `connection_established` baru. | `socketId` dihapus (`null`) setiap kali meninggalkan status `connected`. |
| 6 | **Format body autentikasi salah**. Client resmi mengirim JSON (`application/json`), tetapi endpoint `/auth` standar di worker mengharapkan `application/x-www-form-urlencoded`. | Mengubah body menjadi `URLSearchParams` dan header `Content-Type` yang sesuai. |

## 📦 Isi Repositori

- `client/apinator-client.js` — Client Apinator yang sudah diperbaiki, siap digunakan di browser (ES module).

## 🚀 Cara Menggunakan

### contoh sederhana
```html
<script type="module">
  import { Apinator } from 'https://raw.githubusercontent.com/barbatosotos/cf-worker-apinator/main/client/apinator-client.js';

  const client = new Apinator({
    appKey: 'YOUR_APP_KEY', // app_xxxxxx
    cluster: 'us' // 'eu'
  });

  client.connect();
  // subscribe Public channel 'my-channel' dengan event 'my-event'
  const channel = client.subscribe('my-channel');
  channel.bind('my-event', data => console.log(data));

</script>
```

## 📘 API yang Didukung
API publik sepenuhnya kompatibel dengan dokumentasi resmi Apinator. Metode dan properti yang tersedia:

`connect()`, `disconnect()`

`subscribe(channel)`, `unsubscribe(channel)`

`bind(event, callback)`, `unbind(event, callback)`

`trigger(channel, event, data)` (untuk client event)

`socketId`, `state`

`Channel`, `PresenceChannel` dengan semua event (`realtime:subscription_succeeded`, `realtime:member_added`, dll.)



## 🔒 Keamanan
Autentikasi untuk channel private/presence tetap menggunakan alur standar: client memanggil `authEndpoint` Anda dengan body application/x-www-form-urlencoded (perbaikan #6).


## 🔗 Referensi
[Repositori resmi Apinator.io](https://github.com/apinator-io/sdk-js)

[Dokumentasi Apinator.io](https://apinator.io/documentation/)


## ⚖️ Lisensi
Kode ini merupakan turunan dari [Apinator SDK JS](https://github.com/apinator-io/sdk-js) yang dilisensikan di bawah MIT. Oleh karena itu, file ini juga dilisensikan di bawah MIT.
