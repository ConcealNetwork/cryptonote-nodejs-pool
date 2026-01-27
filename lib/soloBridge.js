/**
 * Solo Mining Bridge
 *
 * Minimal stratum server for solo mining - connects miners directly to local daemon
 * No Redis, no payments, no API - just job distribution and block submission
 */

// Load configuration
require('./soloConfigReader.js');

// Load required modules
const net = require('net');
const os = require('os');
const BN = require('bn.js');
const cnHashing = require('cryptonight-hashing');
const utils = require('./utils.js');
const daemonRpc = require('./soloDaemonRpc.js');
const telegram = require('./telegram.js');

// Simple console logger for solo mode
// Skip debug logs unless --debug flag is set
function log(severity, system, text, data) {
    // Skip debug logs unless debug mode is enabled
    if (severity === 'debug' && !global.SOLO_DEBUG) {
        return;
    }

    const timestamp = new Date().toISOString();
    let message = `[${timestamp}] [${severity.toUpperCase()}] ${system}: ${text}`;
    if (data && data.length > 0) {
        let dataIndex = 0;
        message = message.replace(/%[sdj%]/g, (match) => {
            if (match === '%%') return '%';
            if (dataIndex < data.length) {
                const value = data[dataIndex++];
                if (match === '%j') return JSON.stringify(value);
                return String(value);
            }
            return match;
        });
    }
    console.log(message);
}

const logSystem = 'solo-bridge';

// Set cryptonight algorithm
// For variant 3 (CryptoNight-GPU), try cryptonight_gpu first, fallback to cryptonight
const cnVariant = config.cnVariant || 0;
const cnBlobType = config.cnBlobType || 0;
const cnAlgorithm = config.cnAlgorithm || 'cryptonight';

// Determine which hashing function to use
let cryptoNight;
if (cnVariant === 3) {
    // Try cryptonight_gpu first (if available in ConcealNetwork fork)
    if (cnHashing?.cryptonight_gpu) {
        cryptoNight = cnHashing.cryptonight_gpu;
        log('info', logSystem, 'Using cryptonight_gpu for variant 3 (CryptoNight-GPU)');
    } else if (cnHashing?.[cnAlgorithm]) {
        // Fallback to standard cryptonight (may work if variant 3 uses GPU internally)
        cryptoNight = cnHashing[cnAlgorithm];
        log('warn', logSystem, 'cryptonight_gpu not available, using %s for variant 3 (may not match miner)', [
            cnAlgorithm,
        ]);
    } else {
        log('error', logSystem, 'No cryptonight function available (tried cryptonight_gpu and %s)', [cnAlgorithm]);
        process.exit(1);
    }
} else {
    // Use standard cryptonight for other variants
    if (!cnHashing?.[cnAlgorithm]) {
        log('error', logSystem, 'Invalid cryptonight algorithm: %s (variant: %d)', [cnAlgorithm, cnVariant]);
        process.exit(1);
    }
    cryptoNight = cnHashing[cnAlgorithm];
}

// Set instance id (used in block template)
const instanceId = utils.instanceId();

// Difficulty buffer
const diff1 = new BN('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', 16);

// Block template management
let currentBlockTemplate = null;
const validBlockTemplates = [];

// Global job cache
// Removed global job cache - each getJob() call now generates a unique job with incremented extraNonce

// Connected miners (simplified - just track connection state)
const connectedMiners = {};

// Nonce pattern validation
const noncePattern = /^[0-9A-Fa-f]{8}$/;

// Server started flag
let serverStarted = false;

/**
 * Block Template class
 */
function BlockTemplate(template) {
    this.blob = template.blocktemplate_blob;
    this.difficulty = template.difficulty;
    this.height = template.height;
    this.reserveOffset = template.reserved_offset;
    this.buffer = Buffer.from(this.blob, 'hex');
    instanceId.copy(this.buffer, this.reserveOffset + 4, 0, 3);
    this.previous_hash = Buffer.alloc(32);
    this.buffer.copy(this.previous_hash, 0, 7, 39);
    this.extraNonce = 0;
}

BlockTemplate.prototype = {
    nextBlob: function () {
        this.buffer.writeUInt32BE(++this.extraNonce, this.reserveOffset);
        return utils.cnUtil.convert_blob(this.buffer, cnBlobType).toString('hex');
    },
    nextBlobRaw: function () {
        // Return raw blob (for miners that do their own conversion)
        this.extraNonce++;
        this.buffer.writeUInt32BE(this.extraNonce, this.reserveOffset);
        return this.buffer.toString('hex');
    },
};

/**
 * Valid difficulty values (discrete steps: 5000 increments from 5000 to 100000)
 */
const validDifficulties = [];
for (let i = 5000; i <= 100000; i += 5000) {
    validDifficulties.push(i);
}

/**
 * Find nearest valid difficulty value
 */
function snapToValidDifficulty(value) {
    let nearest = validDifficulties[0];
    let minDiff = Math.abs(value - nearest);

    for (let i = 1; i < validDifficulties.length; i++) {
        const diff = Math.abs(value - validDifficulties[i]);
        if (diff < minDiff) {
            minDiff = diff;
            nearest = validDifficulties[i];
        }
    }

    return nearest;
}

/**
 * Resolve difficulty from login params or use default
 * Supports difficulty specification in login (e.g., "address+difficulty")
 * Snaps to valid discrete values: [5000, 10000, 15000, ..., 100000] (5000 increments)
 */
function resolveDifficulty(params) {
    let requestedDiff = config.solo.defaultDifficulty;

    // Check if difficulty is specified in login (format: "address+difficulty")
    if (params.login && typeof params.login === 'string') {
        const loginParts = params.login.split('+');
        if (loginParts.length > 1) {
            const diffValue = parseInt(loginParts[loginParts.length - 1]);
            if (!Number.isNaN(diffValue) && diffValue > 0 && diffValue <= 100000) {
                // Add upper bound for safety
                requestedDiff = diffValue;
            }
        }
    }

    // Snap to nearest valid difficulty value
    requestedDiff = snapToValidDifficulty(requestedDiff);

    // Clamp to min/max from config
    if (requestedDiff < config.solo.minDifficulty) {
        requestedDiff = Math.max(config.solo.minDifficulty, validDifficulties[0]);
    }
    if (requestedDiff > config.solo.maxDifficulty) {
        requestedDiff = Math.min(config.solo.maxDifficulty, validDifficulties[validDifficulties.length - 1]);
    }

    return requestedDiff;
}

/**
 * Metrics tracking
 */
const metrics = {
    shares: {
        accepted: 0,
        rejected: 0,
        blocks: 0,
    },
    miners: {},
    startTime: Date.now(),
};

function updateMinerMetrics(miner, accepted, isBlock) {
    if (!metrics.miners[miner.login]) {
        metrics.miners[miner.login] = {
            accepted: 0,
            rejected: 0,
            blocks: 0,
            lastShare: Date.now(),
            shareTimes: [], // Track share submission times for hashrate calculation
            hashrate: 0,
            lastDifficultyAdjust: 0, // Initialize to 0 so first adjustment can happen
        };
    }
    const minerMetrics = metrics.miners[miner.login];
    const now = Date.now();
    minerMetrics.lastShare = now;

    if (accepted) {
        metrics.shares.accepted++;
        minerMetrics.accepted++;
        // Track share time for hashrate calculation (keep last 20 shares)
        minerMetrics.shareTimes.push(now);
        if (minerMetrics.shareTimes.length > 20) {
            minerMetrics.shareTimes.shift();
        }
        if (isBlock) {
            metrics.shares.blocks++;
            minerMetrics.blocks++;
        }
    } else {
        metrics.shares.rejected++;
        minerMetrics.rejected++;
    }
}

/**
 * Calculate hashrate from share submission times
 * Hashrate = (number of shares * difficulty) / time_span
 */
function calculateHashrate(minerMetrics, currentDifficulty) {
    if (minerMetrics.shareTimes.length < 2) {
        return 0;
    }

    const timeSpan = (minerMetrics.shareTimes[minerMetrics.shareTimes.length - 1] - minerMetrics.shareTimes[0]) / 1000; // seconds
    if (timeSpan <= 0) {
        return 0;
    }

    const shares = minerMetrics.shareTimes.length - 1;
    const hashrate = (shares * currentDifficulty) / timeSpan;
    return Math.floor(hashrate);
}

/**
 * Auto-adjust difficulty based on hashrate (target: difficulty = hashrate * targetShareTime for ~5 shares/minute with 12s target)
 * Only adjust every 30 seconds to avoid too frequent changes
 * Snaps to discrete values: [5000, 10000, 15000, ..., 100000] (5000 increments)
 */
function autoAdjustDifficulty(miner) {
    if (!metrics.miners[miner.login]) {
        return;
    }

    const minerMetrics = metrics.miners[miner.login];
    const now = Date.now();

    // Only adjust every 30 seconds (or if never adjusted before)
    if (minerMetrics.lastDifficultyAdjust > 0 && now - minerMetrics.lastDifficultyAdjust < 30000) {
        return;
    }

    // Need at least 5 shares to calculate hashrate
    if (minerMetrics.shareTimes.length < 5) {
        return;
    }

    const hashrate = calculateHashrate(minerMetrics, miner.shareDifficulty);
    minerMetrics.hashrate = hashrate;

    if (hashrate > 0) {
        // Target difficulty = hashrate * targetShareTime (for ~12 seconds per share = 5 shares/minute)
        const targetShareTime = config.solo.targetShareTime || 12;
        const targetDifficulty = hashrate * targetShareTime;

        // Snap to nearest valid difficulty value
        let snappedDifficulty = snapToValidDifficulty(targetDifficulty);

        // Clamp to min/max from config
        if (snappedDifficulty < config.solo.minDifficulty) {
            snappedDifficulty = Math.max(config.solo.minDifficulty, validDifficulties[0]);
        }
        if (snappedDifficulty > config.solo.maxDifficulty) {
            snappedDifficulty = Math.min(config.solo.maxDifficulty, validDifficulties[validDifficulties.length - 1]);
        }

        // Only adjust if different from current
        const currentDiff = miner.shareDifficulty;
        if (snappedDifficulty !== currentDiff) {
            const oldDifficulty = miner.shareDifficulty;
            miner.shareDifficulty = snappedDifficulty;
            minerMetrics.lastDifficultyAdjust = now;

            log(
                'info',
                logSystem,
                'Auto-adjusted difficulty for %s@%s: %d -> %d (hashrate: %d H/s, target: %d, ~%d shares/min)',
                [
                    miner.login,
                    miner.ip,
                    oldDifficulty,
                    miner.shareDifficulty,
                    hashrate,
                    targetDifficulty,
                    Math.round(60 / targetShareTime),
                ]
            );

            // Send new job with updated difficulty
            if (miner.pushMessage && currentBlockTemplate) {
                const job = miner.getJob();
                if (job) {
                    miner.pushMessage('job', job);
                }
            }
        }
    }
}

function logMetrics() {
    const uptime = Math.floor((Date.now() - metrics.startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = uptime % 60;
    const totalShares = metrics.shares.accepted + metrics.shares.rejected;
    const acceptanceRate = totalShares > 0 ? ((metrics.shares.accepted / totalShares) * 100).toFixed(1) : '0.0';

    // Build miner details string
    const minerDetails = [];
    for (const login in metrics.miners) {
        const m = metrics.miners[login];
        const hashrateStr = m.hashrate > 0 ? `${m.hashrate} H/s` : 'calculating...';
        minerDetails.push(`${login} (${hashrateStr})`);
    }
    const minerInfo = minerDetails.length > 0 ? ` | ${minerDetails.join(', ')}` : '';

    // Use console.log directly for metrics to get the exact format requested
    console.log(
        '[METRIC] solo-bridge: Accepted: %d, Rejected: %d, Blocks: %d, Uptime: %dh %dm %ds, Miners: %d, Acceptance: %s%%%s',
        metrics.shares.accepted,
        metrics.shares.rejected,
        metrics.shares.blocks,
        hours,
        minutes,
        seconds,
        Object.keys(metrics.miners).length,
        acceptanceRate,
        minerInfo
    );
}

// Log metrics every 30 seconds
setInterval(logMetrics, 30 * 1000);

// Log initial metrics immediately
log('info', logSystem, 'Metrics logging started (will print every 30 seconds)');

/**
 * Simplified Miner class
 */
function Miner(id, login, ip, shareDifficulty, pushMessage) {
    this.id = id;
    this.login = login || 'solo-miner';
    this.ip = ip;
    this.shareDifficulty = shareDifficulty || config.solo.defaultDifficulty;
    this.pushMessage = pushMessage;
    this.validJobs = [];
    this.lastBeat = Date.now();
}

Miner.prototype = {
    heartbeat: function () {
        this.lastBeat = Date.now();
    },
    getTargetHex: function () {
        const padded = Buffer.alloc(32);
        padded.fill(0);
        const diffBuff = Buffer.from(diff1.div(new BN(this.shareDifficulty)).toArray('be'));
        diffBuff.copy(padded, 32 - diffBuff.length);
        const buff = padded.slice(0, 4);
        const buffArray = Array.prototype.slice.call(buff, 0).reverse();
        const buffReversed = Buffer.from(buffArray);
        this.target = buffReversed.readUInt32BE(0);
        return buffReversed.toString('hex');
    },
    getJob: function () {
        if (!currentBlockTemplate) {
            return null;
        }

        const blob = currentBlockTemplate.nextBlob();
        const target = this.getTargetHex();

        const newJob = {
            id: utils.uid(),
            extraNonce: currentBlockTemplate.extraNonce, // This is the extraNonce AFTER nextBlob() increments it
            height: currentBlockTemplate.height,
            difficulty: this.shareDifficulty,
            blob: blob, // Store the blob we sent to the miner (for validation/debugging)
        };

        this.validJobs.push(newJob);
        if (this.validJobs.length > 4) {
            this.validJobs.shift();
        }

        const jobResponse = {
            blob: blob,
            job_id: newJob.id,
            target: target,
            id: this.id,
        };

        // Log the exact job we send (for debugging)
        log('debug', logSystem, 'Sending job to miner - blob: %s, job_id: %s, target: %s, extraNonce: %d', [
            `${blob.substr(0, 32)}...`,
            newJob.id,
            target,
            newJob.extraNonce,
        ]);

        return jobResponse;
    },
};

/**
 * Get block template from daemon with automatic retry on failure
 */
let daemonReconnectAttempts = 0;
const maxDaemonReconnectAttempts = 5;
const daemonReconnectDelay = 5000; // 5 seconds

async function getBlockTemplate(callback) {
    try {
        const result = await daemonRpc.getBlockTemplate();

        // Reset reconnect attempts on success
        if (daemonReconnectAttempts > 0) {
            log('info', logSystem, 'Daemon connection restored successfully');
            daemonReconnectAttempts = 0;
        }

        if (!currentBlockTemplate || result.height > currentBlockTemplate.height) {
            log('info', logSystem, 'New block to mine at height %d with difficulty %d', [
                result.height,
                result.difficulty,
            ]);

            if (currentBlockTemplate) {
                validBlockTemplates.push(currentBlockTemplate);
            }
            if (validBlockTemplates.length > 3) {
                validBlockTemplates.shift();
            }

            currentBlockTemplate = new BlockTemplate(result);

            // Push new job to all connected miners (each will get a unique job with incremented extraNonce)
            for (const minerId in connectedMiners) {
                const miner = connectedMiners[minerId];
                const job = miner.getJob();
                if (job && miner.pushMessage) {
                    miner.pushMessage('job', job);
                }
            }
        }

        callback(true);
    } catch (error) {
        daemonReconnectAttempts++;
        log('error', logSystem, 'Error getting block template (attempt %d/%d): %j', [
            daemonReconnectAttempts,
            maxDaemonReconnectAttempts,
            error,
        ]);

        if (daemonReconnectAttempts < maxDaemonReconnectAttempts) {
            log('info', logSystem, 'Retrying daemon connection in %d seconds...', [daemonReconnectDelay / 1000]);
            setTimeout(() => {
                getBlockTemplate(callback);
            }, daemonReconnectDelay);
            return;
        } else {
            log('error', logSystem, 'Max reconnection attempts reached. Will continue trying every %d seconds...', [
                daemonReconnectDelay / 1000,
            ]);
            daemonReconnectAttempts = 0; // Reset counter, but keep trying
            setTimeout(() => {
                getBlockTemplate(callback);
            }, daemonReconnectDelay);
            callback(false);
            return;
        }
    }
}

/**
 * Format miner display name (truncate if too long)
 */
function formatMinerDisplay(login) {
    return login.length > 14 ? `${login.substring(0, 7)}...${login.substring(login.length - 7)}` : login;
}

/**
 * Send Telegram notification for block found
 */
function sendBlockFoundNotification(job, miner, blockHash, hashDiff, blockTemplate) {
    if (!(config.telegram?.enabled && config.telegram.token && config.telegram.chatId)) {
        return;
    }

    const minerDisplay = formatMinerDisplay(miner.login);
    const message =
        `*🎉 BLOCK FOUND! 🎉*\n\n` +
        `Height: _${job.height}_\n` +
        `Miner: _${minerDisplay}_\n` +
        `Hash: \`${blockHash}\`\n` +
        `Difficulty: _${hashDiff.toString()}_\n` +
        `Network Difficulty: _${blockTemplate.difficulty}_\n` +
        `IP: _${miner.ip}_`;

    telegram.sendMessage(config.telegram.chatId, message);
}

/**
 * Send Telegram notification for block submission success
 */
function sendBlockSubmittedNotification(job, miner, blockFastHash, result) {
    if (!(config.telegram?.enabled && config.telegram.token && config.telegram.chatId)) {
        return;
    }

    const minerDisplay = formatMinerDisplay(miner.login);
    const submitMessage =
        `*✅ BLOCK SUBMITTED*\n\n` +
        `Height: _${job.height}_\n` +
        `Block ID: \`${blockFastHash.substr(0, 12)}...\`\n` +
        `Miner: _${minerDisplay}_\n` +
        `Result: \`${JSON.stringify(result)}\``;

    telegram.sendMessage(config.telegram.chatId, submitMessage);
}

/**
 * Send Telegram notification for block submission error
 */
function sendBlockSubmissionErrorNotification(job, error) {
    if (!(config.telegram?.enabled && config.telegram.token && config.telegram.chatId)) {
        return;
    }

    const errorMessage =
        `*❌ BLOCK SUBMISSION FAILED*\n\n` +
        `Height: _${job.height}_\n` +
        `Error: \`${error.message || JSON.stringify(error)}\``;

    telegram.sendMessage(config.telegram.chatId, errorMessage);
}

/**
 * Refresh block template after submission
 */
function refreshBlockTemplateAfterSubmission() {
    setTimeout(() => {
        log('info', logSystem, 'Refreshing block template after block submission...');
        getBlockTemplate((success) => {
            if (success) {
                log('info', logSystem, 'Block template refreshed successfully');
            } else {
                log('error', logSystem, 'Failed to refresh block template');
            }
        });
    }, 2000);
}

/**
 * Submit block to daemon asynchronously
 */
async function submitBlockToDaemon(shareBuffer, job, miner, cnBlobType) {
    try {
        const result = await daemonRpc.submitBlock(shareBuffer.toString('hex'));
        const blockFastHash = utils.cnUtil.get_block_id(shareBuffer, cnBlobType).toString('hex');
        log('info', logSystem, '*** BLOCK SUBMITTED *** %s at height %d by %s@%s - Result: %j', [
            blockFastHash.substr(0, 12),
            job.height,
            miner.login,
            miner.ip,
            result,
        ]);

        sendBlockSubmittedNotification(job, miner, blockFastHash, result);
        updateMinerMetrics(miner, true, true);
        refreshBlockTemplateAfterSubmission();
    } catch (error) {
        log('error', logSystem, 'Error submitting block at height %d: %j', [job.height, error]);
        sendBlockSubmissionErrorNotification(job, error);
        updateMinerMetrics(miner, false, true);
    }
}

/**
 * Process share submission
 */
function processShare(miner, job, blockTemplate, params) {
    // Validate all required parameters
    if (!params) {
        log('error', logSystem, 'Share params missing');
        return false;
    }

    if (!params.result || typeof params.result !== 'string' || !/^[0-9a-fA-F]+$/.test(params.result)) {
        log('error', logSystem, 'Share missing or invalid result hex', { params: JSON.stringify(params) });
        return false;
    }

    if (!params.nonce || typeof params.nonce !== 'string' || !/^[0-9a-fA-F]{8}$/.test(params.nonce)) {
        log('error', logSystem, 'Share missing or invalid nonce hex', { params: JSON.stringify(params) });
        return false;
    }

    if (!job) {
        log('error', logSystem, 'No job found for job_id', { job_id: params.job_id });
        return false;
    }

    if (!job.blob || typeof job.blob !== 'string') {
        log('error', logSystem, 'Job has no blob', { job: JSON.stringify(job) });
        return false;
    }

    if (!blockTemplate) {
        log('error', logSystem, 'No block template for job', { job_id: params.job_id, height: job.height });
        return false;
    }

    const nonce = params.nonce;
    const resultHash = params.result;

    // Log raw params for debugging
    log('debug', logSystem, 'Raw submit params: %s', [JSON.stringify(params)]);
    log('debug', logSystem, 'Job found - id: %s, extraNonce: %d, height: %d, blob: %s', [
        job.id,
        job.extraNonce,
        job.height,
        job.blob ? `${job.blob.substr(0, 32)}...` : 'MISSING',
    ]);
    log('debug', logSystem, 'Nonce: %s, result: %s', [
        nonce,
        resultHash ? `${resultHash.substr(0, 16)}...` : 'missing',
    ]);

    // Reconstruct the block blob (EXACT same as pool.js line 862-872)
    let template;
    let shareBuffer;
    let convertedBlob;
    let hash;
    let hard_fork_version;
    try {
        template = Buffer.alloc(blockTemplate.buffer.length);
        blockTemplate.buffer.copy(template);
        template.writeUInt32BE(job.extraNonce, blockTemplate.reserveOffset);
        shareBuffer = utils.cnUtil.construct_block_blob(template, Buffer.from(nonce, 'hex'), cnBlobType);

        // Convert the blob and hash it
        convertedBlob = utils.cnUtil.convert_blob(shareBuffer, cnBlobType);
        hard_fork_version = convertedBlob[0];

        // Hash directly (native module works fine in main thread)
        if (cnVariant === 3 && cryptoNight === cnHashing.cryptonight_gpu) {
            hash = cryptoNight(convertedBlob, cnVariant, job.height);
        } else {
            hash = cryptoNight(convertedBlob, cnVariant);
        }

        log('debug', logSystem, 'Mining algorithm: %s variant %d, Hard fork version: %d', [
            cnAlgorithm,
            cnVariant,
            hard_fork_version,
        ]);
    } catch (error) {
        log('error', logSystem, 'Error during share processing: %s', [error.message]);
        updateMinerMetrics(miner, false, false);
        return false;
    }

    if (hash.toString('hex') !== resultHash) {
        log('warn', logSystem, 'Bad hash from miner %s@%s', [miner.login, miner.ip]);
        updateMinerMetrics(miner, false, false);
        return false;
    }

    // Calculate share difficulty
    const hashArray = Array.prototype.slice.call(hash, 0).reverse();
    const hashNum = new BN(Buffer.from(hashArray), 'be');
    const hashDiff = diff1.div(hashNum);

    // Check if it's a valid block (meets network difficulty)
    const isBlock = hashDiff.gte(new BN(blockTemplate.difficulty));

    if (isBlock) {
        const blockHash = `${hash.toString('hex').substr(0, 16)}...`;
        log('info', logSystem, '*** BLOCK FOUND *** at height %d by %s@%s! Hash: %s, Difficulty: %s (network: %d)', [
            job.height,
            miner.login,
            miner.ip,
            blockHash,
            hashDiff.toString(),
            blockTemplate.difficulty,
        ]);

        sendBlockFoundNotification(job, miner, blockHash, hashDiff, blockTemplate);
        submitBlockToDaemon(shareBuffer, job, miner, cnBlobType);
        return true;
    }

    // Check if it meets share difficulty
    if (hashDiff.lt(new BN(miner.shareDifficulty))) {
        log(
            'warn',
            logSystem,
            'Rejected low difficulty share from %s@%s - Share diff: %s (required: %d, network: %d)',
            [miner.login, miner.ip, hashDiff.toString(), miner.shareDifficulty, blockTemplate.difficulty]
        );
        updateMinerMetrics(miner, false, false);
        return false;
    }

    // Valid share
    log('info', logSystem, 'Valid share from %s@%s - Share diff: %s (required: %d, network: %d)', [
        miner.login,
        miner.ip,
        hashDiff.toString(),
        miner.shareDifficulty,
        blockTemplate.difficulty,
    ]);
    updateMinerMetrics(miner, true, false);

    // Auto-adjust difficulty based on hashrate
    autoAdjustDifficulty(miner);

    return true;
}

/**
 * Handle login method
 */
function handleLoginMethod(params, ip, sendReply, pushMessage) {
    const login = params.login && typeof params.login === 'string' ? params.login : 'solo-miner';
    const minerId = utils.uid();
    const shareDifficulty = resolveDifficulty(params);

    // Create miner instance
    const miner = new Miner(minerId, login, ip, shareDifficulty, pushMessage);
    connectedMiners[minerId] = miner;

    log('info', logSystem, 'Miner connected: %s@%s (id: %s, share difficulty: %d)', [
        login,
        ip,
        minerId,
        shareDifficulty,
    ]);

    // Send initial job
    const job = miner.getJob();
    if (!job) {
        sendReply('No block template available yet, please try again');
        return;
    }

    sendReply(null, {
        id: minerId,
        job: job,
        status: 'OK',
    });
}

/**
 * Handle getjob method
 */
function handleGetJobMethod(miner, sendReply) {
    if (!miner) {
        sendReply('Unauthenticated');
        return;
    }
    miner.heartbeat();
    const currentJob = miner.getJob();
    if (!currentJob) {
        sendReply('No block template available');
        return;
    }
    sendReply(null, currentJob);
}

/**
 * Validate submit parameters
 */
function validateSubmitParams(params) {
    if (!(params.nonce && params.result && params.job_id)) {
        return 'Invalid submit parameters';
    }
    if (!noncePattern.test(params.nonce)) {
        return 'Invalid nonce format';
    }
    return null;
}

/**
 * Find block template for job
 */
function findBlockTemplateForJob(jobSubmit) {
    let blockTemplate = currentBlockTemplate;
    if (!blockTemplate || blockTemplate.height !== jobSubmit.height) {
        blockTemplate = validBlockTemplates.filter((t) => t.height === jobSubmit.height)[0];
    }
    return blockTemplate;
}

/**
 * Handle submit method
 */
function handleSubmitMethod(miner, params, sendReply) {
    if (!miner) {
        sendReply('Unauthenticated');
        return;
    }
    miner.heartbeat();

    const validationError = validateSubmitParams(params);
    if (validationError) {
        sendReply(validationError);
        return;
    }

    // Force lowercase for further comparison (same as pool.js)
    params.nonce = params.nonce.toLowerCase();

    // Find the job
    const jobSubmit = miner.validJobs.filter((j) => j.id === params.job_id)[0];
    if (!jobSubmit) {
        sendReply('Invalid job id');
        return;
    }

    // Find the block template
    const blockTemplate = findBlockTemplateForJob(jobSubmit);
    if (!blockTemplate) {
        sendReply('Job expired');
        return;
    }

    // Log submit attempt for debugging
    log('debug', logSystem, 'Share submit from %s@%s - job_id: %s, nonce: %s, result: %s', [
        miner.login,
        miner.ip,
        params.job_id,
        params.nonce,
        params.result ? `${params.result.substr(0, 16)}...` : 'missing',
    ]);

    // Process the share
    const shareAccepted = processShare(miner, jobSubmit, blockTemplate, params);
    if (shareAccepted) {
        sendReply(null, { status: 'OK' });
    } else {
        sendReply('Share rejected');
    }
}

/**
 * Handle keepalived method
 */
function handleKeepalivedMethod(miner, sendReply) {
    if (!miner) {
        sendReply('Unauthenticated');
        return;
    }
    miner.heartbeat();
    sendReply(null, { status: 'KEEPALIVED' });
}

/**
 * Handle miner RPC methods
 */
function handleMinerMethod(method, params, ip, sendReply, pushMessage) {
    const miner = connectedMiners[params.id];

    switch (method) {
        case 'login':
            handleLoginMethod(params, ip, sendReply, pushMessage);
            break;

        case 'getjob':
            handleGetJobMethod(miner, sendReply);
            break;

        case 'submit':
            handleSubmitMethod(miner, params, sendReply);
            break;

        case 'keepalived':
            handleKeepalivedMethod(miner, sendReply);
            break;

        default:
            sendReply('Invalid method');
            break;
    }
}

/**
 * Check if an IP address is a localhost/loopback address
 */
function isLocalhost(ip) {
    return ip === '127.0.0.1' || ip === 'localhost' || ip === '0.0.0.0';
}

/**
 * Check if a network address is a valid external IPv4 address
 */
function isExternalIPv4(addr) {
    return addr.family === 'IPv4' && !addr.internal;
}

/**
 * Find the first non-internal IPv4 address from network interfaces
 */
function findFirstExternalIPv4() {
    const interfaces = os.networkInterfaces();
    for (const ifaceName in interfaces) {
        const iface = interfaces[ifaceName];
        for (const addr of iface) {
            if (isExternalIPv4(addr)) {
                return addr.address;
            }
        }
    }
    return null;
}

/**
 * Get local network IP address for display
 */
function getLocalNetworkIP() {
    const configuredIP = config.solo.host;
    if (isLocalhost(configuredIP)) {
        return findFirstExternalIPv4() || configuredIP;
    }
    return configuredIP;
}

/**
 * Parse JSON message from socket
 */
function parseMessage(message, socket) {
    try {
        return JSON.parse(message);
    } catch {
        log('warn', logSystem, 'Malformed message from %s: %s', [socket.remoteAddress, message]);
        socket.destroy();
        return null;
    }
}

/**
 * Create reply sender function for socket
 */
function createReplySender(socket, messageId) {
    return (error, result) => {
        if (!socket.writable) return;
        const sendData = `${JSON.stringify({
            id: messageId,
            jsonrpc: '2.0',
            error: error ? { code: -1, message: error } : null,
            result: result,
        })}\n`;
        socket.write(sendData);
    };
}

/**
 * Process a single message from socket
 */
function processMessage(message, socket, pushMessage) {
    const jsonData = parseMessage(message, socket);
    if (!jsonData) return;

    if (!jsonData.id) {
        log('warn', logSystem, 'Message missing RPC id from %s', [socket.remoteAddress]);
        return;
    }

    const sendReply = createReplySender(socket, jsonData.id);

    try {
        handleMinerMethod(jsonData.method, jsonData.params || {}, socket.remoteAddress, sendReply, pushMessage);
    } catch (e) {
        log('error', logSystem, 'Error handling message: %s', [e.message]);
        sendReply('Internal error');
    }
}

/**
 * Start TCP server
 */
function startTcpServer() {
    const server = net.createServer((socket) => {
        log('info', logSystem, 'New connection from %s:%s', [socket.remoteAddress, socket.remotePort]);
        socket.setKeepAlive(true);
        socket.setEncoding('utf8');

        let dataBuffer = '';
        const pushMessage = (type, data) => {
            if (!socket.writable) return;
            const message = `${JSON.stringify({
                method: type,
                params: data,
            })}\n`;
            socket.write(message);
        };

        socket.on('data', (data) => {
            dataBuffer += data;

            if (dataBuffer.indexOf('\n') !== -1) {
                const messages = dataBuffer.split('\n');
                const incomplete = dataBuffer.slice(-1) === '\n' ? '' : messages.pop();

                for (const message of messages) {
                    if (message.trim() === '') continue;
                    processMessage(message, socket, pushMessage);
                }

                dataBuffer = incomplete;
            }
        });

        socket.on('error', (err) => {
            if (err.code !== 'ECONNRESET') {
                log('warn', logSystem, 'Socket error from %s: %s', [socket.remoteAddress, err.message]);
            }
        });

        socket.on('close', (hadError) => {
            // Clean up miner on disconnect - find miner by socket reference
            for (const minerId in connectedMiners) {
                const miner = connectedMiners[minerId];
                if (miner.ip === socket.remoteAddress) {
                    if (hadError) {
                        log(
                            'warn',
                            logSystem,
                            'Miner connection closed with error: %s@%s (will reconnect automatically)',
                            [miner.login, miner.ip]
                        );
                    } else {
                        log('info', logSystem, 'Miner disconnected: %s@%s', [miner.login, miner.ip]);
                    }
                    delete connectedMiners[minerId];
                    break;
                }
            }
        });
    });

    server.listen(config.solo.port, config.solo.host, () => {
        const localIP = getLocalNetworkIP();
        log('info', logSystem, 'Solo mining bridge listening on %s:%s', [config.solo.host, config.solo.port]);
        const connectUrl = `stratum+tcp://${localIP}:${config.solo.port}`;
        log('info', logSystem, 'Connect your miner to: %s', [connectUrl]);
        if (config.solo.host === '127.0.0.1' || config.solo.host === '0.0.0.0') {
            log('info', logSystem, 'Note: Listening on %s, accessible from network at %s', [config.solo.host, localIP]);
        }
    });

    server.on('error', (err) => {
        log('error', logSystem, 'Server error: %s', [err.message]);
        process.exit(1);
    });

    server.on('connection', (socket) => {
        log('debug', logSystem, 'Connection event from %s:%s', [socket.remoteAddress, socket.remotePort]);
    });
}

/**
 * Clean up timed-out miners
 */
setInterval(() => {
    const now = Date.now();
    const timeout = config.solo.minerTimeout * 1000;

    for (const minerId in connectedMiners) {
        const miner = connectedMiners[minerId];
        if (now - miner.lastBeat > timeout) {
            log('info', logSystem, 'Miner timed out: %s@%s', [miner.login, miner.ip]);
            delete connectedMiners[minerId];
        }
    }
}, 30000);

/**
 * Initialize and start
 */
log('info', logSystem, 'Starting solo mining bridge...');
log('info', logSystem, 'Daemon: %s:%s', [config.daemon.host, config.daemon.port]);
log('info', logSystem, 'Algorithm: %s (variant: %s, blob type: %s)', [cnAlgorithm, cnVariant, cnBlobType]);

// Graceful shutdown handlers
function shutdown() {
    log('info', logSystem, 'Shutting down...');
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start block template refresh loop with automatic retry
function startBlockRefresh() {
    getBlockTemplate((success) => {
        if (success && !serverStarted) {
            startTcpServer();
            serverStarted = true;
        }
        // Always continue the refresh loop, even on errors (reconnection logic handles retries)
        setTimeout(startBlockRefresh, config.solo.blockRefreshInterval);
    });
}

startBlockRefresh();
