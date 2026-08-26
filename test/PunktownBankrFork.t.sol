// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface Vm {
    function createSelectFork(string calldata rpcUrl, uint256 blockNumber) external returns (uint256 forkId);
    function envOr(string calldata name, string calldata defaultValue) external returns (string memory value);
    function prank(address msgSender) external;
    function deal(address account, uint256 newBalance) external;
    function roll(uint256 newHeight) external;
}

interface IERC20 {
    function transfer(address recipient, uint256 amount) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

interface IWETH is IERC20 {
    function deposit() external payable;
}

interface IERC721 {
    function ownerOf(uint256 tokenId) external view returns (address);
    function approve(address spender, uint256 tokenId) external;
    function transferFrom(address from, address to, uint256 tokenId) external;
}

interface IPunkAMM {
    function BUY_TOTAL() external view returns (uint256);
    function SELL_PAYOUT() external view returns (uint256);
    function trackedBAES() external view returns (uint256);
    function inventoryCount() external view returns (uint256);
    function fifoHead() external view returns (uint256);
    function buyNextNFT(uint256 expectedHeadTokenId, uint256 maxBAESIn, uint256 minWethOut, uint256 deadline) external;
    function sellNFT(uint256 tokenId, uint256 minBAESOut, uint256 minWethOut, uint256 deadline) external;
    function topUpReserve(uint256 amount) external;
    function syncBAESDonation() external;
    function evictUnownedHead() external;
}

interface ILockVault {
    function tierCost(uint8 tier) external pure returns (uint256);
    function tierWeight(uint8 tier) external pure returns (uint16);
    function stake(uint256 tokenId, uint8 tier, address beneficiary) external returns (uint256 positionId);
    function upgrade(uint256 positionId, uint8 newTier) external;
    function unstake(uint256 positionId) external;
    function unstakeTo(uint256 positionId, address recipient) external;
    function positions(uint256 positionId)
        external
        view
        returns (uint256 tokenId, address depositor, address beneficiary, uint16 weight, uint8 tier, bool active);
}

interface IStockLock {
    function wethPot() external view returns (uint256);
    function stockCredit(address token, address beneficiary) external view returns (uint256);
    function depositTopUp(uint256 amount, bytes32 sourceId) external;
    function pokeBootstrap() external;
    function convert(uint256 amountIn, uint256 deadline) external returns (address token, uint256 stockOut);
    function settlePositions(uint256[] calldata positionIds) external;
    function claim(address token) external;
    function claimTo(address token, address recipient) external;
    function claimBatch(address[] calldata tokens, address recipient) external;
    function claimLossy(address token, address recipient, uint256 minReceived) external;
    function forfeitCredit(address token, uint256 amount) external;
}

interface IFeeQuote {
    function quoteExactBAESForWETH(uint256 amountIn) external returns (uint256 amountOut);
}

contract BankrSmartWalletHarness {
    function execute(address target, bytes calldata data) external returns (bytes memory result) {
        (bool ok, bytes memory returned) = target.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(returned, 0x20), mload(returned))
            }
        }
        return returned;
    }

    function executeValue(address target, bytes calldata data, uint256 value) external returns (bytes memory result) {
        (bool ok, bytes memory returned) = target.call{value: value}(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(returned, 0x20), mload(returned))
            }
        }
        return returned;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    receive() external payable {}
}

// Test-only swap envelope used by the CLI fork harness to prove that acquisition
// verification measures receipt transfers without trusting a router or calldata.
contract BankrSwapReceiptFixture {
    function swap(address source, address output, uint256 sourceAmount, uint256 outputAmount) external {
        require(IERC20(source).transferFrom(msg.sender, address(this), sourceAmount), "source transfer");
        require(IERC20(output).transfer(msg.sender, outputAmount), "output transfer");
    }

    function swapNative(address output, uint256 outputAmount) external payable {
        require(msg.value > 0, "native value");
        require(IERC20(output).transfer(msg.sender, outputAmount), "output transfer");
    }

    function deliverOutput(address output, uint256 outputAmount) external {
        require(IERC20(output).transfer(msg.sender, outputAmount), "output transfer");
    }
}

contract PunktownBankrForkTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant FORK_BLOCK = 50_477_817;
    uint256 private constant FEE = 600_000 ether;
    uint256 private constant CONVERT_AMOUNT = 0.001 ether;
    bytes32 private constant BANKR_FORK_SOURCE = 0x42414e4b522d464f524b00000000000000000000000000000000000000000000;

    address private constant OWNER = 0x702ba46435D1E55B18440100BC81EB055574875e;
    address private constant BAES = 0xa9F6d9EcA1F803854A13CECad0f21d43e007DB07;
    address private constant PUNKS = 0xDC1C20Df3F8EDeDF1466399C5d5D17d864bD3F0f;
    address private constant WETH = 0x4200000000000000000000000000000000000006;
    address private constant PUNK_AMM = 0x555c246d004D2F24b5BaDDd186Fc773eB6fb8445;
    address private constant LOCK_VAULT = 0x69a60eae4Af0cAF965472f1268C723B1d60bcbE9;
    address private constant STOCK_LOCK = 0x4570F784d35ab06a0FA22F42bb6329fAA998a6BA;
    address private constant FEE_ROUTER = 0x753bed09b3B39E750B48814BA7730034Df705fCf;

    BankrSmartWalletHarness private wallet;

    function setUp() public {
        string memory rpc = vm.envOr("BASE_RPC_URL", string("https://base-rpc.publicnode.com"));
        vm.createSelectFork(rpc, FORK_BLOCK);
        wallet = new BankrSmartWalletHarness();

        vm.prank(OWNER);
        require(IERC20(BAES).transfer(address(wallet), 50_000_000 ether), "fund BAES");
        vm.deal(address(wallet), 1 ether);
    }

    function testCompleteBankrSmartWalletFlow() public {
        uint256 firstPunk = _buyNext();
        uint256 secondPunk = _buyNext();
        uint256 thirdPunk = _buyNext();

        _sell(firstPunk);

        uint256 positionOne = _stake(secondPunk, 0);
        uint256 positionTwo = _stake(thirdPunk, 0);
        _upgrade(positionOne, 1);

        _topUpStockLock();
        _exerciseRewards(positionOne, positionTwo);
        _exerciseReserveIngress();

        wallet.execute(LOCK_VAULT, abi.encodeCall(ILockVault.unstake, (positionOne)));
        _assertEq(IERC721(PUNKS).ownerOf(secondPunk), address(wallet), "unstake recipient");

        address alternateRecipient = address(0xB0B);
        wallet.execute(LOCK_VAULT, abi.encodeCall(ILockVault.unstakeTo, (positionTwo, alternateRecipient)));
        _assertEq(IERC721(PUNKS).ownerOf(thirdPunk), alternateRecipient, "unstakeTo recipient");

        _exerciseBrokenHeadRepair();
    }

    function _buyNext() private returns (uint256 tokenId) {
        tokenId = IPunkAMM(PUNK_AMM).fifoHead();
        uint256 buyTotal = IPunkAMM(PUNK_AMM).BUY_TOTAL();
        wallet.execute(BAES, abi.encodeCall(IERC20.approve, (PUNK_AMM, buyTotal)));
        _assertEq(IERC20(BAES).allowance(address(wallet), PUNK_AMM), buyTotal, "exact buy approval");
        wallet.execute(
            PUNK_AMM, abi.encodeCall(IPunkAMM.buyNextNFT, (tokenId, buyTotal, _feeMinimum(), block.timestamp + 600))
        );
        _assertEq(IERC20(BAES).allowance(address(wallet), PUNK_AMM), 0, "buy approval consumed");
        _assertEq(IERC721(PUNKS).ownerOf(tokenId), address(wallet), "smart wallet receives bought punk");
    }

    function _sell(uint256 tokenId) private {
        uint256 beforeBalance = IERC20(BAES).balanceOf(address(wallet));
        wallet.execute(PUNKS, abi.encodeCall(IERC721.approve, (PUNK_AMM, tokenId)));
        wallet.execute(
            PUNK_AMM,
            abi.encodeCall(
                IPunkAMM.sellNFT, (tokenId, IPunkAMM(PUNK_AMM).SELL_PAYOUT(), _feeMinimum(), block.timestamp + 600)
            )
        );
        _assertEq(
            IERC20(BAES).balanceOf(address(wallet)) - beforeBalance,
            IPunkAMM(PUNK_AMM).SELL_PAYOUT(),
            "exact sell payout"
        );
        _assertEq(IERC721(PUNKS).ownerOf(tokenId), PUNK_AMM, "sold punk enters desk");
    }

    function _stake(uint256 tokenId, uint8 tier) private returns (uint256 positionId) {
        uint256 cost = ILockVault(LOCK_VAULT).tierCost(tier);
        wallet.execute(BAES, abi.encodeCall(IERC20.approve, (LOCK_VAULT, cost)));
        wallet.execute(PUNKS, abi.encodeCall(IERC721.approve, (LOCK_VAULT, tokenId)));
        bytes memory returned =
            wallet.execute(LOCK_VAULT, abi.encodeCall(ILockVault.stake, (tokenId, tier, address(wallet))));
        positionId = abi.decode(returned, (uint256));
        (uint256 storedToken, address depositor, address beneficiary, uint16 weight, uint8 storedTier, bool active) =
            ILockVault(LOCK_VAULT).positions(positionId);
        _assertEq(storedToken, tokenId, "staked token");
        _assertEq(depositor, address(wallet), "position depositor");
        _assertEq(beneficiary, address(wallet), "position beneficiary");
        _assertEq(uint256(storedTier), uint256(tier), "position tier");
        _assertEq(uint256(weight), uint256(ILockVault(LOCK_VAULT).tierWeight(tier)), "position weight");
        require(active, "position active");
        _assertEq(IERC20(BAES).allowance(address(wallet), LOCK_VAULT), 0, "stake approval consumed");
    }

    function _upgrade(uint256 positionId, uint8 newTier) private {
        (,,, uint16 oldWeight, uint8 oldTier,) = ILockVault(LOCK_VAULT).positions(positionId);
        uint256 delta = ILockVault(LOCK_VAULT).tierCost(newTier) - ILockVault(LOCK_VAULT).tierCost(oldTier);
        wallet.execute(BAES, abi.encodeCall(IERC20.approve, (LOCK_VAULT, delta)));
        wallet.execute(LOCK_VAULT, abi.encodeCall(ILockVault.upgrade, (positionId, newTier)));
        (,,, uint16 weight, uint8 tier,) = ILockVault(LOCK_VAULT).positions(positionId);
        require(weight > oldWeight, "weight increased");
        _assertEq(uint256(tier), uint256(newTier), "upgraded tier");
        _assertEq(IERC20(BAES).allowance(address(wallet), LOCK_VAULT), 0, "upgrade approval consumed");
    }

    function _topUpStockLock() private {
        uint256 amount = 0.01 ether;
        wallet.executeValue(WETH, abi.encodeCall(IWETH.deposit, ()), amount);
        wallet.execute(WETH, abi.encodeCall(IERC20.approve, (STOCK_LOCK, amount)));
        uint256 beforePot = IStockLock(STOCK_LOCK).wethPot();
        wallet.execute(STOCK_LOCK, abi.encodeCall(IStockLock.depositTopUp, (amount, BANKR_FORK_SOURCE)));
        _assertEq(IStockLock(STOCK_LOCK).wethPot() - beforePot, amount, "accounted WETH top-up");
        _assertEq(IERC20(WETH).allowance(address(wallet), STOCK_LOCK), 0, "WETH approval consumed");
        wallet.execute(STOCK_LOCK, abi.encodeCall(IStockLock.pokeBootstrap, ()));
    }

    function _exerciseRewards(uint256 positionOne, uint256 positionTwo) private {
        uint256[] memory positions = new uint256[](2);
        positions[0] = positionOne;
        positions[1] = positionTwo;

        address tokenOne = _convert();
        wallet.execute(STOCK_LOCK, abi.encodeCall(IStockLock.settlePositions, (positions)));
        uint256 creditOne = IStockLock(STOCK_LOCK).stockCredit(tokenOne, address(wallet));
        require(creditOne > 0, "first credit");
        uint256 beforeOne = IERC20(tokenOne).balanceOf(address(wallet));
        wallet.execute(STOCK_LOCK, abi.encodeCall(IStockLock.claim, (tokenOne)));
        _assertEq(IERC20(tokenOne).balanceOf(address(wallet)) - beforeOne, creditOne, "strict claim");

        address tokenTwo = _convert();
        wallet.execute(STOCK_LOCK, abi.encodeCall(IStockLock.settlePositions, (positions)));
        uint256 creditTwo = IStockLock(STOCK_LOCK).stockCredit(tokenTwo, address(wallet));
        require(creditTwo > 0, "second credit");
        address rewardRecipient = address(0xCAFE);
        uint256 beforeTwo = IERC20(tokenTwo).balanceOf(rewardRecipient);
        wallet.execute(STOCK_LOCK, abi.encodeCall(IStockLock.claimTo, (tokenTwo, rewardRecipient)));
        _assertEq(IERC20(tokenTwo).balanceOf(rewardRecipient) - beforeTwo, creditTwo, "claimTo");

        address tokenThree = _convert();
        wallet.execute(STOCK_LOCK, abi.encodeCall(IStockLock.settlePositions, (positions)));
        uint256 creditThree = IStockLock(STOCK_LOCK).stockCredit(tokenThree, address(wallet));
        require(creditThree > 0, "third credit");
        address[] memory oneToken = new address[](1);
        oneToken[0] = tokenThree;
        wallet.execute(STOCK_LOCK, abi.encodeCall(IStockLock.claimBatch, (oneToken, address(wallet))));
        _assertEq(IStockLock(STOCK_LOCK).stockCredit(tokenThree, address(wallet)), 0, "claimBatch credit");

        address tokenFour = _convert();
        wallet.execute(STOCK_LOCK, abi.encodeCall(IStockLock.settlePositions, (positions)));
        uint256 creditFour = IStockLock(STOCK_LOCK).stockCredit(tokenFour, address(wallet));
        require(creditFour > 0, "fourth credit");
        wallet.execute(STOCK_LOCK, abi.encodeCall(IStockLock.claimLossy, (tokenFour, address(wallet), creditFour)));
        _assertEq(IStockLock(STOCK_LOCK).stockCredit(tokenFour, address(wallet)), 0, "lossy claim credit");

        address tokenFive = _convert();
        wallet.execute(STOCK_LOCK, abi.encodeCall(IStockLock.settlePositions, (positions)));
        uint256 creditFive = IStockLock(STOCK_LOCK).stockCredit(tokenFive, address(wallet));
        require(creditFive > 1, "fifth credit");
        uint256 forfeitAmount = creditFive / 2;
        wallet.execute(STOCK_LOCK, abi.encodeCall(IStockLock.forfeitCredit, (tokenFive, forfeitAmount)));
        _assertEq(
            IStockLock(STOCK_LOCK).stockCredit(tokenFive, address(wallet)),
            creditFive - forfeitAmount,
            "partial forfeit"
        );
    }

    function _convert() private returns (address token) {
        vm.roll(block.number + 1);
        uint256 wethBefore = IERC20(WETH).balanceOf(address(wallet));
        bytes memory returned =
            wallet.execute(STOCK_LOCK, abi.encodeCall(IStockLock.convert, (CONVERT_AMOUNT, block.timestamp + 300)));
        uint256 stockOut;
        (token, stockOut) = abi.decode(returned, (address, uint256));
        require(stockOut > 0, "stock output");
        _assertEq(
            IERC20(WETH).balanceOf(address(wallet)) - wethBefore, CONVERT_AMOUNT / 100, "permissionless convert bounty"
        );
    }

    function _exerciseReserveIngress() private {
        uint256 beforeTracked = IPunkAMM(PUNK_AMM).trackedBAES();
        wallet.execute(BAES, abi.encodeCall(IERC20.approve, (PUNK_AMM, 1 ether)));
        wallet.execute(PUNK_AMM, abi.encodeCall(IPunkAMM.topUpReserve, (1 ether)));
        _assertEq(IPunkAMM(PUNK_AMM).trackedBAES() - beforeTracked, 1 ether, "reserve top-up");

        beforeTracked = IPunkAMM(PUNK_AMM).trackedBAES();
        wallet.execute(BAES, abi.encodeCall(IERC20.transfer, (PUNK_AMM, 2 ether)));
        wallet.execute(PUNK_AMM, abi.encodeCall(IPunkAMM.syncBAESDonation, ()));
        _assertEq(IPunkAMM(PUNK_AMM).trackedBAES() - beforeTracked, 2 ether, "donation sync");
    }

    function _exerciseBrokenHeadRepair() private {
        uint256 inventoryBefore = IPunkAMM(PUNK_AMM).inventoryCount();
        uint256 brokenHead = IPunkAMM(PUNK_AMM).fifoHead();
        vm.prank(PUNK_AMM);
        IERC721(PUNKS).transferFrom(PUNK_AMM, address(0xDEAD), brokenHead);
        wallet.execute(PUNK_AMM, abi.encodeCall(IPunkAMM.evictUnownedHead, ()));
        _assertEq(IPunkAMM(PUNK_AMM).inventoryCount(), inventoryBefore - 1, "broken head evicted");
    }

    function _feeMinimum() private returns (uint256) {
        uint256 quote = IFeeQuote(FEE_ROUTER).quoteExactBAESForWETH(FEE);
        require(quote > 0, "fee quote");
        return quote * 97 / 100;
    }

    function _assertEq(uint256 actual, uint256 expected, string memory reason) private pure {
        require(actual == expected, reason);
    }

    function _assertEq(address actual, address expected, string memory reason) private pure {
        require(actual == expected, reason);
    }
}
