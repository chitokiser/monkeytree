// /assets/js/index.js
(() => {
  const ethers = window.ethers;

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

    // event
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
  // Images
  // =========================
  const IMG = {
    empty: "assets/img/tree/seed.png",   // 화분(빈포트 / 방금심음)
    sprout: "assets/img/tree/seed2.png", // 새싹
    tree: "assets/img/tree/seed3.png",   // 나무
    fruit: "assets/img/tree/hex.png",    // 열매(HEX)
  };

  const OPBNB = {
  chainId: "0xCC", // 204
  chainName: "opBNB Mainnet",
  nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
  rpcUrls: ["https://opbnb-mainnet-rpc.bnbchain.org"],
  blockExplorerUrls: ["https://opbnbscan.com"],
};

async function ensureOpBNB() {
  if (!window.ethereum) throw new Error("지갑(메타마스크) 없음");

  const cur = await window.ethereum.request({ method: "eth_chainId" });
  if (cur && cur.toLowerCase() === OPBNB.chainId.toLowerCase()) return;

  // 1) 우선 체인 전환 시도
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: OPBNB.chainId }],
    });
    return;
  } catch (e) {
    // 2) 체인이 없으면 추가 후 전환
    // Metamask: 4902 = Unknown chain
    if (e?.code !== 4902) throw e;
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [OPBNB],
    });
    // add 후 switch는 지갑이 알아서 되거나, 필요시 다시 switch 호출
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

  // 온체인 네온 표기
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
  // 성장 판단 (value/depo 기준)
  // - 방금 심은 상태: value <= depo => seed1(화분)만
  // =========================
  const getStageByValue = (owner, valueWei, depoWei) => {
    // 빈포트: owner 0 이거나 depo 0이면 seed1(화분)만
    if (!owner || owner === ethers.ZeroAddress) return { base: IMG.empty, fruits: 0 };
    if (!depoWei || BigInt(depoWei) === 0n) return { base: IMG.empty, fruits: 0 };

    const v = BigInt(valueWei ?? 0n);
    const d = BigInt(depoWei ?? 0n);

    // 방금 심은 상태(또는 value가 아직 안 커짐)
    if (v <= d) return { base: IMG.empty, fruits: 0 };

    // r100 = (value/depo)*100
    const r100 = (v * 100n) / d;

    // seed2(새싹) / seed3(나무) + 열매 단계
    if (r100 < 120n) return { base: IMG.sprout, fruits: 0 }; // 1.00~1.19배
    if (r100 < 150n) return { base: IMG.tree, fruits: 0 };
    if (r100 < 180n) return { base: IMG.tree, fruits: 1 };
    if (r100 < 220n) return { base: IMG.tree, fruits: 2 };
    if (r100 < 260n) return { base: IMG.tree, fruits: 3 };
    return { base: IMG.tree, fruits: 4 };
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
  // Web3 state
  // =========================
  let provider = null;
  let signer = null;
  let contract = null;
  let account = null;

  let hexToken = null;
  let HEX_ADDRESS = null;

  // event parser
  const iface = new ethers.Interface(ABI);

  const refreshHeaderBadges = () => {
    setText("addrBadge", account ? `지갑: ${shortAddr(account)}` : "지갑: 미연결");
    setText("netBadge", "네트워크: opBNB");
  };

  const ensureConnected = async () => {
    if (!window.ethereum) throw new Error("지갑(메타마스크) 없음");
   await ensureOpBNB();
    provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send("eth_requestAccounts", []);
    signer = await provider.getSigner();
    account = await signer.getAddress();

    contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);

    // HEX 주소 자동 로딩
    HEX_ADDRESS = await contract.HEX();
    hexToken = new ethers.Contract(HEX_ADDRESS, ERC20_ABI, signer);

    return { provider, signer, contract, account, hexToken, HEX_ADDRESS };
  };

  // =========================
  // Summary (onchain values)
  // =========================
  const refreshSummary = async () => {
    if (!contract) return;

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
      contract.price(),
      contract.remain(),
      contract.rate(),
      contract.tax(),
      contract.pllength(),
      contract.g1(),
      contract.dailyCap(),
      contract.withdrawnToday(),
      contract.dayBalance(),
    ]);

    setText("updatedAt", new Date().toLocaleString());

    // 온체인 값은 네온
    setOnchain("mPrice", fmtHex(priceWei, 4));
    setOnchain("mRemain", String(remain));
    setOnchain("mRate", String(rate));
    setOnchain("mTax", fmtHex(taxWei, 4));
    setOnchain("mPlLen", String(plLen));
    setOnchain("mCxHex", fmtHex(cxHexWei, 4));
    setOnchain("mDailyCap", fmtHex(dailyCapWei, 4));
    setOnchain("mWithdrawnToday", fmtHex(withdrawnTodayWei, 4));
    setOnchain("mDayBalance", fmtHex(dayBalanceWei, 4));

    if (account && hexToken) {
      const [myPayWei, myTickets, allowt, myHexWei] = await Promise.all([
        contract.mypay(account),
        contract.mytiket(account),
        contract.allowt(account),
        hexToken.balanceOf(account),
      ]);

      setOnchain("mMyPay", fmtHex(myPayWei, 4), true);
      setOnchain("mMyTickets", String(myTickets), true);
      setOnchain("mAllowt", fmtTs(allowt), true);
      setOnchain("mMyHex", fmtHex(myHexWei, 4), true);
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
    const [p, v] = await Promise.all([contract.port(n), contract.getvalue(n)]);

    setText("portChip", `port: ${n}`);
    setOnchain("pOwner", p.owner && p.owner !== ethers.ZeroAddress ? p.owner : "-", true);
    setOnchain("pDepo", fmtHex(p.depo, 4), true);
    setOnchain("pDepon", String(p.depon), true);
    setOnchain("pValue", fmtHex(v, 4), true);
  };

  // =========================
  // Approve helper
  // =========================
  const approveHexAndWait = async (amountWei) => {
    if (!hexToken) throw new Error("HEX 토큰 연결 안됨");

    const cur = await hexToken.allowance(account, CONTRACT_ADDRESS);
    if (cur >= amountWei) return { skipped: true, tx: null, allowance: cur };

    const tx = await hexToken.approve(CONTRACT_ADDRESS, amountWei);
    await tx.wait();

    const after = await hexToken.allowance(account, CONTRACT_ADDRESS);
    return { skipped: false, tx, allowance: after };
  };

  // =========================
  // Event parse: farmnum(winnum)
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
      } catch {
        // ignore
      }
    }
    return null;
  };

  // =========================
  // Render ports grid
  // =========================
  const renderPorts = async (remain) => {
    const grid = $("portsGrid");
    if (!grid) return;
    grid.innerHTML = "";

    const nums = Array.from({ length: remain }, (_, i) => i + 1);

    // skeleton
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
          <img class="tree-base" src="${IMG.empty}" alt="tree"/>
          <div class="fruits"></div>
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

    // load
    await mapLimit(nums, 12, async (num) => {
      const [p, v] = await Promise.all([contract.port(num), contract.getvalue(num)]);

      const card = grid.querySelector(`.port-card[data-port="${num}"]`);
      if (!card) return;

      const owner = p.owner;

      const ownerEl = card.querySelector(".port-owner");
      if (ownerEl) ownerEl.textContent = owner && owner !== ethers.ZeroAddress ? shortAddr(owner) : "빈포트";

      // ✅ value/depo 기반 단계
      const { base, fruits } = getStageByValue(owner, v, p.depo);

      const baseImg = card.querySelector("img.tree-base");
      if (baseImg) baseImg.src = base;

      const fruitsWrap = card.querySelector(".fruits");
      if (fruitsWrap) {
        fruitsWrap.innerHTML = "";
        for (let i = 0; i < fruits; i++) {
          const img = document.createElement("img");
          img.src = IMG.fruit;
          img.alt = "fruit";
          fruitsWrap.appendChild(img);
        }
      }

      const mini = card.querySelectorAll(".mini-row .val");
      if (mini && mini.length >= 3) {
        mini[0].textContent = fmtHex(p.depo, 3);
        mini[1].textContent = String(p.depon);
        mini[2].textContent = fmtHex(v, 3);

        // mini도 온체인 네온
        mini[0].classList.add("onchain-soft");
        mini[1].classList.add("onchain-soft");
        mini[2].classList.add("onchain-soft");
      }
    });

    // 렌더 후 내 포트 자동 표시
    if (account && $("myPortsBox")) {
      try {
        await scanMyPorts(false);
      } catch {
        // ignore
      }
    }
  };

  // =========================
  // Scan my ports
  // =========================
  const scanMyPorts = async (showMsg = true) => {
    if (!contract || !account) throw new Error("지갑 연결 필요");

    const remain = Number(await contract.remain());
    const nums = Array.from({ length: remain }, (_, i) => i + 1);

    if (showMsg) setNote("myPortsBox", "내 포트 검색중…");

    const mine = [];
    await mapLimit(nums, 12, async (n) => {
      const p = await contract.port(n);
      if (p.owner && p.owner.toLowerCase() === account.toLowerCase()) mine.push(n);
    });

    mine.sort((a, b) => a - b);

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

    // highlight cards
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
      } catch (e) {
        setNote("noteBox", parseEthersError(e));
      }
    });

    $("btnReadPort")?.addEventListener("click", async () => {
      try {
        if (!contract) await ensureConnected();
        await readPortToPanel();
        setNote("txBox", "조회 완료");
      } catch (e) {
        setNote("txBox", parseEthersError(e));
      }
    });

    $("btnMyPorts")?.addEventListener("click", async () => {
      try {
        if (!contract) await ensureConnected();
        await scanMyPorts(true);
      } catch (e) {
        setNote("myPortsBox", parseEthersError(e));
      }
    });

    // seeding: farmnum 이벤트로 포트번호 출력
    $("btnSeeding")?.addEventListener("click", async () => {
      try {
        if (!contract) await ensureConnected();

        setNote("txBox", "랜덤 심기 tx 전송중…");
        const tx = await contract.seeding();
        setNote("txBox", `tx: ${tx.hash} (확정 대기중…)`);

        const receipt = await tx.wait();

        const winnum = getFarmnumFromReceipt(receipt);
        if (winnum) {
          setNote("txBox", `랜덤 심기 완료: PORT #${winnum} 에 씨앗을 심었습니다.`);
          focusPort(winnum);
          await readPortToPanel();
        } else {
          setNote("txBox", `랜덤 심기 완료. (farmnum 이벤트를 찾지 못함) tx: ${tx.hash}`);
        }

        await refreshAll();
      } catch (e) {
        setNote("txBox", parseEthersError(e));
      }
    });

    $("btnChoice")?.addEventListener("click", async () => {
      try {
        if (!contract) await ensureConnected();
        const n = Number($("inChoiceNum")?.value || 0);
        if (!n) throw new Error("지정 포트 번호 필요");

        const tx = await contract.choice(n);
        setNote("txBox", `지정 심기 tx: ${tx.hash}`);
        await tx.wait();

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
        if (!contract) await ensureConnected();
        const tx = await contract.withdraw();
        setNote("txBox", `출금 tx: ${tx.hash}`);
      } catch (e) {
        setNote("txBox", parseEthersError(e));
      }
    });

    $("btnCharge")?.addEventListener("click", async () => {
      try {
        if (!contract) await ensureConnected();

        const amt = String($("inCharge")?.value || "").trim();
        if (!amt) throw new Error("충전 수량 필요");

        const wei = ethers.parseUnits(amt, 18);

        const alw = await hexToken.allowance(account, CONTRACT_ADDRESS);
        if (alw < wei) throw new Error("승인이 부족합니다. 먼저 “충전 승인”을 눌러주세요.");

        const tx = await contract.charge(wei);
        setNote("txBox", `충전 tx: ${tx.hash}`);
      } catch (e) {
        setNote("txBox", parseEthersError(e));
      }
    });

    $("btnBuyTicket")?.addEventListener("click", async () => {
      try {
        if (!contract) await ensureConnected();

        const qty = Number($("inTicketQty")?.value || 0);
        if (!qty) throw new Error("티켓 수량 필요");

        const tx = await contract.buyTicket(qty);
        setNote("txBox", `티켓 구매 tx: ${tx.hash}`);
      } catch (e) {
        setNote("txBox", parseEthersError(e));
      }
    });

    $("btnApproveCharge")?.addEventListener("click", async () => {
      try {
        if (!contract) await ensureConnected();

        const amt = String($("inCharge")?.value || "").trim();
        if (!amt) throw new Error("충전 수량 필요");

        const wei = ethers.parseUnits(amt, 18);

        setNote("txBox", "충전 승인 진행중…");
        const res = await approveHexAndWait(wei);

        if (res.skipped) {
          setNote("txBox", `충전 승인 스킵(이미 충분). allowance=${fmtHex(res.allowance, 4)}`);
        } else {
          setNote("txBox", `충전 승인 완료. allowance=${fmtHex(res.allowance, 4)}`);
        }
      } catch (e) {
        setNote("txBox", parseEthersError(e));
      }
    });

    $("btnApproveTicket")?.addEventListener("click", async () => {
      try {
        if (!contract) await ensureConnected();

        const qty = Number($("inTicketQty")?.value || 0);
        if (!qty) throw new Error("티켓 수량 필요");

        const priceWei = await contract.TICKET_PRICE();
        const need = BigInt(qty) * BigInt(priceWei);

        setNote("txBox", "티켓 구매 승인 진행중…");
        const res = await approveHexAndWait(need);

        if (res.skipped) {
          setNote("txBox", `티켓 승인 스킵(이미 충분). allowance=${fmtHex(res.allowance, 4)}`);
        } else {
          setNote("txBox", `티켓 구매 승인 완료. allowance=${fmtHex(res.allowance, 4)}`);
        }
      } catch (e) {
        setNote("txBox", parseEthersError(e));
      }
    });
  };

  // =========================
  // Refresh all
  // =========================
  const refreshAll = async () => {
    if (!contract) return;
    const { remain } = await refreshSummary();
    await renderPorts(remain);
  };

  // =========================
  // init
  // =========================
  bindUI();
  refreshHeaderBadges();

  // auto connect if already connected
  (async () => {
    try {
      if (!window.ethereum) return;
      const accs = await window.ethereum.request({ method: "eth_accounts" });
      if (!accs || accs.length === 0) return;

      await ensureConnected();
      refreshHeaderBadges();
      await refreshAll();
    } catch {
      // ignore
    }
  })();
})();
