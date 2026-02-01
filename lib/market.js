/**
 * Cryptonote Node.JS Pool
 * https://github.com/dvandal/cryptonote-nodejs-pool
 *
 * Market Exchanges
 **/

// Load required modules
const apiInterfaces = require('./apiInterfaces.js')(config.daemon, config.wallet);

// Initialize log system
const logSystem = 'market';
require('./exceptionWriter.js')(logSystem);

/**
 * Get market prices
 **/
exports.get = (exchange, tickers, callback) => {
    if (!exchange) { 
        callback('No exchange specified', null);
        return;
    }
    const exchangeLower = exchange.toLowerCase();

    if (!tickers || tickers.length === 0) {
        callback('No tickers specified', null);
    }

    const marketPrices = [];
    const numTickers = tickers.length;
    let completedFetches = 0;

    getExchangeMarkets(exchangeLower, (error, marketData) => {
        if (!marketData || marketData.length === 0) {
            callback({});
            return ;
        }

        for (const i in tickers) {
            (function(i){
                const pairName = tickers[i];
                const pairParts = pairName.split('-');
                const base = pairParts[0] || null;
                const target = pairParts[1] || null;

                if (!marketData[base]) {
                    completedFetches++;
                    if (completedFetches === numTickers) callback(marketPrices);
                } else {
                    const price = marketData[base][target] || null;
                    if (!price || price === 0) {
                        let cryptonatorBase;
                        if (marketData[base]['BTC']) cryptonatorBase = 'BTC';
                        else if (marketData[base]['ETH']) cryptonatorBase = 'ETH';
                        else if (marketData[base]['LTC']) cryptonatorBase = 'LTC';

                        if (!cryptonatorBase) {
                            completedFetches++;
                            if (completedFetches === numTickers) callback(marketPrices);
                        } else {
                            getExchangePrice("cryptonator", cryptonatorBase, target, (error, tickerData) => {
                                completedFetches++;
                                if (tickerData && tickerData.price) {
                                    marketPrices[i] = {
                                        ticker: pairName,
                                        price: tickerData.price * marketData[base][cryptonatorBase],
                                        source: tickerData.source
                                    };
                                }
                                if (completedFetches === numTickers) callback(marketPrices);
                            });
                        }
                    } else {
                        completedFetches++;
                        marketPrices[i] = { ticker: pairName, price: price, source: exchangeLower };
                        if (completedFetches === numTickers) callback(marketPrices);
                    }
                }
            })(i);
        }
    });
}

/**
 * Get Exchange Market Prices
 **/

const marketRequestsCache = {};

const getExchangeMarkets = (exchange, callback) => {
    callback = callback || (() => {});
    if (!exchange) { 
        callback('No exchange specified', null);
    }
    exchange = exchange.toLowerCase();

    // Return cache if available
    const cacheKey = exchange;
    const currentTimestamp = Date.now() / 1000;

    if (marketRequestsCache[cacheKey] && marketRequestsCache[cacheKey].ts > (currentTimestamp - 60)) {
        callback(null, marketRequestsCache[cacheKey].data);
        return ;
    }

    // Altex
    if (exchange == "altex") {
        apiInterfaces.jsonHttpRequest('api.altex.exchange', 443, '', (error, response) => {
            if (error) log('error', logSystem, 'API request to %s has failed: %s', [exchange, error]);

            if (error) callback(error, {});
            if (!response || !response.success) callback('No market informations', {});

            const data = {};
            for (const ticker in response.data) {
                tickerParts = ticker.split('_');
                const target = tickerParts[0];
                const symbol = tickerParts[1];

                const price = +parseFloat(response.data[ticker].last);
                if (price === 0) continue;

                if (!data[symbol]) data[symbol] = {};
                data[symbol][target] = price;
            }
            if (!error) marketRequestsCache[cacheKey] = { ts: currentTimestamp, data: data };
            callback(null, data);
        }, '/v1/ticker');
    }
    
    // Crex24
    else if (exchange == "crex24") {
        apiInterfaces.jsonHttpRequest('api.crex24.com', 443, '', function(error, response) {
            if (error) log('error', logSystem, 'API request to %s has failed: %s', [exchange, error]);

            if (error) callback(error, {});
            if (!response || !response.Tickers) callback('No market informations', {});

            const data = {};
            for (const i in response.Tickers) {
                const ticker = response.Tickers[i];

                const pairName = ticker.PairName;
                const pairParts = pairName.split('_');
                const target = pairParts[0];
                const symbol = pairParts[1];

                const price = +ticker.Last;
                if (!price || price === 0) continue;

                if (!data[symbol]) data[symbol] = {};
                data[symbol][target] = price;
            }
            if (!error) marketRequestsCache[cacheKey] = { ts: currentTimestamp, data: data };
            callback(null, data);
        }, '/CryptoExchangeService/BotPublic/ReturnTicker');
    }

    // Cryptopia
    else if (exchange == "cryptopia") {
        apiInterfaces.jsonHttpRequest('www.cryptopia.co.nz', 443, '', (error, response) => {
            if (error) log('error', logSystem, 'API request to %s has failed: %s', [exchange, error]);

            if (error) callback(error, {});
            if (!response || !response.Success) callback('No market informations', {});

            const data = {};
            for (const i in response.Data) {
                const ticker = response.Data[i];

                const pairName = ticker.Label;
                const pairParts = pairName.split('/');
                const target = pairParts[1];
                const symbol = pairParts[0];

                const price = +ticker.LastPrice;
                if (!price || price === 0) continue;

                if (!data[symbol]) data[symbol] = {};
                data[symbol][target] = price;
            }
            if (!error) marketRequestsCache[cacheKey] = { ts: currentTimestamp, data: data };
            callback(null, data);
        }, '/api/GetMarkets');
    }

    // Stocks.Exchange
    else if (exchange == "stocks.exchange") {
        apiInterfaces.jsonHttpRequest('stocks.exchange', 443, '', (error, response) => {
            if (error) log('error', logSystem, 'API request to %s has failed: %s', [exchange, error]);

            if (error) callback(error, {});
            if (!response) callback('No market informations', {});

            const data = {};
            for (const i in response) {
                const ticker = response[i];

                const pairName = ticker.market_name;
                const pairParts = pairName.split('_');
                const target = pairParts[1];
                const symbol = pairParts[0];

                const price = +ticker.last;
                if (!price || price === 0) continue;

                if (!data[symbol]) data[symbol] = {};
                data[symbol][target] = price;
            }
            if (!error) marketRequestsCache[cacheKey] = { ts: currentTimestamp, data: data };
            callback(null, data);
        }, '/api2/ticker');
    }
    
    // TradeOgre
    else if (exchange == "tradeogre") {
        apiInterfaces.jsonHttpRequest('tradeogre.com', 443, '', (error, response) => {
            if (error) log('error', logSystem, 'API request to %s has failed: %s', [exchange, error]);

            const data = {};
            if (!error && response) {
                for (const i in response) {
                    for (const pairName in response[i]) {
                        const pairParts = pairName.split('-');
                        const target = pairParts[0];
                        const symbol = pairParts[1];

                        const price = +response[i][pairName].price;
                        if (price === 0) continue;

                        if (!data[symbol]) data[symbol] = {};
                        data[symbol][target] = price;
                    }
                }
            }
            if (!error) marketRequestsCache[cacheKey] = { ts: currentTimestamp, data: data };
            callback(null, data);
        }, '/api/v1/markets');
    }

    // Unknown
    else {
        callback('Exchange not supported: ' + exchange);
    }
}
exports.getExchangeMarkets = getExchangeMarkets;

/**
 * Get Exchange Market Price
 **/

const priceRequestsCache = {};

const getExchangePrice = (exchange, base, target, callback) => {
    callback = callback || (() => {});

    if (!exchange) { 
        callback('No exchange specified');
    }
    else if (!base) {
        callback('No base specified');
    }
    else if (!target) {
        callback('No target specified');
    }

    exchange = exchange.toLowerCase();
    base = base.toUpperCase();
    target = target.toUpperCase();

    // Return cache if available
    const cacheKey = exchange + '-' + base + '-' + target;
    const currentTimestamp = Date.now() / 1000;

    if (priceRequestsCache[cacheKey] && priceRequestsCache[cacheKey].ts > (currentTimestamp - 60)) {
        callback(null, priceRequestsCache[cacheKey].data);
        return ;
    }

    // Cryptonator
    if (exchange == "cryptonator") {
        const ticker = base + '-' + target;
        apiInterfaces.jsonHttpRequest('api.cryptonator.com', 443, '', (error, response) => {
            if (error) log('error', logSystem, 'API request to %s has failed: %s', [exchange, error]);
            if (response.error) log('warn', logSystem, 'Cryptonator API error: %s', [response.error]);

            const finalError = response.error ? response.error : error;
            const price = response.success ? +response.ticker.price : null;
            if (!price) log('warn', logSystem, 'No exchange data for %s using %s', [ticker, exchange]);

            const data = { ticker: ticker, price: price, source: exchange };
            if (!finalError) priceRequestsCache[cacheKey] = { ts: currentTimestamp, data: data };
            callback(finalError, data);
        }, '/api/ticker/' + ticker);
    }

    // Altex
    else if (exchange == "altex") {
        getExchangeMarkets(exchange, (error, data) => {
            if (error) log('error', logSystem, 'API request to %s has failed: %s', [exchange, error]);

            let price = null;
            if (!error && data[base] && data[base][target]) {
                price = data[base][target];
            }
            if (!price) log('warn', logSystem, 'No exchange data for %s using %s', [ticker, exchange]);

            const tickerData = { ticker: ticker, price: price, source: exchange };
            if (!error) priceRequestsCache[cacheKey] = { ts: currentTimestamp, data: tickerData };
            callback(error, tickerData);
        });
    }
    
    // Crex24
    else if (exchange == "crex24") {
        const ticker = base + '_' + target;
        apiInterfaces.jsonHttpRequest('api.crex24.com', 443, '', (error, response) => {
            if (error) log('error', logSystem, 'API request to %s has failed: %s', [exchange, error]);
            if (response.Error) log('warn', logSystem, 'Crex24 API error: %s', [response.Error]);

            const finalError = response.Error ? response.Error : error;
            const price = (response.Tickers && response.Tickers[0]) ? +response.Tickers[0].Last : null;
            if (!price) log('warn', logSystem, 'No exchange data for %s using %s', [ticker, exchange]);

            const data = { ticker: ticker, price: price, source: exchange };
            if (!finalError) priceRequestsCache[cacheKey] = { ts: currentTimestamp, data: data };
            callback(finalError, data);
        }, '/CryptoExchangeService/BotPublic/ReturnTicker?request=[NamePairs=' + ticker + ']');
    }

    // Cryptopia
    else if (exchange == "cryptopia") {
        const ticker = base + '_' + target;
        apiInterfaces.jsonHttpRequest('www.cryptopia.co.nz', 443, '', (error, response) => {
            if (error) log('error', logSystem, 'API request to %s has failed: %s', [exchange, error]);
            if (response.Error) log('warn', logSystem, 'Cryptopia API error: %s', [response.Error]);

            const finalError = response.Error ? response.Error : error;
            const price = (response.Data && response.Data.LastPrice) ? +response.Data.LastPrice : null;

            const data = { ticker: ticker, price: price, source: exchange };
            if (!finalError) priceRequestsCache[cacheKey] = { ts: currentTimestamp, data: data };
            callback(finalError, data);
        }, '/api/GetMarket/' + ticker);
    }
    
    // Stocks.Exchange
    else if (exchange == "stocks.exchange") {
        getExchangeMarkets(exchange, (error, data) => {
            if (error) log('error', logSystem, 'API request to %s has failed: %s', [exchange, error]);

            let price;
            if (!error && data[base] && data[base][target]) {
                price = data[base][target];
            }
            if (!price) log('warn', logSystem, 'No exchange data for %s using %s', [ticker, exchange]);

            const tickerData = { ticker: ticker, price: price, source: exchange };
            if (!error) priceRequestsCache[cacheKey] = { ts: currentTimestamp, data: tickerData };
            callback(error, tickerData);
        });
    }

    // TradeOgre
    else if (exchange == "tradeogre") {
        const ticker = target + '-' + base;
        apiInterfaces.jsonHttpRequest('tradeogre.com', 443, '', (error, response) => {
            if (error) log('error', logSystem, 'API request to %s has failed: %s', [exchange, error]);
            if (response.message) log('warn', logSystem, 'TradeOgre API error: %s', [response.message]);

            const finalError = response.message ? response.message : error;
            const price = +response.price || null;
            if (!price) log('warn', logSystem, 'No exchange data for %s using %s', [ticker, exchange]);

            const data = { ticker: ticker, price: price, source: exchange };
            if (!finalError) priceRequestsCache[cacheKey] = { ts: currentTimestamp, data: data };
            callback(finalError, data);
        }, '/api/v1/ticker/' + ticker);
    }

    // Unknown
    else {
        callback('Exchange not supported: ' + exchange);
    }
}
exports.getExchangePrice = getExchangePrice;
