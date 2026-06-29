importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyBfQlLpHbuRsZ7YKIFBj8Fa5o-HMo0SBrU",
  authDomain: "hariom-delivery.firebaseapp.com",
  projectId: "hariom-delivery",
  storageBucket: "hariom-delivery.firebasestorage.app",
  messagingSenderId: "60300951507",
  appId: "1:60300951507:web:e5d55d0d18dc2000b47926"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(function(payload) {

  const title = payload?.data?.title || "New Notification";
  const body  = payload?.data?.body  || "";

  self.registration.showNotification(title, {
    body: body,
    icon: "/icons/icon-192.png",
    requireInteraction: true
  });

});