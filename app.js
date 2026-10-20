'use strict';

if (new URLSearchParams(location.search).has('preview')) {
  location.replace('/preview.html' + location.search + location.hash);
} else {
  BazaarLive.create({Wallet:BazaarWallet,illustration}).init();
}
