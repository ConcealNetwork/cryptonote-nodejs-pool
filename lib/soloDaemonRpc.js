/**
 * Solo Mining Bridge - Daemon RPC Client
 * Simplified daemon RPC interface for solo mining
 */

// fetch is available globally in Node.js 18+

/**
 * Send JSON RPC request to daemon (async/await version)
 */
async function rpc(host, port, method, params) {
    const request = {
        id: '0',
        jsonrpc: '2.0',
        method: method,
        params: params || {},
    };

    const protocol = port === 443 ? 'https' : 'http';
    const url = `${protocol}://${host}:${port}/json_rpc`;
    const data = JSON.stringify(request);

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
        body: data,
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const replyJson = await response.json();
                    if (replyJson.error) {
        throw replyJson.error;
    }
    return replyJson.result;
}

/**
 * Get block template from daemon
 */
async function getBlockTemplate() {
    const daemon = config.daemon;
    // Miningcore uses ReserveSize = 9 (ExtraNonceSize(4) + InstanceIdSize(4) + 1 zero byte)
    // The daemon allocates 9 bytes, but only 8 are used (the last byte MUST be zero)
    // See: https://github.com/blackmennewstyle/miningcore/blob/dev/src/Miningcore/Blockchain/Conceal/ConcealConstants.cs
    return await rpc(daemon.host, daemon.port, 'getblocktemplate', {
        wallet_address: config.solo.walletAddress || config.solo.poolAddress,
        reserve_size: 9,
    });
}

/**
 * Submit block to daemon
 */
async function submitBlock(blob) {
    const daemon = config.daemon;
    return await rpc(daemon.host, daemon.port, 'submitblock', [blob]);
}

/**
 * Get daemon info
 */
async function getInfo() {
    const daemon = config.daemon;
    return await rpc(daemon.host, daemon.port, 'get_info', {});
}

module.exports = {
    getBlockTemplate: getBlockTemplate,
    submitBlock: submitBlock,
    getInfo: getInfo,
    rpc: rpc,
};
