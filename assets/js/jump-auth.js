// /assets/js/jump-auth.js
// Jump 수탁 지갑 Firebase 인증 모듈
// 동적 로드 방식: header-wallet.js가 필요할 때 loadScript()로 불러옴
// → 별도 HTML 파일 수정 불필요

(function () {
  'use strict';

  // ── Firebase / Jump 설정 — jump-config.js 에서 로드 ──────────────────
  // 실제 키는 assets/js/jump-config.js (gitignore) 에 있습니다.
  // 배포 서버에 jump-config.js 파일을 직접 올려두세요.
  const _cfg = window.JUMP_CONFIG;
  if (!_cfg) throw new Error('jump-config.js 가 로드되지 않았습니다.');

  const FIREBASE_CONFIG = _cfg.firebase;
  const JUMP_API        = _cfg.jumpApiUrl;
  const JUMP_API_KEY    = _cfg.jumpApiKey;

  // ── Firebase 초기화 (중복 방지) ────────────────────────────────────────
  let _initialized = false;
  function ensureInit() {
    if (_initialized) return;
    if (typeof firebase === 'undefined') throw new Error('Firebase SDK가 로드되지 않았습니다.');
    if (!firebase.apps || !firebase.apps.length) {
      firebase.initializeApp(FIREBASE_CONFIG);
    }
    _initialized = true;
  }

  // firebase.auth가 함수(팩토리)일 수도, 이미 초기화된 인스턴스일 수도 있음
  async function getAuth() {
    for (let i = 0; i < 30; i++) {
      if (typeof firebase.auth === 'function') return firebase.auth();
      if (firebase.auth && typeof firebase.auth.getRedirectResult === 'function') return firebase.auth;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('Firebase Auth SDK가 초기화되지 않았습니다. firebase-auth-compat.js 로드를 확인하세요.');
  }

  // ── Jump API: 사용자 지갑 확인 ────────────────────────────────────────
  async function apiVerifyUser(idToken) {
    const res = await fetch(JUMP_API + '/verifyUser', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userToken: idToken, apiKey: JUMP_API_KEY }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error('Jump verifyUser 실패 (' + res.status + '): ' + txt);
    }
    return res.json(); // { address, email, name }
  }

  // ── Jump API: 메시지 서명 ──────────────────────────────────────────────
  async function apiSignMessage(idToken, message) {
    const res = await fetch(JUMP_API + '/signMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userToken: idToken, message, apiKey: JUMP_API_KEY }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error('Jump signMessage 실패 (' + res.status + '): ' + txt);
    }
    return res.json(); // { signature, address, message }
  }

  // ── Jump API: 트랜잭션 서명 + 브로드캐스트 ──────────────────────────────
  async function apiSignTransaction(idToken, tx) {
    const res = await fetch(JUMP_API + '/signTransaction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': JUMP_API_KEY },
      body: JSON.stringify({ idToken, tx, apiKey: JUMP_API_KEY }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error('Jump signTransaction 실패 (' + res.status + '): ' + txt);
    }
    return res.json(); // { ok: true, data: { txHash, from, txType } }
  }

  // ── 공통: fbUser → jumpWallet 설정 ─────────────────────────────────────
  async function setupWallet(fbUser) {
    const idToken = await fbUser.getIdToken();
    const info    = await apiVerifyUser(idToken);
    console.log('[Jump] verifyUser 응답 (raw):', JSON.stringify(info));

    window.jumpWallet = {
      type:    'jump',
      address: (info.data || info).walletAddress || (info.data || info).address,
      email:   (info.data || info).email   || fbUser.email,
      name:    (info.data || info).name    || fbUser.displayName,
      _fbUser: fbUser,
      async getIdToken() { return fbUser.getIdToken(true); },
      async signMsg(message) {
        const token = await this.getIdToken();
        return apiSignMessage(token, message);
      },
    };
    return window.jumpWallet;
  }

  // ── Google 팝업 로그인 ────────────────────────────────────────────────────
  let _popupInProgress = false;
  async function login() {
    if (_popupInProgress) return;
    _popupInProgress = true;
    try {
      ensureInit();
      const auth = await getAuth();
      const GProvider = firebase.auth.GoogleAuthProvider;
      if (!GProvider) throw new Error('GoogleAuthProvider를 찾을 수 없습니다.');
      const result = await auth.signInWithPopup(new GProvider());
      return setupWallet(result.user);
    } finally {
      _popupInProgress = false;
    }
  }

  // ── 로그아웃 ────────────────────────────────────────────────────────────
  async function logout() {
    try { ensureInit(); } catch { /* Firebase 미초기화면 스킵 */ }
    if (typeof firebase !== 'undefined') {
      await (await getAuth()).signOut().catch(() => {});
    }
    window.jumpWallet = null;
    location.reload();
  }

  // ── 전역 노출 ────────────────────────────────────────────────────────────
  window.jumpLogin    = login;
  window.jumpLogout   = logout;
  window.jumpSignTx   = apiSignTransaction;
})();
