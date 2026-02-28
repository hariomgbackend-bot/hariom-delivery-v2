// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyBfQlLpHbuRsZ7YKIFBj8Fa5o-HMo0SBrU",
  authDomain: "hariom-delivery.firebaseapp.com",
  databaseURL: "https://hariom-delivery-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "hariom-delivery",
  storageBucket: "hariom-delivery.firebasestorage.app",
  messagingSenderId: "60300951507",
  appId: "1:60300951507:web:e5d55d0d18dc2000b47926"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

export default app;