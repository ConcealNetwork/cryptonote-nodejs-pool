#!/usr/bin/env node
/**
 * Solo Mining Bridge Entry Point
 * 
 * Usage: 
 *   node index.js --solo-mining              # Start solo mining bridge
 *   node index.js --solo-mining --health    # Run health check and exit
 *   node index.js --solo-mining --debug     # Start with debug logging enabled
 * 
 * This starts a minimal stratum server that connects miners to your local daemon
 * for solo mining. No Redis, no payments, no API - just job distribution and block submission.
 */

// Check for flags
var soloMode = false;
var healthCheck = false;
var debugMode = false;

for (var i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--solo-mining') {
        soloMode = true;
    }
    if (process.argv[i] === '--health') {
        healthCheck = true;
    }
    if (process.argv[i] === '--debug') {
        debugMode = true;
    }
}

// Set global debug flag for solo bridge
if (soloMode) {
    global.SOLO_DEBUG = debugMode;
}

if (!soloMode) {
    // Fall back to regular pool mode
    require('./init.js');
} else if (healthCheck) {
    // Health check mode - one-off probe then exit
    require('./lib/soloHealth.js');
} else {
    // Solo mining mode
    console.log('Starting solo mining bridge...');
    require('./lib/soloBridge.js');
}
