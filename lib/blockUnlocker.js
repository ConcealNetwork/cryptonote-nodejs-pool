/**
 * Cryptonote Node.JS Pool
 * https://github.com/dvandal/cryptonote-nodejs-pool
 *
 * Block unlocker
 **/

// Load required modules

const apiInterfaces = require('./apiInterfaces.js')(config.daemon, config.wallet, config.api);
const notifications = require('./notifications.js');
const utils = require('./utils.js');

const slushMiningEnabled = config.poolServer.slushMining?.enabled;

// Initialize log system
const logSystem = 'unlocker';
require('./exceptionWriter.js')(logSystem);

/**
 * Run block unlocker
 **/
 
log('info', logSystem, 'Started');

// Helper function for Redis zRange (promise-based)
const redisZrange = async (key, start, stop, options = {}) => {
    return await redisClient.zRange(key, start, stop, options);
};

// Helper function for Redis multi exec (promise-based)
const redisMultiExec = async (commands) => {
    const multi = redisClient.multi();
    for (const cmd of commands) {
        switch (cmd[0]) {
            case 'hgetall':
                multi.hGetAll(cmd[1]);
                break;
            case 'zadd':
                multi.zAdd(cmd[1], { score: parseFloat(cmd[2]), value: cmd[3] });
                break;
            case 'zrem':
                multi.zRem(cmd[1], cmd[2]);
                break;
            case 'hincrby':
                multi.hIncrBy(cmd[1], cmd[2], cmd[3]);
                break;
            case 'hset':
                multi.hSet(cmd[1], cmd[2], cmd[3]);
                break;
            case 'del':
                multi.del(cmd[1]);
                break;
            default:
                // Fallback for unknown commands
                log('warn', logSystem, 'Unknown Redis command in multi: %j', [cmd]);
                break;
        }
    }
    try {
        return await multi.exec();
    } catch (err) {
        // Log detailed error information for MULTI/EXEC failures
        if (err.errorIndexes && Array.isArray(err.errorIndexes)) {
            log('error', logSystem, 'blockUnlocker MULTI/EXEC failed: %d command(s) failed at indexes: %j', [err.errorIndexes.length, err.errorIndexes]);
            if (err.replies && Array.isArray(err.replies)) {
                err.errorIndexes.forEach((idx) => {
                    if (err.replies[idx] && err.replies[idx].message) {
                        log('error', logSystem, '  blockUnlocker command %d error: %s', [idx, err.replies[idx].message]);
                    } else if (err.replies[idx]) {
                        log('error', logSystem, '  blockUnlocker command %d error: %j', [idx, err.replies[idx]]);
                    }
                    // Log the command that failed
                    if (commands[idx]) {
                        log('error', logSystem, '  Failed command: %j', [commands[idx]]);
                    }
                });
            }
        } else {
            log('error', logSystem, 'blockUnlocker MULTI/EXEC failed: %j', [err]);
        }
        throw err; // Re-throw to maintain error propagation
    }
};

// Helper function to promisify RPC calls
const rpcDaemon = (method, params) => {
    return new Promise((resolve, reject) => {
        apiInterfaces.rpcDaemon(method, params, (error, result) => {
            if (error) reject(error);
            else resolve(result);
        });
    });
};

// Mutex to prevent concurrent executions (race condition fix)
let isRunning = false;

const runInterval = async () => {
    // Prevent concurrent executions that would credit rewards multiple times
    if (isRunning) {
        log('warn', logSystem, 'Block unlocker already running, skipping this interval');
        setTimeout(runInterval, config.blockUnlocker.interval * 1000);
        return;
    }
    
    isRunning = true;
    try {
        // Get all block candidates in redis
        // Redis v5 requires zRangeWithScores, not zRange with WITHSCORES option
        const results = await redisClient.zRangeWithScores(`${config.coin}:blocks:candidates`, 0, -1);
        
                if (results.length === 0){
                    log('info', logSystem, 'No blocks candidates in redis');
                    isRunning = false;
            setTimeout(runInterval, config.blockUnlocker.interval * 1000);
                    return;
                }

        const blocks = [];

        // Redis v5 zRangeWithScores returns array of objects: [{value: 'data', score: 123}, ...]
        for (const item of results) {
            const parts = item.value.split(':');
            blocks.push({
                serialized: item.value,
                height: parseInt(item.score, 10),
                hash: parts[0],
                time: parts[1],
                difficulty: parts[2],
                shares: parts[3],
                score: parts.length >= 5 ? parts[4] : parts[3]
            });
        }

        // Check if blocks are orphaned
        const daemonType = config.daemonType ? config.daemonType.toLowerCase() : "default";
        
        const blockChecks = await Promise.all(blocks.map(async (block) => {
            try {
                // Preserve original height from Redis before RPC call
                const originalHeight = block.height;
                log('info', logSystem, 'Checking block at height %d (hash: %s)', [originalHeight, block.hash]);
                
                // Use getblockheaderbyhash for Conceal compatibility (getblockheaderbyheight has issues)
                const result = await rpcDaemon('getblockheaderbyhash', {hash: block.hash});
                
                if (!result.block_header){
                    log('error', logSystem, 'Error with getblockheaderbyhash, no details returned for %s - %j', [block.serialized, result]);
                    block.unlocked = false;
                    return false;
                }
                
                const blockHeader = result.block_header;
                // Ensure height is preserved (RPC response may not include it)
                block.height = originalHeight;
                block.orphaned = blockHeader.hash === block.hash ? 0 : 1;
                block.unlocked = blockHeader.depth >= config.blockUnlocker.depth;
                block.reward = blockHeader.reward;
                if (config.blockUnlocker.networkFee) {
                    const networkFeePercent = config.blockUnlocker.networkFee / 100;
                    block.reward = block.reward - (block.reward * networkFeePercent);
                }
                log('info', logSystem, 'Block %d: orphaned=%d, unlocked=%s, depth=%d, reward=%d', [block.height, block.orphaned, block.unlocked, blockHeader.depth, block.reward]);
                return block.unlocked;
            } catch (error) {
                log('error', logSystem, 'Error with getblockheaderbyhash RPC request for block %s - %j', [block.serialized, error]);
                block.unlocked = false;
                return false;
            }
        }));

        const unlockedBlocks = blocks.filter((_block, index) => blockChecks[index]);

                if (unlockedBlocks.length === 0){
                    log('info', logSystem, 'No pending blocks are unlocked yet (%d pending)', [blocks.length]);
                    isRunning = false;
            setTimeout(runInterval, config.blockUnlocker.interval * 1000);
                    return;
                }

        // Get worker shares for each unlocked block
        const redisCommands = unlockedBlocks.map((block)=> ['hgetall', `${config.coin}:scores:round${block.height}`]);

        const replies = await redisMultiExec(redisCommands);
        
        for (let i = 0; i < replies.length; i++){
            const workerScores = replies[i];
            unlockedBlocks[i].workerScores = workerScores;
                }

        // Handle orphaned blocks
        const orphanCommands = [];

        unlockedBlocks.forEach((block)=> {
                if (!block.orphaned) return;

            orphanCommands.push(['del', `${config.coin}:scores:round${block.height}`]);
            orphanCommands.push(['del', `${config.coin}:shares_actual:round${block.height}`]);

            orphanCommands.push(['zrem', `${config.coin}:blocks:candidates`, block.serialized]);
            orphanCommands.push(['zadd', `${config.coin}:blocks:matured`, block.height, [
                    block.hash,
                    block.time,
                    block.difficulty,
                    block.shares,
                    block.orphaned
                ].join(':')]);

                if (block.workerScores && !slushMiningEnabled) {
                const workerScores = block.workerScores;
                Object.keys(workerScores).forEach((worker) => {
                    orphanCommands.push(['hincrby', `${config.coin}:scores:roundCurrent`, worker, workerScores[worker]]);
                    });
                }

                notifications.sendToAll('blockOrphaned', {
                    'HEIGHT': block.height,
                'BLOCKTIME': utils.dateFormat(new Date(parseInt(block.time, 10) * 1000), 'yyyy-mm-dd HH:MM:ss Z'),
                    'HASH': block.hash,
                    'DIFFICULTY': block.difficulty,
                    'SHARES': block.shares,
                'EFFORT': `${Math.round(block.shares / block.difficulty * 100)}%`
                });
            });

            if (orphanCommands.length > 0){
            await redisMultiExec(orphanCommands);
            }

        // Handle unlocked blocks
        const unlockedBlocksCommands = [];
        const payments = {};
        let totalBlocksUnlocked = 0;
        
        for (const block of unlockedBlocks) {
            if (block.orphaned) continue;
                totalBlocksUnlocked++;

            unlockedBlocksCommands.push(['del', `${config.coin}:scores:round${block.height}`]);
            unlockedBlocksCommands.push(['del', `${config.coin}:shares_actual:round${block.height}`]);
            unlockedBlocksCommands.push(['zrem', `${config.coin}:blocks:candidates`, block.serialized]);
            unlockedBlocksCommands.push(['zadd', `${config.coin}:blocks:matured`, block.height, [
                    block.hash,
                    block.time,
                    block.difficulty,
                    block.shares,
                    block.orphaned,
                    block.reward
                ].join(':')]);

            let feePercent = config.blockUnlocker.poolFee / 100;

                if (Object.keys(donations).length) {
                for(const wallet in donations) {
                    const percent = donations[wallet] / 100;
                        feePercent += percent;
                        payments[wallet] = Math.round(block.reward * percent);
                        log('info', logSystem, 'Block %d donation to %s as %d percent of reward: %d', [block.height, wallet, percent, payments[wallet]]);
                    }
                }

            const reward = Math.round(block.reward - (block.reward * feePercent));

                log('info', logSystem, 'Unlocked %d block with reward %d and donation fee %d. Miners reward: %d', [block.height, block.reward, feePercent, reward]);

                if (block.workerScores) {
                const totalScore = parseFloat(block.score);
                for (const worker of Object.keys(block.workerScores)) {
                    const percent = block.workerScores[worker] / totalScore;
                    const workerReward = Math.round(reward * percent);
                        payments[worker] = (payments[worker] || 0) + workerReward;
                        log('info', logSystem, 'Block %d payment to %s for %d%% of total block score: %d', [block.height, worker, percent*100, payments[worker]]);
                    redisClient.zAdd(`${config.coin}:blocksMiner:matured:${worker}`, block.height, [
                            block.hash,
                            block.time,
                            block.difficulty,
                            block.shares,
                            block.orphaned,
                            block.reward,
                            percent*100,
                            payments[worker]
                        ].join(':'));
                }
                }

                notifications.sendToAll('blockUnlocked', {
                    'HEIGHT': block.height,
                'BLOCKTIME': utils.dateFormat(new Date(parseInt(block.time, 10) * 1000), 'yyyy-mm-dd HH:MM:ss Z'),
                    'HASH': block.hash,
                    'REWARD': utils.getReadableCoins(block.reward),
                    'DIFFICULTY': block.difficulty,
                    'SHARES': block.shares,
                'EFFORT': `${Math.round(block.shares / block.difficulty * 100)}%`
            });
        }

        for (const worker in payments) {
            const amount = parseInt(payments[worker], 10);
                if (amount <= 0){
                    delete payments[worker];
                    continue;
                }
            unlockedBlocksCommands.push(['hincrby', `${config.coin}:workers:${worker}`, 'balance', amount]);
            }

            if (unlockedBlocksCommands.length === 0){
            log('info', logSystem, 'No unlocked blocks yet (%d pending)', [unlockedBlocks.length]);
                isRunning = false;
            setTimeout(runInterval, config.blockUnlocker.interval * 1000);
                return;
            }

        await redisMultiExec(unlockedBlocksCommands);
                log('info', logSystem, 'Unlocked %d blocks and update balances for %d workers', [totalBlocksUnlocked, Object.keys(payments).length]);
        
    } catch (error) {
        const errorMessage = error?.message || String(error);
        const errorStack = error?.stack ? `\nStack: ${error.stack}` : '';
        log('error', logSystem, 'Error in block unlocker: %s%s', [errorMessage, errorStack]);
        if (Object.keys(error || {}).length > 0) {
            log('error', logSystem, 'Error details: %j', [error]);
        }
    } finally {
        isRunning = false;  // Release lock
        setTimeout(runInterval, config.blockUnlocker.interval * 1000);
}
};

runInterval();

