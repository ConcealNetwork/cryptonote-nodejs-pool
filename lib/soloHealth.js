/**
 * Solo Mining Bridge Health Check
 *
 * One-off probe: connects to daemon, fetches block template, prints status and exits
 * Usage: node index.js --at-home-solo --health
 */

// Load configuration
require('./soloConfigReader.js');

// Load required modules
const BN = require('bn.js');
const utils = require('./utils.js');
const daemonRpc = require('./soloDaemonRpc.js');

// Set cryptonight algorithm
const cnAlgorithm = config.cnAlgorithm || 'cryptonight';
const cnVariant = config.cnVariant || 0;
const cnBlobType = config.cnBlobType || 0;

// Difficulty buffer
const diff1 = new BN('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', 16);

// Set instance id (used in block template)
const instanceId = utils.instanceId();

/**
 * Block Template class (same as in soloBridge.js - matches pool.js)
 * Used in runHealthCheck() to create block template instances
 */
class BlockTemplate {
    constructor(template) {
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

    nextBlob() {
        this.buffer.writeUInt32BE(++this.extraNonce, this.reserveOffset);
        return utils.cnUtil.convert_blob(this.buffer, cnBlobType).toString('hex');
    }
}

/**
 * Build job for miner (same logic as soloBridge.js)
 */
function buildJobForMiner(blockTemplate, difficulty) {
    difficulty = difficulty || config.solo.difficulty;

    // Calculate target hex (same as Miner.getTargetHex)
    const padded = Buffer.alloc(32);
    padded.fill(0);
    const diffBuff = Buffer.from(diff1.div(new BN(difficulty)).toArray('be'));
    diffBuff.copy(padded, 32 - diffBuff.length);
    const buff = padded.slice(0, 4);
    const buffArray = Array.prototype.slice.call(buff, 0).reverse();
    const buffReversed = Buffer.from(buffArray);
    const target = buffReversed.toString('hex');

    // Get blob
    const blob = blockTemplate.nextBlob();

    return {
        blob: blob,
        target: target,
        difficulty: difficulty,
    };
}

/**
 * Run health check
 */
async function runHealthCheck() {
    console.error('Checking daemon connection and block template...');

    try {
        const result = await daemonRpc.getBlockTemplate();

        if (!result) {
            const output = {
                ok: false,
                daemonConnected: false,
                error: 'No result from daemon',
            };
            console.log(JSON.stringify(output, null, 2));
            process.exit(1);
            return;
        }

        try {
            // Create block template (same as bridge uses)
            const blockTemplate = new BlockTemplate(result);

            // Build job (same as bridge would send to miners)
            const shareDifficulty = config.solo.defaultDifficulty;
            const job = buildJobForMiner(blockTemplate, shareDifficulty);

            // Extract seed hash if available (for some Cryptonote variants)
            let seedHash = null;
            if (result.seed_hash) {
                seedHash = result.seed_hash;
            } else if (result.seed) {
                seedHash = result.seed;
            }

            // Build status output
            const status = {
                ok: true,
                daemonConnected: true,
                height: result.height,
                networkDifficulty: result.difficulty,
                shareDifficulty: shareDifficulty,
                minDifficulty: config.solo.minDifficulty,
                maxDifficulty: config.solo.maxDifficulty,
                defaultDifficulty: config.solo.defaultDifficulty,
                target: job.target,
                algorithm: cnAlgorithm,
                variant: cnVariant,
                blobType: cnBlobType,
            };

            const header = {
                blob: job.blob,
                height: result.height,
                difficulty: result.difficulty,
                target: job.target,
            };

            if (seedHash) {
                header.seed_hash = seedHash;
            }

            // Extract previous hash
            if (blockTemplate.previous_hash) {
                header.previous_hash = blockTemplate.previous_hash.toString('hex');
            }

            const output = {
                status: status,
                header: header,
            };

            console.log(JSON.stringify(output, null, 2));
            process.exit(0);
        } catch (e) {
            const output = {
                ok: false,
                daemonConnected: true,
                error: e.message || String(e),
                stack: e.stack,
            };
            console.log(JSON.stringify(output, null, 2));
            process.exit(1);
        }
    } catch (error) {
        const output = {
            ok: false,
            daemonConnected: false,
            error: error.message || String(error),
        };
        console.log(JSON.stringify(output, null, 2));
        process.exit(1);
    }
}

// Run the health check
runHealthCheck();
