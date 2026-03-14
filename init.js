/**
 * Cryptonite Node.JS Pool
 * https://github.com/dvandal/cryptonote-nodejs-pool
 *
 * Pool initialization script
 **/

// Load needed modules
var fs = require('fs');
var cluster = require('cluster');
var os = require('os');
var v8 = require('v8');

// Load configuration
require('./lib/configReader.js');

// Load log system
require('./lib/logger.js');

// Initialize redis database client
var redis = require('redis');

var redisDB = (config.redis.db && config.redis.db > 0) ? config.redis.db : 0;
// Redis client uses modern API format
var redisOptions = {
    socket: {
        host: config.redis.host,
        port: config.redis.port
    },
    database: redisDB
};
if (config.redis.auth) {
    redisOptions.password = config.redis.auth;
}

global.redisClient = redis.createClient(redisOptions);

// Connect to Redis and handle errors
global.redisClient.on('error', function(err) {
    if (typeof log === 'function') {
        log('error', 'redis', 'Redis client error: %s', [err]);
    } else {
        console.error('Redis client error:', err);
    }
});

// Connect asynchronously - explicit connection required
global.redisClient.connect().catch(function(err) {
    if (typeof log === 'function') {
        log('error', 'redis', 'Failed to connect to Redis: %s', [err]);
    } else {
        console.error('Failed to connect to Redis:', err);
    }
});

// Load pool modules
if (cluster.isWorker){
    switch(process.env.workerType){
        case 'pool':
            require('./lib/pool.js');
            break;
        case 'blockUnlocker':
            require('./lib/blockUnlocker.js');
            break;
        case 'paymentProcessor':
            require('./lib/paymentProcessor.js');
            break;
        case 'api':
            require('./lib/api.js');
            break;
        case 'chartsDataCollector':
            require('./lib/chartsDataCollector.js');
            break;
        case 'telegramBot':
            require('./lib/telegramBot.js');
            break;
    }
    return;
}

// Initialize log system
var logSystem = 'master';
require('./lib/exceptionWriter.js')(logSystem);

// Pool informations
log('info', logSystem, 'Starting Cryptonote Node.JS pool version %s', [version]);

/**
 * CPU Usage Tracking
 **/
var lastCpuMeasure = null;

function getCpuUsage() {
    const cpus = os.cpus();
    let user = 0, nice = 0, sys = 0, idle = 0, irq = 0;

    for (let cpu of cpus) {
        user += cpu.times.user;
        nice += cpu.times.nice;
        sys += cpu.times.sys;
        idle += cpu.times.idle;
        irq += cpu.times.irq;
    }

    const current = { user, nice, sys, idle, irq };
    
    if (!lastCpuMeasure) {
        lastCpuMeasure = current;
        return null;
    }

    const userDiff = current.user - lastCpuMeasure.user;
    const niceDiff = current.nice - lastCpuMeasure.nice;
    const sysDiff = current.sys - lastCpuMeasure.sys;
    const idleDiff = current.idle - lastCpuMeasure.idle;
    const irqDiff = current.irq - lastCpuMeasure.irq;
    const total = userDiff + niceDiff + sysDiff + idleDiff + irqDiff;

    lastCpuMeasure = current;

    if (total === 0) return null;

    return {
        user: ((userDiff / total) * 100).toFixed(2),
        nice: ((niceDiff / total) * 100).toFixed(2),
        sys: ((sysDiff / total) * 100).toFixed(2),
        idle: ((idleDiff / total) * 100).toFixed(2),
        irq: ((irqDiff / total) * 100).toFixed(2),
        used: (((total - idleDiff) / total) * 100).toFixed(2)
    };
}

function logSystemStats() {
    // CPU Usage
    const cpuUsage = getCpuUsage();
    if (cpuUsage) {
        log('info', logSystem, 'CPU Usage: %s%% used | user: %s%%, sys: %s%%, nice: %s%%, irq: %s%%, idle: %s%%', 
            [cpuUsage.used, cpuUsage.user, cpuUsage.sys, cpuUsage.nice, cpuUsage.irq, cpuUsage.idle]);
    }

    // Memory Usage
    const heapStats = v8.getHeapStatistics();
    const totalHeapMB = (heapStats.total_heap_size / 1024 / 1024).toFixed(2);
    const usedHeapMB = (heapStats.used_heap_size / 1024 / 1024).toFixed(2);
    const heapLimitMB = (heapStats.heap_size_limit / 1024 / 1024).toFixed(2);
    const heapUsagePercent = ((heapStats.used_heap_size / heapStats.total_heap_size) * 100).toFixed(2);
    
    const memUsage = process.memoryUsage();
    const rssMB = (memUsage.rss / 1024 / 1024).toFixed(2);
    const externalMB = (memUsage.external / 1024 / 1024).toFixed(2);

    log('info', logSystem, 'Memory: RSS %s MB | Heap: %s MB / %s MB (%s%%) | Limit: %s MB | External: %s MB', 
        [rssMB, usedHeapMB, totalHeapMB, heapUsagePercent, heapLimitMB, externalMB]);
}

// Start system monitoring (every 10 seconds)
setInterval(logSystemStats, 10000);
 
// Run a single module ?
var singleModule = (function(){
    var validModules = ['pool', 'api', 'unlocker', 'payments', 'chartsDataCollector', 'telegramBot'];

    for (var i = 0; i < process.argv.length; i++){
        if (process.argv[i].indexOf('-module=') === 0){
            var moduleName = process.argv[i].split('=')[1];
            if (validModules.indexOf(moduleName) > -1)
                return moduleName;

            log('error', logSystem, 'Invalid module "%s", valid modules: %s', [moduleName, validModules.join(', ')]);
            process.exit();
        }
    }
})();

/**
 * Start modules
 **/
(function init(){
    checkRedisVersion(function(){
        if (singleModule){
            log('info', logSystem, 'Running in single module mode: %s', [singleModule]);

            switch(singleModule){
                case 'pool':
                    spawnPoolWorkers();
                    break;
                case 'unlocker':
                    spawnBlockUnlocker();
                    break;
                case 'payments':
                    spawnPaymentProcessor();
                    break;
                case 'api':
                    spawnApi();
                    break;
                case 'chartsDataCollector':
                    spawnChartsDataCollector();
                    break;
                case 'telegramBot':
                    spawnTelegramBot();
                    break;
            }
        }
        else{
            spawnPoolWorkers();
            spawnBlockUnlocker();
            spawnPaymentProcessor();
            spawnApi();
            spawnChartsDataCollector();
            spawnTelegramBot();
        }
    });
})();

/**
 * Check redis database version
 **/
function checkRedisVersion(callback){
    // Requires connection first, then we can use callbacks
    function doCheck() {
        // info() returns a promise, convert to callback
        global.redisClient.info().then(function(response){
            var parts = response.split('\r\n');
            var version;
            var versionString;
            for (var i = 0; i < parts.length; i++){
                if (parts[i].indexOf(':') !== -1){
                    var valParts = parts[i].split(':');
                    if (valParts[0] === 'redis_version'){
                        versionString = valParts[1];
                        version = parseFloat(versionString);
                        break;
                    }
                }
            }
            if (!version){
                log('error', logSystem, 'Could not detect redis version - must be super old or broken');
                return;
            }
            else if (version < 2.6){
                log('error', logSystem, "You're using redis version %s the minimum required version is 2.6. Follow the damn usage instructions...", [versionString]);
                return;
            }
            callback();
        }).catch(function(error){
            log('error', logSystem, 'Redis version check failed: %s', [error]);
        });
    }
    
    // Ensure client is connected
    if (global.redisClient.isOpen) {
        doCheck();
    } else {
        global.redisClient.connect().then(doCheck).catch(function(err) {
            log('error', logSystem, 'Failed to connect to Redis for version check: %s', [err]);
        });
    }
}

/**
 * Spawn pool workers module
 **/
function spawnPoolWorkers(){
    if (!config.poolServer || !config.poolServer.enabled || !config.poolServer.ports || config.poolServer.ports.length === 0) return;

    if (config.poolServer.ports.length === 0){
        log('error', logSystem, 'Pool server enabled but no ports specified');
        return;
    }

    var numForks = (function(){
        if (!config.poolServer.clusterForks)
            return 1;
        if (config.poolServer.clusterForks === 'auto')
            return os.cpus().length;
        if (isNaN(config.poolServer.clusterForks))
            return 1;
        return config.poolServer.clusterForks;
    })();

    var poolWorkers = {};

    var createPoolWorker = function(forkId){
        var worker = cluster.fork({
            workerType: 'pool',
            forkId: forkId
        });
        worker.forkId = forkId;
        worker.type = 'pool';
        poolWorkers[forkId] = worker;
        worker.on('exit', function(code, signal){
            log('error', logSystem, 'Pool fork %s died, spawning replacement worker...', [forkId]);
            setTimeout(function(){
                createPoolWorker(forkId);
            }, 2000);
        }).on('message', function(msg){
            switch(msg.type){
                case 'banIP':
                    Object.keys(cluster.workers).forEach(function(id) {
                        if (cluster.workers[id].type === 'pool'){
                            cluster.workers[id].send({type: 'banIP', ip: msg.ip});
                        }
                    });
                    break;
            }
        });
    };

    var i = 1;
    var spawnInterval = setInterval(function(){
        createPoolWorker(i.toString());
        i++;
        if (i - 1 === numForks){
            clearInterval(spawnInterval);
            log('info', logSystem, 'Pool spawned on %d thread(s)', [numForks]);
        }
    }, 10);
}

/**
 * Spawn block unlocker module
 **/
function spawnBlockUnlocker(){
    if (!config.blockUnlocker || !config.blockUnlocker.enabled) return;

    var worker = cluster.fork({
        workerType: 'blockUnlocker'
    });
    worker.on('exit', function(code, signal){
        log('error', logSystem, 'Block unlocker died, spawning replacement...');
        setTimeout(function(){
            spawnBlockUnlocker();
        }, 2000);
    });
}

/**
 * Spawn payment processor module
 **/
function spawnPaymentProcessor(){
    if (!config.payments || !config.payments.enabled) return;

    var worker = cluster.fork({
        workerType: 'paymentProcessor'
    });
    worker.on('exit', function(code, signal){
        log('error', logSystem, 'Payment processor died, spawning replacement...');
        setTimeout(function(){
            spawnPaymentProcessor();
        }, 2000);
    });
}

/**
 * Spawn API module
 **/
function spawnApi(){
    if (!config.api || !config.api.enabled) return;

    var worker = cluster.fork({
        workerType: 'api'
    });
    worker.on('exit', function(code, signal){
        log('error', logSystem, 'API died, spawning replacement...');
        setTimeout(function(){
            spawnApi();
        }, 2000);
    });
}

/**
 * Spawn charts data collector module
 **/
function spawnChartsDataCollector(){
    if (!config.charts) return;

    var worker = cluster.fork({
        workerType: 'chartsDataCollector'
    });
    worker.on('exit', function(code, signal){
        log('error', logSystem, 'chartsDataCollector died, spawning replacement...');
        setTimeout(function(){
            spawnChartsDataCollector();
        }, 2000);
    });
}

/**
 * Spawn telegram bot module
 **/
function spawnTelegramBot(){
    if (!config.telegram || !config.telegram.enabled || !config.telegram.token) return;

    var worker = cluster.fork({
        workerType: 'telegramBot'
    });
    worker.on('exit', function(code, signal){
        log('error', logSystem, 'telegramBot died, spawning replacement...');
        setTimeout(function(){
            spawnTelegramBot();
        }, 2000);
    });
}
