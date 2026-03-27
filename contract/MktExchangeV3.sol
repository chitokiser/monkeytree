// /contracts/MktExchangeV3.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * MktExchangeV3
 *
 * V2 대비 변경점:
 *   1. 거래 체결 시 자동으로 VWAP 계산 → marketPrice 갱신 (봇 불필요)
 *   2. 최근 VWAP_WINDOW 건의 거래를 원형 버퍼(ring buffer)에 저장
 *   3. VWAP 가 현재 가격과 MIN_UPDATE_BPS(0.5%) 이상 차이날 때만 업데이트
 *   4. 어드민은 여전히 setMarketPrice() 로 수동 오버라이드 가능
 *   5. getVwapInfo() 뷰 함수로 프론트엔드에서 버퍼 현황 조회 가능
 *
 * 가격 조작 방어 (Anti-Manipulation):
 *   A. 셀프 체결 금지: fillLimitBuy/fillLimitSell 에서 maker == msg.sender 차단
 *   B. VWAP 변동폭 제한: 한 번의 업데이트로 MAX_VWAP_MOVE_BPS(5%) 이상 움직이지 않음
 *      → 다른 지갑으로 조작해도 한 번에 5% 씩만 오르므로 공격 비용이 매우 큼
 */

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
}

contract MktExchangeV3 {

    /* ===================== Constants ===================== */

    uint256 public constant BPS           = 10_000;
    uint256 public constant FEE_BPS       = 300;   // 3%

    // VWAP 자동 업데이트 파라미터
    uint256 public constant VWAP_WINDOW      = 20;    // 최근 N 건
    uint256 public constant MIN_UPDATE_BPS   = 50;    // 0.5% 이상 차이날 때만 반영

    // 가격 조작 방어 파라미터
    uint256 public constant MAX_VWAP_MOVE_BPS  = 500;  // VWAP 한 번 업데이트 시 최대 ±5% 변동 허용

    /* ===================== Tokens ===================== */

    IERC20 public immutable mkt;
    IERC20 public immutable quoteToken;

    /* ===================== Admin ===================== */

    address public admin;
    address public feeRecipient;

    // 0 = 거래 중지, 1 = 시장가만, 2 = 시장가 + 지정가
    uint8 public act;

    // 시장가 기준 가격: quote wei per 1 MKT (단위는 V2와 동일)
    uint256 public marketPrice;

    /* ===================== Reserve Accounting ===================== */

    uint256 public reservedQuote;   // 지정가 매수 에스크로
    uint256 public reservedMkt;     // 지정가 매도 에스크로
    uint256 public totalFeeQuote;   // 누적 수수료

    /* ===================== VWAP Ring Buffer ===================== */

    struct TradeSlot {
        uint128 mktAmt;    // 체결된 MKT 수량 (wei)
        uint128 quoteAmt;  // 체결된 grossQuote  (wei)
    }

    TradeSlot[VWAP_WINDOW] private _tradeRing;
    uint256 private _ringHead;   // 다음 쓰기 위치
    uint256 private _ringCount;  // 현재 채워진 슬롯 수

    /* ===================== Reentrancy Guard ===================== */

    uint256 private _unlocked = 1;

    modifier nonReentrant() {
        require(_unlocked == 1, "REENTRANT");
        _unlocked = 2;
        _;
        _unlocked = 1;
    }

    modifier onlyAdmin() {
        require(msg.sender == admin, "NO_ADMIN");
        _;
    }

    modifier onlyActive(uint8 minAct) {
        require(act >= minAct, "NOT_ACTIVE");
        _;
    }

    /* ===================== Orders ===================== */

    enum Side { Buy, Sell }

    struct Order {
        uint256 id;
        address maker;
        Side    side;
        uint256 price;      // quote wei per 1 MKT
        uint256 amount;     // original MKT amount
        uint256 remaining;  // remaining MKT amount
        bool    active;
    }

    uint256 public nextOrderId = 1;
    mapping(uint256 => Order) public orders;

    /* ===================== Events ===================== */

    event AdminTransferred(address indexed prevAdmin, address indexed nextAdmin);
    event FeeRecipientUpdated(address indexed prevRecipient, address indexed nextRecipient);
    event ActUpdated(uint8 prevAct, uint8 nextAct);
    event MarketPriceUpdated(uint256 prevPrice, uint256 nextPrice);  // 수동 또는 자동 모두 emit

    event MarketBuy(
        address indexed user,
        uint256 mktAmount,
        uint256 grossQuote,
        uint256 feeQuote,
        uint256 totalQuotePaid
    );
    event MarketSell(
        address indexed user,
        uint256 mktAmount,
        uint256 grossQuote,
        uint256 feeQuote,
        uint256 netQuoteReceived
    );
    event LimitOrderPlaced(
        uint256 indexed orderId,
        address indexed maker,
        Side    side,
        uint256 price,
        uint256 amount
    );
    event LimitOrderCancelled(
        uint256 indexed orderId,
        address indexed maker,
        uint256 refundMkt,
        uint256 refundQuote
    );
    event LimitBuyFilled(
        uint256 indexed orderId,
        address indexed maker,
        address indexed seller,
        uint256 amountFilled,
        uint256 price,
        uint256 grossQuote,
        uint256 feeQuote
    );
    event LimitSellFilled(
        uint256 indexed orderId,
        address indexed maker,
        address indexed buyer,
        uint256 amountFilled,
        uint256 price,
        uint256 grossQuote,
        uint256 feeQuote
    );
    event MarketLiquidityAdded(address indexed by, uint256 mktAmount, uint256 quoteAmount);
    event MarketLiquidityRemoved(address indexed to, uint256 mktAmount, uint256 quoteAmount);

    /* ===================== Constructor ===================== */

    constructor(
        address _mkt,
        address _quoteToken,
        address _feeRecipient,
        uint256 _initialMarketPrice,
        uint8   _act
    ) {
        require(_mkt            != address(0), "MKT_ZERO");
        require(_quoteToken     != address(0), "QUOTE_ZERO");
        require(_feeRecipient   != address(0), "FEE_ZERO");
        require(_initialMarketPrice > 0,       "PRICE_ZERO");

        mkt          = IERC20(_mkt);
        quoteToken   = IERC20(_quoteToken);
        admin        = msg.sender;
        feeRecipient = _feeRecipient;
        marketPrice  = _initialMarketPrice;
        act          = _act;
    }

    /* ===================== Internal Token Helpers ===================== */

    function _safeTransfer(IERC20 token, address to, uint256 amount) internal {
        if (amount == 0) return;
        require(token.transfer(to, amount), "TRANSFER_FAIL");
    }

    function _safeTransferFrom(IERC20 token, address from, address to, uint256 amount) internal {
        if (amount == 0) return;
        require(token.transferFrom(from, to, amount), "TRANSFER_FROM_FAIL");
    }

    function _grossQuote(uint256 mktAmount, uint256 price) internal pure returns (uint256) {
        return mktAmount * price;
    }

    function _fee(uint256 gross) internal pure returns (uint256) {
        return (gross * FEE_BPS) / BPS;
    }

    /* ===================== VWAP Auto-Update (내부) ===================== */

    /**
     * 거래 체결 후 호출: 원형 버퍼에 기록 → VWAP 재계산 → 조건 충족 시 marketPrice 갱신
     *
     * 방어 구조:
     *   [방어 A] 셀프 체결 금지 — fillLimitBuy/fillLimitSell 에서 차단 (이미 적용)
     *   [방어 C] VWAP 변동폭 클램핑 — 1회 업데이트 최대 ±MAX_VWAP_MOVE_BPS(5%)
     *
     * ±20% 이상가 필터(구 방어 B) 제거 이유:
     *   지정가는 사용자가 설정하므로 어드민의 marketPrice 와 차이날 수 있음.
     *   SELF_TRADE 로 셀프 조작은 차단되고, 클램핑으로 급등/급락도 방어하므로
     *   범위 필터는 정상 거래까지 차단하는 부작용만 있었음.
     *
     * @param mktAmt   체결된 MKT 수량 (wei)
     * @param quoteAmt 체결된 grossQuote (wei)
     */
    function _recordTrade(uint256 mktAmt, uint256 quoteAmt) internal {
        uint256 curr = marketPrice;

        // ── 1. 원형 버퍼에 기록 ─────────────────────────────────────────
        _tradeRing[_ringHead] = TradeSlot({
            mktAmt  : uint128(mktAmt),
            quoteAmt: uint128(quoteAmt)
        });
        _ringHead = (_ringHead + 1) % VWAP_WINDOW;
        if (_ringCount < VWAP_WINDOW) _ringCount++;

        // ── 2. VWAP 계산 ────────────────────────────────────────────────
        uint256 start = (_ringCount < VWAP_WINDOW) ? 0 : _ringHead;
        uint256 totalMkt   = 0;
        uint256 totalQuote = 0;

        for (uint256 i = 0; i < _ringCount; i++) {
            uint256 idx = (start + i) % VWAP_WINDOW;
            totalMkt   += uint256(_tradeRing[idx].mktAmt);
            totalQuote += uint256(_tradeRing[idx].quoteAmt);
        }

        if (totalMkt == 0) return;
        uint256 vwap = totalQuote / totalMkt;
        if (vwap == 0) return;

        // ── 3. 최소 변동폭 확인 ─────────────────────────────────────────
        uint256 diff = vwap > curr ? vwap - curr : curr - vwap;
        if (diff * BPS < curr * MIN_UPDATE_BPS) return;

        // ── [방어 C] VWAP 변동폭 클램핑 (+5% / -5%) ──────────────────────
        uint256 maxUp   = curr + curr * MAX_VWAP_MOVE_BPS / BPS;
        uint256 maxDown = curr - curr * MAX_VWAP_MOVE_BPS / BPS;
        if (vwap > maxUp)   vwap = maxUp;
        if (vwap < maxDown) vwap = maxDown;

        // ── 4. 가격 갱신 ────────────────────────────────────────────────
        marketPrice = vwap;
        emit MarketPriceUpdated(curr, vwap);
    }

    /* ===================== View Helpers ===================== */

    function quoteBalance() public view returns (uint256) {
        return quoteToken.balanceOf(address(this));
    }

    function mktBalance() public view returns (uint256) {
        return mkt.balanceOf(address(this));
    }

    function availableQuoteForMarket() public view returns (uint256) {
        uint256 bal = quoteBalance();
        return bal <= reservedQuote ? 0 : bal - reservedQuote;
    }

    function availableMktForMarket() public view returns (uint256) {
        uint256 bal = mktBalance();
        return bal <= reservedMkt ? 0 : bal - reservedMkt;
    }

    function getBuyOrderEscrowNeeded(uint256 mktAmount, uint256 price) public pure returns (uint256) {
        return _grossQuote(mktAmount, price);
    }

    function previewMarketBuy(uint256 mktAmount)
        external view
        returns (uint256 grossQuote, uint256 feeQuote, uint256 totalQuote)
    {
        grossQuote = _grossQuote(mktAmount, marketPrice);
        feeQuote   = _fee(grossQuote);
        totalQuote = grossQuote + feeQuote;
    }

    function previewMarketSell(uint256 mktAmount)
        external view
        returns (uint256 grossQuote, uint256 feeQuote, uint256 netQuote)
    {
        grossQuote = _grossQuote(mktAmount, marketPrice);
        feeQuote   = _fee(grossQuote);
        netQuote   = grossQuote - feeQuote;
    }

    /**
     * VWAP 버퍼 현황 조회 (프론트엔드용)
     * @return count    현재 버퍼에 쌓인 거래 수
     * @return sumMkt   버퍼 내 총 MKT 수량
     * @return sumQuote 버퍼 내 총 grossQuote
     * @return vwap     현재 VWAP (count==0 이면 0)
     */
    function getVwapInfo()
        external view
        returns (uint256 count, uint256 sumMkt, uint256 sumQuote, uint256 vwap)
    {
        count = _ringCount;
        uint256 start = (_ringCount < VWAP_WINDOW) ? 0 : _ringHead;
        for (uint256 i = 0; i < _ringCount; i++) {
            uint256 idx = (start + i) % VWAP_WINDOW;
            sumMkt   += uint256(_tradeRing[idx].mktAmt);
            sumQuote += uint256(_tradeRing[idx].quoteAmt);
        }
        vwap = (sumMkt > 0) ? sumQuote / sumMkt : 0;
    }

    /* ===================== Admin ===================== */

    function transferAdmin(address next) external onlyAdmin {
        require(next != address(0), "ZERO_ADDR");
        address prev = admin;
        admin = next;
        emit AdminTransferred(prev, next);
    }

    function setFeeRecipient(address next) external onlyAdmin {
        require(next != address(0), "ZERO_ADDR");
        address prev = feeRecipient;
        feeRecipient = next;
        emit FeeRecipientUpdated(prev, next);
    }

    function setAct(uint8 nextAct) external onlyAdmin {
        require(nextAct <= 2, "BAD_ACT");
        uint8 prev = act;
        act = nextAct;
        emit ActUpdated(prev, nextAct);
    }

    /// @notice 어드민이 수동으로 시장가 오버라이드 (긴급 조정용)
    function setMarketPrice(uint256 nextPrice) external onlyAdmin {
        require(nextPrice > 0, "PRICE_ZERO");
        uint256 prev = marketPrice;
        marketPrice  = nextPrice;
        emit MarketPriceUpdated(prev, nextPrice);
    }

    function addMarketLiquidity(uint256 mktAmount, uint256 quoteAmount) external onlyAdmin nonReentrant {
        if (mktAmount   > 0) _safeTransferFrom(mkt,        msg.sender, address(this), mktAmount);
        if (quoteAmount > 0) _safeTransferFrom(quoteToken, msg.sender, address(this), quoteAmount);
        emit MarketLiquidityAdded(msg.sender, mktAmount, quoteAmount);
    }

    /// 예약(에스크로)되지 않은 잔고만 인출 가능
    function removeMarketLiquidity(address to, uint256 mktAmount, uint256 quoteAmount)
        external onlyAdmin nonReentrant
    {
        require(to != address(0), "ZERO_ADDR");
        require(mktAmount   <= availableMktForMarket(),   "MKT_RESERVED");
        require(quoteAmount <= availableQuoteForMarket(), "QUOTE_RESERVED");
        _safeTransfer(mkt,        to, mktAmount);
        _safeTransfer(quoteToken, to, quoteAmount);
        emit MarketLiquidityRemoved(to, mktAmount, quoteAmount);
    }

    /* ===================== Market Orders ===================== */

    /**
     * 시장가 매수
     * 체결 후 자동으로 VWAP 갱신
     */
    function marketBuy(uint256 mktAmount, uint256 maxTotalQuote)
        external nonReentrant onlyActive(1)
        returns (bool)
    {
        require(mktAmount > 0,                             "AMOUNT_ZERO");
        require(availableMktForMarket() >= mktAmount,      "INSUFFICIENT_MKT");

        uint256 grossQuote = _grossQuote(mktAmount, marketPrice);
        uint256 feeQuote   = _fee(grossQuote);
        uint256 totalQuote = grossQuote + feeQuote;

        if (maxTotalQuote != 0) require(totalQuote <= maxTotalQuote, "SLIPPAGE");

        _safeTransferFrom(quoteToken, msg.sender, address(this), grossQuote);
        _safeTransferFrom(quoteToken, msg.sender, feeRecipient, feeQuote);
        _safeTransfer(mkt, msg.sender, mktAmount);

        totalFeeQuote += feeQuote;

        emit MarketBuy(msg.sender, mktAmount, grossQuote, feeQuote, totalQuote);

        // ── 자동 VWAP 갱신 ───────────────────────────────────────────────
        _recordTrade(mktAmount, grossQuote);

        return true;
    }

    /**
     * 시장가 매도
     * 체결 후 자동으로 VWAP 갱신
     */
    function marketSell(uint256 mktAmount, uint256 minNetQuote)
        external nonReentrant onlyActive(1)
        returns (bool)
    {
        require(mktAmount > 0, "AMOUNT_ZERO");

        uint256 grossQuote = _grossQuote(mktAmount, marketPrice);
        uint256 feeQuote   = _fee(grossQuote);
        uint256 netQuote   = grossQuote - feeQuote;

        require(availableQuoteForMarket() >= grossQuote, "INSUFFICIENT_QUOTE");
        if (minNetQuote != 0) require(netQuote >= minNetQuote, "SLIPPAGE");

        _safeTransferFrom(mkt, msg.sender, address(this), mktAmount);
        _safeTransfer(quoteToken, msg.sender, netQuote);
        _safeTransfer(quoteToken, feeRecipient, feeQuote);

        totalFeeQuote += feeQuote;

        emit MarketSell(msg.sender, mktAmount, grossQuote, feeQuote, netQuote);

        // ── 자동 VWAP 갱신 ───────────────────────────────────────────────
        _recordTrade(mktAmount, grossQuote);

        return true;
    }

    /* ===================== Limit Orders ===================== */

    function placeLimitBuy(uint256 mktAmount, uint256 pricePerMkt)
        external nonReentrant onlyActive(2)
        returns (uint256 orderId)
    {
        require(mktAmount   > 0, "AMOUNT_ZERO");
        require(pricePerMkt > 0, "PRICE_ZERO");

        uint256 grossQuote = _grossQuote(mktAmount, pricePerMkt);
        _safeTransferFrom(quoteToken, msg.sender, address(this), grossQuote);
        reservedQuote += grossQuote;

        orderId = nextOrderId++;
        orders[orderId] = Order({
            id       : orderId,
            maker    : msg.sender,
            side     : Side.Buy,
            price    : pricePerMkt,
            amount   : mktAmount,
            remaining: mktAmount,
            active   : true
        });

        emit LimitOrderPlaced(orderId, msg.sender, Side.Buy, pricePerMkt, mktAmount);
    }

    function placeLimitSell(uint256 mktAmount, uint256 pricePerMkt)
        external nonReentrant onlyActive(2)
        returns (uint256 orderId)
    {
        require(mktAmount   > 0, "AMOUNT_ZERO");
        require(pricePerMkt > 0, "PRICE_ZERO");

        _safeTransferFrom(mkt, msg.sender, address(this), mktAmount);
        reservedMkt += mktAmount;

        orderId = nextOrderId++;
        orders[orderId] = Order({
            id       : orderId,
            maker    : msg.sender,
            side     : Side.Sell,
            price    : pricePerMkt,
            amount   : mktAmount,
            remaining: mktAmount,
            active   : true
        });

        emit LimitOrderPlaced(orderId, msg.sender, Side.Sell, pricePerMkt, mktAmount);
    }

    function cancelOrder(uint256 orderId) external nonReentrant returns (bool) {
        Order storage o = orders[orderId];
        require(o.active,                                  "NOT_ACTIVE");
        require(o.maker == msg.sender || msg.sender == admin, "NO_AUTH");

        o.active = false;

        uint256 refundQuote = 0;
        uint256 refundMkt   = 0;

        if (o.side == Side.Buy) {
            refundQuote    = _grossQuote(o.remaining, o.price);
            reservedQuote -= refundQuote;
            _safeTransfer(quoteToken, o.maker, refundQuote);
        } else {
            refundMkt    = o.remaining;
            reservedMkt -= refundMkt;
            _safeTransfer(mkt, o.maker, refundMkt);
        }

        o.remaining = 0;
        emit LimitOrderCancelled(orderId, o.maker, refundMkt, refundQuote);
        return true;
    }

    /**
     * 지정가 매수 주문 체결 (seller 가 호출)
     * 체결 후 자동으로 VWAP 갱신
     */
    function fillLimitBuy(uint256 orderId, uint256 mktAmount)
        external nonReentrant onlyActive(2)
        returns (bool)
    {
        Order storage o = orders[orderId];
        require(o.active,                           "NOT_ACTIVE");
        require(o.side == Side.Buy,                 "NOT_BUY_ORDER");
        require(mktAmount > 0 && mktAmount <= o.remaining, "BAD_AMOUNT");
        // [방어 A] 셀프 체결 금지: maker 본인이 자신의 매수 주문에 팔 수 없음
        require(o.maker != msg.sender,              "SELF_TRADE");

        uint256 grossQuote = _grossQuote(mktAmount, o.price);
        uint256 feeQuote   = _fee(grossQuote);
        uint256 netQuote   = grossQuote - feeQuote;

        _safeTransferFrom(mkt, msg.sender, o.maker, mktAmount);
        _safeTransfer(quoteToken, msg.sender, netQuote);
        _safeTransfer(quoteToken, feeRecipient, feeQuote);

        reservedQuote -= grossQuote;
        totalFeeQuote += feeQuote;

        o.remaining -= mktAmount;
        if (o.remaining == 0) o.active = false;

        emit LimitBuyFilled(orderId, o.maker, msg.sender, mktAmount, o.price, grossQuote, feeQuote);

        // ── 자동 VWAP 갱신 ───────────────────────────────────────────────
        _recordTrade(mktAmount, grossQuote);

        return true;
    }

    /**
     * 지정가 매도 주문 체결 (buyer 가 호출)
     * 체결 후 자동으로 VWAP 갱신
     */
    function fillLimitSell(uint256 orderId, uint256 mktAmount, uint256 maxTotalQuote)
        external nonReentrant onlyActive(2)
        returns (bool)
    {
        Order storage o = orders[orderId];
        require(o.active,                           "NOT_ACTIVE");
        require(o.side == Side.Sell,                "NOT_SELL_ORDER");
        require(mktAmount > 0 && mktAmount <= o.remaining, "BAD_AMOUNT");
        // [방어 A] 셀프 체결 금지: maker 본인이 자신의 매도 주문을 살 수 없음
        require(o.maker != msg.sender,              "SELF_TRADE");

        uint256 grossQuote = _grossQuote(mktAmount, o.price);
        uint256 feeQuote   = _fee(grossQuote);
        uint256 totalQuote = grossQuote + feeQuote;

        if (maxTotalQuote != 0) require(totalQuote <= maxTotalQuote, "SLIPPAGE");

        _safeTransferFrom(quoteToken, msg.sender, o.maker, grossQuote);
        _safeTransferFrom(quoteToken, msg.sender, feeRecipient, feeQuote);
        _safeTransfer(mkt, msg.sender, mktAmount);

        reservedMkt   -= mktAmount;
        totalFeeQuote += feeQuote;

        o.remaining -= mktAmount;
        if (o.remaining == 0) o.active = false;

        emit LimitSellFilled(orderId, o.maker, msg.sender, mktAmount, o.price, grossQuote, feeQuote);

        // ── 자동 VWAP 갱신 ───────────────────────────────────────────────
        _recordTrade(mktAmount, grossQuote);

        return true;
    }
}
