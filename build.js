// build.js — Netlify 빌드 시 jump-config.js 자동 생성
// 환경변수에서 실제 키 값을 읽어 assets/js/jump-config.js 를 생성합니다.
const fs = require('fs');
const path = require('path');

const required = [
  'FIREBASE_API_KEY',
  'FIREBASE_AUTH_DOMAIN',
  'FIREBASE_PROJECT_ID',
  'FIREBASE_STORAGE_BUCKET',
  'FIREBASE_MESSAGING_SENDER_ID',
  'FIREBASE_APP_ID',
  'JUMP_API_URL',
  'JUMP_API_KEY',
];

const missing = required.filter(k => !process.env[k]);
if (missing.length) {
  console.error('[build.js] 누락된 환경변수:', missing.join(', '));
  process.exit(1);
}

const content = `// /assets/js/jump-config.js
// !! 자동 생성된 파일입니다. 직접 수정하지 마세요. !!
// build.js 가 Netlify 환경변수에서 읽어 생성합니다.

window.JUMP_CONFIG = {
  firebase: {
    apiKey:            "${process.env.FIREBASE_API_KEY}",
    authDomain:        "${process.env.FIREBASE_AUTH_DOMAIN}",
    projectId:         "${process.env.FIREBASE_PROJECT_ID}",
    storageBucket:     "${process.env.FIREBASE_STORAGE_BUCKET}",
    messagingSenderId: "${process.env.FIREBASE_MESSAGING_SENDER_ID}",
    appId:             "${process.env.FIREBASE_APP_ID}",${process.env.FIREBASE_MEASUREMENT_ID ? `\n    measurementId:     "${process.env.FIREBASE_MEASUREMENT_ID}",` : ''}
  },
  jumpApiUrl: "${process.env.JUMP_API_URL}",
  jumpApiKey: "${process.env.JUMP_API_KEY}",
};
`;

const outPath = path.join(__dirname, 'assets', 'js', 'jump-config.js');
fs.writeFileSync(outPath, content, 'utf8');
console.log('[build.js] jump-config.js 생성 완료:', outPath);
