/**
 * Cryptonote Node.JS Pool
 * https://github.com/dvandal/cryptonote-nodejs-pool
 *
 * Configuration Reader
 * 
 * CCX added by the Conceal Network Dev team, all donation goes to DVANDAL except for CCX.
 **/

// Load required modules
const fs = require('node:fs');

// Set pool software version
global.version = "v1.5.0";

/**
 * Load pool configuration
 **/
 
// Get configuration file path
const configFile = (() => {
    for (const arg of process.argv) {
        if (arg.indexOf('-config=') === 0)
            return arg.split('=')[1];
    }
    return 'config.json';
})();

// Read configuration file data
try {
    global.config = JSON.parse(fs.readFileSync(configFile));
}
catch(error){
    console.error(`Failed to read config file ${configFile}\n\n${error}`);
    process.exit(1);
}

/**
 * Developper donation addresses -- thanks for supporting dvandal works or CCX team work on this project!
 **/
 
const donationAddresses = {
    BTC: '17XRyHm2gWAj2yfbyQgqxm25JGhvjYmQjm',
    BCH: 'qpl0gr8u3yu7z4nzep955fqy3w8m6w769sec08u3dp',
    CCX: 'ccx7Mi9osGEiPkJ8Eq9ajfFFipavENjJ92Gf4xCmu4KXiExSjcWoSefCQYtcA2BUrTPjrMY5pssgMNPRxaR1DXtj3TvTJG6LRo',
    ETH: '0x83ECF65934690D132663F10a2088a550cA201353',
    LTC: 'LS9To9u2C95VPHKauRMEN5BLatC8C1k4F1',
    DERO: 'dERojUtWgEsAGjTXEJyezgSqvpEEfRGiWCRxuELx2PXa9gopNwNr7YGPAFNmJzzWgW84wGJ84RS8jAp1GesTeXgY7VDJMBGWYt',
    GRFT: 'GBqRuitSoU3PFPBAkXMEnLdBRWXH4iDSD6RDxnQiEFjVJhWUi1UuqfV5EzosmaXgpPGE6JJQjMYhZZgWY8EJQn8jQTsuTit',
    ITNS: 'iz4fRGV8XsRepDtnK8XQDpHc3TbtciQWQ5Z9285qihDkCAvB9VX1yKt6qUCY6sp2TCC252SQLHrjmeLuoXsv4aF42YZtnZQ53',
    MSR: '5n7mffxVT9USrq7tcG3TM8HL5yAz7MirUWypXXJfHrNfTcjNtDouLAAGex8s8htu4vBpmMXFzay8KG3jYGMFhYPr2aMbN6i',
    XMR: '49WyMy9Q351C59dT913ieEgqWjaN12dWM5aYqJxSTZCZZj1La5twZtC3DyfUsmVD3tj2Zud7m6kqTVDauRz53FqA9zphHaj',
    SUMO: 'Sumoo4mVXMfYw2PFtPRXzviHfESnx5aW6VrMLoYVeVubYH6snAwr6D9R8j7fuvQvjifDqLLKH1KtMXuv7iHGgCM1fd4spVrvP1T',
    XHV: 'hvxy2RAzE7NfXPLE3AmsuRaZztGDYckCJ14XMoWa6BUqGrGYicLCcjDEjhjGAQaAvHYGgPD7cGUwcYP7nEUs8u6w3uaap9UZTf',
    XTL: 'Se45GzgpFG3CnvYNwEFnxiRHD2x7YzRnhFLdxjUqXdbv3ysNbfW5U7aUdn87RgMRPM7xwN6CTbXNc7nL5QUgcww11bDeypTe1'
};

global.donations = {};

const percent = config.blockUnlocker.devDonation;
const wallet = donationAddresses[config.symbol];
if (percent && wallet) {
    global.donations[wallet] = percent;
}
