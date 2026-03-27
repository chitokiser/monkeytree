// /assets/js/exchange.js
// MktExchangeV2 거래소 UI
(() => {
  const ethers = window.ethers;
  if (!ethers) { alert('ethers 로딩 실패'); return; }

  /* ── JumpSigner ─────────────────────────────────────────────────────── */
  class JumpSigner extends ethers.AbstractSigner {
    constructor(jw, provider) { super(provider); this._j = jw; }
    async getAddress() { return this._j.address; }
    async signMessage(msg) {
      const m = typeof msg === 'string' ? msg : ethers.hexlify(msg);
      return (await this._j.signMsg(m)).signature;
    }
    async signTransaction() { throw new Error('Jump: signTransaction은 sendTransaction을 통해 처리'); }
    async sendTransaction(tx) {
      const token = await this._j.getIdToken();
      const IFACE = new ethers.Interface([
        'function approve(address spender, uint256 amount) returns (bool)',
        'function marketBuy(uint256 mktAmount, uint256 maxTotalQuote) returns (bool)',
        'function marketSell(uint256 mktAmount, uint256 minNetQuote) returns (bool)',
        'function placeLimitBuy(uint256 mktAmount, uint256 pricePerMkt) returns (uint256)',
        'function placeLimitSell(uint256 mktAmount, uint256 pricePerMkt) returns (uint256)',
        'function cancelOrder(uint256 orderId) returns (bool)',
        'function fillLimitBuy(uint256 orderId, uint256 mktAmount) returns (bool)',
        'function fillLimitSell(uint256 orderId, uint256 mktAmount, uint256 maxTotalQuote) returns (bool)',
        'function setAct(uint8 nextAct)',
        'function setMarketPrice(uint256 nextPrice)',
        'function addMarketLiquidity(uint256 mktAmount, uint256 quoteAmount)',
        'function removeMarketLiquidity(address to, uint256 mktAmount, uint256 quoteAmount)',
      ]);
      let jumpTx;
      try {
        const decoded = IFACE.parseTransaction({ data: tx.data || '0x' });
        const args = decoded.args.map(a => a.toString());
        jumpTx = { type: 'contract', to: tx.to, abi: [decoded.fragment.format('full')], method: decoded.name, args };
      } catch {
        throw new Error('Jump: 지원하지 않는 트랜잭션: ' + (tx.data || '0x').slice(0, 10));
      }
      const result = await window.jumpSignTx(token, jumpTx);
      const txHash = result?.data?.txHash || result?.txHash;
      if (!txHash) throw new Error('Jump: txHash 없음: ' + JSON.stringify(result));
      const provider = this.provider;
      return {
        hash: txHash,
        wait: async () => {
          let receipt = null;
          while (!receipt) {
            await new Promise(r => setTimeout(r, 2000));
            receipt = await provider.getTransactionReceipt(txHash).catch(() => null);
          }
          return receipt;
        },
      };
    }
    async signTypedData() { throw new Error('Jump: signTypedData 미지원'); }
    connect(p) { return new JumpSigner(this._j, p); }
  }

  /* ── Constants ──────────────────────────────────────────────────────── */
  const EXCHANGE_ADDRESS = '0x058EbD15e414993d428ADd8fCD04fFc9Fa36A1bB'; // MktExchangeV3

  const EXCHANGE_ABI = [
    'function marketPrice() view returns (uint256)',
    'function act() view returns (uint8)',
    'function availableMktForMarket() view returns (uint256)',
    'function availableQuoteForMarket() view returns (uint256)',
    'function nextOrderId() view returns (uint256)',
    'function mkt() view returns (address)',
    'function quoteToken() view returns (address)',
    'function totalFeeQuote() view returns (uint256)',
    'function quoteBalance() view returns (uint256)',
    'function mktBalance() view returns (uint256)',
    'function previewMarketBuy(uint256) view returns (uint256 grossQuote, uint256 feeQuote, uint256 totalQuote)',
    'function previewMarketSell(uint256) view returns (uint256 grossQuote, uint256 feeQuote, uint256 netQuote)',
    'function orders(uint256) view returns (uint256 id, address maker, uint8 side, uint256 price, uint256 amount, uint256 remaining, bool active)',
    'function marketBuy(uint256 mktAmount, uint256 maxTotalQuote) returns (bool)',
    'function marketSell(uint256 mktAmount, uint256 minNetQuote) returns (bool)',
    'function placeLimitBuy(uint256 mktAmount, uint256 pricePerMkt) returns (uint256)',
    'function placeLimitSell(uint256 mktAmount, uint256 pricePerMkt) returns (uint256)',
    'function cancelOrder(uint256 orderId) returns (bool)',
    'function fillLimitBuy(uint256 orderId, uint256 mktAmount) returns (bool)',
    'function fillLimitSell(uint256 orderId, uint256 mktAmount, uint256 maxTotalQuote) returns (bool)',
    // Events (for chart)
    'event MarketBuy(address indexed user, uint256 mktAmount, uint256 grossQuote, uint256 feeQuote, uint256 totalQuotePaid)',
    'event MarketSell(address indexed user, uint256 mktAmount, uint256 grossQuote, uint256 feeQuote, uint256 netQuoteReceived)',
    'event LimitBuyFilled(uint256 indexed orderId, address indexed maker, address indexed seller, uint256 amountFilled, uint256 price, uint256 grossQuote, uint256 feeQuote)',
    'event LimitSellFilled(uint256 indexed orderId, address indexed maker, address indexed buyer, uint256 amountFilled, uint256 price, uint256 grossQuote, uint256 feeQuote)',
    'event MarketPriceUpdated(uint256 prevPrice, uint256 nextPrice)',
    'function admin() view returns (address)',
    'function setAct(uint8 nextAct)',
    'function setMarketPrice(uint256 nextPrice)',
    'function addMarketLiquidity(uint256 mktAmount, uint256 quoteAmount)',
    'function removeMarketLiquidity(address to, uint256 mktAmount, uint256 quoteAmount)',
    // V3: VWAP 버퍼 조회
    'function getVwapInfo() view returns (uint256 count, uint256 sumMkt, uint256 sumQuote, uint256 vwap)',
  ];

  const ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
  ];

  const OPBNB = {
    chainId: '0xCC',
    chainName: 'opBNB Mainnet',
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    rpcUrls: ['https://opbnb-mainnet-rpc.bnbchain.org'],
    blockExplorerUrls: ['https://opbnbscan.com'],
  };

  const publicProvider = new ethers.JsonRpcProvider(OPBNB.rpcUrls[0]);

  /* ── State ────────────────────────────────────────────────────────────── */
  let account = null, signer = null;
  let readExch = null, writeExch = null;
  let readMkt = null, writeMkt = null;
  let readQuote = null, writeQuote = null;
  let mktAddr = null, quoteAddr = null;
  let mktDec = 18, quoteDec = 18;
  let mktSym = 'MKT', quoteSym = 'HEX';
  let _contractsInited = false;

  /* ── DOM helpers ─────────────────────────────────────────────────────── */
  const $ = id => document.getElementById(id);
  const setText = (id, v) => { const el = $(id); if (el) el.textContent = v ?? ''; };
  const setNote = v => { const el = $('exchNote'); if (el) el.textContent = v || ''; };

  /* ── Formatters ──────────────────────────────────────────────────────── */
  const fmt = (wei, dec, digits = 6, fixed = false) => {
    if (wei == null) return '-';
    try {
      const n = parseFloat(ethers.formatUnits(wei.toString(), dec));
      if (isNaN(n)) return wei.toString();
      return n.toLocaleString('ko-KR', {
        minimumFractionDigits: fixed ? digits : 0,
        maximumFractionDigits: digits,
      });
    } catch { return wei.toString(); }
  };

  const parse = (val, dec) => {
    if (!val || !val.trim()) return null;
    try { return ethers.parseUnits(val.trim().replace(/,/g, ''), dec); } catch { return null; }
  };

  /* ── Network ─────────────────────────────────────────────────────────── */
  async function ensureOpBNB() {
    if (!window.ethereum) throw new Error('지갑(MetaMask/Rabby) 없음');
    const cur = await window.ethereum.request({ method: 'eth_chainId' });
    if (cur?.toLowerCase() === OPBNB.chainId.toLowerCase()) return;
    try {
      await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: OPBNB.chainId }] });
    } catch (e) {
      if (e?.code !== 4902) throw e;
      await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [OPBNB] });
    }
  }

  /* ── Init contracts ──────────────────────────────────────────────────── */
  async function initContracts() {
    if (_contractsInited) return;
    _contractsInited = true;
    readExch = new ethers.Contract(EXCHANGE_ADDRESS, EXCHANGE_ABI, publicProvider);
    [mktAddr, quoteAddr] = await Promise.all([readExch.mkt(), readExch.quoteToken()]);
    readMkt = new ethers.Contract(mktAddr, ERC20_ABI, publicProvider);
    readQuote = new ethers.Contract(quoteAddr, ERC20_ABI, publicProvider);
    const [md, ms, qd, qs] = await Promise.all([
      readMkt.decimals(), readMkt.symbol(), readQuote.decimals(), readQuote.symbol()
    ]);
    mktDec = Number(md); mktSym = ms;
    quoteDec = Number(qd); quoteSym = qs;
    document.querySelectorAll('[data-sym-mkt]').forEach(el => el.textContent = mktSym);
    document.querySelectorAll('[data-sym-quote]').forEach(el => el.textContent = quoteSym);
  }

  /* ── Connect wallet ──────────────────────────────────────────────────── */
  async function ensureConnected() {
    await initContracts();

    if (window.jumpWallet) {
      account = window.jumpWallet.address;
      signer = new JumpSigner(window.jumpWallet, publicProvider);
      writeExch = new ethers.Contract(EXCHANGE_ADDRESS, EXCHANGE_ABI, signer);
      writeMkt = new ethers.Contract(mktAddr, ERC20_ABI, signer);
      writeQuote = new ethers.Contract(quoteAddr, ERC20_ABI, signer);
      updateAddrBadge();
      return true;
    }

    if (!window.ethereum) { alert('지갑을 연결하거나 구글 로그인을 사용하세요.'); return false; }
    await ensureOpBNB();
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    if (!accounts?.length) { alert('계정을 선택해주세요.'); return false; }
    account = accounts[0];
    const web3Provider = new ethers.BrowserProvider(window.ethereum);
    signer = await web3Provider.getSigner();
    writeExch = new ethers.Contract(EXCHANGE_ADDRESS, EXCHANGE_ABI, signer);
    writeMkt = new ethers.Contract(mktAddr, ERC20_ABI, signer);
    writeQuote = new ethers.Contract(quoteAddr, ERC20_ABI, signer);
    updateAddrBadge();
    return true;
  }

  function updateAddrBadge() {
    if (!account) return;
    const short = account.slice(0, 6) + '...' + account.slice(-4);
    setText('addrBadge', '지갑: ' + short);
    const hdrConnect = $('hdrConnect');
    if (hdrConnect) hdrConnect.textContent = short;
  }

  /* ── Load market state ───────────────────────────────────────────────── */
  async function loadMarketState() {
    try {
      await initContracts();
      const [price, actVal, availMkt, availQuote, cxMkt, cxQuote, totalFee] = await Promise.all([
        readExch.marketPrice(),
        readExch.act(),
        readExch.availableMktForMarket(),
        readExch.availableQuoteForMarket(),
        readExch.mktBalance(),
        readExch.quoteBalance(),
        readExch.totalFeeQuote(),
      ]);

      setText('mktPrice', fmt(price, quoteDec, 4, true) + ' ' + quoteSym + ' / 1 ' + mktSym);
      const actNum = Number(actVal);
      const actLabels = ['⛔ 거래중단', '✅ 시장가 가능', '✅ 전체 가능'];
      setText('mktStatus', actLabels[actNum] || '-');

      // Disable/enable trade tabs based on act
      document.querySelectorAll('[data-tab="pane-limit-buy"], [data-tab="pane-limit-sell"]').forEach(btn => {
        btn.disabled = actNum < 2;
        btn.title = actNum < 2 ? '현재 지정가 거래가 비활성화되어 있습니다.' : '';
      });

      setText('availMkt', fmt(availMkt, mktDec) + ' ' + mktSym);
      setText('availQuote', fmt(availQuote, quoteDec) + ' ' + quoteSym);

      setText('cxMktBal', fmt(cxMkt, mktDec) + ' ' + mktSym);
      setText('cxQuoteBal', fmt(cxQuote, quoteDec) + ' ' + quoteSym);
      setText('cxTotalFee', fmt(totalFee, quoteDec) + ' ' + quoteSym);

      if (account) {
        const [myMkt, myQuote] = await Promise.all([
          readMkt.balanceOf(account),
          readQuote.balanceOf(account),
        ]);
        setText('myMktBal', fmt(myMkt, mktDec) + ' ' + mktSym);
        setText('myQuoteBal', fmt(myQuote, quoteDec) + ' ' + quoteSym);
      }
    } catch (e) {
      console.error('[exchange] loadMarketState 오류', e);
    }
  }

  /* ── Preview ─────────────────────────────────────────────────────────── */
  async function previewBuy() {
    const amt = parse($('inBuyMkt')?.value, mktDec);
    if (!amt || amt <= 0n) { setText('previewBuyResult', ''); return; }
    try {
      const [gross, fee, total] = await readExch.previewMarketBuy(amt);
      setText('previewBuyResult',
        `예상 비용: ${fmt(total, quoteDec)} ${quoteSym}  (원금 ${fmt(gross, quoteDec)} + 수수료 ${fmt(fee, quoteDec)})`);
    } catch (e) { setText('previewBuyResult', '조회 실패: ' + (e.reason || e.message)); }
  }

  async function previewSell() {
    const amt = parse($('inSellMkt')?.value, mktDec);
    if (!amt || amt <= 0n) { setText('previewSellResult', ''); return; }
    try {
      const [gross, fee, net] = await readExch.previewMarketSell(amt);
      setText('previewSellResult',
        `예상 수령: ${fmt(net, quoteDec)} ${quoteSym}  (원금 ${fmt(gross, quoteDec)} - 수수료 ${fmt(fee, quoteDec)})`);
    } catch (e) { setText('previewSellResult', '조회 실패: ' + (e.reason || e.message)); }
  }

  /* ── Auto Approve ────────────────────────────────────────────────────── */
  async function ensureApprove(tokenContract, tokenSym, needed) {
    const cur = await tokenContract.allowance(account, EXCHANGE_ADDRESS);
    if (cur >= needed) return;
    setNote(`${tokenSym} 사용 승인 중... (지갑에서 승인해주세요)`);
    const tx = await tokenContract.approve(EXCHANGE_ADDRESS, ethers.MaxUint256);
    setNote('승인 트랜잭션 확인 대기 중...');
    await tx.wait();
    setNote('승인 완료');
  }

  /* ── Market Buy ──────────────────────────────────────────────────────── */
  async function doMarketBuy() {
    if (!await ensureConnected()) return;
    const amt = parse($('inBuyMkt')?.value, mktDec);
    if (!amt || amt <= 0n) { alert('구매할 ' + mktSym + ' 수량을 입력하세요.'); return; }
    try {
      setNote('시장가 매수 준비 중...');
      const [, , totalQuote] = await readExch.previewMarketBuy(amt);
      const maxQuote = totalQuote * 105n / 100n;
      await ensureApprove(writeQuote, quoteSym, totalQuote);
      setNote('시장가 매수 실행 중...');
      const tx = await writeExch.marketBuy(amt, maxQuote);
      setNote('트랜잭션 확인 대기 중... ' + tx.hash.slice(0, 12) + '...');
      await tx.wait();
      setNote('✅ 시장가 매수 완료! ' + fmt(amt, mktDec) + ' ' + mktSym + ' 구매');
      $('inBuyMkt').value = '';
      setText('previewBuyResult', '');
      await loadMarketState();
    } catch (e) {
      console.error('[exchange] marketBuy 오류', e);
      setNote('❌ 오류: ' + (e.reason || e.message || '알 수 없는 오류'));
    }
  }

  /* ── Market Sell ─────────────────────────────────────────────────────── */
  async function doMarketSell() {
    if (!await ensureConnected()) return;
    const amt = parse($('inSellMkt')?.value, mktDec);
    if (!amt || amt <= 0n) { alert('판매할 ' + mktSym + ' 수량을 입력하세요.'); return; }
    try {
      setNote('시장가 매도 준비 중...');
      const [, , netQuote] = await readExch.previewMarketSell(amt);
      const minNet = netQuote * 95n / 100n;
      await ensureApprove(writeMkt, mktSym, amt);
      setNote('시장가 매도 실행 중...');
      const tx = await writeExch.marketSell(amt, minNet);
      setNote('트랜잭션 확인 대기 중... ' + tx.hash.slice(0, 12) + '...');
      await tx.wait();
      setNote('✅ 시장가 매도 완료! ' + fmt(amt, mktDec) + ' ' + mktSym + ' 판매, ' + fmt(netQuote, quoteDec) + ' ' + quoteSym + ' 수령');
      $('inSellMkt').value = '';
      setText('previewSellResult', '');
      await loadMarketState();
    } catch (e) {
      console.error('[exchange] marketSell 오류', e);
      setNote('❌ 오류: ' + (e.reason || e.message || '알 수 없는 오류'));
    }
  }

  /* ── Limit Buy ───────────────────────────────────────────────────────── */
  async function doPlaceLimitBuy() {
    if (!await ensureConnected()) return;
    const amt = parse($('inLimitBuyMkt')?.value, mktDec);
    const price = parse($('inLimitBuyPrice')?.value, quoteDec);
    if (!amt || amt <= 0n) { alert('구매할 ' + mktSym + ' 수량을 입력하세요.'); return; }
    if (!price || price <= 0n) { alert('지정 가격(' + quoteSym + ')을 입력하세요.'); return; }
    try {
      setNote('지정가 매수 주문 준비 중...');
      // escrow = amt * price (raw) → computed in contract as grossQuote
      // We need to approve grossQuote quoteTokens
      const grossQuote = (amt * price) / (10n ** BigInt(mktDec)); // normalize if same decimals
      // Use contract's own escrow calculation: getBuyOrderEscrowNeeded is not in our ABI
      // Instead: escrow = mktAmount * pricePerMkt (raw product, same as contract)
      // We approve a safe upper bound
      const escrow = amt * price;
      await ensureApprove(writeQuote, quoteSym, escrow);
      setNote('지정가 매수 주문 생성 중...');
      const tx = await writeExch.placeLimitBuy(amt, price);
      setNote('트랜잭션 확인 대기 중...');
      await tx.wait();
      setNote('✅ 지정가 매수 주문 등록! ' + fmt(amt, mktDec) + ' ' + mktSym + ' @ ' + fmt(price, quoteDec, 4, true) + ' ' + quoteSym);
      $('inLimitBuyMkt').value = '';
      $('inLimitBuyPrice').value = '';
      await loadOrderBook();
      await loadMyOrders();
    } catch (e) {
      console.error('[exchange] placeLimitBuy 오류', e);
      setNote('❌ 오류: ' + (e.reason || e.message || '알 수 없는 오류'));
    }
  }

  /* ── Limit Sell ──────────────────────────────────────────────────────── */
  async function doPlaceLimitSell() {
    if (!await ensureConnected()) return;
    const amt = parse($('inLimitSellMkt')?.value, mktDec);
    const price = parse($('inLimitSellPrice')?.value, quoteDec);
    if (!amt || amt <= 0n) { alert('판매할 ' + mktSym + ' 수량을 입력하세요.'); return; }
    if (!price || price <= 0n) { alert('지정 가격(' + quoteSym + ')을 입력하세요.'); return; }
    try {
      setNote('지정가 매도 주문 준비 중...');
      await ensureApprove(writeMkt, mktSym, amt);
      setNote('지정가 매도 주문 생성 중...');
      const tx = await writeExch.placeLimitSell(amt, price);
      setNote('트랜잭션 확인 대기 중...');
      await tx.wait();
      setNote('✅ 지정가 매도 주문 등록! ' + fmt(amt, mktDec) + ' ' + mktSym + ' @ ' + fmt(price, quoteDec, 4) + ' ' + quoteSym);
      $('inLimitSellMkt').value = '';
      $('inLimitSellPrice').value = '';
      await loadOrderBook();
      await loadMyOrders();
    } catch (e) {
      console.error('[exchange] placeLimitSell 오류', e);
      setNote('❌ 오류: ' + (e.reason || e.message || '알 수 없는 오류'));
    }
  }

  /* ── Cancel Order ────────────────────────────────────────────────────── */
  async function doCancelOrder(orderId) {
    if (!await ensureConnected()) return;
    try {
      setNote('주문 #' + orderId + ' 취소 중...');
      const tx = await writeExch.cancelOrder(BigInt(orderId));
      await tx.wait();
      setNote('✅ 주문 #' + orderId + ' 취소 완료. 예치금이 환불되었습니다.');
      await loadOrderBook();
      await loadMyOrders();
      await loadMarketState();
    } catch (e) {
      setNote('❌ 취소 오류: ' + (e.reason || e.message));
    }
  }

  /* ── Fill Limit Buy (seller calls this) ─────────────────────────────── */
  async function doFillLimitBuy(orderId, remainingStr, priceStr) {
    if (!await ensureConnected()) return;
    const remaining = BigInt(remainingStr);
    const amtStr = prompt(
      '주문 #' + orderId + '에 판매할 ' + mktSym + ' 수량\n(최대 ' + fmt(remaining, mktDec) + ' ' + mktSym + '):',
      fmt(remaining, mktDec)
    );
    if (!amtStr) return;
    const amt = parse(amtStr, mktDec);
    if (!amt || amt <= 0n || amt > remaining) { alert('올바른 수량을 입력하세요.'); return; }
    try {
      setNote('지정가 매수주문 #' + orderId + ' 체결 중 (MKT 전달)...');
      await ensureApprove(writeMkt, mktSym, amt);
      const tx = await writeExch.fillLimitBuy(BigInt(orderId), amt);
      await tx.wait();
      setNote('✅ 주문 #' + orderId + ' 체결 완료! ' + quoteSym + ' 수령됨.');
      await loadOrderBook();
      await loadMyOrders();
      await loadMarketState();
    } catch (e) {
      setNote('❌ 체결 오류: ' + (e.reason || e.message));
    }
  }

  /* ── Fill Limit Sell (buyer calls this) ─────────────────────────────── */
  async function doFillLimitSell(orderId, remainingStr, priceStr) {
    if (!await ensureConnected()) return;
    const remaining = BigInt(remainingStr);
    const price = BigInt(priceStr);
    const amtStr = prompt(
      '주문 #' + orderId + '에서 구매할 ' + mktSym + ' 수량\n(최대 ' + fmt(remaining, mktDec) + ' ' + mktSym + '):',
      fmt(remaining, mktDec)
    );
    if (!amtStr) return;
    const amt = parse(amtStr, mktDec);
    if (!amt || amt <= 0n || amt > remaining) { alert('올바른 수량을 입력하세요.'); return; }
    try {
      setNote('지정가 매도주문 #' + orderId + ' 체결 중 (' + quoteSym + ' 결제)...');
      const grossQuote = amt * price;
      const feeQuote = grossQuote * 300n / 10000n;
      const totalQuote = grossQuote + feeQuote;
      const maxTotal = totalQuote * 105n / 100n;
      await ensureApprove(writeQuote, quoteSym, totalQuote);
      const tx = await writeExch.fillLimitSell(BigInt(orderId), amt, maxTotal);
      await tx.wait();
      setNote('✅ 주문 #' + orderId + ' 체결 완료! ' + mktSym + ' 수령됨.');
      await loadOrderBook();
      await loadMyOrders();
      await loadMarketState();
    } catch (e) {
      setNote('❌ 체결 오류: ' + (e.reason || e.message));
    }
  }

  /* ── Load Order Book ─────────────────────────────────────────────────── */
  async function loadOrderBook() {
    try {
      const nextId = Number(await readExch.nextOrderId());
      if (nextId <= 1) {
        renderOrders('bookBuys', [], 0);
        renderOrders('bookSells', [], 1);
        return;
      }
      const start = Math.max(1, nextId - 100);
      const ids = Array.from({ length: nextId - start }, (_, i) => start + i);
      const rawOrders = await Promise.all(
        ids.map(id => readExch.orders(id).then(o => ({
          id,
          maker:     o.maker,
          side:      o.side,
          price:     o.price,
          amount:    o.amount,
          remaining: o.remaining,
          active:    o.active,
        })).catch(() => null))
      );
      const active = rawOrders.filter(o => o && o.active);
      // Sort buy orders: highest price first; sell orders: lowest price first
      const buys = active.filter(o => Number(o.side) === 0)
        .sort((a, b) => (b.price > a.price ? 1 : b.price < a.price ? -1 : 0));
      const sells = active.filter(o => Number(o.side) === 1)
        .sort((a, b) => (a.price > b.price ? 1 : a.price < b.price ? -1 : 0));
      renderOrders('bookBuys', buys, 0);
      renderOrders('bookSells', sells, 1);
    } catch (e) {
      console.error('[exchange] loadOrderBook 오류', e);
    }
  }

  function renderOrders(containerId, orders, side) {
    const el = $(containerId);
    if (!el) return;
    if (!orders.length) {
      el.innerHTML = '<div class="book-empty">활성 주문 없음</div>';
      return;
    }
    el.innerHTML = orders.map(o => {
      const makerLc  = (o.maker || '').toLowerCase();
      const accountLc = (account || '').toLowerCase();
      const connected = !!account;
      const isMine   = connected && !!makerLc && makerLc === accountLc;
      const canFill  = connected && !isMine;
      return `<div class="book-row${isMine ? ' mine' : ''}">
        <span class="book-id">#${o.id}</span>
        <span class="book-price">${fmt(o.price, quoteDec, 4, true)}</span>
        <span class="book-amt">${fmt(o.remaining, mktDec)} / ${fmt(o.amount, mktDec)}</span>
        <span class="book-actions">
          ${isMine  ? `<button class="btnx small danger" onclick="window._exchCancel(${o.id})">취소</button>` : ''}
          ${canFill && side === 0 ? `<button class="btnx small" onclick="window._exchFillBuy(${o.id},'${o.remaining}','${o.price}')">팔기</button>` : ''}
          ${canFill && side === 1 ? `<button class="btnx small" onclick="window._exchFillSell(${o.id},'${o.remaining}','${o.price}')">사기</button>` : ''}
          ${!connected ? `<span style="font-size:11px;color:var(--muted);">연결 필요</span>` : ''}
        </span>
      </div>`;
    }).join('');
  }

  /* ── My Orders ───────────────────────────────────────────────────────── */
  async function loadMyOrders() {
    const el = $('myOrdersList');
    if (!el) return;
    if (!account) {
      el.innerHTML = '<div class="book-empty">지갑을 연결하면 내 주문이 표시됩니다.</div>';
      return;
    }
    try {
      const nextId = Number(await readExch.nextOrderId());
      if (nextId <= 1) { el.innerHTML = '<div class="book-empty">주문 없음</div>'; return; }
      const start = Math.max(1, nextId - 200);
      const ids = Array.from({ length: nextId - start }, (_, i) => start + i);
      const rawOrders = await Promise.all(
        ids.map(id => readExch.orders(id).then(o => ({
          id,
          maker:     o.maker,
          side:      o.side,
          price:     o.price,
          amount:    o.amount,
          remaining: o.remaining,
          active:    o.active,
        })).catch(() => null))
      );
      const mine = rawOrders.filter(o =>
        o && o.active && o.maker.toLowerCase() === account.toLowerCase()
      );
      if (!mine.length) { el.innerHTML = '<div class="book-empty">활성 주문 없음</div>'; return; }
      el.innerHTML = mine.map(o => {
        const side = Number(o.side) === 0 ? '매수' : '매도';
        const cls = Number(o.side) === 0 ? 'buy-label' : 'sell-label';
        return `<div class="book-row mine">
          <span class="book-id">#${o.id}</span>
          <span class="${cls}">${side}</span>
          <span class="book-price">${fmt(o.price, quoteDec, 4, true)} ${quoteSym}</span>
          <span class="book-amt">${fmt(o.remaining, mktDec)} / ${fmt(o.amount, mktDec)} ${mktSym}</span>
          <span class="book-actions">
            <button class="btnx small danger" onclick="window._exchCancel(${o.id})">취소</button>
          </span>
        </div>`;
      }).join('');
    } catch (e) {
      console.error('[exchange] loadMyOrders 오류', e);
    }
  }

  /* ── Admin helpers ───────────────────────────────────────────────────── */
  const setAdminNote = v => { const el = $('adminNote'); if (el) el.textContent = v || ''; };

  async function checkAdmin() {
    if (!account) return;
    try {
      const adminAddr = await readExch.admin();
      if (adminAddr.toLowerCase() === account.toLowerCase()) {
        const panel = $('adminPanel');
        if (panel) panel.style.display = '';
        // Pre-select current act
        const actVal = Number(await readExch.act());
        const sel = $('inSetAct');
        if (sel) sel.value = actVal.toString();
      }
    } catch (e) { /* not admin or query failed */ }
  }

  async function doSetAct() {
    if (!await ensureConnected()) return;
    const val = $('inSetAct')?.value;
    if (val == null) return;
    try {
      setAdminNote('거래 상태 변경 중...');
      const tx = await writeExch.setAct(Number(val));
      await tx.wait();
      setAdminNote('✅ 거래 상태 변경 완료: act = ' + val);
      await loadMarketState();
    } catch (e) {
      setAdminNote('❌ 오류: ' + (e.reason || e.message));
    }
  }

  async function doSetPrice() {
    if (!await ensureConnected()) return;
    const raw = $('inSetPrice')?.value?.trim();
    if (!raw) { alert('가격을 입력하세요.'); return; }
    try {
      const price = BigInt(raw);
      setAdminNote('시장가 변경 중...');
      const tx = await writeExch.setMarketPrice(price);
      await tx.wait();
      setAdminNote('✅ 시장가 변경 완료: ' + fmt(price, quoteDec, 4, true) + ' ' + quoteSym);
      await loadMarketState();
    } catch (e) {
      setAdminNote('❌ 오류: ' + (e.reason || e.message));
    }
  }

  async function doAddLiquidity() {
    if (!await ensureConnected()) return;
    const mktAmt = parse($('inAddMkt')?.value || '0', mktDec) ?? 0n;
    const quoteAmt = parse($('inAddQuote')?.value || '0', quoteDec) ?? 0n;
    if (mktAmt <= 0n && quoteAmt <= 0n) { alert('MKT 또는 HEX 수량을 입력하세요.'); return; }
    try {
      if (mktAmt > 0n) {
        setAdminNote(mktSym + ' 승인 중...');
        const appTx = await writeMkt.approve(EXCHANGE_ADDRESS, mktAmt);
        await appTx.wait();
      }
      if (quoteAmt > 0n) {
        setAdminNote(quoteSym + ' 승인 중...');
        const appTx = await writeQuote.approve(EXCHANGE_ADDRESS, quoteAmt);
        await appTx.wait();
      }
      setAdminNote('유동성 공급 중...');
      const tx = await writeExch.addMarketLiquidity(mktAmt, quoteAmt);
      await tx.wait();
      setAdminNote(
        '✅ 유동성 공급 완료! MKT: ' + fmt(mktAmt, mktDec) +
        '  HEX: ' + fmt(quoteAmt, quoteDec)
      );
      $('inAddMkt').value = '';
      $('inAddQuote').value = '';
      await loadMarketState();
    } catch (e) {
      setAdminNote('❌ 오류: ' + (e.reason || e.message));
    }
  }

  async function doRemoveLiquidity() {
    if (!await ensureConnected()) return;
    const mktAmt = parse($('inRmMkt')?.value || '0', mktDec) ?? 0n;
    const quoteAmt = parse($('inRmQuote')?.value || '0', quoteDec) ?? 0n;
    if (mktAmt <= 0n && quoteAmt <= 0n) { alert('회수할 MKT 또는 HEX 수량을 입력하세요.'); return; }
    try {
      setAdminNote('유동성 회수 중...');
      const tx = await writeExch.removeMarketLiquidity(account, mktAmt, quoteAmt);
      await tx.wait();
      setAdminNote('✅ 유동성 회수 완료!');
      $('inRmMkt').value = '';
      $('inRmQuote').value = '';
      await loadMarketState();
    } catch (e) {
      setAdminNote('❌ 오류: ' + (e.reason || e.message));
    }
  }

  /* ── Global callbacks ────────────────────────────────────────────────── */
  window._exchCancel = doCancelOrder;
  window._exchFillBuy = doFillLimitBuy;
  window._exchFillSell = doFillLimitSell;
  window._exchLoadMyOrders = loadMyOrders;

  /* ── Tab switching ───────────────────────────────────────────────────── */
  function initTabs() {
    document.querySelectorAll('.exch-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        document.querySelectorAll('.exch-tab').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.exch-pane').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        const pane = $(btn.dataset.tab);
        if (pane) pane.classList.add('active');
      });
    });
  }

  /* ── Button bindings ─────────────────────────────────────────────────── */
  function bind() {
    const btnConnect = $('btnConnect');
    if (btnConnect) btnConnect.addEventListener('click', async () => {
      if (await ensureConnected()) {
        await loadMarketState();
        await loadOrderBook();
        await loadMyOrders();
        await checkAdmin();
      }
    });

    const btnRefresh = $('btnRefresh');
    if (btnRefresh) btnRefresh.addEventListener('click', async () => {
      await loadMarketState();
      await loadOrderBook();
      if (account) await loadMyOrders();
    });

    const btnRefreshOrders = $('btnRefreshOrders');
    if (btnRefreshOrders) btnRefreshOrders.addEventListener('click', () => {
      loadOrderBook();
      loadMyOrders();
    });

    $('btnMarketBuy')?.addEventListener('click', doMarketBuy);
    $('btnMarketSell')?.addEventListener('click', doMarketSell);
    $('btnLimitBuy')?.addEventListener('click', doPlaceLimitBuy);
    $('btnLimitSell')?.addEventListener('click', doPlaceLimitSell);

    $('inBuyMkt')?.addEventListener('input', previewBuy);
    $('inSellMkt')?.addEventListener('input', previewSell);

    // Admin buttons
    $('btnSetAct')?.addEventListener('click', doSetAct);
    $('btnSetPrice')?.addEventListener('click', doSetPrice);
    $('btnAddLiquidity')?.addEventListener('click', doAddLiquidity);
    $('btnRemoveLiquidity')?.addEventListener('click', doRemoveLiquidity);
  }

  /* ── Jump connected ──────────────────────────────────────────────────── */
  window.addEventListener('jump:connected', async () => {
    if (await ensureConnected()) {
      await loadMarketState();
      await loadOrderBook();
      await loadMyOrders();
      await checkAdmin();
    }
  });

  /* ── Chart ───────────────────────────────────────────────────────────── */
  const TF_SEC = { '1H': 3600, '4H': 14400, '1D': 86400 };
  let _chart = null;
  let _candleSeries = null;
  let _volumeSeries = null;
  let _currentTf = '1H';
  let _cachedTrades = null; // raw trades cache

  function initChartInstance() {
    const container = $('chartContainer');
    if (!container || !window.LightweightCharts) return;
    if (_chart) { _chart.remove(); _chart = null; }

    _chart = LightweightCharts.createChart(container, {
      width: container.clientWidth,
      height: 320,
      layout: {
        background: { type: 'solid', color: 'transparent' },
        textColor: 'rgba(234,240,255,0.75)',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.06)' },
        horzLines: { color: 'rgba(255,255,255,0.06)' },
      },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.12)' },
      timeScale: {
        borderColor: 'rgba(255,255,255,0.12)',
        timeVisible: true,
        secondsVisible: _currentTf === '1H',
      },
    });

    _candleSeries = _chart.addCandlestickSeries({
      upColor:     '#26c990',
      downColor:   '#ef5350',
      borderVisible: false,
      wickUpColor:   '#26c990',
      wickDownColor: '#ef5350',
    });

    _volumeSeries = _chart.addHistogramSeries({
      color: 'rgba(124,255,209,0.18)',
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
    });
    _chart.priceScale('vol').applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    new ResizeObserver(() => {
      if (_chart) _chart.applyOptions({ width: container.clientWidth });
    }).observe(container);
  }

  async function loadChartData(forceRefresh = false) {
    const noteEl = $('chartNote');
    if (noteEl) noteEl.textContent = '데이터 로딩 중...';

    try {
      await initContracts();

      if (forceRefresh || !_cachedTrades) {
        const currentBlock = await publicProvider.getBlockNumber();
        const fromBlock = Math.max(0, currentBlock - 200000); // ~55 hours on opBNB

        if (noteEl) noteEl.textContent = '이벤트 조회 중...';

        const [mBuys, mSells, lBuyFills, lSellFills, priceUpds] = await Promise.all([
          readExch.queryFilter(readExch.filters.MarketBuy(),         fromBlock).catch(() => []),
          readExch.queryFilter(readExch.filters.MarketSell(),        fromBlock).catch(() => []),
          readExch.queryFilter(readExch.filters.LimitBuyFilled(),    fromBlock).catch(() => []),
          readExch.queryFilter(readExch.filters.LimitSellFilled(),   fromBlock).catch(() => []),
          readExch.queryFilter(readExch.filters.MarketPriceUpdated(),fromBlock).catch(() => []),
        ]);

        const allEvts = [...mBuys, ...mSells, ...lBuyFills, ...lSellFills, ...priceUpds];

        // Batch-fetch block timestamps
        const uniqueBlocks = [...new Set(allEvts.map(e => e.blockNumber))];
        const blockInfos = await Promise.all(
          uniqueBlocks.map(n => publicProvider.getBlock(n).catch(() => null))
        );
        const tsMap = {};
        uniqueBlocks.forEach((n, i) => { if (blockInfos[i]) tsMap[n] = blockInfos[i].timestamp; });

        // Build trade list
        const trades = [];

        const marketPrice = (grossQ, mktAmt) => {
          const q = parseFloat(ethers.formatUnits(grossQ, quoteDec));
          const m = parseFloat(ethers.formatUnits(mktAmt, mktDec));
          return m > 0 ? q / m : 0;
        };

        for (const e of mBuys) {
          const ts = tsMap[e.blockNumber]; if (!ts) continue;
          const p = marketPrice(e.args.grossQuote, e.args.mktAmount); if (p <= 0) continue;
          const vol = parseFloat(ethers.formatUnits(e.args.mktAmount, mktDec));
          trades.push({ time: ts, price: p, volume: vol });
        }
        for (const e of mSells) {
          const ts = tsMap[e.blockNumber]; if (!ts) continue;
          const p = marketPrice(e.args.grossQuote, e.args.mktAmount); if (p <= 0) continue;
          const vol = parseFloat(ethers.formatUnits(e.args.mktAmount, mktDec));
          trades.push({ time: ts, price: p, volume: vol });
        }
        for (const e of lBuyFills) {
          const ts = tsMap[e.blockNumber]; if (!ts) continue;
          const p = marketPrice(e.args.grossQuote, e.args.amountFilled); if (p <= 0) continue;
          const vol = parseFloat(ethers.formatUnits(e.args.amountFilled, mktDec));
          trades.push({ time: ts, price: p, volume: vol });
        }
        for (const e of lSellFills) {
          const ts = tsMap[e.blockNumber]; if (!ts) continue;
          const p = marketPrice(e.args.grossQuote, e.args.amountFilled); if (p <= 0) continue;
          const vol = parseFloat(ethers.formatUnits(e.args.amountFilled, mktDec));
          trades.push({ time: ts, price: p, volume: vol });
        }
        // Admin price changes
        for (const e of priceUpds) {
          const ts = tsMap[e.blockNumber]; if (!ts) continue;
          const p = parseFloat(fmt(e.args.nextPrice, quoteDec).replace(/,/g, ''));
          if (p > 0) trades.push({ time: ts, price: p, volume: 0 });
        }

        trades.sort((a, b) => a.time - b.time);
        _cachedTrades = trades;
      }

      renderCandles(_cachedTrades);

    } catch (e) {
      console.error('[chart] 오류', e);
      if (noteEl) noteEl.textContent = '차트 로딩 실패: ' + (e.message || '');
    }
  }

  function renderCandles(trades) {
    const noteEl = $('chartNote');
    if (!_candleSeries) return;

    if (!trades.length) {
      // No trades – plot current market price as a single candle
      readExch.marketPrice().then(p => {
        const pHuman = parseFloat(fmt(p, quoteDec).replace(/,/g, ''));
        const now = Math.floor(Date.now() / 1000);
        _candleSeries.setData([{ time: now, open: pHuman, high: pHuman, low: pHuman, close: pHuman }]);
        _volumeSeries.setData([]);
        if (noteEl) noteEl.textContent = '거래 내역 없음 — 현재 시장가 기준 표시';
      }).catch(() => {});
      return;
    }

    const tfSec = TF_SEC[_currentTf] || 3600;
    const buckets = {};

    for (const t of trades) {
      const key = Math.floor(t.time / tfSec) * tfSec;
      if (!buckets[key]) {
        buckets[key] = { time: key, open: t.price, high: t.price, low: t.price, close: t.price, volume: t.volume };
      } else {
        const c = buckets[key];
        if (t.price > c.high) c.high = t.price;
        if (t.price < c.low)  c.low  = t.price;
        c.close = t.price;
        c.volume += t.volume;
      }
    }

    const candles = Object.values(buckets).sort((a, b) => a.time - b.time);
    const volData = candles.map(c => ({
      time: c.time,
      value: c.volume,
      color: c.close >= c.open ? 'rgba(38,201,144,0.25)' : 'rgba(239,83,80,0.25)',
    }));

    _candleSeries.setData(candles);
    _volumeSeries.setData(volData);
    _chart.timeScale().fitContent();

    if (noteEl) {
      noteEl.textContent = `${candles.length}캔들 · ${trades.filter(t=>t.volume>0).length}거래 · ${_currentTf} 기준`;
    }
  }

  function initChartControls() {
    document.querySelectorAll('.chart-tf').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.chart-tf').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _currentTf = btn.dataset.tf;
        if (_chart) {
          _chart.applyOptions({ timeScale: { secondsVisible: _currentTf === '1H' } });
        }
        if (_cachedTrades) renderCandles(_cachedTrades);
      });
    });

    $('btnReloadChart')?.addEventListener('click', () => {
      _cachedTrades = null;
      loadChartData(true);
    });
  }

  /* ── Init ────────────────────────────────────────────────────────────── */
  async function init() {
    initTabs();
    initChartControls();
    bind();
    try {
      await initContracts();
      await Promise.all([loadMarketState(), loadOrderBook()]);
      initChartInstance();
      loadChartData(); // async, non-blocking
    } catch (e) {
      console.error('[exchange] init 오류', e);
    }
  }

  document.addEventListener('DOMContentLoaded', () => setTimeout(init, 150));
})();
