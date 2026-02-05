/**
 * Cryptonote Node.JS Pool
 * https://github.com/dvandal/cryptonote-nodejs-pool
 *
 * Pool API
 **/

// Load required modules
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const url = require('node:url');

const apiInterfaces = require('./apiInterfaces.js')(config.daemon, config.wallet);
const AuthManager = require('./auth.js');
const AdminHandler = require('./adminHandler.js');
const charts = require('./charts.js');
const notifications = require('./notifications.js');
const market = require('./market.js');
const utils = require('./utils.js');

// Initialize log system
const logSystem = 'api';
require('./exceptionWriter.js')(logSystem);

// Initialize authentication manager
const authManager = new AuthManager(config, log, logSystem);
const corsOrigin = authManager.corsOrigin;

// Log CORS origin after initialization
log('info', logSystem, 'CORS origin configured: %s', [corsOrigin]);

// Data storage variables used for live statistics
let currentStats = {};
let minerStats = {};
let minersHashrate = {};

const liveConnections = {};
const addressConnections = {};

/**
 * Check if IP is rate limited
 * @param {string} ip - IP address to check
 * @param {string} endpoint - Endpoint being accessed (for logging)
 * @returns {object} - { allowed: boolean, remainingAttempts: number, resetTime: number }
 **/
/**
 * Handle server requests
 **/
function handleServerRequest(request, response) {
    try {
        const urlParts = url.parse(request.url, true);

        // Handle CORS preflight requests
        if (request.method === 'OPTIONS') {
            response.writeHead(200, {
                'Access-Control-Allow-Origin': corsOrigin,
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                'Access-Control-Allow-Credentials': 'true',
                'Access-Control-Max-Age': '86400',
            });
            response.end();
            return;
        }

        switch (urlParts.pathname) {
            // Pool statistics
            case '/stats':
                handleStats(urlParts, request, response);
                break;
            case '/live_stats': {
                try {
                    log('debug', logSystem, 'live_stats request received, origin: %s, corsOrigin: %s', [
                        request.headers.origin,
                        corsOrigin,
                    ]);
                    const address = urlParts.query.address ? urlParts.query.address : 'undefined';

                    // Send immediate response with current stats (fetch expects one response per request)
                    // Ensure we always have a valid structure even if currentStats is empty
                    const data = currentStats || {};

                    // Ensure pool object exists with all required fields
                    if (!data.pool || typeof data.pool !== 'object') {
                        data.pool = {
                            stats: {},
                            blocks: [],
                            totalBlocks: 0,
                            totalDiff: 0,
                            totalShares: 0,
                            payments: [],
                            totalPayments: 0,
                            totalMinersPaid: 0,
                            miners: 0,
                            workers: 0,
                            hashrate: 0,
                            roundScore: 0,
                            roundHashes: 0,
                        };
                    }

                    // Ensure network object exists
                    if (!data.network || typeof data.network !== 'object') {
                        data.network = { difficulty: 0, height: 0 };
                    }

                    // Ensure config object exists
                    if (!data.config || typeof data.config !== 'object') {
                        data.config = {
                            poolHost: config.poolHost || '',
                            coin: config.coin,
                            symbol: config.symbol,
                            coinUnits: config.coinUnits,
                            coinDecimalPlaces: config.coinDecimalPlaces || 4,
                            coinDifficultyTarget: config.coinDifficultyTarget || 120,
                        };
                    }

                    // Ensure lastblock object exists
                    if (!data.lastblock || typeof data.lastblock !== 'object') {
                        data.lastblock = {};
                    }

                    // Ensure charts object exists if it should be there
                    if (!data.charts || typeof data.charts !== 'object') {
                        data.charts = {};
                    }

                    // Set miner data - aggregate from all workers
                    data.miner = {};
                    if (address && address !== 'undefined' && minerStats) {
                        let totalHashrate = 0;
                        let totalRoundScore = 0;
                        let totalRoundHashes = 0;
                        
                        for (const minerKey in minerStats) {
                            if (minerKey === address || minerKey.startsWith(address + '~')) {
                                totalHashrate += minerStats[minerKey].hashrate || 0;
                                totalRoundScore += minerStats[minerKey].roundScore || 0;
                                totalRoundHashes += minerStats[minerKey].roundHashes || 0;
                            }
                        }
                        
                        if (totalHashrate > 0 || totalRoundScore > 0) {
                            data.miner = {
                                hashrate: totalHashrate,
                                roundScore: totalRoundScore,
                                roundHashes: totalRoundHashes,
                            };
                        }
                    }

                    // Ensure network has required fields even if empty
                    if (data.network.difficulty === undefined || data.network.difficulty === null) {
                        data.network.difficulty = 0;
                    }
                    if (data.network.height === undefined || data.network.height === null) {
                        data.network.height = 0;
                    }

                    // Ensure pool has required numeric fields
                    if (typeof data.pool.hashrate !== 'number') data.pool.hashrate = 0;
                    if (typeof data.pool.miners !== 'number') data.pool.miners = 0;
                    if (typeof data.pool.workers !== 'number') data.pool.workers = 0;
                    if (!Array.isArray(data.pool.blocks)) data.pool.blocks = [];
                    if (!Array.isArray(data.pool.payments)) data.pool.payments = [];
                    if (typeof data.pool.totalMinersPaid !== 'number') {
                        data.pool.totalMinersPaid =
                            data.pool.totalMinersPaid === '-1' ? 0 : data.pool.totalMinersPaid || 0;
                    }

                    const dataJSON = JSON.stringify(data);

                    // Set all headers in writeHead
                    response.writeHead(200, {
                        'Access-Control-Allow-Origin': corsOrigin,
                        'Cache-Control': 'no-cache',
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(dataJSON, 'utf8'),
                    });
                    response.end(dataJSON);
                    log('debug', logSystem, 'live_stats response sent successfully');
                } catch (err) {
                    log('error', logSystem, 'Error in live_stats endpoint: %j', [err]);
                    log('error', logSystem, 'Error stack: %s', [err.stack]);
                    try {
                        const errorJSON = JSON.stringify({ error: 'Internal server error' });
                        response.writeHead(500, {
                            'Access-Control-Allow-Origin': corsOrigin,
                            'Content-Type': 'application/json',
                            'Content-Length': Buffer.byteLength(errorJSON, 'utf8'),
                        });
                        response.end(errorJSON);
                    } catch (responseErr) {
                        log('error', logSystem, 'Failed to send error response: %j', [responseErr]);
                        // Last resort - try to send something
                        try {
                            response.writeHead(500, { 'Access-Control-Allow-Origin': corsOrigin });
                            response.end('{"error":"Internal server error"}');
                        } catch (finalErr) {
                            log('error', logSystem, 'Completely failed to send response: %j', [finalErr]);
                        }
                    }
                }
                break;
            }

            // Worker statistics
            case '/stats_address':
                handleMinerStats(urlParts, response);
                break;

            // Payments
            case '/get_payments':
                handleGetPayments(urlParts, response);
                break;

            // Blocks
            case '/get_blocks':
                handleGetBlocks(urlParts, response);
                break;

            // Get market prices
            case '/get_market':
                handleGetMarket(urlParts, response);
                break;

            // Top 10 miners
            case '/get_top10miners':
                handleTopMiners(response);
                break;

            // Miner settings
            case '/get_miner_payout_level':
                handleGetMinerPayoutLevel(urlParts, response);
                break;
            case '/set_miner_payout_level':
                handleSetMinerPayoutLevel(urlParts, response);
                break;
            case '/get_email_notifications':
                handleGetMinerNotifications(urlParts, response);
                break;
            case '/set_email_notifications':
                handleSetMinerNotifications(urlParts, response);
                break;
            case '/get_telegram_notifications':
                handleGetTelegramNotifications(urlParts, response);
                break;
            case '/set_telegram_notifications':
                handleSetTelegramNotifications(urlParts, response);
                break;

            // Miners/workers hashrate (used for charts)
            case '/miners_hashrate':
                handleGetMinersHashrate(response);
                break;
            case '/workers_hashrate':
                handleGetWorkersHashrate(response);
                break;

            // Pool Administration
            case '/admin_login':
                authManager.handleAdminLogin(request, response);
                break;
            case '/admin_stats':
                if (!authManager.authorize(request, response)) return;
                adminHandler.handleAdminStats(response);
                break;
            case '/admin_monitoring':
                if (!authManager.authorize(request, response)) {
                    return;
                }
                adminHandler.handleAdminMonitoring(response);
                break;
            case '/admin_log':
                if (!authManager.authorize(request, response)) {
                    return;
                }
                adminHandler.handleAdminLog(urlParts, response);
                break;
            case '/admin_users':
                if (!authManager.authorize(request, response)) {
                    return;
                }
                adminHandler.handleAdminUsers(response);
                break;
            case '/admin_ports':
                if (!authManager.authorize(request, response)) {
                    return;
                }
                adminHandler.handleAdminPorts(response);
                break;
            case '/admin_manual_payment':
                if (!authManager.authorize(request, response)) {
                    return;
                }
                adminHandler.handleAdminManualPayment(urlParts, response);
                break;

            // Test notifications
            case '/test_email_notification':
                if (!authManager.authorize(request, response)) {
                    return;
                }
                adminHandler.handleTestEmailNotification(urlParts, response);
                break;
            case '/test_telegram_notification':
                if (!authManager.authorize(request, response)) {
                    return;
                }
                adminHandler.handleTestTelegramNotification(urlParts, response);
                break;

            // Default response
            default:
                response.writeHead(404, {
                    'Access-Control-Allow-Origin': corsOrigin,
                });
                response.end('Invalid API call');
                break;
        }
    } catch (err) {
        log('error', logSystem, 'Error handling request: %j', [err]);
        const errorJSON = JSON.stringify({ error: 'Internal server error' });
        response.writeHead(500, {
            'Access-Control-Allow-Origin': corsOrigin,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(errorJSON, 'utf8'),
        });
        response.end(errorJSON);
    }
}

/**
 * Collect statistics data
 **/
function collectStats() {
    log('info', logSystem, 'Starting stats collection...');
    const startTime = Date.now();
    let redisFinished;
    let daemonFinished;

    // Calculate hashrate window cutoff time
    const windowTime = ((Date.now() / 1000 - config.api.hashrateWindow) | 0).toString();

    // Use Promise.all for parallel execution
    const getPoolStats = new Promise((resolve, reject) => {
        log('info', logSystem, 'Collecting pool stats from Redis...');
        const multi = redisClient.multi();
        multi.zRemRangeByScore(`${config.coin}:hashrate`, '-inf', `(${windowTime}`);
        multi.zRange(`${config.coin}:hashrate`, 0, -1);
        multi.hGetAll(`${config.coin}:stats`);
        multi.zRangeWithScores(`${config.coin}:blocks:candidates`, 0, -1);
        multi.zRangeWithScores(`${config.coin}:blocks:matured`, -(config.api.blocks), -1);
        multi.hGetAll(`${config.coin}:scores:roundCurrent`);
        multi.hGetAll(`${config.coin}:stats`);
        multi.zCard(`${config.coin}:blocks:matured`);
        multi.zRangeWithScores(`${config.coin}:payments:all`, -(config.api.payments), -1);
        multi.zCard(`${config.coin}:payments:all`);
        multi.keys(`${config.coin}:payments:*`);
        multi.hGetAll(`${config.coin}:shares_actual:roundCurrent`);

        multi
            .exec()
            .then((replies) => {
                redisFinished = Date.now();
                log('info', logSystem, 'Redis pool stats received, replies count: %d', [replies ? replies.length : 0]);
                if (!replies || replies.length === 0) {
                    throw new Error('Redis multi exec returned empty or null replies');
                }
                const _dateNowSeconds = (Date.now() / 1000) | 0;

                // Handle WITHSCORES format - node-redis v5 returns [{value, score}, ...]
                const blocksCandidatesRaw = replies[3] || [];
                const blocksMaturedRaw = replies[4] || [];
                const paymentsRaw = replies[8] || [];

                // Convert from [{value, score}, ...] to flat array [value, score, value, score, ...]
                // Frontend expects [serializedBlock, height, serializedBlock, height, ...]
                const blocksCandidates = [];
                for (const item of blocksCandidatesRaw) {
                    blocksCandidates.push(item.value);
                    blocksCandidates.push(item.score);
                }
                const blocksMatured = [];
                for (const item of blocksMaturedRaw) {
                    blocksMatured.push(item.value);
                    blocksMatured.push(item.score);
                }

                // For payments: Convert to flat array [value, score, value, score, ...]
                // Frontend expects [serializedPayment, timestamp, serializedPayment, timestamp, ...]
                const paymentsValues = [];
                for (const item of paymentsRaw) {
                    paymentsValues.push(item.value);
                    paymentsValues.push(item.score);
                }

                const data = {
                    stats: replies[2] || {},
                    blocks: blocksCandidates.concat(blocksMatured),
                    totalBlocks: parseInt(replies[7] || 0, 10) + blocksCandidatesRaw.length,
                    totalDiff: 0,
                    totalShares: 0,
                    payments: paymentsValues,
                    totalPayments: parseInt(replies[9] || 0, 10),
                    totalMinersPaid: replies[10] && replies[10].length > 0 ? replies[10].length - 1 : 0,
                    miners: 0,
                    workers: 0,
                    hashrate: 0,
                    roundScore: 0,
                    roundHashes: 0,
                };

                // Process blocks for totalDiff and totalShares
                // blocks array format: [serializedBlock, height, serializedBlock, height, ...]
                // So we process every other element (i += 2) to get only serialized blocks
                for (let i = 0; i < data.blocks.length; i += 2) {
                    const block = data.blocks[i].split(':');
                    if (block[5]) {
                        const blockShares = parseInt(block[3], 10);
                        const blockDiff = parseInt(block[2], 10);
                        data.totalDiff += blockDiff;
                        data.totalShares += blockShares;
                    }
                }

                // Clear objects without reassigning (so references remain valid)
                for (const key in minerStats) {
                    delete minerStats[key];
                }
                for (const key in minersHashrate) {
                    delete minersHashrate[key];
                }

                const hashrates = replies[1] || [];
                log('info', logSystem, 'Processing %d hashrate entries', [hashrates.length]);
                for (let i = 0; i < hashrates.length; i++) {
                    if (hashrates[i]) {
                        const hashParts = hashrates[i].split(':');
                        if (hashParts.length >= 2) {
                            minersHashrate[hashParts[1]] =
                                (minersHashrate[hashParts[1]] || 0) + parseInt(hashParts[0], 10);
                        }
                    }
                }
                log('info', logSystem, 'Processed hashrates for %d unique addresses', [
                    Object.keys(minersHashrate).length,
                ]);

                let totalShares = 0;
                const uniqueMiners = new Set();

                // First pass: calculate total shares and identify unique miners
                for (const miner in minersHashrate) {
                    totalShares += minersHashrate[miner];
                    
                    // Extract address from "address" or "address~workername"
                    const address = miner.split('~')[0];
                    uniqueMiners.add(address);
                }

                // Second pass: calculate individual hashrates and count workers
                for (const miner in minersHashrate) {
                    if (miner.indexOf('~') !== -1) {
                        data.workers++;
                    }

                    minersHashrate[miner] = Math.round(minersHashrate[miner] / config.api.hashrateWindow);

                    if (!minerStats[miner]) {
                        minerStats[miner] = {};
                    }
                    minerStats[miner].hashrate = minersHashrate[miner];
                }

                // Count unique miner addresses
                data.miners = uniqueMiners.size;

                data.hashrate = Math.round(totalShares / config.api.hashrateWindow);
                log('info', logSystem, 'Stats calculated: miners=%d, workers=%d, hashrate=%d, minerStats entries=%d', [
                    data.miners,
                    data.workers,
                    data.hashrate,
                    Object.keys(minerStats).length,
                ]);

                data.roundScore = 0;

                if (replies[5]) {
                    for (const miner in replies[5]) {
                        const roundScore = parseFloat(replies[5][miner]);

                        data.roundScore += roundScore;

                        if (!minerStats[miner]) {
                            minerStats[miner] = {};
                        }
                        minerStats[miner].roundScore = roundScore;
                    }
                }

                data.roundHashes = 0;

                if (replies[11]) {
                    for (const miner in replies[11]) {
                        const roundHashes = parseInt(replies[11][miner], 10);
                        data.roundHashes += roundHashes;

                        if (!minerStats[miner]) {
                            minerStats[miner] = {};
                        }
                        minerStats[miner].roundHashes = roundHashes;
                    }
                }

                if (replies[6]) {
                    data.lastBlockFound = replies[6].lastBlockFound;
                }

                resolve(data);
            })
            .catch((err) => {
                log('error', logSystem, 'Redis multi exec error: %s', [err?.message || 'Unknown error']);
                log('error', logSystem, 'Redis error details: %j', [err]);
                logRedisError('collectStats', err);
                reject(err);
            });
    });

    const getLastBlock = new Promise((resolve, reject) => {
        log('info', logSystem, 'Getting last block data from daemon...');
        getLastBlockData((error, data) => {
            daemonFinished = Date.now();
            if (error) {
                log('error', logSystem, 'Last block data error: %j', [error]);
                reject(error);
            } else {
                log('info', logSystem, 'Last block data received: %j', [data]);
                resolve(data);
            }
        });
    });

    const getNetwork = (async () => {
        log('info', logSystem, 'Getting network data from daemon...');
        try {
            const data = await getNetworkDataPromise();
            daemonFinished = Date.now();
            log('info', logSystem, 'Network data received: %j', [data]);
            return data;
        } catch (error) {
            daemonFinished = Date.now();
            log('error', logSystem, 'Network data error: %j', [error]);
            throw error;
        }
    })();

    const getConfig = Promise.resolve({
        poolHost: config.poolHost || '',
        ports: getPublicPorts(config.poolServer.ports),
        cnAlgorithm: config.cnAlgorithm || 'cryptonight',
        cnVariant: config.cnVariant || 0,
        cnBlobType: config.cnBlobType || 0,
        hashrateWindow: config.api.hashrateWindow,
        fee: config.blockUnlocker.poolFee,
        networkFee: config.blockUnlocker.networkFee || 0,
        coin: config.coin,
        coinUnits: config.coinUnits,
        coinDecimalPlaces: config.coinDecimalPlaces || 4, // config.coinUnits.toString().length - 1,
        coinDifficultyTarget: config.coinDifficultyTarget,
        symbol: config.symbol,
        depth: config.blockUnlocker.depth,
        donation: donations,
        version: version,
        paymentsInterval: config.payments.interval,
        minPaymentThreshold: config.payments.minPayment,
        maxPaymentThreshold: config.payments.maxPayment || null,
        transferFee: config.payments.transferFee,
        denominationUnit: config.payments.denomination,
        slushMiningEnabled: config.poolServer.slushMining.enabled,
        weight: config.poolServer.slushMining.weight,
        priceSource: config.prices ? config.prices.source : 'cryptonator',
        priceCurrency: config.prices ? config.prices.currency : 'USD',
        paymentIdSeparator: config.poolServer.paymentId?.addressSeparator
            ? config.poolServer.paymentId.addressSeparator
            : '.',
        fixedDiffEnabled: config.poolServer.fixedDiff.enabled,
        fixedDiffSeparator: config.poolServer.fixedDiff.addressSeparator,
        sendEmails: config.email ? config.email.enabled : false,
        blocksChartEnabled: config.charts.blocks?.enabled,
        blocksChartDays: config.charts.blocks?.days ? config.charts.blocks.days : null,
        telegramBotName: config.telegram?.botName ? config.telegram.botName : null,
        telegramBotStats: config.telegram?.botCommands ? config.telegram.botCommands.stats : '/stats',
        telegramBotReport: config.telegram?.botCommands ? config.telegram.botCommands.report : '/report',
        telegramBotNotify: config.telegram?.botCommands ? config.telegram.botCommands.notify : '/notify',
        telegramBotBlocks: config.telegram?.botCommands ? config.telegram.botCommands.blocks : '/blocks',
    });

    const getCharts = new Promise((resolve, reject) => {
        log('info', logSystem, 'Getting charts data...');

        // Add timeout to prevent hanging indefinitely
        const chartsTimeout = setTimeout(() => {
            log('warn', logSystem, 'Charts data collection timeout after 3 seconds, using empty data');
            resolve({});
        }, 3000);

        // Get enabled charts data
        charts.getPoolChartsData((error, data) => {
            clearTimeout(chartsTimeout);
            if (error) {
                log('warn', logSystem, 'Charts data error: %j', [error]);
                resolve({}); // Resolve with empty data instead of rejecting
                return;
            }
            log('info', logSystem, 'Charts data received');

            // Blocks chart
            if (!(config.charts.blocks && config.charts.blocks.enabled && config.charts.blocks.days)) {
                log('info', logSystem, 'Blocks chart disabled, skipping');
                resolve(data);
                return;
            }

            log('info', logSystem, 'Getting blocks chart data...');
            const chartDays = config.charts.blocks.days;

            let beginAtTimestamp = Date.now() / 1000 - chartDays * 86400;
            let beginAtDate = new Date(beginAtTimestamp * 1000);
            if (chartDays > 1) {
                beginAtDate = new Date(
                    beginAtDate.getFullYear(),
                    beginAtDate.getMonth(),
                    beginAtDate.getDate(),
                    0,
                    0,
                    0,
                    0
                );
                beginAtTimestamp = (beginAtDate / 1000) | 0;
            }

            const blocksCount = {};
            if (chartDays === 1) {
                for (let h = 0; h <= 24; h++) {
                    const date = utils.dateFormat(
                        new Date((beginAtTimestamp + h * 60 * 60) * 1000),
                        'yyyy-mm-dd HH:00'
                    );
                    blocksCount[date] = 0;
                }
            } else {
                for (let d = 0; d <= chartDays; d++) {
                    const date = utils.dateFormat(new Date((beginAtTimestamp + d * 86400) * 1000), 'yyyy-mm-dd');
                    blocksCount[date] = 0;
                }
            }

            redisClient
                .zRangeWithScores(`${config.coin}:blocks:matured`, 0, -1)
                .then((result) => {
                    // zRangeWithScores returns [{value, score}, ...]
                    for (let i = 0; i < result.length; i++) {
                        if (result[i] && result[i].value) {
                            const block = result[i].value.split(':');
                            if (block[5]) {
                                const blockTimestamp = block[1];
                                if (blockTimestamp < beginAtTimestamp) {
                                    continue;
                                }
                                const date = utils.dateFormat(new Date(blockTimestamp * 1000), 'yyyy-mm-dd');
                                if (chartDays === 1)
                                    utils.dateFormat(new Date(blockTimestamp * 1000), 'yyyy-mm-dd HH:00');
                                if (!blocksCount[date]) blocksCount[date] = 0;
                                blocksCount[date]++;
                            }
                        }
                    }
                    data.blocks = blocksCount;
                    resolve(data);
                })
                .catch((err) => {
                    log('error', logSystem, 'Error getting blocks chart data: %j', [err]);
                    reject(err);
                });
        });
    });

    // Execute all promises in parallel
    Promise.all([getPoolStats, getLastBlock, getNetwork, getConfig, getCharts])
        .then(([pool, lastblock, network, configData, chartsData]) => {
            log('info', logSystem, 'Stat collection finished: %d ms redis, %d ms daemon', [
                redisFinished - startTime,
                daemonFinished - startTime,
            ]);

            currentStats = {
                pool: pool,
                lastblock: lastblock,
                network: network,
                config: configData,
                charts: chartsData,
            };

            broadcastLiveStats();
            setTimeout(collectStats, config.api.updateInterval * 1000);
        })
        .catch((error) => {
            log('error', logSystem, 'Error collecting all stats: %j', [error]);
            log('error', logSystem, 'Error type: %s, message: %s', [error?.constructor?.name, error?.message]);
            log('error', logSystem, 'Stack: %s', [error?.stack || 'No stack']);
            // Still try to provide minimal stats structure even on error
            if (!currentStats || Object.keys(currentStats).length === 0) {
                currentStats = {
                    pool: {},
                    network: {},
                    config: {
                        poolHost: config.poolHost || '',
                        coin: config.coin,
                        symbol: config.symbol,
                        coinUnits: config.coinUnits,
                        coinDecimalPlaces: config.coinDecimalPlaces || 4,
                    },
                    lastblock: {},
                };
            }
            setTimeout(collectStats, config.api.updateInterval * 1000);
        });
}

/**
 * Get Network data
 **/
function getNetworkData(callback) {
    // Conceal daemon only supports getlastblockheader via JSON-RPC (not get_info)
    apiInterfaces.rpcDaemon('getlastblockheader', {}, (error, reply) => {
        if (error) {
            log('error', logSystem, 'Error getting network data from getlastblockheader: %j', [error]);
            // Return empty network data instead of error to prevent stats collection failure
            callback(null, {
                difficulty: 0,
                height: 0,
            });
            return;
        }

        const blockHeader = reply.block_header;
        if (!blockHeader) {
            log('warn', logSystem, 'getlastblockheader returned no block_header');
            callback(null, {
                difficulty: 0,
                height: 0,
            });
            return;
        }

        callback(null, {
            difficulty: blockHeader.difficulty || 0,
            height: (blockHeader.height || 0) + 1,
        });
    });
}

/**
 * Get Network data (Promise version)
 **/
const getNetworkDataPromise = () => {
    return new Promise((resolve, reject) => {
        getNetworkData((error, data) => {
            if (error) {
                reject(error);
            } else {
                resolve(data);
            }
        });
    });
};

/**
 * Get Last Block data
 **/
function getLastBlockData(callback) {
    apiInterfaces.rpcDaemon('getlastblockheader', {}, (error, reply) => {
        if (error) {
            log('error', logSystem, 'Error getting last block data %j', [error]);
            // Return empty lastblock data instead of error to prevent stats collection failure
            callback(null, {
                difficulty: 0,
                height: 0,
                timestamp: 0,
                reward: 0,
                hash: '',
            });
            return;
        }
        const blockHeader = reply.block_header;
        if (!blockHeader) {
            log('warn', logSystem, 'getlastblockheader returned no block_header');
            callback(null, {
                difficulty: 0,
                height: 0,
                timestamp: 0,
                reward: 0,
                hash: '',
            });
            return;
        }
        callback(null, {
            difficulty: blockHeader.difficulty || 0,
            height: blockHeader.height || 0,
            timestamp: blockHeader.timestamp || 0,
            reward: blockHeader.reward || 0,
            hash: blockHeader.hash || '',
        });
    });
}

/**
 * Broadcast live statistics
 **/
function broadcastLiveStats() {
    log('info', logSystem, 'Broadcasting to %d visitors and %d address lookups', [
        Object.keys(liveConnections).length,
        Object.keys(addressConnections).length,
    ]);

    // Live statistics
    const processAddresses = {};
    for (const key in liveConnections) {
        const addrOffset = key.indexOf(':');
        const address = key.substr(0, addrOffset);
        if (!processAddresses[address]) processAddresses[address] = [];
        processAddresses[address].push(liveConnections[key]);
    }

    for (const address in processAddresses) {
        const data = currentStats;

        data.miner = {};
        if (address) {
            // Aggregate hashrate from all workers for this address
            let totalHashrate = 0;
            let totalRoundScore = 0;
            let totalRoundHashes = 0;
            
            for (const minerKey in minerStats) {
                if (minerKey === address || minerKey.startsWith(address + '~')) {
                    totalHashrate += minerStats[minerKey].hashrate || 0;
                    totalRoundScore += minerStats[minerKey].roundScore || 0;
                    totalRoundHashes += minerStats[minerKey].roundHashes || 0;
                }
            }
            
            if (totalHashrate > 0 || totalRoundScore > 0) {
                data.miner = {
                    hashrate: totalHashrate,
                    roundScore: totalRoundScore,
                    roundHashes: totalRoundHashes,
                };
            }
        }

        const destinations = processAddresses[address];
        sendLiveStats(data, destinations);
    }

    // Workers Statistics
    const processAddresses2 = {};
    for (const key in addressConnections) {
        const addrOffset = key.indexOf(':');
        const address = key.substr(0, addrOffset);
        if (!processAddresses2[address]) processAddresses2[address] = [];
        processAddresses2[address].push(addressConnections[key]);
    }

    for (const address in processAddresses2) {
        broadcastWorkerStats(address, processAddresses2[address]);
    }
}

/**
 * Takes a chart data JSON string and uses it to compute the average over the past hour, 6 hours,
 * and 24 hours.  Returns [AVG1, AVG6, AVG24].
 **/
const extractAverageHashrates = (chartdata) => {
    const now = (Date.now() / 1000) | 0;

    const sums = [0, 0, 0, 0, 0, 0]; // 1h, 6h, 24h, 5m, 15m, 12h
    const counts = [0, 0, 0, 0, 0, 0];

    const sets = JSON.parse(chartdata); // [time, avgValue, updateCount]
    for (const j in sets) {
        const hr = sets[j][1];
        if (now - sets[j][0] <= 1 * 60 * 60) {
            sums[0] += hr;
            counts[0]++;
        }
        if (now - sets[j][0] <= 6 * 60 * 60) {
            sums[1] += hr;
            counts[1]++;
        }
        if (now - sets[j][0] <= 24 * 60 * 60) {
            sums[2] += hr;
            counts[2]++;
        }
        if (now - sets[j][0] <= 5 * 60) {
            sums[3] += hr;
            counts[3]++;
        }
        if (now - sets[j][0] <= 15 * 60) {
            sums[4] += hr;
            counts[4]++;
        }
        if (now - sets[j][0] <= 12 * 60 * 60) {
            sums[5] += hr;
            counts[5]++;
        }
    }

    return [
        (sums[0] * 1.0) / (counts[0] || 1),
        (sums[1] * 1.0) / (counts[1] || 1),
        (sums[2] * 1.0) / (counts[2] || 1),
        (sums[3] * 1.0) / (counts[3] || 1),
        (sums[4] * 1.0) / (counts[4] || 1),
        (sums[5] * 1.0) / (counts[5] || 1),
    ];
};

/**
 * Broadcast worker statistics
 **/
async function broadcastWorkerStats(address, destinations) {
    try {
        // Redis v5 multi syntax
        const multi = redisClient.multi();
        multi.hGetAll(`${config.coin}:workers:${address}`);
        multi.zRangeWithScores(`${config.coin}:payments:${address}`, -(config.api.payments), -1);
        multi.keys(`${config.coin}:unique_workers:${address}~*`);
        multi.get(`${config.coin}:charts:hashrate:${address}`);
        const replies = await multi.exec();

        if (!replies || !replies[0]) {
            sendLiveStats({ error: 'Not found' }, destinations);
            return;
        }

        const stats = replies[0];
        stats.hashrate = minerStats[address]?.hashrate ? minerStats[address].hashrate : 0;
        stats.roundScore = minerStats[address]?.roundScore ? minerStats[address].roundScore : 0;
        stats.roundHashes = minerStats[address]?.roundHashes ? minerStats[address].roundHashes : 0;
        if (replies[3]) {
            const hr_avg = extractAverageHashrates(replies[3]);
            stats.hashrate_1h = hr_avg[0];
            stats.hashrate_6h = hr_avg[1];
            stats.hashrate_24h = hr_avg[2];
        }

        // Convert payments from [{value, score}, ...] to flat array [value, score, ...]
        const paymentsRaw = replies[1] || [];
        const paymentsData = [];
        for (const item of paymentsRaw) {
            paymentsData.push(item.value);
            paymentsData.push(item.score);
        }

        const workersData = [];
        for (let j = 0; j < replies[2].length; j++) {
            const key = replies[2][j];
            const keyParts = key.split(':');
            const miner = keyParts[2];
            if (miner.indexOf('~') !== -1) {
                const workerName = miner.substr(miner.indexOf('~') + 1, miner.length);
                const workerData = {
                    name: workerName,
                    hashrate: minerStats[miner]?.hashrate ? minerStats[miner].hashrate : 0,
                };
                workersData.push(workerData);
            }
        }

        charts.getUserChartsData(address, paymentsData, async (_error, chartsData) => {
            try {
                // Redis v4+ multi syntax for workers data
                if (workersData.length > 0) {
                    const workerMulti = redisClient.multi();
                    for (const i in workersData) {
                        workerMulti.hGetAll(`${config.coin}:unique_workers:${address}~${workersData[i].name}`);
                        workerMulti.get(`${config.coin}:charts:worker_hashrate:${address}~${workersData[i].name}`);
                    }
                    const workerReplies = await workerMulti.exec();

                    for (const i in workersData) {
                        const wi = 2 * i;
                        const hi = wi + 1;
                        if (workerReplies[wi]) {
                            workersData[i].lastShare = workerReplies[wi].lastShare ? parseInt(workerReplies[wi].lastShare, 10) : 0;
                            workersData[i].hashes = workerReplies[wi].hashes ? parseInt(workerReplies[wi].hashes, 10) : 0;
                        }
                        if (workerReplies[hi]) {
                            const avgs = extractAverageHashrates(workerReplies[hi]);
                            workersData[i].hashrate_1h = avgs[0];
                            workersData[i].hashrate_6h = avgs[1];
                            workersData[i].hashrate_24h = avgs[2];
                        }
                    }
                }

                const data = {
                    stats: stats,
                    payments: paymentsData,
                    charts: chartsData,
                    workers: workersData,
                };

                sendLiveStats(data, destinations);
            } catch (innerError) {
                log('error', logSystem, 'Error in broadcastWorkerStats inner callback: %j', [innerError]);
                sendLiveStats({ error: 'Internal error' }, destinations);
            }
        });
    } catch (error) {
        log('error', logSystem, 'Error in broadcastWorkerStats: %j', [error]);
        sendLiveStats({ error: 'Internal error' }, destinations);
    }
}

/**
 * Send live statistics to specified destinations
 **/
const sendLiveStats = (data, destinations) => {
    if (!destinations) return;

    const dataJSON = JSON.stringify(data);
    for (const i in destinations) {
        const response = destinations[i];
        if (response && !response.destroyed && response.writable) {
            try {
                // For long-polling, we need to send data with proper formatting
                // jQuery expects complete JSON responses, so we write and end each update
                response.write(dataJSON);
                // Note: We don't call end() here to keep connection alive for multiple updates
            } catch (err) {
                log('warn', logSystem, 'Error writing to live stats connection: %j', [err]);
                delete liveConnections[Object.keys(liveConnections).find((key) => liveConnections[key] === response)];
            }
        }
    }
};

/**
 * Return pool statistics
 **/
function handleStats(urlParts, _request, response) {
    let data = currentStats;

    // Ensure data has required structure even if stats haven't been collected yet
    if (!data || Object.keys(data).length === 0) {
        data = {
            pool: {},
            network: {},
            config: {
                poolHost: config.poolHost || '',
                coin: config.coin,
                symbol: config.symbol,
                coinUnits: config.coinUnits,
                coinDecimalPlaces: config.coinDecimalPlaces || 4,
            },
            lastblock: {},
        };
    }

    data.miner = {};
    const address = urlParts.query.address;
    if (address) {
        // Aggregate hashrate from all workers for this address
        let totalHashrate = 0;
        let totalRoundScore = 0;
        let totalRoundHashes = 0;
        
        for (const minerKey in minerStats) {
            // Check if this minerStats entry belongs to this address
            if (minerKey === address || minerKey.startsWith(address + '~')) {
                totalHashrate += minerStats[minerKey].hashrate || 0;
                totalRoundScore += minerStats[minerKey].roundScore || 0;
                totalRoundHashes += minerStats[minerKey].roundHashes || 0;
            }
        }
        
        if (totalHashrate > 0 || totalRoundScore > 0) {
            data.miner = {
                hashrate: totalHashrate,
                roundScore: totalRoundScore,
                roundHashes: totalRoundHashes,
            };
        }
    }

    const dataJSON = JSON.stringify(data);

    response.writeHead('200', {
        'Access-Control-Allow-Origin': corsOrigin,
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(dataJSON, 'utf8'),
    });
    response.end(dataJSON);
}

/**
 * Return miner (worker) statistics
 **/
function handleMinerStats(urlParts, response) {
    const address = urlParts.query.address;
    const longpoll = urlParts.query.longpoll === 'true';

    if (longpoll) {
        response.writeHead(200, {
            'Access-Control-Allow-Origin': corsOrigin,
            'Cache-Control': 'no-cache',
            'Content-Type': 'application/json',
            Connection: 'keep-alive',
        });

        redisClient
            .exists(`${config.coin}:workers:${address}`)
            .then((result) => {
                if (!result) {
                    response.end(JSON.stringify({ error: 'Not found' }));
                    return;
                }

                const address2 = urlParts.query.address;
                const uid = Math.random().toString();
                const key = `${address2}:${uid}`;

                response.on('finish', () => {
                    delete addressConnections[key];
                });
                response.on('close', () => {
                    delete addressConnections[key];
                });

                addressConnections[key] = response;
            })
            .catch((err) => {
                response.end(JSON.stringify({ error: 'Not found' }));
            });
    } else {
        const multi = redisClient.multi();
        multi.hGetAll(`${config.coin}:workers:${address}`);
        multi.zRangeWithScores(`${config.coin}:payments:${address}`, -(config.api.payments), -1);
        multi.keys(`${config.coin}:unique_workers:${address}~*`);
        multi.get(`${config.coin}:charts:hashrate:${address}`);
        multi.zRangeWithScores(`${config.coin}:blocksMiner:matured:${address}`, 0, -1);
        multi.zRangeWithScores(`${config.coin}:blocksMiner:found:${address}`, 0, -1);
        multi.zCard(`${config.coin}:blocksMiner:found:${address}`);
        multi
            .exec()
            .then((replies) => {
                // Check if replies exist and first reply (hgetall) has data
                const workerData = replies && replies[0] ? replies[0] : null;
                if (!workerData || (typeof workerData === 'object' && Object.keys(workerData).length === 0)) {
                    log('warn', logSystem, 'Worker not found in Redis: %s, replies[0]: %j', [address, replies[0]]);
                    const dataJSON = JSON.stringify({ error: 'Not found' });
                    response.writeHead(200, {
                        'Access-Control-Allow-Origin': corsOrigin,
                        'Cache-Control': 'no-cache',
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(dataJSON, 'utf8'),
                    });
                    response.end(dataJSON);
                    return;
                }

                const stats = workerData;
                
                // Aggregate hashrate from all workers for this address
                let totalHashrate = 0;
                let totalRoundScore = 0;
                let totalRoundHashes = 0;
                
                for (const minerKey in minerStats) {
                    // Check if this minerStats entry belongs to this address
                    if (minerKey === address || minerKey.startsWith(address + '~')) {
                        totalHashrate += minerStats[minerKey].hashrate || 0;
                        totalRoundScore += minerStats[minerKey].roundScore || 0;
                        totalRoundHashes += minerStats[minerKey].roundHashes || 0;
                    }
                }
                
                stats.hashrate = totalHashrate;
                stats.roundScore = totalRoundScore;
                stats.roundHashes = totalRoundHashes;
                if (replies[3] && replies[3] !== null) {
                    const hr_avg = extractAverageHashrates(replies[3]);
                    stats.hashrate_1h = hr_avg[0];
                    stats.hashrate_6h = hr_avg[1];
                    stats.hashrate_24h = hr_avg[2];
                }

                // Handle partial failures - some commands may fail (empty sets, missing keys) which is OK
                // Convert from [{value, score}, ...] to flat arrays
                const paymentsRaw = replies[1] && Array.isArray(replies[1]) ? replies[1] : [];
                const paymentsData = [];
                for (const item of paymentsRaw) {
                    paymentsData.push(item.value);
                    paymentsData.push(item.score);
                }
                
                const blocksShareRaw = replies[4] && Array.isArray(replies[4]) ? replies[4] : [];
                const blocksShareData = [];
                for (const item of blocksShareRaw) {
                    blocksShareData.push(item.value);
                    blocksShareData.push(item.score);
                }
                
                const blocksFoundRaw = replies[5] && Array.isArray(replies[5]) ? replies[5] : [];
                const blocksFoundData = [];
                for (const item of blocksFoundRaw) {
                    blocksFoundData.push(item.value);
                    blocksFoundData.push(item.score);
                }
                
                const totalBlocksFoundData = replies[6] !== null && replies[6] !== undefined ? replies[6] : 0;

                const workersData = [];
                for (let i = 0; i < replies[2].length; i++) {
                    const key = replies[2][i];
                    const keyParts = key.split(':');
                    const miner = keyParts[2];
                        const workerName = miner.substr(miner.indexOf('~') + 1, miner.length);
                        const workerData = {
                            name: workerName,
                            hashrate: minerStats[miner]?.hashrate ? minerStats[miner].hashrate : 0,
                        };
                        workersData.push(workerData);
                }

                charts.getUserChartsData(address, paymentsData, (_error, chartsData) => {
                    const redisCommands = [];
                    if (workersData.length === 0) {
                        const data = {
                            stats: stats,
                            payments: paymentsData,
                            charts: chartsData,
                            workers: workersData,
                            blocksShare: blocksShareData,
                            blocksFound: blocksFoundData,
                            totalBlocksFound: totalBlocksFoundData,
                        };
                        const dataJSON = JSON.stringify(data);
                        response.writeHead(200, {
                            'Access-Control-Allow-Origin': corsOrigin,
                            'Cache-Control': 'no-cache',
                            'Content-Type': 'application/json',
                            'Content-Length': Buffer.byteLength(dataJSON, 'utf8'),
                        });
                        response.end(dataJSON);
                        return;
                    }

                    // Redis v4+ multi syntax
                    const workerMulti = redisClient.multi();
                    for (const i in workersData) {
                        workerMulti.hGetAll(`${config.coin}:unique_workers:${address}~${workersData[i].name}`);
                        workerMulti.get(`${config.coin}:charts:worker_hashrate:${address}~${workersData[i].name}`);
                    }
                    workerMulti
                        .exec()
                        .then((replies) => {
                            for (const i in workersData) {
                                const wi = 2 * i;
                                const hi = wi + 1;
                                if (replies[wi]) {
                                    workersData[i].lastShare = replies[wi].lastShare
                                        ? parseInt(replies[wi].lastShare, 10)
                                        : 0;
                                    workersData[i].hashes = replies[wi].hashes ? parseInt(replies[wi].hashes, 10) : 0;
                                    workersData[i].validShares = replies[wi].validShares
                                        ? parseInt(replies[wi].validShares, 10)
                                        : 0;
                                    workersData[i].invalidShares = replies[wi].invalidShares
                                        ? parseInt(replies[wi].invalidShares, 10)
                                        : 0;
                                }
                                if (replies[hi]) {
                                    const avgs = extractAverageHashrates(replies[hi]);
                                    workersData[i].hashrate_1h = avgs[0];
                                    workersData[i].hashrate_6h = avgs[1];
                                    workersData[i].hashrate_24h = avgs[2];
                                }
                            }

                            const data = {
                                stats: stats,
                                payments: paymentsData,
                                charts: chartsData,
                                workers: workersData,
                                blocksShare: blocksShareData,
                                blocksFound: blocksFoundData,
                                totalBlocksFound: totalBlocksFoundData,
                            };

                            const dataJSON = JSON.stringify(data);

                            response.writeHead(200, {
                                'Access-Control-Allow-Origin': corsOrigin,
                                'Cache-Control': 'no-cache',
                                'Content-Type': 'application/json',
                                'Content-Length': Buffer.byteLength(dataJSON, 'utf8'),
                            });
                            response.end(dataJSON);
                        })
                        .catch((err2) => {
                            logRedisError('Worker data', err2);
                            const data = {
                                stats: stats,
                                payments: paymentsData,
                                charts: chartsData,
                                workers: workersData,
                                blocksShare: blocksShareData,
                                blocksFound: blocksFoundData,
                                totalBlocksFound: totalBlocksFoundData,
                            };
                            const dataJSON = JSON.stringify(data);
                            response.writeHead(200, {
                                'Access-Control-Allow-Origin': corsOrigin,
                                'Cache-Control': 'no-cache',
                                'Content-Type': 'application/json',
                                'Content-Length': Buffer.byteLength(dataJSON, 'utf8'),
                            });
                            response.end(dataJSON);
                        });
                });
            })
            .catch((err) => {
                logRedisError('handleMinerStats', err);

                // multi().exec() may reject if some commands fail, but includes replies in error
                // Check if we have partial results we can use
                if (err && err.replies && Array.isArray(err.replies)) {
                    const replies = err.replies;
                    const workerData = replies[0];

                    // If we have worker data, we can still return partial results
                    if (workerData && typeof workerData === 'object' && Object.keys(workerData).length > 0) {
                        log('warn', logSystem, 'Some Redis commands failed but have partial data: %j', [
                            err.errorIndexes,
                        ]);

                        const stats = workerData;
                        
                        // Aggregate hashrate from all workers for this address
                        let totalHashrate = 0;
                        let totalRoundScore = 0;
                        let totalRoundHashes = 0;
                        
                        for (const minerKey in minerStats) {
                            // Check if this minerStats entry belongs to this address
                            if (minerKey === address || minerKey.startsWith(address + '~')) {
                                totalHashrate += minerStats[minerKey].hashrate || 0;
                                totalRoundScore += minerStats[minerKey].roundScore || 0;
                                totalRoundHashes += minerStats[minerKey].roundHashes || 0;
                            }
                        }
                        
                        stats.hashrate = totalHashrate;
                        stats.roundScore = totalRoundScore;
                        stats.roundHashes = totalRoundHashes;

                        const paymentsData =
                            replies[1] && typeof replies[1] === 'object' && !Array.isArray(replies[1])
                                ? replies[1]
                                : [];
                        const blocksShareData =
                            replies[4] && typeof replies[4] === 'object' && !Array.isArray(replies[4])
                                ? replies[4]
                                : [];
                        const blocksFoundData =
                            replies[5] && typeof replies[5] === 'object' && !Array.isArray(replies[5])
                                ? replies[5]
                                : [];
                        const totalBlocksFoundData = replies[6] !== null && replies[6] !== undefined ? replies[6] : 0;

                        const workersData = [];
                        if (replies[2] && Array.isArray(replies[2])) {
                            for (let i = 0; i < replies[2].length; i++) {
                                const key = replies[2][i];
                                const keyParts = key.split(':');
                                const miner = keyParts[2];
                                if (miner && miner.indexOf('~') !== -1) {
                                    const workerName = miner.substr(miner.indexOf('~') + 1, miner.length);
                                    const workerData = {
                                        name: workerName,
                                        hashrate: minerStats[miner]?.hashrate ? minerStats[miner].hashrate : 0,
                                    };
                                    workersData.push(workerData);
                                }
                            }
                        }

                        charts.getUserChartsData(address, paymentsData, (_error, chartsData) => {
                            const data = {
                                stats: stats,
                                payments: paymentsData,
                                charts: chartsData || {},
                                workers: workersData,
                                blocksShare: blocksShareData,
                                blocksFound: blocksFoundData,
                                totalBlocksFound: totalBlocksFoundData,
                            };
                            const dataJSON = JSON.stringify(data);
                            response.writeHead(200, {
                                'Access-Control-Allow-Origin': corsOrigin,
                                'Cache-Control': 'no-cache',
                                'Content-Type': 'application/json',
                                'Content-Length': Buffer.byteLength(dataJSON, 'utf8'),
                            });
                            response.end(dataJSON);
                        });
                        return;
                    }
                }

                // No usable data, return error
                log('error', logSystem, 'Error getting miner stats from redis: %j', [err]);
                const dataJSON = JSON.stringify({ error: 'Internal server error' });
                response.writeHead(200, {
                    'Access-Control-Allow-Origin': corsOrigin,
                    'Cache-Control': 'no-cache',
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(dataJSON, 'utf8'),
                });
                response.end(dataJSON);
            });
    }
}

/**
 * Return payments history
 **/
function handleGetPayments(urlParts, response) {
    let paymentKey = ':payments:all';

    if (urlParts.query.address) paymentKey = `:payments:${urlParts.query.address}`;

    // Input validation: Ensure time is a positive integer
    const time = parseInt(urlParts.query.time, 10);
    if (!time || time < 0 || !Number.isFinite(time)) {
        response.writeHead(400, {
            'Access-Control-Allow-Origin': corsOrigin,
            'Content-Type': 'application/json',
        });
        response.end(JSON.stringify({ error: 'Invalid time parameter' }));
        return;
    }

    redisClient
        .zRangeByScore(`${config.coin}${paymentKey}`, '-inf', `(${time}`, {
            REV: true,
            WITHSCORES: true,
            LIMIT: { offset: 0, count: config.api.payments },
        })
        .then((result) => {
            const data = result;
            const reply = JSON.stringify(data);

            response.writeHead('200', {
                'Access-Control-Allow-Origin': corsOrigin,
                'Cache-Control': 'no-cache',
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(reply, 'utf8'),
            });
            response.end(reply);
        })
        .catch((err) => {
            const _data = { error: 'Query failed' };
            const reply = JSON.stringify(_data);
            response.writeHead('200', {
                'Access-Control-Allow-Origin': corsOrigin,
                'Cache-Control': 'no-cache',
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(reply, 'utf8'),
            });
            response.end(reply);
        });
}

/**
 * Return blocks data
 **/
function handleGetBlocks(urlParts, response) {
    // Input validation: Ensure height is a positive integer
    const height = parseInt(urlParts.query.height, 10);
    if (!height || height < 0 || !Number.isFinite(height)) {
        response.writeHead(400, {
            'Access-Control-Allow-Origin': corsOrigin,
            'Content-Type': 'application/json',
        });
        response.end(JSON.stringify({ error: 'Invalid height parameter' }));
        return;
    }

    redisClient
        .zRangeByScore(`${config.coin}:blocks:matured`, '-inf', `(${height}`, {
            REV: true,
            WITHSCORES: true,
            LIMIT: { offset: 0, count: config.api.blocks },
        })
        .then((result) => {
            const data = result;
            const reply = JSON.stringify(data);

            response.writeHead('200', {
                'Access-Control-Allow-Origin': corsOrigin,
                'Cache-Control': 'no-cache',
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(reply, 'utf8'),
            });
            response.end(reply);
        })
        .catch((err) => {
            const _data = { error: 'Query failed' };
            const reply = JSON.stringify(_data);
            response.writeHead('200', {
                'Access-Control-Allow-Origin': corsOrigin,
                'Cache-Control': 'no-cache',
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(reply, 'utf8'),
            });
            response.end(reply);
        });
}

/**
 * Get market exchange prices
 **/
function handleGetMarket(urlParts, response) {
    response.writeHead(200, {
        'Access-Control-Allow-Origin': corsOrigin,
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
    });
    response.write('\n');

    const tickers = urlParts.query['tickers[]'] || urlParts.query.tickers;
    if (!tickers || tickers === undefined) {
        response.end(JSON.stringify({ error: 'No tickers specified.' }));
        return;
    }

    const exchange = urlParts.query.exchange || config.prices.source;
    if (!exchange || exchange === undefined) {
        response.end(JSON.stringify({ error: 'No exchange specified.' }));
        return;
    }

    // Get market prices
    market.get(exchange, tickers, (data) => {
        response.end(JSON.stringify(data));
    });
}

/**
 * Return top 10 miners
 **/
async function handleTopMiners(response) {
    try {
        const workerKeys = await redisClient.keys(`${config.coin}:workers:*`);

        // Get donation addresses to exclude
        const donationAddresses = getDonationAddresses();

        // Redis v4+ multi syntax
        const multi = redisClient.multi();
        for (const key of workerKeys) {
            multi.hGetAll(key);
        }
        const redisData = await multi.exec();

        const minersData = [];
        for (const i in redisData) {
            const keyParts = workerKeys[i].split(':');
            const address = keyParts[keyParts.length - 1];

            // Skip donation addresses
            if (donationAddresses.includes(address)) {
                continue;
            }

            const data = redisData[i];
            
            // Aggregate hashrate from all workers for this address
            let totalHashrate = 0;
            for (const minerKey in minerStats) {
                if (minerKey === address || minerKey.startsWith(address + '~')) {
                    totalHashrate += minerStats[minerKey].hashrate || 0;
                }
            }
            
            minersData.push({
                miner: `${address.substring(0, 7)}...${address.substring(address.length - 7)}`,
                hashrate: totalHashrate,
                lastShare: data?.lastShare || 0,
                hashes: data?.hashes || 0,
            });
        }

        minersData.sort(compareTopMiners);
        const topMiners = minersData.slice(0, 10);

        const reply = JSON.stringify(topMiners);

        response.writeHead(200, {
            'Access-Control-Allow-Origin': corsOrigin,
            'Cache-Control': 'no-cache',
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(reply, 'utf8'),
        });
        response.end(reply);
    } catch (error) {
        log('error', logSystem, 'Error in handleTopMiners: %j', [error]);
        response.writeHead(200, {
            'Access-Control-Allow-Origin': corsOrigin,
            'Content-Type': 'application/json',
        });
        response.end(JSON.stringify({ error: 'Error collecting top 10 miners stats' }));
    }
}

const compareTopMiners = (a, b) => {
    const v1 = a.hashrate ? parseInt(a.hashrate, 10) : 0;
    const v2 = b.hashrate ? parseInt(b.hashrate, 10) : 0;
    if (v1 > v2) return -1;
    if (v1 < v2) return 1;
    return 0;
};

/**
 * Miner settings: minimum payout level
 **/

// Get current minimum payout level
function handleGetMinerPayoutLevel(urlParts, response) {
    response.writeHead(200, {
        'Access-Control-Allow-Origin': corsOrigin,
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
    });
    response.write('\n');

    const address = urlParts.query.address;

    // Check the minimal required parameters for this handle.
    if (address === undefined) {
        response.end(JSON.stringify({ status: 'Parameters are incomplete' }));
        return;
    }

    // Return current miner payout level (Modern Redis client uses Promises)
    redisClient
        .hGet(`${config.coin}:workers:${address}`, 'minPayoutLevel')
        .then((value) => {
            let minLevel = config.payments.minPayment / config.coinUnits;
            if (minLevel < 0) minLevel = 0;

            const maxLevel = config.payments.maxPayment ? config.payments.maxPayment / config.coinUnits : null;

            let currentLevel = value ? value / config.coinUnits : minLevel;
            if (currentLevel < minLevel) currentLevel = minLevel;
            if (maxLevel && currentLevel > maxLevel) currentLevel = maxLevel;

            response.end(JSON.stringify({ status: 'done', level: currentLevel }));
        })
        .catch((error) => {
            log('error', logSystem, 'Error getting payout level: %j', [error]);
            response.end(JSON.stringify({ status: 'Unable to get the current minimum payout level from database' }));
        });
}

// Set minimum payout level
function handleSetMinerPayoutLevel(urlParts, response) {
    response.writeHead(200, {
        'Access-Control-Allow-Origin': corsOrigin,
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
    });
    response.write('\n');

    const address = urlParts.query.address;
    const ip = urlParts.query.ip;
    let level = urlParts.query.level;

    // Check the minimal required parameters for this handle.
    if (ip === undefined || address === undefined || level === undefined) {
        response.end(JSON.stringify({ status: 'Parameters are incomplete' }));
        return;
    }

    // Do not allow wildcards in the queries.
    if (ip.indexOf('*') !== -1 || address.indexOf('*') !== -1) {
        response.end(JSON.stringify({ status: 'Remove the wildcard from your miner address' }));
        return;
    }

    level = parseFloat(level);
    if (Number.isNaN(level)) {
        response.end(JSON.stringify({ status: "Your minimum payout level doesn't look like a number" }));
        return;
    }

    let minLevel = config.payments.minPayment / config.coinUnits;
    if (minLevel < 0) minLevel = 0;

    const maxLevel = config.payments.maxPayment ? config.payments.maxPayment / config.coinUnits : null;

    if (level < minLevel) {
        response.end(JSON.stringify({ status: `The minimum payout level is ${minLevel}` }));
        return;
    }

    if (maxLevel && level > maxLevel) {
        response.end(JSON.stringify({ status: `The maximum payout level is ${maxLevel}` }));
        return;
    }

    // Only do a modification if we have seen the IP address in combination with the wallet address.
    minerSeenWithIPForAddress(address, ip, (error, found) => {
        if (!found || error) {
            response.end(JSON.stringify({ status: "We haven't seen that IP for your address" }));
            return;
        }

        const payoutLevel = level * config.coinUnits;
        // Modern Redis client uses Promises
        redisClient
            .hSet(`${config.coin}:workers:${address}`, 'minPayoutLevel', payoutLevel)
            .then(() => {
                log('info', logSystem, `Updated minimum payout level for ${address} to: ${payoutLevel}`);
                response.end(JSON.stringify({ status: 'done' }));
            })
            .catch((error) => {
                log('error', logSystem, 'Error setting payout level: %j', [error]);
                response.end(JSON.stringify({ status: 'An error occurred when updating the value in our database' }));
            });
    });
}

/**
 * Miner settings: email notifications
 **/

// Get destination for email notifications
function handleGetMinerNotifications(urlParts, response) {
    response.writeHead(200, {
        'Access-Control-Allow-Origin': corsOrigin,
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
    });
    response.write('\n');

    const address = urlParts.query.address;

    // Check the minimal required parameters for this handle.
    if (address === undefined) {
        response.end(JSON.stringify({ status: 'Parameters are incomplete' }));
        return;
    }

    // Return current email for notifications (Modern Redis client uses Promises)
    redisClient
        .hGet(`${config.coin}:notifications`, address)
        .then((value) => {
            response.end(JSON.stringify({ status: 'done', email: value || '' }));
        })
        .catch((error) => {
            log('error', logSystem, 'Error getting email notifications: %j', [error]);
            response.end(JSON.stringify({ status: 'Unable to get current email from database' }));
        });
}

// Set email notifications
function handleSetMinerNotifications(urlParts, response) {
    response.writeHead(200, {
        'Access-Control-Allow-Origin': corsOrigin,
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
    });
    response.write('\n');

    const email = urlParts.query.email;
    const address = urlParts.query.address;
    const ip = urlParts.query.ip;
    const action = urlParts.query.action;

    // Check the minimal required parameters for this handle.
    if (ip === undefined || address === undefined || action === undefined) {
        response.end(JSON.stringify({ status: 'Parameters are incomplete' }));
        return;
    }

    // Do not allow wildcards in the queries.
    if (ip.indexOf('*') !== -1 || address.indexOf('*') !== -1) {
        response.end(JSON.stringify({ status: 'Remove the wildcard from your input' }));
        return;
    }

    // Check the action
    if (action === undefined || action === '' || (action !== 'enable' && action !== 'disable')) {
        response.end(JSON.stringify({ status: 'Invalid action' }));
        return;
    }

    // Now only do a modification if we have seen the IP address in combination with the wallet address.
    minerSeenWithIPForAddress(address, ip, (error, found) => {
        if (!found || error) {
            response.end(JSON.stringify({ status: "We haven't seen that IP for your address" }));
            return;
        }

        if (action === 'enable') {
            if (email === undefined) {
                response.end(JSON.stringify({ status: 'No email address specified' }));
                return;
            }
            // Modern Redis client uses Promises
            redisClient
                .hSet(`${config.coin}:notifications`, address, email)
                .then(() => {
                    log('info', logSystem, `Enable email notifications to ${email} for address: ${address}`);
                    notifications.sendToMiner(address, 'emailAdded', {
                        ADDRESS: address,
                        EMAIL: email,
                    });
                    response.end(JSON.stringify({ status: 'done' }));
                })
                .catch((error) => {
                    log('error', logSystem, 'Error enabling email notifications: %j', [error]);
                    response.end(JSON.stringify({ status: 'Unable to add email address in database' }));
                });
        } else if (action === 'disable') {
            // Modern Redis client uses Promises
            redisClient
                .hDel(`${config.coin}:notifications`, address)
                .then(() => {
                    log('info', logSystem, `Disabled email notifications for address: ${address}`);
                    response.end(JSON.stringify({ status: 'done' }));
                })
                .catch((error) => {
                    log('error', logSystem, 'Error disabling email notifications: %j', [error]);
                    response.end(JSON.stringify({ status: 'Unable to remove email address from database' }));
                });
        }
    });
}

/**
 * Miner settings: telegram notifications
 **/

// Get destination for telegram notifications
async function handleGetTelegramNotifications(urlParts, response) {
    response.writeHead(200, {
        'Access-Control-Allow-Origin': corsOrigin,
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
    });
    response.write('\n');

    const chatId = urlParts.query.chatId;
    const address = urlParts.query.address;
    const type = urlParts.query.type || 'miner';

    if (chatId === undefined || chatId === '') {
        response.end(JSON.stringify({ status: 'No chat id specified' }));
        return;
    }

    try {
        // Default miner address
        if (type === 'default') {
            const value = await redisClient.hGet(`${config.coin}:telegram:default`, chatId);
            response.end(JSON.stringify({ status: 'done', address: value }));
            return;
        }

        // Blocks notification
        if (type === 'blocks') {
            const value = await redisClient.hGet(`${config.coin}:telegram:blocks`, chatId);
            response.end(JSON.stringify({ status: 'done', enabled: +value }));
            return;
        }

        // Miner notification
        if (type === 'miner') {
            if (address === undefined || address === '') {
                response.end(JSON.stringify({ status: 'No miner address specified' }));
                return;
            }

            const value = await redisClient.hGet(`${config.coin}:telegram`, address);
            response.end(JSON.stringify({ status: 'done', chatId: value }));
            return;
        }
    } catch (error) {
        log('error', logSystem, 'Error getting telegram settings: %j', [error]);
        response.end(JSON.stringify({ status: 'Unable to get telegram settings from database' }));
    }
}

// Enable/disable telegram notifications
async function handleSetTelegramNotifications(urlParts, response) {
    response.writeHead(200, {
        'Access-Control-Allow-Origin': corsOrigin,
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
    });
    response.write('\n');

    const chatId = urlParts.query.chatId;
    const type = urlParts.query.type || 'miner';
    const action = urlParts.query.action;
    const address = urlParts.query.address;

    // Check chat id
    if (chatId === undefined || chatId === '') {
        response.end(JSON.stringify({ status: 'No chat id specified' }));
        return;
    }

    // Check action
    if (
        type !== 'default' &&
        (action === undefined || action === '' || (action !== 'enable' && action !== 'disable'))
    ) {
        response.end(JSON.stringify({ status: 'Invalid action' }));
        return;
    }

    try {
        // Default miner address
        if (type === 'default') {
            if (address === undefined || address === '') {
                response.end(JSON.stringify({ status: 'No miner address specified' }));
                return;
            }

            await redisClient.hSet(`${config.coin}:telegram:default`, chatId, address);
            response.end(JSON.stringify({ status: 'done' }));
            return;
        }

        // Blocks notification
        if (type === 'blocks') {
            // Enable
            if (action === 'enable') {
                await redisClient.hSet(`${config.coin}:telegram:blocks`, chatId, '1');
                log('info', logSystem, `Enabled telegram notifications for blocks to ${chatId}`);
                response.end(JSON.stringify({ status: 'done' }));
                return;
            }

            // Disable
            else if (action === 'disable') {
                await redisClient.hDel(`${config.coin}:telegram:blocks`, chatId);
                log('info', logSystem, `Disabled telegram notifications for blocks to ${chatId}`);
                response.end(JSON.stringify({ status: 'done' }));
                return;
            }
        }

        // Miner notification
        if (type === 'miner') {
            if (address === undefined || address === '') {
                response.end(JSON.stringify({ status: 'No miner address specified' }));
                return;
            }

            const exists = await redisClient.exists(`${config.coin}:workers:${address}`);
            if (!exists) {
                response.end(JSON.stringify({ status: 'Miner not found in database' }));
                return;
            }

            // Enable
            if (action === 'enable') {
                await redisClient.hSet(`${config.coin}:telegram`, address, chatId);
                log('info', logSystem, `Enabled telegram notifications to ${chatId} for address: ${address}`);
                response.end(JSON.stringify({ status: 'done' }));
                return;
            }

            // Disable
            else if (action === 'disable') {
                await redisClient.hDel(`${config.coin}:telegram`, address);
                log('info', logSystem, `Disabled telegram notifications for address: ${address}`);
                response.end(JSON.stringify({ status: 'done' }));
                return;
            }
        }
    } catch (error) {
        log('error', logSystem, 'Error setting telegram settings: %j', [error]);
        response.end(JSON.stringify({ status: 'Unable to set telegram settings in database' }));
    }
}

/**
 * Return miners hashrate
 **/
const handleGetMinersHashrate = (response) => {
    const data = {};
    
    // Aggregate hashrate from all workers (with and without names) per address
    for (const miner in minersHashrate) {
        const address = miner.indexOf('~') !== -1 ? miner.split('~')[0] : miner;
        data[address] = (data[address] || 0) + minersHashrate[miner];
    }

    const result = {
        minersHashrate: data,
    };

    const reply = JSON.stringify(result);

    response.writeHead('200', {
        'Access-Control-Allow-Origin': corsOrigin,
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(reply, 'utf8'),
    });
    response.end(reply);
};

/**
 * Return workers hashrate
 **/
const handleGetWorkersHashrate = (response) => {
    const data = {};
    for (const miner in minersHashrate) {
        if (miner.indexOf('~') === -1) continue;
        data[miner] = minersHashrate[miner];
    }

    const reply = JSON.stringify({
        workersHashrate: data,
    });

    response.writeHead('200', {
        'Access-Control-Allow-Origin': corsOrigin,
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
        'Content-Length': reply.length,
    });
    response.end(reply);
};

/**
 * Get list of donation addresses (pool fee + dev donations)
 **/
const getDonationAddresses = () => {
    const addresses = [];

    // Pool fee wallet
    if (config.blockUnlocker && config.blockUnlocker.poolFee) {
        const feeWallet = config.poolServer.poolAddress;
        if (feeWallet) addresses.push(feeWallet);
    }

    // Dev donation wallets
    if (config.blockUnlocker && config.blockUnlocker.devDonation) {
        for (const wallet in global.donations || {}) {
            addresses.push(wallet);
        }
    }

    return addresses;
};

/**
 * Log Redis errors with detailed information if available
 **/
const logRedisError = (context, error) => {
    if (error.errorIndexes && Array.isArray(error.errorIndexes)) {
        log('error', logSystem, '%s MULTI/EXEC failed: %d command(s) failed at indexes: %j', [
            context,
            error.errorIndexes.length,
            error.errorIndexes,
        ]);
        if (error.replies && Array.isArray(error.replies)) {
            error.errorIndexes.forEach((idx) => {
                if (error.replies[idx] && error.replies[idx].message) {
                    log('error', logSystem, '  %s command %d error: %s', [context, idx, error.replies[idx].message]);
                } else if (error.replies[idx]) {
                    log('error', logSystem, '  %s command %d error: %j', [context, idx, error.replies[idx]]);
                }
            });
        }
    } else {
        log('error', logSystem, '%s error: %j', [context, error]);
    }
};

/**
 * RPC monitoring of daemon and wallet
 **/

// Get monitoring data key for Redis
const getMonitoringDataKey = (module) => {
    return `${config.coin}:status:${module}`;
};

// Start RPC monitoring
const startRpcMonitoring = (rpc, module, method, interval, params = {}) => {
    setInterval(() => {
        rpc(method, params, async (error, response) => {
            const stat = {
                lastCheck: (Date.now() / 1000) | 0,
                lastStatus: error ? 'fail' : 'ok',
                lastResponse: JSON.stringify(error ? error : response),
            };
            if (error) {
                stat.lastFail = stat.lastCheck;
                stat.lastFailResponse = stat.lastResponse;
            }

            try {
                const key = getMonitoringDataKey(module);
                // Use hSet with multiple field-value pairs
                await redisClient.hSet(key, stat);
                log('debug', logSystem, 'Monitoring data saved for %s: %s', [module, stat.lastStatus]);
            } catch (redisError) {
                log('error', logSystem, 'Error saving monitoring data for %s: %j', [module, redisError]);
            }
        });
    }, interval * 1000);
};

// Return monitoring data key
// Initialize monitoring
function initMonitoring() {
    const modulesRpc = {
        daemon: apiInterfaces.rpcDaemon,
        wallet: apiInterfaces.rpcWallet,
    };
    const daemonType = config.daemonType ? config.daemonType.toLowerCase() : 'default';
    const coin = config.coin ? config.coin.toLowerCase() : '';
    for (const module in config.monitoring) {
        const settings = config.monitoring[module];
        if (daemonType === 'bytecoin' && module === 'wallet' && settings.rpcMethod === 'getbalance') {
            settings.rpcMethod = 'getBalance';
        }
        if ((coin === 'conceal' || coin === 'ccx') && module === 'wallet' && settings.rpcMethod === 'getbalance') {
            settings.rpcMethod = 'getBalance';
        }
        if (settings.checkInterval) {
            let rpcParams = {};
            if ((coin === 'conceal' || coin === 'ccx') && module === 'wallet' && settings.rpcMethod === 'getBalance') {
                rpcParams = { address: config.poolServer.poolAddress };
            }
            startRpcMonitoring(modulesRpc[module], module, settings.rpcMethod, settings.checkInterval, rpcParams);
        }
    }
}

/**
 * Return pool public ports
 **/
const getPublicPorts = (ports) => {
    return ports.filter((port) => !port.hidden);
};

/**
 * Check if a miner has been seen with specified IP address
 **/
const minerSeenWithIPForAddress = (address, ip, callback) => {
    const ipv4_regex = /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/;
    let ipAddress = ip;
    if (ipv4_regex.test(ipAddress)) {
        ipAddress = `::ffff:${ipAddress}`;
    }
    // Modern Redis client uses Promises
    redisClient
        .sIsMember(`${config.coin}:workers_ip:${address}`, ipAddress)
        .then((result) => {
            const found = result > 0;
            callback(null, found);
        })
        .catch((error) => {
            callback(error, false);
        });
};

/**
 * Parse cookies data
 **/
/**
 * Start pool API
 **/

// Initialize admin handler with dependencies
const adminHandler = new AdminHandler({
    config: config,
    log: log,
    logSystem: 'adminHandler',
    redisClient: redisClient,
    corsOrigin: corsOrigin,
    minerStats: minerStats,
    apiInterfaces: apiInterfaces,
    notifications: notifications,
    utils: utils,
    getNetworkDataPromise: getNetworkDataPromise,
});

// Collect statistics for the first time
collectStats();

// Initialize RPC monitoring
initMonitoring();

// Enable to be bind to a certain ip or all by default
const bindIp = config.api.bindIp ? config.api.bindIp : '0.0.0.0';

// Start API on HTTP port
const server = http.createServer((request, response) => {
    if (request.method.toUpperCase() === 'OPTIONS') {
        response.writeHead('204', 'No Content', {
            'Access-Control-Allow-Origin': corsOrigin,
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization',
            'Access-Control-Allow-Credentials': 'true',
            'Access-Control-Max-Age': 86400, // Seconds.
            'content-length': 0,
        });
        return response.end();
    }

    handleServerRequest(request, response);
});

server.listen(config.api.port, bindIp, () => {
    log('info', logSystem, 'API started & listening on %s port %d', [bindIp, config.api.port]);
});

// Start API on SSL port
if (config.api.ssl) {
    if (!config.api.sslCert) {
        log('error', logSystem, 'Could not start API listening on %s port %d (SSL): SSL certificate not configured', [
            bindIp,
            config.api.sslPort,
        ]);
    } else if (!config.api.sslKey) {
        log('error', logSystem, 'Could not start API listening on %s port %d (SSL): SSL key not configured', [
            bindIp,
            config.api.sslPort,
        ]);
    } else if (!config.api.sslCA) {
        log(
            'error',
            logSystem,
            'Could not start API listening on %s port %d (SSL): SSL certificate authority not configured',
            [bindIp, config.api.sslPort]
        );
    } else if (!fs.existsSync(config.api.sslCert)) {
        log(
            'error',
            logSystem,
            'Could not start API listening on %s port %d (SSL): SSL certificate file not found (configuration error)',
            [bindIp, config.api.sslPort]
        );
    } else if (!fs.existsSync(config.api.sslKey)) {
        log(
            'error',
            logSystem,
            'Could not start API listening on %s port %d (SSL): SSL key file not found (configuration error)',
            [bindIp, config.api.sslPort]
        );
    } else if (!fs.existsSync(config.api.sslCA)) {
        log(
            'error',
            logSystem,
            'Could not start API listening on %s port %d (SSL): SSL certificate authority file not found (configuration error)',
            [bindIp, config.api.sslPort]
        );
    } else {
        const options = {
            key: fs.readFileSync(config.api.sslKey),
            cert: fs.readFileSync(config.api.sslCert),
            ca: fs.readFileSync(config.api.sslCA),
            honorCipherOrder: true,
        };

        const ssl_server = https.createServer(options, (request, response) => {
            if (request.method.toUpperCase() === 'OPTIONS') {
                response.writeHead('204', 'No Content', {
                    'Access-Control-Allow-Origin': corsOrigin,
                    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization',
                    'Access-Control-Allow-Credentials': 'true',
                    'Access-Control-Max-Age': 86400, // Seconds.
                    'content-length': 0,
                    'strict-transport-security': 'max-age=604800',
                });
                return response.end();
            }

            handleServerRequest(request, response);
        });

        ssl_server.listen(config.api.sslPort, bindIp, () => {
            log('info', logSystem, 'API started & listening on %s port %d (SSL)', [bindIp, config.api.sslPort]);
        });
    }
}
