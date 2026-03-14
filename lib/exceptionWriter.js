/**
 * Cryptonote Node.JS Pool
 * https://github.com/dvandal/cryptonote-nodejs-pool
 *
 * Exception writer
 **/

// Load required modules
const fs = require('node:fs');
const cluster = require('node:cluster');
const dateFormat = require('dateformat');

/**
 * Handle exceptions
 **/
module.exports = (logSystem) => {
    process.on('uncaughtException', (err) => {
        console.log('\n' + err.stack + '\n');
        const time = dateFormat(new Date(), 'yyyy-mm-dd HH:MM:ss');
        fs.appendFile(`${config.logging.files.directory}/${logSystem}_crash.log`, `${time}\n${err.stack}\n\n`, (err) => {
            if (cluster.isWorker)
                process.exit();
        });
    });
};