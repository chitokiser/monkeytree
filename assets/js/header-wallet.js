// /assets/js/header-wallet.js
// MonkeyTree - Jump 수탁 지갑 Google 로그인 헤더 모듈
(() => {
  // ── Firebase + jump-auth 동적 로드 ────────────────────────────────────
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('스크립트 로드 실패: ' + src));
      document.head.appendChild(s);
    });
  }

  async function loadFirebaseAndJump() {
    const FBV = '9.23.0';
    await loadScript('assets/js/jump-config.js');          // 키 설정 (gitignore)
    await loadScript(`https://www.gstatic.com/firebasejs/${FBV}/firebase-app-compat.js`);
    await loadScript(`https://www.gstatic.com/firebasejs/${FBV}/firebase-auth-compat.js`);
    await loadScript('assets/js/jump-auth.js');
  }

  const GOOGLE_BTN_HTML =
    `<svg width="14" height="14" viewBox="0 0 24 24" style="flex-shrink:0;vertical-align:middle;">` +
    `<path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>` +
    `<path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>` +
    `<path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>` +
    `<path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>` +
    `</svg> 구글 로그인`;

  // ── Jump 연결 성공 후 UI 처리 ────────────────────────────────────────
  async function onJumpConnected(wallet) {
    // index.js의 jump:connected 이벤트 핸들러를 트리거 → ensureConnected(jumpWallet) 실행
    window.dispatchEvent(new CustomEvent('jump:connected'));

    // 헤더 Google 버튼 UI 업데이트
    const gBtn = document.getElementById('btnGoogleLogin');
    if (gBtn) {
      const nick = wallet.email ? wallet.email.split('@')[0] : wallet.address.slice(0, 6) + '...';
      gBtn.innerHTML = `<span style="font-size:11px;">📧</span> ${nick}`;
    }

    // 헤더 지갑연결 버튼에도 주소 표시
    const hdrConnect = document.getElementById('hdrConnect');
    if (hdrConnect) {
      const addr = wallet.address;
      hdrConnect.textContent = addr.slice(0, 6) + '...' + addr.slice(-4);
    }
  }

  // ── Google 로그인 / 로그아웃 토글 ───────────────────────────────────
  let _jumpConnecting = false;

  async function connectJump() {
    const gBtn = document.getElementById('btnGoogleLogin');

    // 이미 연결된 경우 → 로그아웃 확인
    if (window.jumpWallet) {
      const who = window.jumpWallet.email || window.jumpWallet.address;
      if (confirm(who + ' 로그아웃 하시겠습니까?')) {
        await window.jumpLogout();
      }
      return;
    }

    if (_jumpConnecting) return;
    _jumpConnecting = true;
    if (gBtn) gBtn.textContent = '연결 중...';

    try {
      await loadFirebaseAndJump();
      const wallet = await window.jumpLogin();
      if (!wallet) {
        if (gBtn) gBtn.innerHTML = GOOGLE_BTN_HTML;
        return;
      }
      await onJumpConnected(wallet);
    } catch (e) {
      console.error('[header-wallet] Jump 로그인 실패', e);
      if (gBtn) gBtn.innerHTML = GOOGLE_BTN_HTML;
      if (e?.code !== 'auth/popup-closed-by-user') {
        alert(e?.message || 'Jump 로그인 실패');
      }
    } finally {
      _jumpConnecting = false;
    }
  }

  // ── 버튼 바인딩 ────────────────────────────────────────────────────
  function bind() {
    // Google 로그인 버튼
    const gBtn = document.getElementById('btnGoogleLogin');
    if (gBtn && !gBtn.dataset.hwBound) {
      gBtn.dataset.hwBound = '1';
      gBtn.addEventListener('click', connectJump);
    }

    // 헤더 지갑연결 버튼 → index.html의 btnConnect(메인 버튼) 연동
    const hdrConnect = document.getElementById('hdrConnect');
    const mainConnect = document.getElementById('btnConnect');
    if (hdrConnect && mainConnect && !hdrConnect.dataset.hwBound) {
      hdrConnect.dataset.hwBound = '1';
      hdrConnect.addEventListener('click', () => mainConnect.click());
    }
  }

  // 헤더 파셜 로드 완료 후 바인딩
  window.addEventListener('partials:loaded', bind);
  // 혹시 파셜보다 DOMContentLoaded가 늦게 발생하는 경우 대비
  document.addEventListener('DOMContentLoaded', () => setTimeout(bind, 200));
})();
