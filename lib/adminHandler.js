/**
 * Cryptonote Node.JS Pool
 * https://github.com/dvandal/cryptonote-nodejs-pool
 *
 * Admin Handler Module - All administration endpoints
 **/

// Load required modules
const fs = require('node:fs');
const path = require('node:path');

/**
 * AdminHandler class
 * Handles all administration endpoints for the pool
 **/
class AdminHandler {
    constructor(dependencies) {
        // Store dependencies
        this.config = dependencies.config;
        this.log = dependencies.log;
        this.logSystem = dependencies.logSystem || 'adminHandler';
        this.redisClient = dependencies.redisClient;
        this.corsOrigin = dependencies.corsOrigin;
        this.minerStats = dependencies.minerStats;
        this.apiInterfaces = dependencies.apiInterfaces;
        this.notifications = dependencies.notifications;
        this.utils = dependencies.utils;
        this.getNetworkDataPromise = dependencies.getNetworkDataPromise;
    }

    /**
     * Get donation addresses (pool fee + dev donations)
     **/
    getDonationAddresses() {
        const addresses = [];

        // Pool fee wallet
        if (this.config.blockUnlocker && this.config.blockUnlocker.poolFee) {
            const feeWallet = this.config.poolServer.poolAddress;
            if (feeWallet) addresses.push(feeWallet);
        }

        // Dev donation wallets
        if (this.config.blockUnlocker && this.config.blockUnlocker.devDonation) {
            for (const wallet in global.donations || {}) {
                addresses.push(wallet);
            }
        }

        return addresses;
    }

    /**
     * Get monitoring data key for Redis
     **/
    getMonitoringDataKey(module) {
        return `${this.config.coin}:status:${module}`;
    }

    /**
     * Get monitoring data for all configured modules
     **/
    async getMonitoringData(callback) {
        try {
            const modules = Object.keys(this.config.monitoring);
            const stats = {};

            // Get monitoring data for each module
            for (const module of modules) {
                const key = this.getMonitoringDataKey(module);
                const data = await this.redisClient.hGetAll(key);

                // Always return a module entry with all required fields
                if (data && Object.keys(data).length > 0) {
                    // Convert string values from Redis to proper types and ensure all fields exist
                    stats[module] = {
                        lastCheck: data.lastCheck ? parseInt(data.lastCheck, 10) : null,
                        lastStatus: data.lastStatus || 'unknown',
                        lastResponse: data.lastResponse || '',
                        lastFail: data.lastFail ? parseInt(data.lastFail, 10) : null,
                        lastFailResponse: data.lastFailResponse || '',
                    };
                } else {
                    // Return empty structure so frontend doesn't break
                    stats[module] = {
                        lastCheck: null,
                        lastStatus: 'pending',
                        lastResponse: '',
                        lastFail: null,
                        lastFailResponse: '',
                    };
                }
            }

            this.log('debug', this.logSystem, 'Retrieved monitoring data for modules: %j', [Object.keys(stats)]);
            callback(null, stats);
        } catch (error) {
            this.log('error', this.logSystem, 'Error getting monitoring data: %j', [error]);
            // Return empty structure for all configured modules
            const stats = {};
            for (const module of Object.keys(this.config.monitoring)) {
                stats[module] = {
                    lastCheck: null,
                    lastStatus: 'error',
                    lastResponse: '',
                    lastFail: null,
                    lastFailResponse: '',
                };
            }
            callback(null, stats);
        }
    }

    /**
     * Get list of log files
     **/
    getLogFiles(callback) {
        const dir = this.config.logging.files.directory;
        fs.readdir(dir, (error, files) => {
            const logs = {};
            for (const i in files) {
                const file = files[i];
                const stats = fs.statSync(`${dir}/${file}`);
                logs[file] = {
                    size: stats.size,
                    changed: (Date.parse(stats.mtime) / 1000) | 0,
                };
            }
            callback(error, logs);
        });
    }

    /**
     * Administration: return pool statistics
     **/
    async handleAdminStats(response) {
        response.writeHead(200, {
            'Access-Control-Allow-Origin': this.corsOrigin,
            'Access-Control-Allow-Credentials': 'true',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Content-Type': 'application/json',
        });

        try {
            // Get worker keys
            const workerKeys = await this.redisClient.keys(`${this.config.coin}:workers:*`);
            this.log('debug', this.logSystem, 'Admin stats: found %d worker keys', [workerKeys.length]);

            // Get unlocked blocks
            const blocks = await this.redisClient.zRange(`${this.config.coin}:blocks:matured`, 0, -1);
            this.log('debug', this.logSystem, 'Admin stats: found %d matured blocks', [blocks ? blocks.length : 0]);

            // Get pending blocks (candidates)
            const pendingBlocks = await this.redisClient.zRangeWithScores(
                `${this.config.coin}:blocks:candidates`,
                0,
                -1
            );
            this.log('debug', this.logSystem, 'Admin stats: pending blocks raw result length: %d', [
                pendingBlocks ? pendingBlocks.length : 0,
            ]);

            const stats = {
                totalOwed: 0,
                totalPaid: 0,
                totalRevenue: 0,
                totalDiff: 0,
                totalShares: 0,
                blocksOrphaned: 0,
                blocksUnlocked: 0,
                blocksPending: 0,
                totalWorkers: 0,
                donationAddresses: 0,
                walletBalance: 0,
                // Current pool activity
                currentMiners: 0,
                currentWorkers: 0,
                currentHashrate: 0,
                currentRoundScore: 0,
                currentRoundHashes: 0,
            };

            // Get donation addresses for filtering
            const donationAddresses = this.getDonationAddresses();

            // Count total registered workers (any address that has submitted shares)
            // Separate real miners from donation addresses
            let realMiners = 0;
            let donationCount = 0;

            if (workerKeys && workerKeys.length > 0) {
                for (const key of workerKeys) {
                    const keyParts = key.split(':');
                    const address = keyParts[keyParts.length - 1];

                    if (donationAddresses.includes(address)) {
                        donationCount++;
                    } else {
                        realMiners++;
                    }
                }
            }

            stats.totalWorkers = realMiners;
            stats.donationAddresses = donationCount;
            this.log('debug', this.logSystem, 'Admin stats: total workers: %d (real: %d, donations: %d)', [
                workerKeys?.length || 0,
                realMiners,
                donationCount,
            ]);

            // Get worker balances if there are workers
            if (workerKeys && workerKeys.length > 0) {
                for (const key of workerKeys) {
                    const data = await this.redisClient.hmGet(key, ['balance', 'paid']);
                    if (data && Array.isArray(data)) {
                        stats.totalOwed += parseInt(data[0], 10) || 0;
                        stats.totalPaid += parseInt(data[1], 10) || 0;
                    }
                }
                this.log('debug', this.logSystem, 'Admin stats: totalOwed=%d, totalPaid=%d', [
                    stats.totalOwed,
                    stats.totalPaid,
                ]);
            }

            // Count pending blocks (candidates waiting for confirmations)
            // Redis v4 with WITHSCORES returns just the values (scores are separate/omitted in array return)
            if (pendingBlocks && pendingBlocks.length > 0) {
                stats.blocksPending = pendingBlocks.length;
                this.log('info', this.logSystem, 'Admin stats: blocks pending: %d', [stats.blocksPending]);
            }

            if (blocks && blocks.length > 0) {
                for (let i = 0; i < blocks.length; i++) {
                    const block = blocks[i].split(':');
                    if (block[5]) {
                        stats.blocksUnlocked++;
                        stats.totalDiff += parseInt(block[2], 10);
                        stats.totalShares += parseInt(block[3], 10);
                        stats.totalRevenue += parseInt(block[5], 10);
                    } else {
                        stats.blocksOrphaned++;
                    }
                }
            }

            // Add current round shares to get overall luck (not just completed blocks)
            const roundScores = await this.redisClient.hGetAll(`${this.config.coin}:scores:roundCurrent`);
            let currentRoundShares = 0;
            if (roundScores) {
                for (const address in roundScores) {
                    currentRoundShares += parseInt(roundScores[address], 10) || 0;
                }
            }

            // Get current network difficulty for overall luck calculation
            let currentDifficulty = 0;
            try {
                const networkData = await this.getNetworkDataPromise();
                if (networkData && networkData.difficulty) {
                    currentDifficulty = parseInt(networkData.difficulty, 10);
                }
            } catch (err) {
                this.log('warn', this.logSystem, 'Could not get current difficulty for luck calculation: %j', [err]);
            }

            // Calculate overall luck including current round
            stats.currentRoundShares = currentRoundShares;
            stats.currentRoundDifficulty = currentDifficulty;
            stats.totalSharesIncludingCurrent = stats.totalShares + currentRoundShares;
            stats.totalDiffIncludingCurrent = stats.totalDiff + currentDifficulty;

            // Get current pool activity from Redis (same as collectStats does)
            const now = (Date.now() / 1000) | 0;
            const hashrateCutoff = now - this.config.api.hashrateWindow;

            // Get hashrate entries from Redis zset (just values, no scores needed for counting)
            const hashrates = await this.redisClient.zRange(`${this.config.coin}:hashrate`, 0, -1);
            this.log('debug', this.logSystem, 'Admin stats: found %d hashrate entries', [
                hashrates ? hashrates.length : 0,
            ]);

            // Reuse roundScores already fetched above for luck calculation
            this.log('debug', this.logSystem, 'Admin stats: found %d round score entries', [
                roundScores ? Object.keys(roundScores).length : 0,
            ]);

            // Process hashrate data - same logic as collectStats
            if (hashrates && hashrates.length > 0) {
                const minersHashrate = {};

                // Parse hashrate entries: format is "difficulty:address:timestamp" or "difficulty:address~worker:timestamp"
                for (const entry of hashrates) {
                    const hashParts = entry.split(':');
                    if (hashParts.length >= 2) {
                        const difficulty = parseInt(hashParts[0], 10) || 0;
                        const addressOrWorker = hashParts[1]; // Could be "address" or "address~worker"

                        minersHashrate[addressOrWorker] = (minersHashrate[addressOrWorker] || 0) + difficulty;
                    }
                }

                // Count miners and workers
                let totalShares = 0;
                const uniqueMiners = new Set();

                for (const miner in minersHashrate) {
                    const difficulty = minersHashrate[miner];
                    totalShares += difficulty;

                    // Extract address from "address" or "address~workername"
                    const address = miner.split('~')[0];
                    uniqueMiners.add(address);

                    // Count ALL entries as workers (both with and without worker names)
                    stats.currentWorkers++;
                }

                // Count unique miner addresses
                stats.currentMiners = uniqueMiners.size;

                // Calculate total hashrate (average over the hashrate window)
                stats.currentHashrate = Math.floor(totalShares / this.config.api.hashrateWindow);
            }

            // Process round scores
            if (roundScores) {
                for (const address in roundScores) {
                    const score = parseInt(roundScores[address], 10) || 0;
                    stats.currentRoundScore += score;
                    stats.currentRoundHashes += score;
                }
            }

            // Get wallet balance from wallet daemon
            try {
                const walletRpcResult = await new Promise((resolve, reject) => {
                    this.apiInterfaces.rpcWallet(
                        'getBalance',
                        { address: this.config.poolServer.poolAddress },
                        (error, result) => {
                            if (error) {
                                this.log('warn', this.logSystem, 'Failed to get wallet balance: %j', [error]);
                                resolve(null);
                            } else {
                                resolve(result);
                            }
                        },
                        6
                    );
                });

                if (walletRpcResult && walletRpcResult.availableBalance !== undefined) {
                    stats.walletBalance = parseInt(walletRpcResult.availableBalance, 10) || 0;
                }
            } catch (walletError) {
                this.log('warn', this.logSystem, 'Error getting wallet balance: %j', [walletError]);
                stats.walletBalance = 0;
            }

            // Calculate pool fee earnings (pool's actual profit from mining)
            // This is more accurate than totalRevenue - totalOwed - totalPaid,
            // which can be negative if manual payments were made from pre-existing wallet balance
            const poolFeePercent = this.config.payments.poolFee || 0.8; // default 0.8%
            stats.poolFeeEarned = Math.floor((stats.totalRevenue * poolFeePercent) / 100);

            this.log(
                'info',
                this.logSystem,
                'Admin stats: workers=%d, blocks=%d, revenue=%d, current miners=%d, current hashrate=%d, wallet=%d, poolFee=%d',
                [
                    stats.totalWorkers,
                    stats.blocksUnlocked,
                    stats.totalRevenue,
                    stats.currentMiners,
                    stats.currentHashrate,
                    stats.walletBalance,
                    stats.poolFeeEarned,
                ]
            );
            response.end(JSON.stringify(stats));
        } catch (error) {
            this.log('error', this.logSystem, 'Error collecting admin stats: %j', [error]);
            response.end(JSON.stringify({ error: 'Error collecting stats' }));
        }
    }

    /**
     * Administration: users list
     **/
    async handleAdminUsers(response) {
        response.writeHead(200, {
            'Access-Control-Allow-Origin': this.corsOrigin,
            'Access-Control-Allow-Credentials': 'true',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Content-Type': 'application/json',
        });

        try {
            // get workers Redis keys
            const workerKeys = await this.redisClient.keys(`${this.config.coin}:workers:*`);

            if (!workerKeys || workerKeys.length === 0) {
                response.end(JSON.stringify({}));
                return;
            }

            // Get donation addresses to exclude
            const donationAddresses = this.getDonationAddresses();

            // get workers data
            const workersData = {};
            for (const key of workerKeys) {
                const keyParts = key.split(':');
                const address = keyParts[keyParts.length - 1];

                // Skip donation addresses
                if (donationAddresses.includes(address)) {
                    this.log('debug', this.logSystem, 'Skipping donation address from users list: %s', [address]);
                    continue;
                }

                // Get all worker data
                const data = await this.redisClient.hGetAll(key);

                // Only include workers who have actually mined (have hashes or lastShare)
                if (!(data.hashes || data.lastShare)) {
                    continue;
                }

                // Aggregate hashrate from all workers for this address
                let totalHashrate = 0;
                let totalRoundScore = 0;
                let totalRoundHashes = 0;
                
                for (const minerKey in this.minerStats) {
                    // Check if this minerStats entry belongs to this address
                    if (minerKey === address || minerKey.startsWith(address + '~')) {
                        totalHashrate += this.minerStats[minerKey].hashrate || 0;
                        totalRoundScore += this.minerStats[minerKey].roundScore || 0;
                        totalRoundHashes += this.minerStats[minerKey].roundHashes || 0;
                    }
                }

                workersData[address] = {
                    pending: parseInt(data.balance, 10) || 0,
                    paid: parseInt(data.paid, 10) || 0,
                    lastShare: parseInt(data.lastShare, 10) || 0,
                    hashes: parseInt(data.hashes, 10) || 0,
                    hashrate: totalHashrate,
                    roundScore: totalRoundScore,
                    roundHashes: totalRoundHashes,
                };
            }

            this.log('info', this.logSystem, 'Admin users: returning %d workers, minerStats has %d entries', [
                Object.keys(workersData).length,
                Object.keys(this.minerStats).length,
            ]);
            response.end(JSON.stringify(workersData));
        } catch (error) {
            this.log('error', this.logSystem, 'Error collecting users stats: %j', [error]);
            response.end(JSON.stringify({ error: 'Error collecting users stats' }));
        }
    }

    /**
     * Administration: pool monitoring
     **/
    async handleAdminMonitoring(response) {
        response.writeHead(200, {
            'Access-Control-Allow-Origin': this.corsOrigin,
            'Access-Control-Allow-Credentials': 'true',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Content-Type': 'application/json',
        });

        try {
            // Get monitoring and log data in parallel using Promise.all
            const [monitoring, logs] = await Promise.all([
                new Promise((resolve, reject) =>
                    this.getMonitoringData((err, data) => (err ? reject(err) : resolve(data)))
                ),
                new Promise((resolve, reject) =>
                    this.getLogFiles((err, data) => (err ? reject(err) : resolve(data)))
                ),
            ]);

            const result = { monitoring, logs };
            this.log('info', this.logSystem, 'Admin monitoring: returning data with %d modules', [
                Object.keys(monitoring || {}).length,
            ]);
            response.end(JSON.stringify(result));
        } catch (error) {
            this.log('error', this.logSystem, 'Error in handleAdminMonitoring: %j', [error]);
            response.end(JSON.stringify({ monitoring: {}, logs: {} }));
        }
    }

    /**
     * Administration: log file data
     **/
    handleAdminLog(urlParts, response) {
        const file = urlParts.query.file;

        // Security: Prevent path traversal attacks
        // 1. Check for path traversal characters
        if (!file || file.includes('..') || file.includes('/') || file.includes('\\')) {
            response.writeHead(400, {
                'Access-Control-Allow-Origin': this.corsOrigin,
                'Content-Type': 'text/plain',
            });
            response.end('Invalid log file name');
            return;
        }

        // 2. Whitelist: Only allow alphanumeric, underscore, and .log extension
        if (!file.match(/^[a-zA-Z0-9_]+\.log$/)) {
            response.writeHead(400, {
                'Access-Control-Allow-Origin': this.corsOrigin,
                'Content-Type': 'text/plain',
            });
            response.end('Invalid log file format');
            return;
        }

        // 3. Use path.resolve to ensure file is within logs directory
        const logsDir = path.resolve(this.config.logging.files.directory);
        const filePath = path.resolve(logsDir, file);

        // 4. Verify the resolved path is still within the logs directory
        if (!filePath.startsWith(logsDir + path.sep)) {
            response.writeHead(403, {
                'Access-Control-Allow-Origin': this.corsOrigin,
                'Content-Type': 'text/plain',
            });
            response.end('Access denied');
            return;
        }

        // 5. Check if file exists before setting Content-Length
        if (!fs.existsSync(filePath)) {
            response.writeHead(404, {
                'Access-Control-Allow-Origin': this.corsOrigin,
                'Content-Type': 'text/plain',
            });
            response.end('Log file not found');
            return;
        }

        response.writeHead(200, {
            'Access-Control-Allow-Origin': this.corsOrigin,
            'Access-Control-Allow-Credentials': 'true',
            'Content-Type': 'text/plain',
            'Cache-Control': 'no-cache',
            'Content-Length': fs.statSync(filePath).size,
        });
        fs.createReadStream(filePath).pipe(response);
    }

    /**
     * Administration: pool ports usage
     **/
    async handleAdminPorts(response) {
        response.writeHead(200, {
            'Access-Control-Allow-Origin': this.corsOrigin,
            'Access-Control-Allow-Credentials': 'true',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Content-Type': 'application/json',
        });

        try {
            const portsKeys = await this.redisClient.keys(`${this.config.coin}:ports:*`);

            if (!portsKeys || portsKeys.length === 0) {
                response.end(JSON.stringify({}));
                return;
            }

            const portsData = {};

            for (const key of portsKeys) {
                const portMatch = key.match(/:ports:(\d+)$/);
                if (!portMatch) continue;

                const port = portMatch[1];
                const [workers, miners] = await Promise.all([
                    this.redisClient.hGet(key, 'users'),
                    this.redisClient.sCard(`${this.config.coin}:ports:${port}:miners`),
                ]);

                portsData[key] = {
                    port: port,
                    miners: miners || 0,
                    workers: parseInt(workers, 10) || 0,
                };
            }

            response.end(JSON.stringify(portsData));
        } catch (error) {
            this.log('error', this.logSystem, 'Error collecting ports stats: %j', [error]);
            response.end(JSON.stringify({ error: 'Error collecting Ports stats' }));
        }
    }

    /**
     * Administration: manual payment to a miner
     **/
    async handleAdminManualPayment(urlParts, response) {
        response.writeHead(200, {
            'Access-Control-Allow-Origin': this.corsOrigin,
            'Access-Control-Allow-Credentials': 'true',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Content-Type': 'application/json',
        });

        try {
            const address = urlParts.query.address;

            if (!address) {
                response.end(JSON.stringify({ status: 'error', message: 'No address provided' }));
                return;
            }

            // Get current balance
            const workerData = await this.redisClient.hGetAll(`${this.config.coin}:workers:${address}`);
            if (!workerData || !workerData.balance) {
                response.end(JSON.stringify({ status: 'error', message: 'No balance found for this address' }));
                return;
            }

            const balance = parseInt(workerData.balance, 10);
            const transferFee = this.config.payments.transferFee;

            // Check if balance is sufficient for payment
            if (balance <= transferFee) {
                response.end(
                    JSON.stringify({
                        status: 'error',
                        message: `Balance (${balance}) is too low. Must be greater than transfer fee (${transferFee})`,
                    })
                );
                return;
            }

            const amount = balance;
            const coin = this.config.coin.toLowerCase();
            const daemonType = this.config.daemonType ? this.config.daemonType.toLowerCase() : 'default';

            this.log('info', this.logSystem, 'Manual payment request for %s, balance: %d', [address, amount]);

            // Prepare payment transaction
            let rpcCommand = 'transfer';
            let rpcRequest = {
                destinations: [{ amount: amount, address: address }],
                fee: transferFee,
                mixin: this.config.payments.mixin || 5,
                unlock_time: 0,
            };

            // Conceal uses sendTransaction method
            if (coin === 'conceal' || coin === 'ccx') {
                rpcCommand = 'sendTransaction';
                rpcRequest = {
                    transfers: [{ amount: amount, address: address }],
                    fee: transferFee,
                    anonymity: this.config.payments.mixin || 5,
                    unlockTime: 0,
                    addresses: [this.config.poolServer.poolAddress], // Source address
                    changeAddress: this.config.poolServer.poolAddress, // Return change to pool
                };
            } else if (daemonType === 'bytecoin') {
                rpcCommand = 'sendTransaction';
                rpcRequest = {
                    transfers: [{ amount: amount, address: address }],
                    fee: transferFee,
                    anonymity: this.config.payments.mixin || 5,
                    unlockTime: 0,
                };
            }

            // Send payment via wallet RPC
            this.apiInterfaces.rpcWallet(rpcCommand, rpcRequest, async (error, result) => {
                if (error) {
                    this.log('error', this.logSystem, 'Error with manual payment RPC request: %j', [error]);
                    response.end(
                        JSON.stringify({
                            status: 'error',
                            message: `Payment failed: ${error.message || JSON.stringify(error)}`,
                        })
                    );
                    return;
                }

                const now = (Date.now() / 1000) | 0;
                // Conceal and bytecoin use transactionHash, standard uses tx_hash
                let txHash =
                    coin === 'conceal' || coin === 'ccx' || daemonType === 'bytecoin'
                        ? result.transactionHash
                        : result.tx_hash;

                // Security: Validate transaction hash format to prevent XSS
                // Transaction hashes must be 64-character hexadecimal strings
                if (!txHash || typeof txHash !== 'string') {
                    this.log('error', this.logSystem, 'Invalid transaction hash type from daemon');
                    response.end(JSON.stringify({ status: 'error', message: 'Invalid transaction hash' }));
                    return;
                }

                // Remove any whitespace
                txHash = txHash.trim();

                // Validate: must be exactly 64 hex characters
                if (!/^[0-9a-fA-F]{64}$/.test(txHash)) {
                    this.log('error', this.logSystem, 'Invalid transaction hash format: %s', [txHash]);
                    response.end(JSON.stringify({ status: 'error', message: 'Invalid transaction hash format' }));
                    return;
                }

                // Update Redis: reset balance to 0, increment paid amount, record payment
                try {
                    const multi = this.redisClient.multi();
                    multi.hSet(`${this.config.coin}:workers:${address}`, 'balance', '0');
                    multi.hIncrBy(`${this.config.coin}:workers:${address}`, 'paid', amount);
                    multi.zAdd(`${this.config.coin}:payments:all`, {
                        score: now,
                        value: [txHash, amount, transferFee, this.config.payments.mixin || 5, 1].join(':'),
                    });
                    multi.zAdd(`${this.config.coin}:payments:${address}`, {
                        score: now,
                        value: [txHash, amount, transferFee, this.config.payments.mixin || 5].join(':'),
                    });
                    await multi.exec();

                    this.log('info', this.logSystem, 'Manual payment of %d to %s successful, txHash: %s', [
                        amount,
                        address,
                        txHash,
                    ]);

                    // Send notification
                    this.notifications.sendToMiner(address, 'payment', {
                        ADDRESS: address.substring(0, 7) + '...' + address.substring(address.length - 7),
                        AMOUNT: this.utils.getReadableCoins(amount),
                    });

                    response.end(
                        JSON.stringify({
                            status: 'success',
                            txHash: txHash,
                            amount: amount,
                            message: `Payment of ${this.utils.getReadableCoins(amount)} sent successfully`,
                        })
                    );
                } catch (redisError) {
                    this.log('error', this.logSystem, 'CRITICAL: Payment sent but Redis update failed! TxHash: %s, Error: %j', [
                        txHash,
                        redisError,
                    ]);
                    response.end(
                        JSON.stringify({
                            status: 'warning',
                            txHash: txHash,
                            amount: amount,
                            message: `Payment sent but database update failed. Please verify manually. TxHash: ${txHash}`,
                        })
                    );
                }
            }, 19);
        } catch (error) {
            this.log('error', this.logSystem, 'Error in manual payment handler: %j', [error]);
            response.end(JSON.stringify({ status: 'error', message: 'Internal server error' }));
        }
    }

    /**
     * Administration: test email notification
     **/
    handleTestEmailNotification(urlParts, response) {
        response.writeHead(200, {
            'Access-Control-Allow-Origin': this.corsOrigin,
            'Access-Control-Allow-Credentials': 'true',
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache',
        });

        const email = urlParts.query.email;
        if (!this.config.email) {
            response.end(JSON.stringify({ status: 'Email system is not configured' }));
            return;
        }
        if (!this.config.email.enabled) {
            response.end(JSON.stringify({ status: 'Email system is not enabled' }));
            return;
        }
        if (!email) {
            response.end(JSON.stringify({ status: 'No email specified' }));
            return;
        }
        this.log('info', this.logSystem, 'Sending test e-mail notification to %s', [email]);
        this.notifications.sendToEmail(email, 'test', {});
        response.end(JSON.stringify({ status: 'done' }));
    }

    /**
     * Administration: test telegram notification
     **/
    handleTestTelegramNotification(_urlParts, response) {
        response.writeHead(200, {
            'Access-Control-Allow-Origin': this.corsOrigin,
            'Access-Control-Allow-Credentials': 'true',
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache',
        });

        if (!this.config.telegram) {
            response.end(JSON.stringify({ status: 'Telegram is not configured' }));
            return;
        }
        if (!this.config.telegram.enabled) {
            response.end(JSON.stringify({ status: 'Telegram is not enabled' }));
            return;
        }
        if (!this.config.telegram.token) {
            response.end(JSON.stringify({ status: 'No telegram bot token specified in configuration' }));
            return;
        }
        if (!this.config.telegram.channel) {
            response.end(JSON.stringify({ status: 'No telegram channel specified in configuration' }));
            return;
        }
        this.log('info', this.logSystem, 'Sending test telegram channel notification');
        this.notifications.sendToTelegramChannel('test', {});
        response.end(JSON.stringify({ status: 'done' }));
    }

    /**
     * Administration: get wallet balance
     **/
    handleAdminWalletBalance(response) {
        response.writeHead(200, {
            'Access-Control-Allow-Origin': this.corsOrigin,
            'Access-Control-Allow-Credentials': 'true',
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache',
        });

        this.log('info', this.logSystem, 'Getting wallet balance for pool address: %s', [
            this.config.poolServer.poolAddress,
        ]);

        this.apiInterfaces.rpcWallet('getBalance', { address: this.config.poolServer.poolAddress }, (error, result) => {
            if (error) {
                this.log('error', this.logSystem, 'Error getting wallet balance: %j', [error]);
                response.end(JSON.stringify({ error: error.message || 'Failed to get wallet balance' }));
                return;
            }

            this.log('info', this.logSystem, 'Wallet balance retrieved: %j', [result]);
            
            // Add pool address to the response for frontend display
            const responseData = {
                ...result,
                address: this.config.poolServer.poolAddress
            };
            
            response.end(JSON.stringify(responseData));
        }, 6);
    }

    /**
     * Administration: estimate fusion transaction
     **/
    handleAdminEstimateFusion(urlParts, response) {
        response.writeHead(200, {
            'Access-Control-Allow-Origin': this.corsOrigin,
            'Access-Control-Allow-Credentials': 'true',
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache',
        });

        const threshold = parseInt(urlParts.query.threshold, 10);

        if (!threshold || threshold < 1) {
            response.end(JSON.stringify({ error: 'Invalid threshold value' }));
            return;
        }

        this.log('info', this.logSystem, 'Estimating fusion for threshold: %d, address: %s', [
            threshold,
            this.config.poolServer.poolAddress,
        ]);

        const rpcRequest = {
            threshold: threshold,
            addresses: [this.config.poolServer.poolAddress],
        };

        this.apiInterfaces.rpcWallet('estimateFusion', rpcRequest, (error, result) => {
            if (error) {
                this.log('error', this.logSystem, 'Error estimating fusion: %j', [error]);
                response.end(JSON.stringify({ error: error.message || 'Failed to estimate fusion' }));
                return;
            }

            this.log('info', this.logSystem, 'Fusion estimation result: %j', [result]);
            response.end(JSON.stringify(result));
        }, 4);
    }

    /**
     * Administration: send fusion transaction
     **/
    handleAdminSendFusion(urlParts, response) {
        response.writeHead(200, {
            'Access-Control-Allow-Origin': this.corsOrigin,
            'Access-Control-Allow-Credentials': 'true',
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache',
        });

        const threshold = parseInt(urlParts.query.threshold, 10);

        if (!threshold || threshold < 1) {
            response.end(JSON.stringify({ error: 'Invalid threshold value' }));
            return;
        }

        this.log('info', this.logSystem, 'Sending fusion transaction for threshold: %d, address: %s', [
            threshold,
            this.config.poolServer.poolAddress,
        ]);

        const rpcRequest = {
            anonymity: 0,
            threshold: threshold,
            addresses: [this.config.poolServer.poolAddress],
            destinationAddress: this.config.poolServer.poolAddress,
        };

        this.apiInterfaces.rpcWallet('sendFusionTransaction', rpcRequest, (error, result) => {
            if (error) {
                this.log('error', this.logSystem, 'Error sending fusion transaction: %j', [error]);
                response.end(JSON.stringify({ error: error.message || 'Failed to send fusion transaction' }));
                return;
            }

            this.log('info', this.logSystem, 'Fusion transaction result: %j', [result]);
            response.end(JSON.stringify(result));
        }, 18);
    }
}

module.exports = AdminHandler;
