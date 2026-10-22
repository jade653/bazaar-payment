// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title wMST - bazaar talent token (1 wMST = 1 KRW)
/// @notice Minimal fixed-supply ERC-20. The whole supply is minted once to the
///         deploying wallet (the operator treasury). There is no owner, no mint,
///         no burn and no pause: nothing to administer on site, and transfers
///         touch only the two balance slots they must.
/// @dev    decimals is 0 because amounts are whole won. transferWithGas lets the
///         operator hand a customer wMST and a little native MST (for fees) in one
///         confirmation instead of two.
contract WMST {
    string public constant name = "wMST";
    string public constant symbol = "wMST";
    uint8 public constant decimals = 0;
    uint256 public immutable totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint256 supply) {
        totalSupply = supply;
        balanceOf[msg.sender] = supply;
        emit Transfer(address(0), msg.sender, supply);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    /// @notice Transfer wMST and forward the native MST sent along (msg.value)
    ///         to the same recipient in a single transaction.
    function transferWithGas(address to, uint256 value) external payable returns (bool) {
        _transfer(msg.sender, to, value);
        if (msg.value > 0) {
            (bool ok, ) = to.call{value: msg.value}("");
            require(ok, "gas transfer failed");
        }
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= value, "insufficient allowance");
            unchecked { allowance[from][msg.sender] = allowed - value; }
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) internal {
        require(to != address(0), "transfer to zero address");
        uint256 balance = balanceOf[from];
        require(balance >= value, "insufficient balance");
        unchecked {
            balanceOf[from] = balance - value;
            balanceOf[to] += value; // cannot overflow: bounded by totalSupply
        }
        emit Transfer(from, to, value);
    }
}
