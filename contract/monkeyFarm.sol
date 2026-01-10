// SPDX-License-Identifier: MIT
// monkeyFarm ver1.2.4 (ticket purchase added: 0.5 HEX per ticket)
pragma solidity ^0.8.20;

interface IERC20 {
  function transfer(address to, uint256 amount) external returns (bool);
  function transferFrom(address from, address to, uint256 amount) external returns (bool);
  function balanceOf(address account) external view returns (uint256);
  function allowance(address owner, address spender) external view returns (uint256);
  function approve(address spender, uint256 amount) external returns (bool);
}

interface Imktbank {
  function totalfeeup(uint256 amount) external;
}

contract monkeyTree{
  IERC20 public immutable HEX;
  Imktbank public mktbank;

  address public admin;
  uint256 public price;     // 씨앗가격 (HEX wei)
  uint8 public remain;      // 1~remain
  uint256 public tax;       // 세금 누적(HEX wei)
  uint8 public rate;        // 기본 차감

  mapping(uint => tree) public port;     // pot number => tree
  uint256[] public pl;                  // 거래/턴 기록
  mapping(address => uint) public mypay;    // 충전금 (내부 잔액)
  mapping(address => uint) public mytiket;  // 티켓
  mapping(address => uint) public allowt;   // 마지막 charge/withdraw 타임스탬프(개인 쿨다운)

  // =========================
  // Daily withdraw cap (global)
  // =========================
  uint256 public dayStart;        // 하루 시작 시각(24h 기준)
  uint256 public dayBalance;      // 하루 시작 시점 컨트랙트 HEX 잔고 스냅샷
  uint256 public withdrawnToday;  // 오늘(전역) 출금 누적

  // =========================
  // Ticket sale
  // =========================
  uint256 public constant TICKET_PRICE = 5e17; // 0.5 HEX (18dec)
  event TicketBought(address indexed who, uint256 qty, uint256 payWei);

  event farmnum(uint winnum);

  constructor(address _mktbank, address hexToken) {
    require(_mktbank != address(0), "bank=0");
    require(hexToken != address(0), "hex=0");

    mktbank = Imktbank(_mktbank);
    HEX = IERC20(hexToken);

    admin = msg.sender;
    remain = 100; //포트개수
    price = 10 * 1e18;
    mytiket[msg.sender] = 100;
    rate = 5; //기본값 

    // daily cap init
    dayStart = block.timestamp;
    dayBalance = HEX.balanceOf(address(this));
    withdrawnToday = 0;
  }

  struct tree {
    uint256 depo;
    uint256 depon;   // pl index snapshot
    uint256 portn;   // pot number
    address owner;
  }

  // 티켓 구매: 1장당 0.5 HEX
  // 사전에 HEX.approve(this, qty*TICKET_PRICE) 필요
  function buyTicket(uint256 qty) external {
    require(qty > 0, "qty=0");
    uint256 pay = qty * TICKET_PRICE;

    require(HEX.balanceOf(msg.sender) >= pay, "no HEX");
    require(HEX.allowance(msg.sender, address(this)) >= pay, "allowance low");

    bool ok = HEX.transferFrom(msg.sender, address(this), pay);
    require(ok, "transferFrom fail");

    mytiket[msg.sender] += qty;

    emit TicketBought(msg.sender, qty, pay);
  }

  function seeding() public {
    uint winnum = ranmod();
    emit farmnum(winnum);

    require(mypay[msg.sender] >= price, "not enough seed");
    mypay[msg.sender] -= price;

    mytiket[msg.sender] += 1;
    pl.push(winnum);

    address prevOwner = port[winnum].owner;
    if (prevOwner != address(0) && port[winnum].depo > 0) {
      uint jack = (port[winnum].depo * getbonus(winnum)) / 100;
      mypay[prevOwner] += jack;
    }

    port[winnum].depo = price;
    port[winnum].depon = pllength();
    port[winnum].portn = winnum;
    port[winnum].owner = msg.sender;

    tax += (price * 3) / 100;
  }

  function choice(uint8 winnum) public {
    require(mytiket[msg.sender] >= 10, "not enough tickets");
    require(winnum >= 1 && winnum <= remain, "Out of range");
    require(mypay[msg.sender] >= price, "not enough seed");

    mypay[msg.sender] -= price;
    mytiket[msg.sender] -= 10;

    pl.push(winnum);

    address prevOwner = port[winnum].owner;
    if (prevOwner != address(0) && port[winnum].depo > 0) {
      uint jack = (port[winnum].depo * getbonus(winnum)) / 100;
      mypay[prevOwner] += jack;
    }

    port[winnum].depo = price;
    port[winnum].depon = pllength();
    port[winnum].portn = winnum;
    port[winnum].owner = msg.sender;

    tax += (price * 3) / 100;
  }

  function remainup(uint8 _remain) public {
    require(admin == msg.sender, "no admin");
    require(_remain >= 1, "remain=0");
    remain = _remain;
  }

  function priceup(uint256 _price) public {
    require(admin == msg.sender, "no admin");
    require(_price > 0, "price=0");
    price = _price;
  }

  function rateup(uint8 _rate) public {
    require(admin == msg.sender, "no admin");
    require(_rate <= 100, "rate>100");
    rate = _rate;
  }

  // 사용자가 미리 HEX.approve(this, pay) 해둔 뒤 호출
  function charge(uint256 pay) public {
    require(pay > 0, "pay=0");
    require(HEX.balanceOf(msg.sender) >= pay, "no HEX");

    uint256 allowance = HEX.allowance(msg.sender, address(this));
    require(allowance >= pay, "Check the token allowance");

    bool ok = HEX.transferFrom(msg.sender, address(this), pay);
    require(ok, "transferFrom failed");

    mypay[msg.sender] += pay;

    // 개인 쿨다운 기준 시각 업데이트
    allowt[msg.sender] = block.timestamp;
  }

  // 내부: 하루(전역) 출금 한도 리셋 체크
  function _rollDayIfNeeded() internal {
    if (block.timestamp >= dayStart + 1 days) {
      dayStart = block.timestamp;
      dayBalance = HEX.balanceOf(address(this));
      withdrawnToday = 0;
    }
  }

  // 오늘 전역 출금 한도(스냅샷 잔고 기준): dayBalance / 10
  function dailyCap() public view returns (uint256) {
    return dayBalance / 10;
  }

  function withdraw() public {
    _rollDayIfNeeded();

    // 내부 잔액의 10%씩 출금
    uint pay = mypay[msg.sender] / 10;

    require(pay >= 1e18, "no pay");
    require(g1() >= pay, "no HEX");

    // 개인 쿨다운: 1일 1회
    require(block.timestamp >= allowt[msg.sender] + 1 days, "cooldown 1d");

    // 전역 하루 출금 한도: 컨트랙트 잔고(스냅샷) / 10
    uint256 cap = dayBalance / 10;
    require(cap > 0, "daily cap=0");
    require(withdrawnToday + pay <= cap, "daily cap exceeded");

    bool ok = HEX.transfer(msg.sender, pay);
    require(ok, "transfer failed");

    withdrawnToday += pay;

    // tax가 충분히 쌓였을 때만 bank로 전송 + 기록
    if (tax > 10e18) {
      bool ok2 = HEX.transfer(address(mktbank), tax);
      require(ok2, "tax transfer failed");
      mktbank.totalfeeup(tax);
      tax = 0;
    }

    mypay[msg.sender] -= pay;
    allowt[msg.sender] = block.timestamp;
  }

  function ranmod() internal view returns (uint256) {
    uint256 winnum =
      (uint256(keccak256(abi.encodePacked(block.timestamp, blockhash(block.number - 1), msg.sender)))
        % remain) + 1;
    return winnum;
  }

  function getbonus(uint _win) public view returns (uint) {
    return (pllength() - port[_win].depon) + (100 - rate);
  }

  function pllength() public view returns (uint) {
    return pl.length;
  }

  function getpl(uint num) public view returns (uint) {
    return pl[num];
  }

  function getvalue(uint num) public view returns (uint) {
    return (price * (pllength() - port[num].depon + 100)) / 100;
  }

  function getmyfarm(uint num) public view returns (uint) {
    require(port[num].owner == msg.sender, "not owner");
    return port[num].portn;
  }

  function g1() public view virtual returns (uint256) {
    return HEX.balanceOf(address(this));
  }
}
