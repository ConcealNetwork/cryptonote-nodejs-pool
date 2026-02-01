/**
 * Solo Mining Bridge Configuration Reader
 * Loads config-solo.json for solo mining mode
 */

const fs = require('node:fs');
const path = require('node:path');

// Get configuration file path (in project root, not lib directory)
const configFile = path.join(process.cwd(), 'config-solo.json');

// Check if config file exists
if (!fs.existsSync(configFile)) {
    console.error('Error: config-solo.json not found!');
    console.error('Please create config-solo.json based on config-solo.json.example');
    process.exit(1);
}

// Read configuration file data
try {
    const fileData = fs.readFileSync(configFile, 'utf8');
    global.config = JSON.parse(fileData);
} catch (error) {
    console.error(`Failed to read config file ${configFile}\n\n${error}`);
    process.exit(1);
}

// Validate required config fields
const validationErrors = [];

if (!config.daemon) {
    validationErrors.push('Missing required field: daemon');
} else {
    if (!config.daemon.host || typeof config.daemon.host !== 'string') {
        validationErrors.push('daemon.host must be a string');
    }
    if (typeof config.daemon.port !== 'number' || config.daemon.port < 1 || config.daemon.port > 65535) {
        validationErrors.push('daemon.port must be a valid port number (1-65535)');
    }
}

if (!config.solo) {
    validationErrors.push('Missing required field: solo');
} else {
    // Set defaults first
    config.solo.port = config.solo.port ?? 3333;
    config.solo.host = config.solo.host ?? '127.0.0.1';
    config.solo.defaultDifficulty = config.solo.defaultDifficulty ?? 1000;
    config.solo.minDifficulty = config.solo.minDifficulty ?? 500;
    config.solo.maxDifficulty = config.solo.maxDifficulty ?? 100000;
    config.solo.minerTimeout = config.solo.minerTimeout ?? 900;
    config.solo.blockRefreshInterval = config.solo.blockRefreshInterval ?? 1000;

    // Validate solo configuration
    if (typeof config.solo.port !== 'number' || config.solo.port < 1 || config.solo.port > 65535) {
        validationErrors.push('solo.port must be a valid port number (1-65535)');
    }
    if (typeof config.solo.host !== 'string' || config.solo.host.length === 0) {
        validationErrors.push('solo.host must be a non-empty string');
    }
    if (typeof config.solo.defaultDifficulty !== 'number' || config.solo.defaultDifficulty < 1) {
        validationErrors.push('solo.defaultDifficulty must be a positive number');
    }
    if (typeof config.solo.minDifficulty !== 'number' || config.solo.minDifficulty < 1) {
        validationErrors.push('solo.minDifficulty must be a positive number');
    }
    if (typeof config.solo.maxDifficulty !== 'number' || config.solo.maxDifficulty < config.solo.minDifficulty) {
        validationErrors.push('solo.maxDifficulty must be greater than or equal to minDifficulty');
    }
    if (typeof config.solo.minerTimeout !== 'number' || config.solo.minerTimeout < 1) {
        validationErrors.push('solo.minerTimeout must be a positive number');
    }
    if (typeof config.solo.blockRefreshInterval !== 'number' || config.solo.blockRefreshInterval < 1) {
        validationErrors.push('solo.blockRefreshInterval must be a positive number');
    }
    if (config.solo.walletAddress) {
        if (typeof config.solo.walletAddress !== 'string') {
            validationErrors.push('solo.walletAddress must be a string');
        } else {
            if (!config.solo.walletAddress.startsWith('ccx')) {
                validationErrors.push('solo.walletAddress must start with "ccx" for Conceal addresses');
            }
            if (config.solo.walletAddress.length !== 98) {
                validationErrors.push('solo.walletAddress must be exactly 98 characters long for Conceal addresses');
            }
        }
    }
}

if (validationErrors.length > 0) {
    console.error('Config validation errors:');
    for (const err of validationErrors) {
        console.error(`  - ${err}`);
    }
    process.exit(1);
}

// Set cryptonight defaults
config.cnAlgorithm = config.cnAlgorithm ?? 'cryptonight';
config.cnVariant = config.cnVariant ?? 0;
config.cnBlobType = config.cnBlobType ?? 0;

// Set logging defaults
if (!config.logging) {
    config.logging = {
        console: { level: 'info', colors: true },
        files: { level: 'info', directory: 'logs', flushInterval: 5 },
    };
}

console.log(`Solo mining bridge configuration loaded from ${configFile}`);
