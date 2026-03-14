/**
 * Cryptonote Node.JS Pool
 * https://github.com/dvandal/cryptonote-nodejs-pool
 *
 * Handle communications to APIs
 **/

// Load required modules
// fetch is available globally in Node.js 18+

/**
 * Send API request using JSON HTTP
 **/
async function jsonHttpRequest(host, port, data, callback, path) {
    path = path || '/json_rpc';
    callback = callback || (()=> {});

    const protocol = port === 443 ? 'https' : 'http';
    const url = `${protocol}://${host}:${port}${path}`;

    const options = {
        method: data ? 'POST' : 'GET',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        // Add timeout to prevent hanging indefinitely
        signal: AbortSignal.timeout(5000) // 5 second timeout
    };

    if (data) {
        options.body = data;
    }

    try {
        const response = await fetch(url, options);
        
        if (!response.ok) {
            callback(new Error(`HTTP ${response.status}: ${response.statusText}`), {});
            return;
        }

        const replyJson = await response.json();
        callback(null, replyJson);
    } catch (error) {
        // Handle timeout and other errors
        if (error.name === 'TimeoutError' || error.name === 'AbortError') {
            callback(new Error(`Request timeout after 5000ms to ${url}`), {});
        } else {
        callback(error, {});
        }
    }
}

/**
 * Send RPC request
 **/
function rpc(host, port, method, params, callback, password, rpcId){
    const request = {
        id: rpcId !== undefined ? rpcId : 0,
        jsonrpc: "2.0",
        method: method,
        params: params
    };
    if (password !== undefined) {
        request.password = password;
    }
    const data = JSON.stringify(request);
    jsonHttpRequest(host, port, data, (error, replyJson)=> {
        if (error){
            callback(error, {});
            return;
        }
        callback(replyJson.error, replyJson.result)
    });
}

/**
 * Send RPC requests in batch mode
 **/
function batchRpc(host, port, array, callback){
    const rpcArray = [];
    for (const [i, item] of array.entries()) {
        rpcArray.push({
            id: i,
            jsonrpc: "2.0",
            method: item[0],
            params: item[1]
        });
    }
    const data = JSON.stringify(rpcArray);
    jsonHttpRequest(host, port, data, callback);
}

/**
 * Send RPC request to pool API
 **/
function poolRpc(host, port, path, callback){
    jsonHttpRequest(host, port, '', callback, path);
}

/**
 * Exports API interfaces functions
 **/
module.exports = (daemonConfig, walletConfig, poolApiConfig)=> ({
        batchRpcDaemon: (batchArray, callback)=> {
            batchRpc(daemonConfig.host, daemonConfig.port, batchArray, callback);
        },
        rpcDaemon: (method, params, callback)=> {
            rpc(daemonConfig.host, daemonConfig.port, method, params, callback);
        },
        rpcWallet: (method, params, callback, rpcId)=> {
            rpc(walletConfig.host, walletConfig.port, method, params, callback,
	walletConfig.password, rpcId);
        },
        pool: (path, callback)=> {
            const bindIp = config.api.bindIp ? config.api.bindIp : "0.0.0.0";
            const poolApi = (bindIp !== "0.0.0.0" ? poolApiConfig.bindIp : "127.0.0.1");
            poolRpc(poolApi, poolApiConfig.port, path, callback);
        },
        jsonHttpRequest: jsonHttpRequest
    });
