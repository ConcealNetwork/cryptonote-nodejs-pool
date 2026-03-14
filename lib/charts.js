/**
 * Cryptonote Node.JS Pool
 * https://github.com/dvandal/cryptonote-nodejs-pool
 *
 * Charts data functions
 **/

// Load required modules

const apiInterfaces = require('./apiInterfaces.js')(config.daemon, config.wallet, config.api);
const market = require('./market.js');

// Set charts cleanup interval
const cleanupInterval = config.redis.cleanupInterval && config.redis.cleanupInterval > 0 ? config.redis.cleanupInterval : 15;

// Initialize log system
const logSystem = 'charts';
require('./exceptionWriter.js')(logSystem);

/**
 * Charts data collectors (used by chartsDataCollector.js)
 **/

// Mutex locks to prevent concurrent executions (race condition protection)
const collectorLocks = {};
 
// Start data collectors
const startDataCollectors = () => {
    for (const chartName of Object.keys(config.charts.pool)) {
        const settings = config.charts.pool[chartName];
        if(settings.enabled) {
            collectorLocks[chartName] = false;
            setInterval(() => {
                if (!collectorLocks[chartName]) {
                    collectorLocks[chartName] = true;
                    collectPoolStatWithInterval(chartName, settings).finally(() => {
                        collectorLocks[chartName] = false;
                    });
                }
            }, settings.updateInterval * 1000);
        }
    }

    const settings = config.charts.user.hashrate;
    if(settings.enabled) {
        collectorLocks['hashrate'] = false;
        setInterval(() => {
            if (!collectorLocks['hashrate']) {
                collectorLocks['hashrate'] = true;
                collectUsersHashrate('hashrate', settings).finally(() => {
                    collectorLocks['hashrate'] = false;
                });
            }
        }, settings.updateInterval * 1000)
    }

    const workerHashrateSettings = config.charts.user.worker_hashrate;
    if (workerHashrateSettings?.enabled) {
        collectorLocks['worker_hashrate'] = false;
        setInterval(() => {
            if (!collectorLocks['worker_hashrate']) {
                collectorLocks['worker_hashrate'] = true;
                collectWorkersHashrate('worker_hashrate', workerHashrateSettings).finally(() => {
                    collectorLocks['worker_hashrate'] = false;
                });
            }
        }, workerHashrateSettings.updateInterval * 1000);
    }
};

// Statistic value handler
const statValueHandler = {
    avg: (set, value) => {
        set[1] = (set[1] * set[2] + value) / (set[2] + 1);
    },
    avgRound: (set, value) => {
        statValueHandler.avg(set, value);
        set[1] = Math.round(set[1]);
    },
    max: (set, value) => {
        if(value > set[1]) {
            set[1] = value;
        }
    }
};

// Presave functions
const preSaveFunctions = {
    hashrate: statValueHandler.avgRound,
    workers: statValueHandler.max,
    difficulty: statValueHandler.avgRound,
    price: statValueHandler.avg,
    profit: statValueHandler.avg
};

// Store collected values in redis database
const storeCollectedValues = (chartName, values, settings) => {
    for(const i in values) {
        storeCollectedValue(`${chartName}:${i}`, values[i], settings);
    }
};

// Store collected value in redis database
const storeCollectedValue = (chartName, value, settings) => {
    const now = Date.now()/ 1000 | 0;
    getChartDataFromRedis(chartName, (sets) => {
        let lastSet = sets[sets.length - 1]; // [time, avgValue, updatesCount]
        if(!lastSet || now - lastSet[0] > settings.stepInterval) {
            lastSet = [now, value, 1];
            sets.push(lastSet);
            while(now - sets[0][0] > settings.maximumPeriod) { // clear old sets
                sets.shift();
            }
        }
        else {
            preSaveFunctions[chartName]
                ? preSaveFunctions[chartName](lastSet, value)
                : statValueHandler.avgRound(lastSet, value);
            lastSet[2]++;
        }
        
        if(getStatsRedisKey(chartName).search(`${config.coin}:charts:hashrate`) >=0){
             redisClient.set(getStatsRedisKey(chartName), JSON.stringify(sets), 'EX', (86400 * cleanupInterval));
        }
        else{
            redisClient.set(getStatsRedisKey(chartName), JSON.stringify(sets));
        }       
        
        log('info', logSystem, `${chartName} chart collected value ${value}. Total sets count ${sets.length}`);
    });
}

// Collect pool statistics with an interval
const collectPoolStatWithInterval = async (chartName, settings) => {
    try {
        const value = await new Promise((resolve, reject) => {
            chartStatFuncs[chartName]((error, result) => {
                if (error) reject(error);
                else resolve(result);
            });
        });
        storeCollectedValue(chartName, value, settings);
    } catch (error) {
        log('error', logSystem, `Error collecting pool stat ${chartName}: ${error}`);
        }
};

/**
 * Get chart data from redis database
 **/
const getChartDataFromRedis = (chartName, callback) => {
    // Modern Redis client uses Promises
    redisClient.get(getStatsRedisKey(chartName)).then((data) => {
        callback(data ? JSON.parse(data) : []);
    }).catch((_error) => {
        callback([]);
    });
};

/**
 * Return redis key for chart data
 **/
const getStatsRedisKey = (chartName) => {
    return `${config.coin}:charts:${chartName}`;
};

/**
 * Get pool statistics from API
 **/
const getPoolStats = (callback) => {
    apiInterfaces.pool('/stats', (error, data) => {
        if (error) {
            log('error', logSystem, `Unable to get API data for stats: ${error}`);
        }
        callback(error, data);
    });
};

/**
 * Get pool hashrate from API
 **/
const getPoolHashrate = (callback) => {
    getPoolStats((error, stats) => {
        callback(error, stats.pool ? Math.round(stats.pool.hashrate) : null);
    });
};

/**
 * Get pool miners from API
 **/
const getPoolMiners = (callback) => {
    getPoolStats((error, stats) => {
        callback(error, stats.pool ? stats.pool.miners : null);
    });
};

/**
 * Get pool workers from API
 **/
const getPoolWorkers = (callback) => {
    getPoolStats((error, stats) => {
        callback(error, stats.pool ? stats.pool.workers : null);
    });
};

/**
 * Get network difficulty from API
 **/
const getNetworkDifficulty = (callback) => {
    getPoolStats((error, stats) => {
        callback(error, stats.pool ? stats.network.difficulty : null);
    });
};

/**
 * Get users hashrate from API
 **/
const getUsersHashrates = (callback) => {
    apiInterfaces.pool('/miners_hashrate', (error, data) => {
        if (error) {
            log('error', logSystem, `Unable to get API data for miners_hashrate: ${error}`);
        }
        const resultData = data?.minersHashrate ? data.minersHashrate : {};
        callback(resultData);
    });
};

/**
 * Get workers' hashrates from API
 **/
const getWorkersHashrates = (callback) => {
    apiInterfaces.pool('/workers_hashrate', (error, data) => {
        if (error) {
            log('error', logSystem, `Unable to get API data for workers_hashrate: ${error}`);
        }
        const resultData = data?.workersHashrate ? data.workersHashrate : {};
        callback(resultData);
    });
};

/**
 * Collect users hashrate from API
 **/
const collectUsersHashrate = async (chartName, settings) => {
    try {
        const redisBaseKey = `${getStatsRedisKey(chartName)}:`;
        // Redis v4+ uses Promises
        const keys = await redisClient.keys(`${redisBaseKey}*`);
        const hashrates = {};
        for(const i in keys) {
            hashrates[keys[i].substr(redisBaseKey.length)] = 0;
        }
        return new Promise((resolve) => {
            getUsersHashrates((newHashrates) => {
                for(const address in newHashrates) {
                    hashrates[address] = newHashrates[address];
                }
                storeCollectedValues(chartName, hashrates, settings);
                resolve();
            });
        });
    } catch (error) {
        log('error', logSystem, 'Error collecting users hashrate: %j', [error]);
    }
};

/**
 * Get user hashrate chart data
 **/
const getUserHashrateChartData = (address, callback) => {
    getChartDataFromRedis(`hashrate:${address}`, callback);
};

/**
 * Collect worker hashrates from API
 **/
const collectWorkersHashrate = async (chartName, settings) => {
    try {
        const redisBaseKey = `${getStatsRedisKey(chartName)}:`;
        // Modern Redis client uses Promises
        const keys = await redisClient.keys(`${redisBaseKey}*`);
        const hashrates = {};
        for(const i in keys) {
            hashrates[keys[i].substr(redisBaseKey.length)] = 0;
        }
        return new Promise((resolve) => {
            getWorkersHashrates((newHashrates) => {
                for(const addr_worker in newHashrates) {
                    hashrates[addr_worker] = newHashrates[addr_worker];
                }
                storeCollectedValues(chartName, hashrates, settings);
                resolve();
            });
        });
    } catch (error) {
        log('error', logSystem, 'Error collecting workers hashrate: %j', [error]);
    }
};

/**
 * Convert payments data to chart
 **/
const convertPaymentsDataToChart = (paymentsData) => {
    const data = [];
    if(paymentsData?.length) {
        for(let i = 0; paymentsData[i]; i += 2) {
            data.unshift([+paymentsData[i + 1], paymentsData[i].split(':')[1]]);
        }
    }
    return data;
};

/**
 * Get current coin market price
 **/
const getCoinPrice = (callback) => {
    const source = config.prices.source;
    const currency = config.prices.currency;

    const tickers = [`${config.symbol.toUpperCase()}-${currency.toUpperCase()}`];
    market.get(source, tickers, (data) => {
        const error = (!((data?.[0] ) && data[0].price)) ? `No exchange data for ${config.symbol.toUpperCase()} to ${currency.toUpperCase()} using ${source}` : null;
        const price = (data?.[0]?.price) ? data[0].price : null;
        callback(error, price);	
    });
};

/**
 * Get current coin profitability
 **/
const getCoinProfit = (callback) => {
    getCoinPrice((error, price) => {
        if(error) {
            callback(error);
            return;
        }
        getPoolStats((error, stats) => {
            if(error) {
                callback(error);
                return;
            }
            callback(null, stats.lastblock.reward * price / stats.network.difficulty / config.coinUnits);
        });
    });
};

// Chart data functions (declared after all functions to avoid use-before-declaration)
const chartStatFuncs = {
    hashrate: getPoolHashrate,
    miners: getPoolMiners,
    workers: getPoolWorkers,
    difficulty: getNetworkDifficulty,
    price: getCoinPrice,
    profit: getCoinProfit
};

/**
 * Return pool charts data
 **/
const getPoolChartsData = (callback) => {
    const chartsNames = [];
    const redisKeys = [];
    for(const chartName in config.charts.pool) {
        if(config.charts.pool[chartName].enabled) {
            chartsNames.push(chartName);
            redisKeys.push(getStatsRedisKey(chartName));
        }
    }
    if(redisKeys.length) {
        // Modern Redis client uses Promises
        redisClient.mGet(redisKeys).then((data) => {
            const stats = {};
            if(data) {
                for(const i in data) {
                    if(data[i]) {
                        stats[chartsNames[i]] = JSON.parse(data[i]);
                    }
                }
            }
            callback(null, stats);
        }).catch((error) => {
            callback(error, {});
        });
    }
    else {
        callback(null, {});
    }
};

/**
 * Return user charts data
 **/
const getUserChartsData = async (address, paymentsData, callback) => {
    const chartsFuncs = {
        hashrate: (callback) => {
            getUserHashrateChartData(address, (data) => {
                callback(null, data);
            });
        },

        payments: (callback) => {
            callback(null, convertPaymentsDataToChart(paymentsData));
        }
    };
    
    for(const chartName in chartsFuncs) {
        if(!config.charts.user[chartName].enabled) {
            delete chartsFuncs[chartName];
        }
    }
    
    // Convert to promises and use Promise.all
    const promises = Object.keys(chartsFuncs).map((key) => {
        return new Promise((resolve, reject) => {
            chartsFuncs[key]((error, data) => {
                if (error) reject(error);
                else resolve({ [key]: data });
            });
        });
    });
    
    try {
        const results = await Promise.all(promises);
        const stats = Object.assign({}, ...results);
        callback(null, stats);
    } catch (error) {
        callback(error, null);
}
};


/**
 * Exports charts functions
 **/
module.exports = {
    startDataCollectors: startDataCollectors,
    getUserChartsData: getUserChartsData,
    getPoolChartsData: getPoolChartsData
};
