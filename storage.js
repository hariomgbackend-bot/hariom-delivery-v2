import { initializeApp } from "firebase/app";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: "AIzaSyBfQlLpHbuRsZ7YKIFBj8Fa5o-HMo0SBrU",
  authDomain: "hariom-delivery.firebaseapp.com",
  databaseURL: "https://hariom-delivery-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "hariom-delivery",
  storageBucket: "hariom-delivery.firebasestorage.app",
  messagingSenderId: "60300951507",
  appId: "1:60300951507:web:e5d55d0d18dc2000b47926"
};


const app = initializeApp(firebaseConfig);

export const storage = getStorage(app);
