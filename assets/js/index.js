// /assets/js/index.js
(() => {
  const ethers = window.ethers;
  if (!ethers) {
    alert("ethers 로딩 실패: 네트워크 또는 CDN 차단 여부 확인 필요");
    return;
  }

  // ── JumpSigner: Jump 수탁 지갑용 ethers.js v6 커스텀 서명자 ────────────
  // Google 로그인 후 window.jumpWallet이 설정되면 이 클래스를 signer로 사용합니다.
  class JumpSigner extends ethers.AbstractSigner {
    constructor(jumpWallet, provider) {
      super(provider);
      this._j = jumpWallet;
    }

    async getAddress() {
      return this._j.address;
    }

    async signMessage(message) {
      const msg = typeof message === 'string' ? message : ethers.hexlify(message);
      const result = await this._j.signMsg(msg);
      return result.signature;
    }

    async signTransaction(_tx) {
      throw new Error('Jump: signTransaction은 sendTransaction을 통해 처리됩니다.');
    }

    // MonkeyTree 컨트랙트 함수들을 Jump API signTransaction으로 위임
    async sendTransaction(tx) {
      const token = await this._j.getIdToken();

      const IFACE = new ethers.Interface([
        'function approve(address spender, uint256 amount) returns (bool)',
        'function charge(uint256 pay)',
        'function withdraw()',
        'function seeding()',
        'function choice(uint8 winnum)',
        'function buyTicket(uint256 qty)',
      ]);

      let jumpTx;
      try {
        const decoded = IFACE.parseTransaction({ data: tx.data || '0x' });
        const args = decoded.args.map((a) => a.toString());
        jumpTx = {
          type:   'contract',
          to:     tx.to,
          abi:    [decoded.fragment.format('full')],
          method: decoded.name,
          args,
        };
      } catch {
        throw new Error('Jump: 지원하지 않는 트랜잭션. calldata: ' + (tx.data || '0x').slice(0, 10));
      }

      console.log('[Jump] sendTransaction 요청:', JSON.stringify(jumpTx));
      const result = await window.jumpSignTx(token, jumpTx);
      console.log('[Jump] sendTransaction 응답:', JSON.stringify(result));

      const txHash = result?.data?.txHash || result?.txHash;
      if (!txHash) throw new Error('Jump sendTransaction: txHash 없음. 응답: ' + JSON.stringify(result));

      const provider = this.provider;
      return {
        hash: txHash,
        wait: async (confirms = 1) => {
          let receipt = null;
          while (!receipt || receipt.confirmations < confirms) {
            await new Promise((r) => setTimeout(r, 2000));
            receipt = await provider.getTransactionReceipt(txHash).catch(() => null);
          }
          return receipt;
        },
      };
    }

    async signTypedData(_domain, _types, _value) {
      throw new Error('Jump 수탁 지갑은 signTypedData를 지원하지 않습니다.');
    }

    connect(provider) {
      return new JumpSigner(this._j, provider);
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  // ── 사운드 (Web Audio API, 외부 파일 없음) ────────────────────────────────
  let _audioCtx = null;
  function getAudioCtx() {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (_audioCtx.state === "suspended") _audioCtx.resume();
    return _audioCtx;
  }

  // 씨앗 심기 – 흙에 씨앗 묻는 느낌 (낮은 톤 → 짧은 상승)
  function soundPlant() {
    try {
      const ctx = getAudioCtx();
      const t = ctx.currentTime;

      // 둔탁한 타격음 (OscillatorNode + noise-like envelope)
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.type = "sine";
      osc.frequency.setValueAtTime(180, t);
      osc.frequency.exponentialRampToValueAtTime(80, t + 0.18);

      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.45, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.22);

      osc.start(t);
      osc.stop(t + 0.25);

      // 작은 찰칵 느낌 (고주파 짧게)
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.connect(gain2);
      gain2.connect(ctx.destination);

      osc2.type = "triangle";
      osc2.frequency.setValueAtTime(900, t);
      osc2.frequency.exponentialRampToValueAtTime(400, t + 0.06);

      gain2.gain.setValueAtTime(0.18, t);
      gain2.gain.exponentialRampToValueAtTime(0.001, t + 0.07);

      osc2.start(t);
      osc2.stop(t + 0.08);
    } catch (_) {}
  }

  // 완료 – 상쾌한 2음 차임 (씨앗 완료, 충전, 티켓 구매 공통)
  function soundSuccess() {
    try {
      const ctx = getAudioCtx();
      const t = ctx.currentTime;
      const notes = [523.25, 783.99]; // C5, G5

      notes.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.type = "sine";
        osc.frequency.setValueAtTime(freq, t + i * 0.13);

        gain.gain.setValueAtTime(0, t + i * 0.13);
        gain.gain.linearRampToValueAtTime(0.35, t + i * 0.13 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.13 + 0.38);

        osc.start(t + i * 0.13);
        osc.stop(t + i * 0.13 + 0.4);
      });
    } catch (_) {}
  }

  // 씨앗이 포트에 안착 확정 – 임팩트 있는 복합 사운드
  // ① 쿵 하는 타격감  ② 밝은 상승 멜로디 4음  ③ 여운 패드
  function soundLand() {
    try {
      const ctx = getAudioCtx();
      const t = ctx.currentTime;

      // ① 임팩트 킥 (저음 펀치)
      const kick = ctx.createOscillator();
      const kickGain = ctx.createGain();
      kick.connect(kickGain);
      kickGain.connect(ctx.destination);
      kick.type = "sine";
      kick.frequency.setValueAtTime(220, t);
      kick.frequency.exponentialRampToValueAtTime(40, t + 0.12);
      kickGain.gain.setValueAtTime(0.9, t);
      kickGain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
      kick.start(t);
      kick.stop(t + 0.2);

      // ② 상승 멜로디 4음 (C5 → E5 → G5 → C6)
      const melody = [523.25, 659.25, 783.99, 1046.5];
      melody.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const g   = ctx.createGain();
        osc.connect(g);
        g.connect(ctx.destination);

        osc.type = "square";
        // 각 음에 약간의 비브라토 느낌 (detune)
        osc.detune.setValueAtTime(i % 2 === 0 ? 5 : -5, t + i * 0.10);
        osc.frequency.setValueAtTime(freq, t + i * 0.10);

        const onset = t + i * 0.10;
        g.gain.setValueAtTime(0, onset);
        g.gain.linearRampToValueAtTime(0.22, onset + 0.015);
        g.gain.exponentialRampToValueAtTime(0.001, onset + 0.32);

        osc.start(onset);
        osc.stop(onset + 0.35);
      });

      // ③ 마지막 음과 함께 여운 패드 (sine, 낮게 깔림)
      const pad = ctx.createOscillator();
      const padGain = ctx.createGain();
      pad.connect(padGain);
      padGain.connect(ctx.destination);
      pad.type = "sine";
      pad.frequency.setValueAtTime(523.25, t + 0.28); // C5
      padGain.gain.setValueAtTime(0, t + 0.28);
      padGain.gain.linearRampToValueAtTime(0.28, t + 0.32);
      padGain.gain.exponentialRampToValueAtTime(0.001, t + 1.1);
      pad.start(t + 0.28);
      pad.stop(t + 1.2);

    } catch (_) {}
  }
  // ─────────────────────────────────────────────────────────────────────────

  // =========================
  // Contract
  // =========================
  const CONTRACT_ADDRESS = "0xCdfdE82e2473245564f0e8B330367C7f63a59397";

  const ABI = [
    "function HEX() view returns (address)",
    "function price() view returns (uint256)",
    "function remain() view returns (uint8)",
    "function tax() view returns (uint256)",
    "function rate() view returns (uint8)",
    "function pllength() view returns (uint256)",
    "function g1() view returns (uint256)",
    "function dayBalance() view returns (uint256)",
    "function withdrawnToday() view returns (uint256)",
    "function dailyCap() view returns (uint256)",
    "function allowt(address) view returns (uint256)",
    "function mypay(address) view returns (uint256)",
    "function mytiket(address) view returns (uint256)",
    "function port(uint256) view returns (uint256 depo,uint256 depon,uint256 portn,address owner)",
    "function getvalue(uint256) view returns (uint256)",

    "function charge(uint256 pay)",
    "function withdraw()",
    "function seeding()",
    "function choice(uint8 winnum)",
    "function buyTicket(uint256 qty)",
    "function TICKET_PRICE() view returns (uint256)",

    "event farmnum(uint256 winnum)",
  ];

  const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
  ];

  // =========================
  // Images — seed.png(빈포트) + seed1~seed14(14단계 성장)
  // =========================
  const IMG_EMPTY = "assets/img/tree/seed.png";
  // 인덱스 0 = seed1(막 심음) … 인덱스 13 = seed14(최대 성장)
  const IMG_STAGES = Array.from({ length: 14 }, (_, i) =>
    `assets/img/tree/seed${i + 1}.png`
  );

  // =========================
  // Network (opBNB)
  // =========================
  const OPBNB = {
    chainId: "0xCC", // 204
    chainName: "opBNB Mainnet",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: ["https://opbnb-mainnet-rpc.bnbchain.org"],
    blockExplorerUrls: ["https://opbnbscan.com"],
  };

  // 읽기 전용(지갑 없이도 항상 조회 가능)
  const publicProvider = new ethers.JsonRpcProvider(OPBNB.rpcUrls[0]);

  async function ensureOpBNB() {
    if (!window.ethereum) throw new Error("지갑(메타마스크/래비) 없음");

    const cur = await window.ethereum.request({ method: "eth_chainId" });
    if (cur && cur.toLowerCase() === OPBNB.chainId.toLowerCase()) return;

    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: OPBNB.chainId }],
      });
      return;
    } catch (e) {
      if (e?.code !== 4902) throw e;
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [OPBNB],
      });
    }
  }

  // =========================
  // DOM helpers
  // =========================
  const $ = (id) => document.getElementById(id);

  const setNote = (id, msg) => {
    const el = $(id);
    if (!el) return;
    el.textContent = msg || "";
  };

  const setText = (id, txt) => {
    const el = $(id);
    if (!el) return;
    el.textContent = txt ?? "";
  };

  const setOnchain = (id, txt, soft = false) => {
    const el = $(id);
    if (!el) return;
    el.textContent = txt ?? "";
    el.classList.add(soft ? "onchain-soft" : "onchain");
  };

  // =========================
  // Formatters
  // =========================
  const fmtHex = (wei, digits = 4) => {
    try {
      const v = ethers.formatUnits(wei ?? 0n, 18);
      const n = Number(v);
      if (!Number.isFinite(n)) return `${v} HEX`;
      return `${n.toFixed(digits)} HEX`;
    } catch {
      return `0 HEX`;
    }
  };

  const fmtTs = (ts) => {
    if (!ts) return "-";
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return "-";
    return new Date(n * 1000).toLocaleString();
  };

  const shortAddr = (a) => {
    if (!a) return "-";
    const s = String(a);
    if (s.length < 10) return s;
    return `${s.slice(0, 6)}…${s.slice(-4)}`;
  };

  const parseEthersError = (e) => {
    return (
      e?.shortMessage ||
      e?.reason ||
      e?.info?.error?.message ||
      e?.message ||
      String(e)
    );
  };

  // =========================
  // 성장 판단 — seed1(막 심음) ~ seed14(최대 성장)
  // r100 = value / depo * 100 기준 14구간 분배
  // =========================
  const STAGE_BREAKS = [100, 115, 130, 145, 160, 175, 190, 205, 220, 235, 250, 265, 280];
  // 구간: <=100→1단, 101~115→2단 … 281+→14단

  const getStageImg = (owner, valueWei, depoWei) => {
    if (!owner || owner === ethers.ZeroAddress) return IMG_EMPTY;
    if (!depoWei || BigInt(depoWei) === 0n) return IMG_EMPTY;

    const v = BigInt(valueWei ?? 0n);
    const d = BigInt(depoWei ?? 0n);
    const r100 = Number((v * 100n) / d);   // 소수점 버림

    // STAGE_BREAKS 기준으로 단계 결정 (1~14)
    let stage = 1;
    for (let i = 0; i < STAGE_BREAKS.length; i++) {
      if (r100 > STAGE_BREAKS[i]) stage = i + 2;
      else break;
    }
    return IMG_STAGES[stage - 1]; // 배열 인덱스 0~13
  };

  // =========================
  // Concurrency helper
  // =========================
  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    });
    await Promise.all(workers);
    return out;
  }

  // =========================
  // Web3 state (read/write 분리)
  // =========================
  let walletProvider = null;
  let signer = null;
  let account = null;

  // 읽기 전용 컨트랙트(항상 사용)
  const readContract = new ethers.Contract(CONTRACT_ADDRESS, ABI, publicProvider);

  // 쓰기 전용 컨트랙트(지갑 연결 시 생성)
  let writeContract = null;

  // HEX (읽기/쓰기 각각)
  let HEX_ADDRESS = null;
  let readHexToken = null;
  let writeHexToken = null;

  // event parser
  const iface = new ethers.Interface(ABI);

  const refreshHeaderBadges = () => {
    setText("addrBadge", account ? `지갑: ${shortAddr(account)}` : "지갑: 미연결");
    setText("netBadge", account ? "네트워크: opBNB" : "네트워크: opBNB (조회만)");
  };

  async function initReadOnly() {
    // HEX 주소는 한번만 로드
    if (!HEX_ADDRESS) {
      HEX_ADDRESS = await readContract.HEX();
      readHexToken = new ethers.Contract(HEX_ADDRESS, ERC20_ABI, publicProvider);
    }
  }

  const ensureConnected = async () => {
    // ── Jump 수탁 지갑 (Google 로그인 완료된 경우) ────────────────────────
    if (window.jumpWallet) {
      account = window.jumpWallet.address;
      if (!account) throw new Error("Jump 지갑 주소 없음 - 콘솔에서 verifyUser 응답 확인 필요");
      signer = new JumpSigner(window.jumpWallet, publicProvider);
      writeContract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);
      if (!HEX_ADDRESS) HEX_ADDRESS = await readContract.HEX();
      if (!readHexToken) readHexToken = new ethers.Contract(HEX_ADDRESS, ERC20_ABI, publicProvider);
      writeHexToken = new ethers.Contract(HEX_ADDRESS, ERC20_ABI, signer);
      return true;
    }

    // ── MetaMask / Rabby 개인 지갑 ───────────────────────────────────────
    if (!window.ethereum) throw new Error("지갑(메타마스크/래비) 없음");

    await ensureOpBNB();

    walletProvider = new ethers.BrowserProvider(window.ethereum);
    await walletProvider.send("eth_requestAccounts", []);
    signer = await walletProvider.getSigner();
    account = await signer.getAddress();

    writeContract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);

    // HEX 주소/컨트랙트 준비
    if (!HEX_ADDRESS) HEX_ADDRESS = await readContract.HEX();
    if (!readHexToken) readHexToken = new ethers.Contract(HEX_ADDRESS, ERC20_ABI, publicProvider);
    writeHexToken = new ethers.Contract(HEX_ADDRESS, ERC20_ABI, signer);

    return true;
  };

  // =========================
  // Summary (onchain values) - 항상 readContract로 조회
  // =========================
  const refreshSummary = async () => {
    await initReadOnly();

    const [
      priceWei,
      remain,
      rate,
      taxWei,
      plLen,
      cxHexWei,
      dailyCapWei,
      withdrawnTodayWei,
      dayBalanceWei,
    ] = await Promise.all([
      readContract.price(),
      readContract.remain(),
      readContract.rate(),
      readContract.tax(),
      readContract.pllength(),
      readContract.g1(),
      readContract.dailyCap(),
      readContract.withdrawnToday(),
      readContract.dayBalance(),
    ]);

    setText("updatedAt", new Date().toLocaleString());

    setOnchain("mPrice", fmtHex(priceWei, 4));
    setOnchain("mRemain", String(remain));
    setOnchain("mRate", String(rate));
    setOnchain("mTax", fmtHex(taxWei, 4));
    setOnchain("mPlLen", String(plLen));
    setOnchain("mCxHex", fmtHex(cxHexWei, 4));
    setOnchain("mDailyCap", fmtHex(dailyCapWei, 4));
    setOnchain("mWithdrawnToday", fmtHex(withdrawnTodayWei, 4));
    setOnchain("mDayBalance", fmtHex(dayBalanceWei, 4));

    // 내 정보는 지갑 연결된 경우만
    if (account) {
      const [myPayWei, myTickets, allowt, myHexWei] = await Promise.all([
        readContract.mypay(account),
        readContract.mytiket(account),
        readContract.allowt(account),
        readHexToken.balanceOf(account),
      ]);

      setOnchain("mMyPay", fmtHex(myPayWei, 4), true);
      setOnchain("mMyTickets", String(myTickets), true);
      setOnchain("mAllowt", fmtTs(allowt), true);
      setOnchain("mMyHex", fmtHex(myHexWei, 4), true);
    } else {
      setText("mMyPay", "-");
      setText("mMyTickets", "-");
      setText("mAllowt", "-");
      setText("mMyHex", "-");
    }

    setText("portsMeta", `remain: ${remain}`);
    return { remain: Number(remain) };
  };

  // =========================
  // Port helpers
  // =========================
  const focusPort = (n) => {
    const inPort = $("inPortNum");
    if (inPort) inPort.value = String(n);

    const chip = $("portChip");
    if (chip) chip.textContent = `port: ${n}`;

    const grid = $("portsGrid");
    const card = grid?.querySelector(`.port-card[data-port="${n}"]`);
    if (card) {
      card.classList.add("flash");
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      setTimeout(() => card.classList.remove("flash"), 900);
    }
  };

  const readPortToPanel = async () => {
    const n = Number($("inPortNum")?.value || 0);
    if (!n) {
      setNote("txBox", "포트 번호를 입력하세요.");
      return;
    }
    const [p, v] = await Promise.all([readContract.port(n), readContract.getvalue(n)]);

    setText("portChip", `port: ${n}`);
    setOnchain("pOwner", p.owner && p.owner !== ethers.ZeroAddress ? p.owner : "-", true);
    setOnchain("pDepo", fmtHex(p.depo, 4), true);
    setOnchain("pDepon", String(p.depon), true);
    setOnchain("pValue", fmtHex(v, 4), true);
  };

  // =========================
  // Approve helper (쓰기 전용)
  // =========================
  const approveHexAndWait = async (amountWei) => {
    if (!account || !writeHexToken) throw new Error("지갑 연결 필요");

    const cur = await readHexToken.allowance(account, CONTRACT_ADDRESS);
    if (cur >= amountWei) return { skipped: true, tx: null, allowance: cur };

    const tx = await writeHexToken.approve(CONTRACT_ADDRESS, amountWei);
    await tx.wait();

    const after = await readHexToken.allowance(account, CONTRACT_ADDRESS);
    return { skipped: false, tx, allowance: after };
  };

  // =========================
  // Event parse
  // =========================
  const getFarmnumFromReceipt = (receipt) => {
    if (!receipt?.logs) return null;
    for (const log of receipt.logs) {
      if (!log?.address) continue;
      if (log.address.toLowerCase() !== CONTRACT_ADDRESS.toLowerCase()) continue;
      try {
        const parsed = iface.parseLog(log);
        if (parsed?.name === "farmnum") {
          const w = parsed.args?.winnum;
          return Number(w);
        }
      } catch {}
    }
    return null;
  };

  // =========================
  // Render ports grid (항상 readContract로 조회)
  // =========================
  const renderPorts = async (remain) => {
    const grid = $("portsGrid");
    if (!grid) return;
    grid.innerHTML = "";

    const nums = Array.from({ length: remain }, (_, i) => i + 1);

    for (const n of nums) {
      const card = document.createElement("div");
      card.className = "port-card";
      card.dataset.port = String(n);

      card.innerHTML = `
        <div class="port-top">
          <div class="port-no">#${n}</div>
          <div class="port-owner">loading…</div>
        </div>

        <div class="port-viz">
          <img class="tree-base" src="${IMG_EMPTY}" alt="tree"/>
        </div>

        <div class="port-mini">
          <div class="mini-row"><span>depo</span><span class="val">-</span></div>
          <div class="mini-row"><span>depon</span><span class="val">-</span></div>
          <div class="mini-row"><span>value</span><span class="val">-</span></div>
        </div>
      `;

      card.addEventListener("click", () => focusPort(n));
      grid.appendChild(card);
    }

    // 모바일 안정성을 위해 동시성 조금 낮춤
    const conc = window.innerWidth <= 680 ? 6 : 12;

    await mapLimit(nums, conc, async (num) => {
      const [p, v] = await Promise.all([readContract.port(num), readContract.getvalue(num)]);

      const card = grid.querySelector(`.port-card[data-port="${num}"]`);
      if (!card) return;

      const owner = p.owner;
      const ownerEl = card.querySelector(".port-owner");
      if (ownerEl) ownerEl.textContent = owner && owner !== ethers.ZeroAddress ? shortAddr(owner) : "빈포트";

      const baseImg = card.querySelector("img.tree-base");
      if (baseImg) baseImg.src = getStageImg(owner, v, p.depo);

      const mini = card.querySelectorAll(".mini-row .val");
      if (mini && mini.length >= 3) {
        mini[0].textContent = fmtHex(p.depo, 3);
        mini[1].textContent = String(p.depon);
        mini[2].textContent = fmtHex(v, 3);

        mini[0].classList.add("onchain-soft");
        mini[1].classList.add("onchain-soft");
        mini[2].classList.add("onchain-soft");
      }
    });

    if (account && $("myPortsBox")) {
      try {
        await scanMyPorts(false);
      } catch {}
    }
  };

  // =========================
  // Scan my ports (readContract 기반)
  // =========================
  const scanMyPorts = async (showMsg = true) => {
    if (!account) throw new Error("지갑 연결 필요");

    const remain = Number(await readContract.remain());
    const nums = Array.from({ length: remain }, (_, i) => i + 1);

    if (showMsg) setNote("myPortsBox", "내 포트 검색중…");

    const mine = [];
    const conc = window.innerWidth <= 680 ? 6 : 12;

    await mapLimit(nums, conc, async (n) => {
      const p = await readContract.port(n);
      if (p.owner && p.owner.toLowerCase() === account.toLowerCase()) mine.push(n);
    });

    mine.sort((a, b) => a - b);

    let totalValueWei = 0n;
    if (mine.length > 0) {
      try {
        const values = await mapLimit(mine, 6, async (n) => {
          const v = await readContract.getvalue(n);
          return BigInt(v ?? 0n);
        });
        totalValueWei = values.reduce((acc, v) => acc + v, 0n);
      } catch {
        totalValueWei = 0n;
      }
    }

    const totalBox = $("myPortsTotal");
    if (totalBox) {
      const vEl = totalBox.querySelector(".v");
      const sEl = totalBox.querySelector(".s");

      if (mine.length === 0) {
        if (vEl) vEl.textContent = "0 HEX";
        if (sEl) sEl.textContent = "현재 내 소유 포트가 없습니다.";
      } else {
        if (vEl) vEl.textContent = fmtHex(totalValueWei, 4);
        if (sEl) sEl.textContent = `내 포트 ${mine.length}개 가치 합산 (getvalue 기준)`;
        if (vEl) vEl.classList.add("onchain");
      }
    }

    const box = $("myPortsBox");
    if (box) {
      if (mine.length === 0) {
        box.textContent = "내 포트: 없음";
      } else {
        box.innerHTML = `
          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
            <span style="opacity:.75;">내 포트 (${mine.length})</span>
            ${mine.map((n) => `<button class="chip mono" data-myport="${n}" style="cursor:pointer;">#${n}</button>`).join("")}
          </div>
        `;

        box.querySelectorAll("[data-myport]").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const n = Number(btn.getAttribute("data-myport"));
            focusPort(n);
            await readPortToPanel();
          });
        });
      }
    }

    const grid = $("portsGrid");
    if (grid) {
      grid.querySelectorAll(".port-card").forEach((c) => c.classList.remove("mine"));
      for (const n of mine) {
        const card = grid.querySelector(`.port-card[data-port="${n}"]`);
        if (card) card.classList.add("mine");
      }
    }

    return mine;
  };

  // =========================
  // Refresh all (조회는 항상 됨)
  // =========================
  const refreshAll = async () => {
    const { remain } = await refreshSummary();
    await renderPorts(remain);
  };

  // =========================
  // UI bindings
  // =========================
  const bindUI = () => {
    $("btnConnect")?.addEventListener("click", async () => {
      try {
        await ensureConnected();
        refreshHeaderBadges();
        setNote("noteBox", `연결됨 (HEX: ${shortAddr(HEX_ADDRESS)})`);
        await refreshAll();
      } catch (e) {
        setNote("noteBox", parseEthersError(e));
      }
    });

    $("btnRefresh")?.addEventListener("click", async () => {
      try {
        await refreshAll();
        setNote("noteBox", account ? "새로고침 완료" : "조회 새로고침 완료 (지갑 없이 조회)");
      } catch (e) {
        setNote("noteBox", parseEthersError(e));
      }
    });

    $("btnReadPort")?.addEventListener("click", async () => {
      try {
        await readPortToPanel();
        setNote("txBox", "조회 완료");
      } catch (e) {
        setNote("txBox", parseEthersError(e));
      }
    });

    $("btnMyPorts")?.addEventListener("click", async () => {
      try {
        await scanMyPorts(true);
      } catch (e) {
        setNote("myPortsBox", parseEthersError(e));
      }
    });

    $("btnSeeding")?.addEventListener("click", async () => {
      try {
        if (!writeContract) throw new Error("지갑 연결 필요");
        setNote("txBox", "랜덤 심기 tx 전송중…");
        soundPlant();

        const tx = await writeContract.seeding();
        setNote("txBox", `tx: ${tx.hash} (확정 대기중…)`);

        const receipt = await tx.wait();
        const winnum = getFarmnumFromReceipt(receipt);

        if (winnum) {
          soundLand();
          setNote("txBox", `랜덤 심기 완료: PORT #${winnum} 에 씨앗을 심었습니다.`);
          focusPort(winnum);
          await readPortToPanel();
        } else {
          soundSuccess();
          setNote("txBox", `랜덤 심기 완료. tx: ${tx.hash}`);
        }

        await refreshAll();
      } catch (e) {
        setNote("txBox", parseEthersError(e));
      }
    });

    $("btnChoice")?.addEventListener("click", async () => {
      try {
        if (!writeContract) throw new Error("지갑 연결 필요");
        const n = Number($("inChoiceNum")?.value || 0);
        if (!n) throw new Error("지정 포트 번호 필요");
        soundPlant();

        const tx = await writeContract.choice(n);
        setNote("txBox", `지정 심기 tx: ${tx.hash}`);
        await tx.wait();

        soundLand();
        setNote("txBox", `지정 심기 완료: PORT #${n} 에 심었습니다.`);
        focusPort(n);
        await readPortToPanel();
        await refreshAll();
      } catch (e) {
        setNote("txBox", parseEthersError(e));
      }
    });

    $("btnWithdraw")?.addEventListener("click", async () => {
      try {
        if (!writeContract) throw new Error("지갑 연결 필요");
        const tx = await writeContract.withdraw();
        setNote("txBox", `출금 tx: ${tx.hash}`);
      } catch (e) {
        setNote("txBox", parseEthersError(e));
      }
    });

    $("btnCharge")?.addEventListener("click", async () => {
      try {
        if (!writeContract || !account) throw new Error("지갑 연결 필요");

        const amt = String($("inCharge")?.value || "").trim();
        if (!amt) throw new Error("충전 수량 필요");
        const wei = ethers.parseUnits(amt, 18);

        const alw = await readHexToken.allowance(account, CONTRACT_ADDRESS);
        if (alw < wei) {
          setNote("txBox", "승인 진행중… (지갑에서 확인해주세요)");
          await approveHexAndWait(wei);
          setNote("txBox", "승인 완료. 충전 진행중…");
        }

        const tx = await writeContract.charge(wei);
        setNote("txBox", `충전 tx: ${tx.hash} (확정 대기중…)`);
        await tx.wait();
        soundSuccess();
        setNote("txBox", "충전 완료!");
        await refreshSummary();
      } catch (e) {
        setNote("txBox", parseEthersError(e));
      }
    });

    $("btnBuyTicket")?.addEventListener("click", async () => {
      try {
        if (!writeContract || !account) throw new Error("지갑 연결 필요");

        const qty = Number($("inTicketQty")?.value || 0);
        if (!qty) throw new Error("티켓 수량 필요");

        const priceWei = await readContract.TICKET_PRICE();
        const need = BigInt(qty) * BigInt(priceWei);

        const alw = await readHexToken.allowance(account, CONTRACT_ADDRESS);
        if (alw < need) {
          setNote("txBox", "승인 진행중… (지갑에서 확인해주세요)");
          await approveHexAndWait(need);
          setNote("txBox", "승인 완료. 티켓 구매 진행중…");
        }

        const tx = await writeContract.buyTicket(qty);
        setNote("txBox", `티켓 구매 tx: ${tx.hash} (확정 대기중…)`);
        await tx.wait();
        soundSuccess();
        setNote("txBox", `티켓 ${qty}장 구매 완료!`);
        await refreshSummary();
      } catch (e) {
        setNote("txBox", parseEthersError(e));
      }
    });
  };

  // =========================
  // init
  // =========================
  bindUI();
  refreshHeaderBadges();

  // 모바일/PC 공통: 첫 화면에서 일단 "조회"는 무조건 실행
  (async () => {
    try {
      await refreshAll();
      setNote("noteBox", "조회 모드로 로딩 완료 (지갑 연결하면 실행 가능)");
    } catch (e) {
      setNote("noteBox", `조회 실패: ${parseEthersError(e)}`);
    }
  })();

  // 자동 연결(권한 이미 준 경우만, MetaMask/Rabby)
  ;(async () => {
    try {
      if (!window.ethereum) return;
      const accs = await window.ethereum.request({ method: "eth_accounts" });
      if (!accs || accs.length === 0) return;
      await ensureConnected();
      refreshHeaderBadges();
      setNote("noteBox", `자동 연결됨: ${shortAddr(account)}`);
      await refreshAll();
    } catch (e) {
      // 자동 연결은 실패해도 조회는 이미 돌아가므로 에러만 표시
      setNote("noteBox", `자동 연결 실패(조회는 정상): ${parseEthersError(e)}`);
    }
  })();

  // Google 로그인(Jump 수탁 지갑) 연결 완료 이벤트
  window.addEventListener("jump:connected", async () => {
    try {
      console.log("[MKT] jump:connected → jumpWallet:", window.jumpWallet);
      await ensureConnected();
      refreshHeaderBadges();
      setNote("noteBox", `수탁 지갑 연결됨 (Jump): ${shortAddr(account)}`);
      await refreshAll();
    } catch (e) {
      console.error("[MKT] Jump 연결 실패:", e);
      setNote("noteBox", `Jump 연결 실패: ${parseEthersError(e)}`);
    }
  });
})();
