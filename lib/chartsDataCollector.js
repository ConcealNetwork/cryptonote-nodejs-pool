/**
 * Cryptonote Node.JS Pool
 * https://github.com/dvandal/cryptonote-nodejs-pool
 *
 * Charts data collector
 **/

// Load required modules
const charts = require('./charts.js');

// Initialize log system
const logSystem = 'chartsDataCollector';
require('./exceptionWriter.js')(logSystem);

/**
 * Run charts data collector
 **/
 
log('info', logSystem, 'Started');
charts.startDataCollectors();
