/**
 * Cryptonote Node.JS Pool
 * https://github.com/dvandal/cryptonote-nodejs-pool
 *
 * Payments processor
 **/

// Load required modules
const fs = require('node:fs');
const async = require('async');

const apiInterfaces = require('./apiInterfaces.js')(config.daemon, config.wallet, config.api);
const notifications = require('./notifications.js');
const utils = require('./utils.js');

// Initialize log system
const logSystem = 'payments';
require('./exceptionWriter.js')(logSystem);

/**
 * Run payments processor
 **/
 
log('info', logSystem, 'Started');

if (!config.poolServer.paymentId) config.poolServer.paymentId = {};
if (!config.poolServer.paymentId.addressSeparator) config.poolServer.paymentId.addressSeparator = "+";
if (!config.payments.priority) config.payments.priority = 0;

// Mutex to prevent concurrent executions (race condition fix - prevents double payments!)
let isRunning = false;

async function runInterval(){
    // Prevent concurrent executions that would send payments multiple times
    if (isRunning) {
        log('warn', logSystem, 'Payment processor already running, skipping this interval');
        setTimeout(runInterval, config.payments.interval * 1000);
        return;
    }
    
    isRunning = true;
    try {
        // Get worker keys (Redis v4+)
        const keys = await redisClient.keys(config.coin + ':workers:*');
        if (!keys || keys.length === 0) {
            log('info', logSystem, 'No workers found for payment processing');
            isRunning = false;
            setTimeout(runInterval, config.payments.interval * 1000);
            return;
        }

        // Get worker balances (Redis v4+ multi syntax)
        const balanceMulti = redisClient.multi();
        for (const key of keys) {
            balanceMulti.hGet(key, 'balance');
        }
        const balanceReplies = await balanceMulti.exec();

        const balances = {};
        for (const [i, reply] of balanceReplies.entries()) {
            const parts = keys[i].split(':');
            const workerId = parts[parts.length - 1];
            balances[workerId] = parseInt(reply, 10) || 0;
        }

        // Get worker minimum payout (Redis v4+ multi syntax)
        const payoutMulti = redisClient.multi();
        for (const key of keys) {
            payoutMulti.hGet(key, 'minPayoutLevel');
        }
        const payoutReplies = await payoutMulti.exec();
        
        log('info', logSystem, 'DEBUG: payoutReplies raw data: %j', [payoutReplies]);

        const minPayoutLevel = {};
        for (const [i, reply] of payoutReplies.entries()) {
            const parts = keys[i].split(':');
            const workerId = parts[parts.length - 1];
            
            log('info', logSystem, 'DEBUG: Processing worker %s, reply type=%s, reply value=%j', [workerId, typeof reply, reply]);

            const minLevel = config.payments.minPayment;
            const maxLevel = config.payments.maxPayment;
            const defaultLevel = minLevel;

            let payoutLevel = parseInt(reply, 10) || minLevel;
            log('info', logSystem, 'DEBUG: Worker %s - parseInt(reply)=%d, payoutLevel=%d, minLevel=%d', [workerId, parseInt(reply, 10), payoutLevel, minLevel]);
            
            if (payoutLevel < minLevel) payoutLevel = minLevel;
            if (maxLevel && payoutLevel > maxLevel) payoutLevel = maxLevel;
            minPayoutLevel[workerId] = payoutLevel;

            if (payoutLevel !== defaultLevel) {
                log('info', logSystem, 'Using payout level of %s for %s (default: %s)', [ utils.getReadableCoins(minPayoutLevel[workerId]), workerId, utils.getReadableCoins(defaultLevel) ]);
            } else {
                log('info', logSystem, 'DEBUG: Worker %s using DEFAULT level (reply was: %j)', [workerId, reply]);
            }
        }

        // Continue with rest of waterfall logic
        await processPayments(balances, minPayoutLevel);
    } catch (error) {
        log('error', logSystem, 'Error in runInterval: %j', [error]);
        isRunning = false;  // Release lock on error
        setTimeout(runInterval, config.payments.interval * 1000);
    }
}

async function processPayments(balances, minPayoutLevel) {
    async.waterfall([

        // Filter workers under balance threshold for payment
        (callback) => {
            const payments = {};
            
            log('info', logSystem, 'DEBUG: Processing payments, balances: %j', [balances]);
            log('info', logSystem, 'DEBUG: minPayoutLevel: %j', [minPayoutLevel]);

            for (const worker in balances){
                const balance = balances[worker];
                const threshold = minPayoutLevel[worker];
                log('info', logSystem, 'DEBUG: Worker %s - balance=%d (%s CCX), threshold=%d (%s CCX), balance>=threshold: %s', 
                    [worker, balance, utils.getReadableCoins(balance), threshold, utils.getReadableCoins(threshold), balance >= threshold]);
                
                if (balance >= minPayoutLevel[worker]){
                    const remainder = balance % config.payments.denomination;
                    let payout = balance - remainder;

                    if (config.payments.dynamicTransferFee && config.payments.minerPayFee){
                        payout -= config.payments.transferFee;
                    }
                    log('info', logSystem, 'DEBUG: Worker %s - payout after fees/denomination: %d', [worker, payout]);
                    if (payout < 0) continue;

                    payments[worker] = payout;
                }
            }

            if (Object.keys(payments).length === 0){
                log('info', logSystem, 'No workers\' balances reached the minimum payment threshold');
                callback(true);
                return;
            }

            const transferCommands = [];
            let addresses = 0;
            let commandAmount = 0;
            let commandIndex = 0;
            
            for (const worker in payments){
                let amount = parseInt(payments[worker], 10);
                if(config.payments.maxTransactionAmount && amount + commandAmount > config.payments.maxTransactionAmount) {
                    amount = config.payments.maxTransactionAmount - commandAmount;
                }
                
                let address = worker;
                let payment_id = null;

                let with_payment_id = false;

                const addr = address.split(config.poolServer.paymentId.addressSeparator);
                if ((addr.length === 1 && utils.isIntegratedAddress(address)) || addr.length >= 2){
                    with_payment_id = true;
                    if (addr.length >= 2){
                        address = addr[0];
                        payment_id = addr[1];
                        payment_id = payment_id.replace(/[^A-Za-z0-9]/g,'');
                        if (payment_id.length !== 16 && payment_id.length !== 64) {
                            with_payment_id = false;
                            payment_id = null;
                        }
                    }
                    if (addresses > 0){
                        commandIndex++;
                        addresses = 0;
                        commandAmount = 0;
                    }
                }

                if (config.poolServer.fixedDiff && config.poolServer.fixedDiff.enabled) {
                    const addr = address.split(config.poolServer.fixedDiff.addressSeparator);
                    if (addr.length >= 2) address = addr[0];
                }

                if(!transferCommands[commandIndex]) {
                    transferCommands[commandIndex] = {
                        redis: [],
                        amount : 0,
                        rpc: {
                            destinations: [],
                            fee: config.payments.transferFee,
                            mixin: config.payments.mixin || 5,
                            priority: config.payments.priority,
                            unlock_time: 0
                        }
                    };
                }

                transferCommands[commandIndex].rpc.destinations.push({amount: amount, address: address});
                if (payment_id) transferCommands[commandIndex].rpc.payment_id = payment_id;

                transferCommands[commandIndex].redis.push(['hincrby', config.coin + ':workers:' + worker, 'balance', -amount]);
                if(config.payments.dynamicTransferFee && config.payments.minerPayFee){
                    transferCommands[commandIndex].redis.push(['hincrby', config.coin + ':workers:' + worker, 'balance', -config.payments.transferFee]);
                }
                transferCommands[commandIndex].redis.push(['hincrby', config.coin + ':workers:' + worker, 'paid', amount]);
                transferCommands[commandIndex].amount += amount;

                addresses++;
                commandAmount += amount;

                if (config.payments.dynamicTransferFee){
                    transferCommands[commandIndex].rpc.fee = config.payments.transferFee * addresses;
                }

                if (addresses >= config.payments.maxAddresses || (config.payments.maxTransactionAmount && commandAmount >= config.payments.maxTransactionAmount) || with_payment_id) {
                    commandIndex++;
                    addresses = 0;
                    commandAmount = 0;
                }
            }

            let timeOffset = 0;
            const notify_miners = [];

            const daemonType = config.daemonType ? config.daemonType.toLowerCase() : "default";
            const coin = config.coin ? config.coin.toLowerCase() : "";

            async.filter(transferCommands, (transferCmd, cback) => {
                let rpcCommand = "transfer";
                let rpcRequest = transferCmd.rpc;

                // Conceal uses sendTransaction method (similar to bytecoin)
                if (coin === "conceal" || coin === "ccx") {
                    rpcCommand = "sendTransaction";
                    rpcRequest = {
                        transfers: transferCmd.rpc.destinations,
                        fee: transferCmd.rpc.fee,
                        anonymity: transferCmd.rpc.mixin,
                        unlockTime: transferCmd.rpc.unlock_time,
                        addresses: [config.poolServer.poolAddress], // Source address for fees
                        changeAddress: config.poolServer.poolAddress // Return change to pool
                    };
                    if (transferCmd.rpc.payment_id) {
                        rpcRequest.paymentId = transferCmd.rpc.payment_id;
                    }
                }
                else if (daemonType === "bytecoin") {
                    rpcCommand = "sendTransaction";
                    rpcRequest = {
                        transfers: transferCmd.rpc.destinations,
                        fee: transferCmd.rpc.fee,
                        anonymity: transferCmd.rpc.mixin,
                        unlockTime: transferCmd.rpc.unlock_time
                    };
                    if (transferCmd.rpc.payment_id) {
                        rpcRequest.paymentId = transferCmd.rpc.payment_id;
                    }
                }

                apiInterfaces.rpcWallet(rpcCommand, rpcRequest, (error, result) => {
                    if (error){
                        log('error', logSystem, 'Error with %s RPC request to wallet daemon %j', [rpcCommand, error]);
                        log('error', logSystem, 'Payments failed to send to %j', transferCmd.rpc.destinations);
                        cback(false);
                        return;
                    }

                    const now = (timeOffset++) + Date.now() / 1000 | 0;
                    // Conceal and bytecoin use transactionHash, standard uses tx_hash
                    let txHash = (coin === "conceal" || coin === "ccx" || daemonType === "bytecoin") ? result.transactionHash : result.tx_hash;
                    
                    // Security: Validate transaction hash format to prevent XSS
                    // Transaction hashes must be 64-character hexadecimal strings
                    if (!txHash || typeof txHash !== 'string') {
                        log('error', logSystem, 'Invalid transaction hash type from daemon');
                        callback('Invalid transaction hash from daemon');
                        return;
                    }
                    
                    // Remove any whitespace
                    txHash = txHash.trim();
                    
                    // Validate: must be exactly 64 hex characters
                    if (!/^[0-9a-fA-F]{64}$/.test(txHash)) {
                        log('error', logSystem, 'Invalid transaction hash format: %s', [txHash]);
                        callback('Invalid transaction hash format from daemon');
                        return;
                    }

                    transferCmd.redis.push(['zadd', config.coin + ':payments:all', now, [
                        txHash,
                        transferCmd.amount,
                        transferCmd.rpc.fee,
                        transferCmd.rpc.mixin,
                        Object.keys(transferCmd.rpc.destinations).length
                    ].join(':')]);

                    const notify_miners_on_success = [];
                    for (const destination of transferCmd.rpc.destinations){
                        if (transferCmd.rpc.payment_id){
                            destination.address += config.poolServer.paymentId.addressSeparator + transferCmd.rpc.payment_id;
                        }
                        transferCmd.redis.push(['zadd', config.coin + ':payments:' + destination.address, now, [
                            txHash,
                            destination.amount,
                            transferCmd.rpc.fee,
                            transferCmd.rpc.mixin
                        ].join(':')]);

                        notify_miners_on_success.push(destination);
                    }

                    log('info', logSystem, 'Payments sent via wallet daemon %j', [result]);
                    
                    // Redis v4+ multi syntax
                    const multi = redisClient.multi();
                    for (const cmd of transferCmd.redis) {
                        const [command, ...args] = cmd;
                        switch (command) {
                            case 'hincrby':
                                multi.hIncrBy(args[0], args[1], args[2]);
                                break;
                            case 'zadd':
                                multi.zAdd(args[0], { score: args[1], value: args[2] });
                                break;
                            default:
                                log('error', logSystem, 'Unknown Redis command in payment processing: %s', [command]);
                        }
                    }
                    
                    multi.exec()
                        .then((replies) => {
                            for (const notify of notify_miners_on_success) {
                                notify_miners.push(notify);
                            }
                            cback(true);
                        })
                        .catch((error) => {
                            log('error', logSystem, 'Super critical error! Payments sent yet failing to update balance in redis, double payouts likely to happen %j', [error]);
                            log('error', logSystem, 'Double payments likely to be sent to %j', transferCmd.rpc.destinations);
                            cback(false);
                        });
                });
            }, (err, succeeded) => {
                if (err) {
                    log('error', logSystem, 'Error in payment filter: %j', [err]);
                    callback(err);
                    return;
                }
                
                const succeededCount = Array.isArray(succeeded) ? succeeded.length : 0;
                const failedAmount = transferCommands.length - succeededCount;

                for (const m in notify_miners) {
                    const notify = notify_miners[m];
                    log('info', logSystem, 'Payment of %s to %s', [ utils.getReadableCoins(notify.amount), notify.address ]);
                    notifications.sendToMiner(notify.address, 'payment', {
                        'ADDRESS': notify.address.substring(0,7)+'...'+notify.address.substring(notify.address.length-7),
                        'AMOUNT': utils.getReadableCoins(notify.amount),
		    });
                }
                log('info', logSystem, 'Payments sent: %d succeeded, %d failed (total commands: %d)', [succeededCount, failedAmount, transferCommands.length]);

                callback(null);
            });

        }

    ], (error, result) => {
        isRunning = false;  // Release lock
        setTimeout(runInterval, config.payments.interval * 1000);
    });
}

runInterval();
