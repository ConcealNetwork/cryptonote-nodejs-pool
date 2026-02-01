/**
 * Cryptonote Node.JS Pool
 * https://github.com/dvandal/cryptonote-nodejs-pool
 *
 * Utilities functions
 **/

// Load required module
const crypto = require('node:crypto');

const dateFormat = require('dateformat');
exports.dateFormat = dateFormat;

const cnUtil = require('cryptoforknote-util');
exports.cnUtil = cnUtil;

// Use safe base58 implementation for address decoding (no native dependencies)
const safeBase58 = require('./safe-base58');

/**
 * Generate random instance id
 **/
exports.instanceId = () => crypto.randomBytes(4);

/**
 * Validate miner address
 * Only initialize if poolServer config exists (not in solo mode)
 **/
let addressBase58Prefix = null;
let integratedAddressBase58Prefix = null;
let subAddressBase58Prefix = "N/A";

if (config.poolServer?.poolAddress) {
    const addressBase58PrefixBuffer = safeBase58.address_decode(Buffer.from(config.poolServer.poolAddress));
    addressBase58Prefix = addressBase58PrefixBuffer ? addressBase58PrefixBuffer[0] : null;
    integratedAddressBase58Prefix = config.poolServer.intAddressPrefix ? parseInt(config.poolServer.intAddressPrefix, 10) : (addressBase58Prefix ? addressBase58Prefix + 1 : null);
    subAddressBase58Prefix = config.poolServer.subAddressPrefix ? parseInt(config.poolServer.subAddressPrefix, 10) : "N/A";
}


// Get address prefix
function getAddressPrefix(address) {
    const addressBuffer = Buffer.from(address);

    let addressPrefix = safeBase58.address_decode(addressBuffer);
    if (addressPrefix && addressPrefix.length > 0) {
        addressPrefix = addressPrefix[0];
    } else {
        addressPrefix = null;
    }

    if (!addressPrefix) {
        addressPrefix = safeBase58.address_decode_integrated(addressBuffer);
        if (addressPrefix && addressPrefix.length > 0) {
            addressPrefix = addressPrefix[0];
        } else {
            addressPrefix = null;
        }
    }

    return addressPrefix || null;
}
exports.getAddressPrefix = getAddressPrefix;

// Validate miner address
exports.validateMinerAddress = (address) => {
    const addressPrefix = getAddressPrefix(address);
    if (addressPrefix === addressBase58Prefix) return true;
    else if (addressPrefix === integratedAddressBase58Prefix) return true;
    else if (addressPrefix === subAddressBase58Prefix) return true;
    return false;
};

// Return if value is an integrated address
exports.isIntegratedAddress = (address) => {
    const addressPrefix = getAddressPrefix(address);
    return (addressPrefix === integratedAddressBase58Prefix);
};

/**
 * Cleanup special characters (fix for non latin characters)
 **/
function cleanupSpecialChars(str) {
    str = str.replace(/[ÀÁÂÃÄÅ]/g,"A");
    str = str.replace(/[àáâãäå]/g,"a");
    str = str.replace(/[ÈÉÊË]/g,"E");
    str = str.replace(/[èéêë]/g,"e");
    str = str.replace(/[ÌÎÏ]/g,"I");
    str = str.replace(/[ìîï]/g,"i");
    str = str.replace(/[ÒÔÖ]/g,"O");
    str = str.replace(/[òôö]/g,"o");
    str = str.replace(/[ÙÛÜ]/g,"U");
    str = str.replace(/[ùûü]/g,"u");
    return str.replace(/[^A-Za-z0-9\-_]/gi,'');
}
exports.cleanupSpecialChars = cleanupSpecialChars;

/**
 * Get readable hashrate
 **/
exports.getReadableHashRate = (hashrate) => {
    let i = 0;
    const byteUnits = [' H', ' KH', ' MH', ' GH', ' TH', ' PH' ];
    let adjustedHashrate = hashrate;
    while (adjustedHashrate > 1000){
        adjustedHashrate = adjustedHashrate / 1000;
        i++;
    }
    return `${adjustedHashrate.toFixed(2)}${byteUnits[i]}/sec`;
};
 
/**
 * Get readable coins
 **/
exports.getReadableCoins = (coins, digits, withoutSymbol) => {
    const coinDecimalPlaces = config.coinDecimalPlaces || config.coinUnits.toString().length - 1;
    const amount = (parseInt(coins || 0, 10) / config.coinUnits).toFixed(digits || coinDecimalPlaces);
    return withoutSymbol ? amount : `${amount} ${config.symbol}`;
};

/**
 * Generate unique id
 **/
exports.uid = () => {
    const min = 100000000000000;
    const max = 999999999999999;
    const id = Math.floor(Math.random() * (max - min + 1)) + min;
    return id.toString();
};

/**
 * Ring buffer
 **/
exports.ringBuffer = (maxSize) => {
    let data = [];
    let cursor = 0;
    let isFull = false;

    return {
        append: (x) => {
            if (isFull){
                data[cursor] = x;
                cursor = (cursor + 1) % maxSize;
            }
            else{
                data.push(x);
                cursor++;
                if (data.length === maxSize){
                    cursor = 0;
                    isFull = true;
                }
            }
        },
        avg: (plusOne) => {
            const sum = data.reduce((a, b) => a + b, plusOne || 0);
            return sum / ((isFull ? maxSize : cursor) + (plusOne ? 1 : 0));
        },
        size: () => isFull ? maxSize : cursor,
        clear: () => {
            data = [];
            cursor = 0;
            isFull = false;
        }
    };
};
