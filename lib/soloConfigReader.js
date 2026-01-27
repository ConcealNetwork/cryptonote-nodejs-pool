/**
 * Solo Mining Bridge Configuration Reader
 * Loads config-solo.json for solo mining mode
 */

const fs = require('fs');

// Get configuration file path
const configFile = 'config-solo.json';

// Check if config file exists
if (!fs.existsSync(configFile)) {
    console.error('Error: config-solo.json not found!');
    console.error('Please create config-solo.json based on the example in the README.');
    process.exit(1);
}

// Read configuration file data
try {
    global.config = JSON.parse(fs.readFileSync(configFile));
} catch (e) {
    console.error(`Failed to read config file ${configFile}\n\n${e}`);
    process.exit(1);
}

// Validate required solo config fields
const requiredFields = ['daemon', 'solo'];
const missingFields = [];

for (const field of requiredFields) {
    if (!config[field]) {
        missingFields.push(field);
    }
}

if (missingFields.length > 0) {
    console.error(`Error: Missing required config fields: ${missingFields.join(', ')}`);
    process.exit(1);
}

// Set defaults
if (!config.solo.port) config.solo.port = 3333;
if (!config.solo.host) config.solo.host = '127.0.0.1';
if (!config.solo.defaultDifficulty) config.solo.defaultDifficulty = 1000;
if (!config.solo.minDifficulty) config.solo.minDifficulty = 500;
if (!config.solo.maxDifficulty) config.solo.maxDifficulty = 100000;
if (!config.solo.minerTimeout) config.solo.minerTimeout = 900;
if (!config.solo.blockRefreshInterval) config.solo.blockRefreshInterval = 1000;

// Validate configuration values
if (typeof config.solo.port !== 'number' || config.solo.port < 1 || config.solo.port > 65535) {
    console.error('Error: solo.port must be a valid port number (1-65535)');
    process.exit(1);
}
if (typeof config.solo.defaultDifficulty !== 'number' || config.solo.defaultDifficulty < 1) {
    console.error('Error: solo.defaultDifficulty must be a positive number');
    process.exit(1);
}
if (typeof config.solo.minDifficulty !== 'number' || config.solo.minDifficulty < 1) {
    console.error('Error: solo.minDifficulty must be a positive number');
    process.exit(1);
}
if (typeof config.solo.maxDifficulty !== 'number' || config.solo.maxDifficulty < config.solo.minDifficulty) {
    console.error('Error: solo.maxDifficulty must be greater than or equal to minDifficulty');
    process.exit(1);
}
if (config.solo.walletAddress && typeof config.solo.walletAddress !== 'string') {
    console.error('Error: solo.walletAddress must be a string');
    process.exit(1);
}
if (config.solo.walletAddress) {
    if (!config.solo.walletAddress.startsWith('ccx')) {
        console.error('Error: solo.walletAddress must start with "ccx" for Conceal addresses');
        process.exit(1);
    }
    if (config.solo.walletAddress.length !== 98) {
        console.error('Error: solo.walletAddress must be exactly 98 characters long for Conceal addresses');
        process.exit(1);
    }
}

// Set cryptonight defaults
if (!config.cnAlgorithm) config.cnAlgorithm = 'cryptonight';
if (!config.cnVariant) config.cnVariant = 0;
if (!config.cnBlobType) config.cnBlobType = 0;

// Set logging defaults
if (!config.logging) {
    config.logging = {
        console: { level: 'info', colors: true },
        files: { level: 'info', directory: 'logs', flushInterval: 5 },
    };
}

console.log(`Solo mining bridge configuration loaded from ${configFile}`);
