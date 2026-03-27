// /assets/js/jump-config.example.js
// 이 파일을 복사해 jump-config.js 로 이름 바꾼 뒤 실제 값을 채우세요.
// jump-config.js 는 .gitignore 로 커밋에서 제외됩니다.

window.JUMP_CONFIG = {
  firebase: {
    apiKey:            "YOUR_FIREBASE_API_KEY",
    authDomain:        "YOUR_PROJECT.firebaseapp.com",
    projectId:         "YOUR_PROJECT",
    storageBucket:     "YOUR_PROJECT.firebasestorage.app",
    messagingSenderId: "YOUR_SENDER_ID",
    appId:             "YOUR_APP_ID",
    measurementId:     "YOUR_MEASUREMENT_ID",
  },
  jumpApiUrl: "https://us-central1-YOUR_PROJECT.cloudfunctions.net/externalApi",
  jumpApiKey: "YOUR_JUMP_API_KEY",
};
