// /contracts/MktExchangeV2.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
}

contract MktExchangeV2 {
    /* ===================== Constants ===================== */

    uint256 public constant BPS = 10_000;
    uint256 public constant FEE_BPS = 300; // 3%

    /* ===================== Tokens ===================== */

    IERC20 public immutable mkt;        // base token
    IERC20 public immutable quoteToken; // HEX or other quote token

    /* ===================== Admin ===================== */

    address public admin;
    address public feeRecipient;

    // 0 = stop, 1 = market only, 2 = market + limit
    uint8 public act;

    // 시장가 기준 가격: quote wei per 1 MKT
    uint256 public marketPrice;

    /* ===================== Reserve Accounting ===================== */

    // 지정가 매수 주문에 묶여 있는 quote 총액
    uint256 public reservedQuote;

    // 지정가 매도 주문에 묶여 있는 mkt 총량
    uint256 public reservedMkt;

    // 누적 수수료(quote token 기준)
    uint256 public totalFeeQuote;

    /* ===================== Reentrancy Guard ===================== */

    uint256 private unlocked = 1;

    modifier nonReentrant() {
        require(unlocked == 1, "REENTRANT");
        unlocked = 2;
        _;
        unlocked = 1;
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

    enum Side {
        Buy,
        Sell
    }

    struct Order {
        uint256 id;
        address maker;
        Side side;
        uint256 price;      // quote wei per 1 MKT
        uint256 amount;     // original amount (MKT)
        uint256 remaining;  // remaining amount (MKT)
        bool active;
    }

    uint256 public nextOrderId = 1;
    mapping(uint256 => Order) public orders;

    /* ===================== Events ===================== */

    event AdminTransferred(address indexed prevAdmin, address indexed nextAdmin);
    event FeeRecipientUpdated(address indexed prevRecipient, address indexed nextRecipient);
    event ActUpdated(uint8 prevAct, uint8 nextAct);
    event MarketPriceUpdated(uint256 prevPrice, uint256 nextPrice);

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
        Side side,
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
        uint8 _act
    ) {
        require(_mkt != address(0), "MKT_ZERO");
        require(_quoteToken != address(0), "QUOTE_ZERO");
        require(_feeRecipient != address(0), "FEE_ZERO");
        require(_initialMarketPrice > 0, "PRICE_ZERO");

        mkt = IERC20(_mkt);
        quoteToken = IERC20(_quoteToken);

        admin = msg.sender;
        feeRecipient = _feeRecipient;
        marketPrice = _initialMarketPrice;
        act = _act;
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

    function _fee(uint256 grossQuote) internal pure returns (uint256) {
        return (grossQuote * FEE_BPS) / BPS;
    }

    /* ===================== View Helpers ===================== */

    function quoteBalance() public view returns (uint256) {
        return quoteToken.balanceOf(address(this));
    }

    function mktBalance() public view returns (uint256) {
        return mkt.balanceOf(address(this));
    }

    // 시장가용으로 실제 사용 가능한 quote 잔고
    function availableQuoteForMarket() public view returns (uint256) {
        uint256 bal = quoteBalance();
        if (bal <= reservedQuote) return 0;
        return bal - reservedQuote;
    }

    // 시장가용으로 실제 사용 가능한 mkt 잔고
    function availableMktForMarket() public view returns (uint256) {
        uint256 bal = mktBalance();
        if (bal <= reservedMkt) return 0;
        return bal - reservedMkt;
    }

    function getBuyOrderEscrowNeeded(uint256 mktAmount, uint256 price) public pure returns (uint256) {
        return _grossQuote(mktAmount, price);
    }

    function previewMarketBuy(uint256 mktAmount)
        external
        view
        returns (uint256 grossQuote, uint256 feeQuote, uint256 totalQuote)
    {
        grossQuote = _grossQuote(mktAmount, marketPrice);
        feeQuote = _fee(grossQuote);
        totalQuote = grossQuote + feeQuote;
    }

    function previewMarketSell(uint256 mktAmount)
        external
        view
        returns (uint256 grossQuote, uint256 feeQuote, uint256 netQuote)
    {
        grossQuote = _grossQuote(mktAmount, marketPrice);
        feeQuote = _fee(grossQuote);
        netQuote = grossQuote - feeQuote;
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

    function setMarketPrice(uint256 nextPrice) external onlyAdmin {
        require(nextPrice > 0, "PRICE_ZERO");
        uint256 prev = marketPrice;
        marketPrice = nextPrice;
        emit MarketPriceUpdated(prev, nextPrice);
    }

    // 관리자가 시장가 거래용 재고/유동성 추가
    function addMarketLiquidity(uint256 mktAmount, uint256 quoteAmount) external onlyAdmin nonReentrant {
        if (mktAmount > 0) {
            _safeTransferFrom(mkt, msg.sender, address(this), mktAmount);
        }
        if (quoteAmount > 0) {
            _safeTransferFrom(quoteToken, msg.sender, address(this), quoteAmount);
        }
        emit MarketLiquidityAdded(msg.sender, mktAmount, quoteAmount);
    }

    // 예약되지 않은 잔고만 회수 가능
    function removeMarketLiquidity(address to, uint256 mktAmount, uint256 quoteAmount)
        external
        onlyAdmin
        nonReentrant
    {
        require(to != address(0), "ZERO_ADDR");
        require(mktAmount <= availableMktForMarket(), "MKT_RESERVED");
        require(quoteAmount <= availableQuoteForMarket(), "QUOTE_RESERVED");

        _safeTransfer(mkt, to, mktAmount);
        _safeTransfer(quoteToken, to, quoteAmount);

        emit MarketLiquidityRemoved(to, mktAmount, quoteAmount);
    }

    /* ===================== Market Orders ===================== */

    // 시장가 매수: 컨트랙트 재고에서 즉시 체결
    // 수수료 3%는 quoteToken(HEX) 기준으로 추가 납부
    function marketBuy(uint256 mktAmount, uint256 maxTotalQuote)
        external
        nonReentrant
        onlyActive(1)
        returns (bool)
    {
        require(mktAmount > 0, "AMOUNT_ZERO");
        require(availableMktForMarket() >= mktAmount, "INSUFFICIENT_MKT");

        uint256 grossQuote = _grossQuote(mktAmount, marketPrice);
        uint256 feeQuote = _fee(grossQuote);
        uint256 totalQuote = grossQuote + feeQuote;

        if (maxTotalQuote != 0) {
            require(totalQuote <= maxTotalQuote, "SLIPPAGE");
        }

        _safeTransferFrom(quoteToken, msg.sender, address(this), grossQuote);
        _safeTransferFrom(quoteToken, msg.sender, feeRecipient, feeQuote);
        _safeTransfer(mkt, msg.sender, mktAmount);

        totalFeeQuote += feeQuote;

        emit MarketBuy(msg.sender, mktAmount, grossQuote, feeQuote, totalQuote);
        return true;
    }

    // 시장가 매도: 컨트랙트가 즉시 매수
    // 수수료 3%는 quoteToken 지급액에서 차감
    function marketSell(uint256 mktAmount, uint256 minNetQuote)
        external
        nonReentrant
        onlyActive(1)
        returns (bool)
    {
        require(mktAmount > 0, "AMOUNT_ZERO");

        uint256 grossQuote = _grossQuote(mktAmount, marketPrice);
        uint256 feeQuote = _fee(grossQuote);
        uint256 netQuote = grossQuote - feeQuote;

        require(availableQuoteForMarket() >= grossQuote, "INSUFFICIENT_QUOTE");
        if (minNetQuote != 0) {
            require(netQuote >= minNetQuote, "SLIPPAGE");
        }

        _safeTransferFrom(mkt, msg.sender, address(this), mktAmount);
        _safeTransfer(quoteToken, msg.sender, netQuote);
        _safeTransfer(quoteToken, feeRecipient, feeQuote);

        totalFeeQuote += feeQuote;

        emit MarketSell(msg.sender, mktAmount, grossQuote, feeQuote, netQuote);
        return true;
    }

    /* ===================== Limit Orders ===================== */

    // 지정가 매수 주문 생성
    // 주문 생성 시 grossQuote(= amount * price) 만큼 quoteToken 예치
    // 주문 체결 시 seller가 MKT를 넘기면, seller는 gross - fee 수령, feeRecipient가 fee 수령
    function placeLimitBuy(uint256 mktAmount, uint256 pricePerMkt)
        external
        nonReentrant
        onlyActive(2)
        returns (uint256 orderId)
    {
        require(mktAmount > 0, "AMOUNT_ZERO");
        require(pricePerMkt > 0, "PRICE_ZERO");

        uint256 grossQuote = _grossQuote(mktAmount, pricePerMkt);

        _safeTransferFrom(quoteToken, msg.sender, address(this), grossQuote);

        reservedQuote += grossQuote;

        orderId = nextOrderId++;
        orders[orderId] = Order({
            id: orderId,
            maker: msg.sender,
            side: Side.Buy,
            price: pricePerMkt,
            amount: mktAmount,
            remaining: mktAmount,
            active: true
        });

        emit LimitOrderPlaced(orderId, msg.sender, Side.Buy, pricePerMkt, mktAmount);
    }

    // 지정가 매도 주문 생성
    // 주문 생성 시 mktAmount 만큼 MKT 예치
    // 주문 체결 시 buyer가 gross + fee 납부, seller는 gross 수령, feeRecipient가 fee 수령
    function placeLimitSell(uint256 mktAmount, uint256 pricePerMkt)
        external
        nonReentrant
        onlyActive(2)
        returns (uint256 orderId)
    {
        require(mktAmount > 0, "AMOUNT_ZERO");
        require(pricePerMkt > 0, "PRICE_ZERO");

        _safeTransferFrom(mkt, msg.sender, address(this), mktAmount);

        reservedMkt += mktAmount;

        orderId = nextOrderId++;
        orders[orderId] = Order({
            id: orderId,
            maker: msg.sender,
            side: Side.Sell,
            price: pricePerMkt,
            amount: mktAmount,
            remaining: mktAmount,
            active: true
        });

        emit LimitOrderPlaced(orderId, msg.sender, Side.Sell, pricePerMkt, mktAmount);
    }

    // 지정가 매수 주문 취소: 남은 quote 환불
    function cancelOrder(uint256 orderId) external nonReentrant returns (bool) {
        Order storage o = orders[orderId];
        require(o.active, "NOT_ACTIVE");
        require(o.maker == msg.sender || msg.sender == admin, "NO_AUTH");

        o.active = false;

        uint256 refundQuote = 0;
        uint256 refundMkt = 0;

        if (o.side == Side.Buy) {
            refundQuote = _grossQuote(o.remaining, o.price);
            reservedQuote -= refundQuote;
            _safeTransfer(quoteToken, o.maker, refundQuote);
        } else {
            refundMkt = o.remaining;
            reservedMkt -= refundMkt;
            _safeTransfer(mkt, o.maker, refundMkt);
        }

        o.remaining = 0;

        emit LimitOrderCancelled(orderId, o.maker, refundMkt, refundQuote);
        return true;
    }

    // 누군가가 지정가 매수 주문에 팔기
    // seller는 MKT 전달, gross - fee 수령
    function fillLimitBuy(uint256 orderId, uint256 mktAmount)
        external
        nonReentrant
        onlyActive(2)
        returns (bool)
    {
        Order storage o = orders[orderId];
        require(o.active, "NOT_ACTIVE");
        require(o.side == Side.Buy, "NOT_BUY_ORDER");
        require(mktAmount > 0 && mktAmount <= o.remaining, "BAD_AMOUNT");

        uint256 grossQuote = _grossQuote(mktAmount, o.price);
        uint256 feeQuote = _fee(grossQuote);
        uint256 netQuote = grossQuote - feeQuote;

        _safeTransferFrom(mkt, msg.sender, o.maker, mktAmount);
        _safeTransfer(quoteToken, msg.sender, netQuote);
        _safeTransfer(quoteToken, feeRecipient, feeQuote);

        reservedQuote -= grossQuote;
        totalFeeQuote += feeQuote;

        o.remaining -= mktAmount;
        if (o.remaining == 0) {
            o.active = false;
        }

        emit LimitBuyFilled(orderId, o.maker, msg.sender, mktAmount, o.price, grossQuote, feeQuote);
        return true;
    }

    // 누군가가 지정가 매도 주문에서 사기
    // buyer는 gross + fee 납부, seller는 gross 수령
    function fillLimitSell(uint256 orderId, uint256 mktAmount, uint256 maxTotalQuote)
        external
        nonReentrant
        onlyActive(2)
        returns (bool)
    {
        Order storage o = orders[orderId];
        require(o.active, "NOT_ACTIVE");
        require(o.side == Side.Sell, "NOT_SELL_ORDER");
        require(mktAmount > 0 && mktAmount <= o.remaining, "BAD_AMOUNT");

        uint256 grossQuote = _grossQuote(mktAmount, o.price);
        uint256 feeQuote = _fee(grossQuote);
        uint256 totalQuote = grossQuote + feeQuote;

        if (maxTotalQuote != 0) {
            require(totalQuote <= maxTotalQuote, "SLIPPAGE");
        }

        _safeTransferFrom(quoteToken, msg.sender, o.maker, grossQuote);
        _safeTransferFrom(quoteToken, msg.sender, feeRecipient, feeQuote);
        _safeTransfer(mkt, msg.sender, mktAmount);

        reservedMkt -= mktAmount;
        totalFeeQuote += feeQuote;

        o.remaining -= mktAmount;
        if (o.remaining == 0) {
            o.active = false;
        }

        emit LimitSellFilled(orderId, o.maker, msg.sender, mktAmount, o.price, grossQuote, feeQuote);
        return true;
    }
}